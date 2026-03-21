"""
core/session.py — Session statistics (VWAP, POC, VAH/VAL, funding, OI).
Resets at UTC midnight automatically.
"""
from __future__ import annotations
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class SessionStats:
    start_ts: float = field(default_factory=time.time)
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: float = 0.0
    delta: float = 0.0
    vwap_num: float = 0.0
    vwap_den: float = 0.0
    levels: Dict[float, float] = field(default_factory=lambda: defaultdict(float))
    funding_rate: float = 0.0
    open_interest: float = 0.0

    @property
    def vwap(self) -> float:
        return self.vwap_num / self.vwap_den if self.vwap_den > 0 else 0.0

    @property
    def poc(self) -> Optional[float]:
        if not self.levels: return None
        return max(self.levels, key=lambda p: self.levels[p])

    def value_area(self, pct: float = 0.70):
        if not self.levels: return None, None, None
        poc = self.poc
        sorted_prices = sorted(self.levels.keys())
        total = sum(self.levels.values())
        target = total * pct
        lo_idx = sorted_prices.index(poc)
        hi_idx = lo_idx
        acc = self.levels[poc]
        n = len(sorted_prices)
        vah = val = poc
        while acc < target:
            vu = self.levels[sorted_prices[hi_idx+1]] if hi_idx+1<n else 0
            vd = self.levels[sorted_prices[lo_idx-1]] if lo_idx>0 else 0
            if vu >= vd and hi_idx+1<n:
                hi_idx+=1; vah=sorted_prices[hi_idx]; acc+=vu
            elif lo_idx>0:
                lo_idx-=1; val=sorted_prices[lo_idx]; acc+=vd
            else: break
        return vah, poc, val

    def add_trade(self, price: float, qty: float, side: str, tick_size: float = 1.0):
        if tick_size > 0:
            bucket = round(round(price/tick_size)*tick_size, 8)
        else:
            bucket = price
        self.levels[bucket] += qty
        self.volume += qty
        self.close = price
        d = qty if side=='B' else -qty
        self.delta += d
        self.vwap_num += price * qty
        self.vwap_den += qty
        if self.open == 0.0: self.open = price
        if self.high == 0.0 or price > self.high: self.high = price
        if self.low  == 0.0 or price < self.low:  self.low  = price

    def to_dict(self) -> dict:
        vah, poc, val = self.value_area()
        return {
            'start_ts':      self.start_ts,
            'open':          round(self.open, 4),
            'high':          round(self.high, 4),
            'low':           round(self.low, 4),
            'close':         round(self.close, 4),
            'volume':        round(self.volume, 4),
            'delta':         round(self.delta, 4),
            'vwap':          round(self.vwap, 4),
            'poc':           poc,
            'vah':           vah,
            'val':           val,
            'funding_rate':  self.funding_rate,
            'open_interest': self.open_interest,
        }


class SessionManager:
    def __init__(self, tick_size: float = 0.0, coin: str = 'BTC'):
        self.tick_size = tick_size
        self.coin = coin
        self._session = SessionStats()
        self._day = self._current_day()

    def _current_day(self) -> int:
        return int(time.time() // 86400)

    def _maybe_reset(self):
        today = self._current_day()
        if today != self._day:
            self._session = SessionStats()
            self._day = today

    def add_trade(self, price: float, qty: float, side: str):
        self._maybe_reset()
        self._session.add_trade(price, qty, side, self.tick_size)

    def update_meta(self, funding_rate: float = None, open_interest: float = None):
        if funding_rate is not None:   self._session.funding_rate = funding_rate
        if open_interest is not None:  self._session.open_interest = open_interest

    def snapshot(self) -> dict:
        self._maybe_reset()
        return self._session.to_dict()