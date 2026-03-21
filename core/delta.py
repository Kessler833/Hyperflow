"""
core/delta.py — Cumulative Volume Delta (CVD) + divergence detection.
"""
from __future__ import annotations
from collections import deque
from typing import List


class CVDTracker:
    def __init__(self, window: int = 300):
        self.window = window
        self._cvd: float = 0.0
        self._history: deque[float] = deque(maxlen=window)
        self._price_hist: deque[float] = deque(maxlen=window)
        self._candle_deltas: deque[float] = deque(maxlen=500)
        self._candle_closes: deque[float] = deque(maxlen=500)
        self._candle_delta_acc: float = 0.0

    def add_trade(self, qty: float, side: str, price: float):
        d = qty if side == 'B' else -qty
        self._cvd += d
        self._candle_delta_acc += d
        self._history.append(self._cvd)
        self._price_hist.append(price)

    def close_candle(self, close_price: float):
        self._candle_deltas.append(self._candle_delta_acc)
        self._candle_closes.append(close_price)
        self._candle_delta_acc = 0.0

    @property
    def cvd(self) -> float:
        return self._cvd

    @property
    def cvd_history(self) -> List[float]:
        return list(self._history)

    def divergence_signal(self, lookback: int = 10) -> str:
        d = self._candle_deltas
        c = self._candle_closes
        if len(d) < lookback or len(c) < lookback:
            return 'none'
        d_recent = list(d)[-lookback:]
        c_recent = list(c)[-lookback:]
        price_up  = c_recent[-1] > c_recent[0]
        delta_up  = d_recent[-1] > d_recent[0]
        if price_up and not delta_up:
            return 'bear'
        if not price_up and delta_up:
            return 'bull'
        return 'none'

    def snapshot(self, n: int = 300) -> dict:
        return {
            'cvd':           round(self._cvd, 6),
            'cvd_history':   [round(v, 6) for v in list(self._history)[-n:]],
            'candle_deltas': [round(v, 6) for v in list(self._candle_deltas)[-n:]],
            'candle_closes': [round(v, 4) for v in list(self._candle_closes)[-n:]],
            'divergence':    self.divergence_signal(),
        }