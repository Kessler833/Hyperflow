"""
core/footprint.py — Footprint candle builder.
"""
from __future__ import annotations
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional


def _decimal_places(v: float) -> int:
    s = str(v)
    return len(s.split('.')[1]) if '.' in s else 0


@dataclass
class TickLevel:
    price:   float
    bid_vol: float = 0.0
    ask_vol: float = 0.0

    @property
    def total(self) -> float:
        return self.bid_vol + self.ask_vol

    @property
    def delta(self) -> float:
        return self.bid_vol - self.ask_vol

    @property
    def imbalance(self) -> float:
        t = self.total
        return self.bid_vol / t if t > 0 else 0.5

    def to_dict(self) -> dict:
        return {
            'price':     self.price,
            'bid_vol':   round(self.bid_vol,   6),
            'ask_vol':   round(self.ask_vol,   6),
            'delta':     round(self.delta,     6),
            'total':     round(self.total,     6),   # ← explicitly serialized
            'imbalance': round(self.imbalance, 4),
        }


@dataclass
class LargeTrade:
    ts:       float
    side:     str
    price:    float
    qty:      float
    notional: float


@dataclass
class FootprintCandle:
    open_ts:  float
    interval: int
    tick_size: float
    coin:     str = ''

    open:   float = 0.0
    high:   float = 0.0
    low:    float = 0.0
    close:  float = 0.0
    volume: float = 0.0
    delta:  float = 0.0

    levels:       Dict[float, TickLevel] = field(default_factory=dict)
    large_trades: List[LargeTrade]       = field(default_factory=list)

    closed:   bool           = False
    close_ts: Optional[float] = None

    def add_trade(self, price: float, qty: float, side: str,
                  ts: float, large_usd: float = 50_000.0):
        if self.tick_size <= 0:
            bucket = price
        else:
            bucket = round(
                round(price / self.tick_size) * self.tick_size,
                _decimal_places(self.tick_size)
            )

        if bucket not in self.levels:
            self.levels[bucket] = TickLevel(price=bucket)

        lv = self.levels[bucket]
        if side == 'B':
            lv.bid_vol += qty
            self.delta += qty
        else:
            lv.ask_vol += qty
            self.delta -= qty

        self.volume += qty
        self.close = price
        if self.open == 0.0:  self.open = price
        if self.high == 0.0 or price > self.high: self.high = price
        if self.low  == 0.0 or price < self.low:  self.low  = price

        notional = price * qty
        if notional >= large_usd:
            self.large_trades.append(LargeTrade(ts, side, price, qty, notional))

    @property
    def poc(self) -> Optional[float]:
        if not self.levels:
            return None
        return max(self.levels, key=lambda p: self.levels[p].total)

    def value_area(self, pct: float = 0.70):
        if not self.levels:
            return None, None, None
        poc_price     = self.poc
        sorted_prices = sorted(self.levels.keys())
        total_vol     = sum(lv.total for lv in self.levels.values())
        target        = total_vol * pct

        vah = poc_price
        val = poc_price
        acc = self.levels[poc_price].total

        lo_idx = sorted_prices.index(poc_price)
        hi_idx = lo_idx
        n      = len(sorted_prices)

        while acc < target:
            vol_up   = self.levels[sorted_prices[hi_idx + 1]].total if hi_idx + 1 < n else 0
            vol_down = self.levels[sorted_prices[lo_idx - 1]].total if lo_idx > 0    else 0
            if vol_up >= vol_down and hi_idx + 1 < n:
                hi_idx += 1; vah = sorted_prices[hi_idx]; acc += vol_up
            elif lo_idx > 0:
                lo_idx -= 1; val = sorted_prices[lo_idx]; acc += vol_down
            else:
                break

        return vah, poc_price, val

    def to_dict(self, include_levels: bool = True) -> dict:
        vah, poc, val = self.value_area()
        d = {
            'open_ts':  self.open_ts,
            'close_ts': self.close_ts,
            'interval': self.interval,
            'coin':     self.coin,
            'open':     self.open,
            'high':     self.high,
            'low':      self.low,
            'close':    self.close,
            'volume':   round(self.volume, 6),
            'delta':    round(self.delta,  6),
            'poc':      poc,
            'vah':      vah,
            'val':      val,
            'closed':   self.closed,
            'large_trades': [
                {'ts': t.ts, 'side': t.side, 'price': t.price,
                 'qty': round(t.qty, 6), 'notional': round(t.notional, 2)}
                for t in self.large_trades[-20:]
            ],
        }
        if include_levels:
            d['levels'] = {
                str(p): lv.to_dict()   # to_dict() now includes 'total'
                for p, lv in self.levels.items()
            }
        return d


class FootprintEngine:
    def __init__(self, interval: int = 60, tick_size: float = 0.0,
                 coin: str = 'BTC', max_candles: int = 500,
                 large_usd: float = 50_000.0):
        self.interval   = interval
        self.tick_size  = tick_size
        self.coin       = coin
        self.max_candles = max_candles
        self.large_usd  = large_usd

        self._candles: deque[FootprintCandle] = deque(maxlen=max_candles)
        self._current: Optional[FootprintCandle] = None

    def _candle_open_ts(self, ts: float) -> float:
        return float(int(ts // self.interval) * self.interval)

    def add_trade(self, price: float, qty: float, side: str, ts: float):
        open_ts = self._candle_open_ts(ts)

        if self._current is None or self._current.open_ts != open_ts:
            if self._current is not None:
                self._current.closed   = True
                self._current.close_ts = open_ts
                self._candles.append(self._current)
            self._current = FootprintCandle(
                open_ts=open_ts, interval=self.interval,
                tick_size=self.tick_size, coin=self.coin
            )

        self._current.add_trade(price, qty, side, ts, self.large_usd)

    def current_candle_dict(self) -> Optional[dict]:
        return self._current.to_dict() if self._current else None

    def snapshot(self, n: int = 200) -> List[dict]:
        candles = list(self._candles)[-n:]
        if self._current:
            candles.append(self._current)
        return [c.to_dict() for c in candles]

    @property
    def candle_count(self) -> int:
        return len(self._candles) + (1 if self._current else 0)