from __future__ import annotations
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional


def _dp(v: float) -> int:
    s = str(v); return len(s.split('.')[1]) if '.' in s else 0


@dataclass
class RawTrade:
    ts:    float
    price: float
    qty:   float
    side:  str   # 'B' or 'A'


@dataclass
class TickLevel:
    price:   float
    bid_vol: float = 0.0
    ask_vol: float = 0.0

    @property
    def total(self)     -> float: return self.bid_vol + self.ask_vol
    @property
    def delta(self)     -> float: return self.bid_vol - self.ask_vol
    @property
    def imbalance(self) -> float:
        t = self.total; return self.bid_vol / t if t > 0 else 0.5

    def to_dict(self) -> dict:
        return {'price': self.price,
                'bid_vol': round(self.bid_vol, 6), 'ask_vol': round(self.ask_vol, 6),
                'delta': round(self.delta, 6),     'total': round(self.total, 6),
                'imbalance': round(self.imbalance, 4)}


@dataclass
class FootprintCandle:
    open_ts:   float
    close_ts:  Optional[float]
    interval:  int
    tick_size: float
    coin:      str = ''

    open:   float = 0.0
    high:   float = 0.0
    low:    float = 0.0
    close:  float = 0.0
    volume: float = 0.0
    delta:  float = 0.0
    closed: bool  = False

    levels:       Dict[float, TickLevel] = field(default_factory=dict)
    large_trades: List[dict]             = field(default_factory=list)

    def _bucket(self, price: float) -> float:
        ts = self.tick_size
        if ts <= 0: return price
        return round(round(price / ts) * ts, _dp(ts))

    def add(self, t: RawTrade, large_usd: float = 50_000.0):
        b = self._bucket(t.price)
        if b not in self.levels: self.levels[b] = TickLevel(price=b)
        lv = self.levels[b]
        if t.side == 'B': lv.bid_vol += t.qty; self.delta += t.qty
        else:             lv.ask_vol += t.qty; self.delta -= t.qty
        self.volume += t.qty
        self.close   = t.price
        if self.open  == 0.0: self.open  = t.price
        if self.high  == 0.0 or t.price > self.high: self.high = t.price
        if self.low   == 0.0 or t.price < self.low:  self.low  = t.price
        n = t.price * t.qty
        if n >= large_usd:
            self.large_trades.append({'ts': t.ts, 'side': t.side,
                                      'price': t.price, 'qty': round(t.qty, 6),
                                      'notional': round(n, 2)})

    @property
    def poc(self) -> Optional[float]:
        return max(self.levels, key=lambda p: self.levels[p].total) if self.levels else None

    def value_area(self, pct: float = 0.70):
        if not self.levels: return None, None, None
        poc_price     = self.poc
        sorted_prices = sorted(self.levels)
        total_vol     = sum(lv.total for lv in self.levels.values())
        target        = total_vol * pct
        lo = hi       = sorted_prices.index(poc_price)
        acc           = self.levels[poc_price].total
        n             = len(sorted_prices)
        while acc < target:
            vu = self.levels[sorted_prices[hi+1]].total if hi+1 < n else 0
            vd = self.levels[sorted_prices[lo-1]].total if lo > 0   else 0
            if vu >= vd and hi+1 < n: hi += 1; acc += vu
            elif lo > 0:              lo -= 1; acc += vd
            else: break
        return sorted_prices[hi], poc_price, sorted_prices[lo]

    def to_dict(self) -> dict:
        vah, poc, val     = self.value_area(0.70)
        vah50, _, val50   = self.value_area(0.50)
        return {
            'open_ts': self.open_ts, 'close_ts': self.close_ts,
            'interval': self.interval, 'coin': self.coin,
            'open': self.open, 'high': self.high,
            'low': self.low,   'close': self.close,
            'volume': round(self.volume, 6), 'delta': round(self.delta, 6),
            'poc': poc, 'vah': vah, 'val': val, 'vah50': vah50, 'val50': val50,
            'closed': self.closed,
            'large_trades': self.large_trades[-20:],
            'levels': {str(p): lv.to_dict() for p, lv in self.levels.items()},
        }


class TradeBuffer:
    """
    Single raw trade store. All timeframes are computed from this.
    Keeps last `max_trades` trades (default 200k — ~hours of BTC data).
    """

    def __init__(self, coin: str = 'BTC', tick_size: float = 0.0,
                 max_trades: int = 200_000, large_usd: float = 50_000.0):
        self.coin       = coin
        self.tick_size  = tick_size
        self.large_usd  = large_usd
        self._trades: deque[RawTrade] = deque(maxlen=max_trades)

    def add(self, price: float, qty: float, side: str, ts: float):
        self._trades.append(RawTrade(ts=ts, price=price, qty=qty, side=side))

    def build(self, interval: int, max_candles: int = 200) -> List[dict]:
        """
        Group raw trades into footprint candles for the given interval.
        Pure computation — no state stored per interval.
        """
        if not self._trades:
            return []

        trades = list(self._trades)

        # Determine time window: last max_candles * interval seconds
        now      = trades[-1].ts
        cutoff   = now - (interval * max_candles)
        trades   = [t for t in trades if t.ts >= cutoff]

        if not trades:
            return []

        candles: Dict[float, FootprintCandle] = {}

        for t in trades:
            open_ts = float(int(t.ts // interval) * interval)
            if open_ts not in candles:
                candles[open_ts] = FootprintCandle(
                    open_ts=open_ts,
                    close_ts=open_ts + interval,
                    interval=interval,
                    tick_size=self.tick_size,
                    coin=self.coin,
                )
            candles[open_ts].add(t, self.large_usd)

        sorted_ts = sorted(candles)

        # Mark all closed except the last
        for i, ts in enumerate(sorted_ts):
            if i < len(sorted_ts) - 1:
                candles[ts].closed = True

        return [candles[ts].to_dict() for ts in sorted_ts]

    @property
    def trade_count(self) -> int:
        return len(self._trades)

    @property
    def latest_price(self) -> Optional[float]:
        return self._trades[-1].price if self._trades else None