"""
config.py — Hyperflow configuration.
"""
from __future__ import annotations
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    # Coin
    coin: str = 'BTC'

    # Footprint candle settings
    candle_seconds: int = 60        # default 1-min candles
    tick_size: float = 0.0          # 0 = auto-detect from feed

    # Delta imbalance threshold (%)
    imbalance_threshold: float = 0.70  # 70% bid or ask dominance = highlight

    # Large trade threshold (USD notional)
    large_trade_usd: float = 50_000.0

    # Hyperliquid WS
    hl_ws_url: str = 'wss://api.hyperliquid.xyz/ws'

    # Max candles kept in memory
    max_candles: int = 500

    # Max trades per candle (capped for memory)
    max_trades_per_candle: int = 10_000


DEFAULT_CONFIG = Config()