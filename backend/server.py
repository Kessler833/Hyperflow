"""
Hyperflow Backend — Single trade buffer, all TFs computed on demand.

Messages → frontend:
  footprint_update   full candle list
  candle_tick        live current candle
  cvd_update         CVD snapshot
  imbalance_update   OB imbalance
  session_update     session stats
  large_trade        large trade alert
  meta_update        funding + OI
  coin_changed       on coin switch

Messages ← frontend:
  set_coin      { coin }
  set_interval  { seconds: 15|60|300|900|1800|3600 }
  get_snapshot  {}
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, str(Path(__file__).parent.parent))
from core.footprint import TradeBuffer
from core.delta import CVDTracker
from core.imbalance import ImbalanceTracker
from core.session import SessionManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("hyperflow")

HL_WS_URL           = "wss://api.hyperliquid.xyz/ws"
SUPPORTED_INTERVALS = (15, 60, 300, 900, 1800, 3600)

# ─ Globals ────────────────────────────────────────────────────────────────
clients:       set[WebSocket] = set()
current_coin:  str  = "BTC"
coin_lock      = asyncio.Lock()
interval_secs: int  = 60

# ONE buffer — all timeframes are views over it
trade_buf:   TradeBuffer      = TradeBuffer(coin="BTC")
cvd_tracker: CVDTracker       = CVDTracker()
imb_tracker: ImbalanceTracker = ImbalanceTracker()
session_mgr: SessionManager   = SessionManager()

_tick_size: float = 0.0


# ─ Broadcast ──────────────────────────────────────────────────────────────
async def broadcast(msg: dict):
    dead = set()
    for ws in list(clients):
        try:    await ws.send_text(json.dumps(msg))
        except: dead.add(ws)
    clients.difference_update(dead)


async def send_to(ws: WebSocket, msg: dict):
    try: await ws.send_text(json.dumps(msg))
    except: pass


# ─ Helpers ────────────────────────────────────────────────────────────────
def _detect_tick(bids: list):
    global _tick_size
    if len(bids) >= 2 and _tick_size == 0.0:
        diff = abs(float(bids[0]['px']) - float(bids[1]['px']))
        if diff > 0:
            _tick_size = diff
            trade_buf.tick_size  = diff
            session_mgr.tick_size = diff


def _reset(coin: str):
    global trade_buf, cvd_tracker, imb_tracker, session_mgr, _tick_size
    _tick_size  = 0.0
    trade_buf   = TradeBuffer(coin=coin)
    cvd_tracker = CVDTracker()
    imb_tracker = ImbalanceTracker()
    session_mgr = SessionManager(coin=coin)


def _snapshot(interval: int) -> dict:
    return {
        'type':     'footprint_update',
        'coin':     current_coin,
        'interval': interval,
        'candles':  trade_buf.build(interval, max_candles=200),
    }


# ─ Feed ───────────────────────────────────────────────────────────────────
async def hl_feed():
    global current_coin

    while True:
        coin = current_coin
        log.info(f"[feed] Connecting: {coin}")
        try:
            async with websockets.connect(HL_WS_URL, ping_interval=20) as ws:
                for sub in [
                    {'type': 'trades',        'coin': coin},
                    {'type': 'l2Book',        'coin': coin, 'nSigFigs': 5},
                    {'type': 'activeAssetCtx','coin': coin},
                ]:
                    await ws.send(json.dumps({'method': 'subscribe', 'subscription': sub}))
                log.info(f"[feed] Subscribed for {coin}")

                await broadcast(_snapshot(interval_secs))

                while True:
                    if current_coin != coin: break
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue

                    data    = json.loads(raw)
                    channel = data.get('channel', '')

                    if channel == 'trades':
                        trades = data.get('data', [])
                        for t in trades:
                            price = float(t['px'])
                            qty   = float(t['sz'])
                            side  = t.get('side', 'B')
                            ts    = t.get('time', time.time() * 1000) / 1000.0

                            # Single buffer — feeds all TFs
                            trade_buf.add(price, qty, side, ts)
                            cvd_tracker.add_trade(qty, side, price)
                            session_mgr.add_trade(price, qty, side)

                            # Build current candle for active interval only
                            snap    = trade_buf.build(interval_secs, max_candles=1)
                            current = snap[-1] if snap else None
                            if current:
                                await broadcast({
                                    'type':     'candle_tick',
                                    'coin':     coin,
                                    'interval': interval_secs,
                                    'candle':   current,
                                })

                            notional = price * qty
                            if notional >= 50_000.0:
                                await broadcast({
                                    'type': 'large_trade', 'coin': coin,
                                    'side': side, 'price': price,
                                    'qty':  round(qty, 6),
                                    'notional': round(notional, 2), 'ts': ts,
                                })

                        if trades:
                            await broadcast({'type': 'cvd_update', 'coin': coin,
                                             **cvd_tracker.snapshot(n=300)})
                            await broadcast({'type': 'session_update', 'coin': coin,
                                             **session_mgr.snapshot()})

                    elif channel == 'l2Book':
                        book   = data.get('data', {})
                        levels = book.get('levels', [[], []])
                        bids   = levels[0] if len(levels) > 0 else []
                        asks   = levels[1] if len(levels) > 1 else []
                        _detect_tick(bids)
                        imb = imb_tracker.update(bids, asks)
                        await broadcast({
                            'type': 'imbalance_update', 'coin': coin,
                            'current': round(imb, 4),
                            'history': imb_tracker.history[-60:],
                            'bids_top5': bids[:5], 'asks_top5': asks[:5],
                        })

                    elif channel == 'activeAssetCtx':
                        ctx = data.get('data', {})
                        if isinstance(ctx, dict):
                            ctx2 = ctx.get('ctx', ctx)
                            fr = oi = 0.0
                            try: fr = float(ctx2.get('funding', 0))
                            except: pass
                            try: oi = float(ctx2.get('openInterest', 0))
                            except: pass
                            session_mgr.update_meta(fr, oi)
                            await broadcast({
                                'type': 'meta_update', 'coin': coin,
                                'funding_rate': fr, 'open_interest': oi,
                            })

        except Exception as e:
            log.error(f"[feed] {e}. Reconnecting in 3s…")
            await asyncio.sleep(3)


# ─ FastAPI ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app_: FastAPI):
    asyncio.create_task(hl_feed())
    yield


app = FastAPI(title="Hyperflow", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['*'],
                   allow_methods=['*'], allow_headers=['*'])


@app.get('/health')
async def health():
    return {
        'status':       'ok',
        'coin':         current_coin,
        'interval':     interval_secs,
        'trades_stored': trade_buf.trade_count,
        'latest_price': trade_buf.latest_price,
    }


@app.websocket('/ws')
async def frontend_ws(ws: WebSocket):
    global current_coin, interval_secs

    await ws.accept()
    clients.add(ws)
    log.info(f'[ws] Client connected ({len(clients)} total)')

    try:
        await send_to(ws, _snapshot(interval_secs))
        await send_to(ws, {'type': 'cvd_update', 'coin': current_coin,
                           **cvd_tracker.snapshot(n=300)})
        await send_to(ws, {'type': 'session_update', 'coin': current_coin,
                           **session_mgr.snapshot()})
        await send_to(ws, {'type': 'imbalance_update', 'coin': current_coin,
                           **imb_tracker.snapshot(n=60)})
    except Exception as e:
        log.warning(f'[ws] initial snapshot error: {e}')

    try:
        while True:
            raw  = await ws.receive_text()
            data = json.loads(raw)
            t    = data.get('type')

            if t == 'set_coin':
                new_coin = data.get('coin', 'BTC').upper().strip()
                async with coin_lock:
                    current_coin = new_coin
                _reset(new_coin)
                log.info(f'[ws] Coin → {new_coin}')
                await broadcast({'type': 'coin_changed', 'coin': new_coin})

            elif t == 'set_interval':
                new_iv = int(data.get('seconds', 60))
                if new_iv in SUPPORTED_INTERVALS:
                    interval_secs = new_iv
                    log.info(f'[ws] Interval → {new_iv}s  '
                             f'(recomputing from {trade_buf.trade_count} trades)')
                    # Recompute from raw buffer — instant, no history loss
                    await broadcast(_snapshot(new_iv))

            elif t == 'get_snapshot':
                await send_to(ws, _snapshot(interval_secs))

    except WebSocketDisconnect:
        clients.discard(ws)
        log.info(f'[ws] Client disconnected ({len(clients)} total)')
    except Exception as e:
        clients.discard(ws)
        log.error(f'[ws] Error: {e}')


if __name__ == '__main__':
    uvicorn.run('server:app', host='127.0.0.1', port=8766, reload=False)