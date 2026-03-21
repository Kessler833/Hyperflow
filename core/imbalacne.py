"""
core/imbalance.py — Order book bid/ask imbalance per update.
"""
from __future__ import annotations
from collections import deque
from typing import List


class ImbalanceTracker:
    def __init__(self, depth: int = 10, history_len: int = 300):
        self.depth = depth
        self._history: deque[float] = deque(maxlen=history_len)
        self._current: float = 0.0

    def update(self, bids: list, asks: list) -> float:
        bid_vol = sum(float(b['sz']) for b in bids[:self.depth])
        ask_vol = sum(float(a['sz']) for a in asks[:self.depth])
        total = bid_vol + ask_vol
        self._current = (bid_vol - ask_vol) / total if total > 0 else 0.0
        self._history.append(self._current)
        return self._current

    @property
    def current(self) -> float:
        return self._current

    @property
    def history(self) -> List[float]:
        return list(self._history)

    def snapshot(self, n: int = 300) -> dict:
        return {
            'current': round(self._current, 4),
            'history': [round(v, 4) for v in list(self._history)[-n:]],
        }