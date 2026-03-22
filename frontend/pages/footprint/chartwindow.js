/* =============================================================
   HYPERFLOW — ChartWindow (state, controls, WS, render loop)
   footprint.js handles all pure drawing functions
   ============================================================= */

window.FootprintPage = (() => {

  // ─ State ─────────────────────────────────────────────────────
  let cfg = {
    coin:               localStorage.getItem('fp_coin') || 'BTC',
    interval:           parseInt(localStorage.getItem('fp_interval') || '60'),
    imbalanceThreshold: parseFloat(localStorage.getItem('fp_imb_thr') || '0.70'),
    showImbalance:      localStorage.getItem('fp_show_imb')  !== 'false',
    showVWAP:           localStorage.getItem('fp_show_vwap') !== 'false',
    cluster:            parseInt(localStorage.getItem('fp_cluster') || '1'),
    maxBubble: 18,
  };

  let candles    = [];
  let session    = {};
  let cvdHistory = [];
  let imbalance  = { current: 0, history: [] };

  let midPrice   = null;
  let tickSize   = null;
  let windowHalf = null, windowHalfAuto = null;
  let userZoomY  = false;
  let xZoomMul   = 1.0;

  let axisDragging = false, axisDragStartY = 0, axisDragStartH = 0;

  let mainCanvas, mainCtx, mainWrap;
  let cvdCanvas,  cvdCtx;
  let vpCanvas,   vpCtx;
  let W = 0, H = 0;

  const CVD_H    = 80;
  const VP_W     = 100;
  const TS_BAR_H = 18;
  const AXIS_W   = 64;

  let dirty = false;
  const bubbles = [];

  // ─ Init ──────────────────────────────────────────────────────
  function init() {
    const page = document.getElementById('page-footprint');
    page.innerHTML = `
      <div id="fp-header">
        <span style="color:var(--accent);font-weight:700;letter-spacing:.3px">Hyperflow</span>
        <span id="fp-coin-badge">${cfg.coin}-PERP</span>
        <span id="fp-price">—</span>
        <span id="fp-delta-badge" class="delta-pos">Δ —</span>

        <div class="fp-ctl-group">
          <label>Coin</label>
          <input id="fp-coin-input" class="fp-input" type="text"
            value="${cfg.coin}" maxlength="10" placeholder="BTC">
          <button id="fp-coin-go" class="fp-btn">Go</button>
        </div>

        <div class="fp-ctl-group">
          <label>Interval</label>
          <select id="fp-interval" class="fp-select">
            <option value="15"   ${cfg.interval==15  ?'selected':''}>15s</option>
            <option value="60"   ${cfg.interval==60  ?'selected':''}>1m</option>
            <option value="300"  ${cfg.interval==300 ?'selected':''}>5m</option>
            <option value="900"  ${cfg.interval==900 ?'selected':''}>15m</option>
            <option value="1800" ${cfg.interval==1800?'selected':''}>30m</option>
            <option value="3600" ${cfg.interval==3600?'selected':''}>1h</option>
          </select>
        </div>

        <div class="fp-ctl-group">
          <label>Cluster</label>
          <input type="range" id="fp-cluster" min="1" max="10" step="1"
            value="${cfg.cluster}" style="width:70px;accent-color:var(--accent)">
          <span id="fp-cluster-val" style="color:var(--accent);min-width:28px;font-weight:600">${cfg.cluster}t</span>
        </div>

        <div class="fp-ctl-group">
          <label>Imb%</label>
          <input type="range" id="fp-imb-thr" min="0.5" max="0.95" step="0.01"
            value="${cfg.imbalanceThreshold}" style="width:60px;accent-color:var(--accent)">
          <span id="fp-imb-thr-val" style="color:var(--text);min-width:28px">${Math.round(cfg.imbalanceThreshold*100)}%</span>
        </div>

        <div class="fp-ctl-group">
          <label><input type="checkbox" id="fp-show-vwap" ${cfg.showVWAP?'checked':''}> VWAP</label>
          <label><input type="checkbox" id="fp-show-imb"  ${cfg.showImbalance?'checked':''}> Imb</label>
        </div>

        <div id="fp-status">
          <div class="status-dot" id="fp-dot"></div>
          <span id="fp-status-text">Connecting…</span>
        </div>
      </div>

      <div id="fp-body">
        <div id="fp-main-row">
          <div id="fp-canvas-wrap">
            <canvas id="fp-canvas"></canvas>
            <div id="fp-axis-drag"></div>
            <div id="fp-zoom-hint">↕ drag Y axis</div>
            <div id="fp-alert-strip"></div>
            <div id="fp-overlay">
              Tick: <span id="ov-tick">—</span> &nbsp;
              Cluster: <span id="ov-cluster">${cfg.cluster}</span>t &nbsp;
              Range: ±<span id="ov-range">—</span> &nbsp;
              Candles: <span id="ov-candles">0</span>
            </div>
            <div id="fp-waiting">
              <div class="spinner"></div>
              <span>Waiting for backend…</span>
              <small style="color:var(--faint);font-size:10px">Run: <code style="color:var(--accent)">python backend/server.py</code></small>
            </div>
          </div>
          <div id="fp-vp">
            <canvas id="fp-vp-canvas"></canvas>
            <div id="fp-vp-label">Vol Profile</div>
          </div>
          <div id="fp-imb-bar">
            <div id="fp-imb-fill"></div>
          </div>
        </div>
        <div id="fp-cvd-row">
          <div id="fp-cvd-label">CVD</div>
          <canvas id="fp-cvd-canvas"></canvas>
        </div>
      </div>
    `;

    mainCanvas = document.getElementById('fp-canvas');
    mainCtx    = mainCanvas.getContext('2d');
    mainWrap   = document.getElementById('fp-canvas-wrap');
    cvdCanvas  = document.getElementById('fp-cvd-canvas');
    cvdCtx     = cvdCanvas.getContext('2d');
    vpCanvas   = document.getElementById('fp-vp-canvas');
    vpCtx      = vpCanvas.getContext('2d');

    new ResizeObserver(resize).observe(mainWrap);
    resize();
    startLoop();
    bindAxisDrag();
    bindScrollZoom();
    bindControls();

    BackendWS.on('footprint_update', onFootprintUpdate);
    BackendWS.on('candle_tick',      onCandleTick);
    BackendWS.on('cvd_update',       onCVDUpdate);
    BackendWS.on('imbalance_update', onImbalanceUpdate);
    BackendWS.on('session_update',   onSessionUpdate);
    BackendWS.on('large_trade',      onLargeTrade);
    BackendWS.on('coin_changed',     msg => {
      setEl('fp-coin-badge', msg.coin + '-PERP');
      resetState();
    });
  }

  // ─ Controls ──────────────────────────────────────────────────
  function bindControls() {
    const coinIn = document.getElementById('fp-coin-input');
    coinIn.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
    const applyCoin = () => {
      const c = coinIn.value.trim().toUpperCase() || 'BTC';
      cfg.coin = c;
      localStorage.setItem('fp_coin', c);
      setEl('fp-coin-badge', c + '-PERP');
      BackendWS.send({ type: 'set_coin', coin: c });
    };
    document.getElementById('fp-coin-go').addEventListener('click', applyCoin);
    coinIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyCoin(); });

    document.getElementById('fp-interval').addEventListener('change', e => {
      cfg.interval = parseInt(e.target.value);
      localStorage.setItem('fp_interval', cfg.interval);
      BackendWS.send({ type: 'set_interval', seconds: cfg.interval });
    });

    document.getElementById('fp-cluster').addEventListener('input', e => {
      cfg.cluster = parseInt(e.target.value);
      localStorage.setItem('fp_cluster', cfg.cluster);
      document.getElementById('fp-cluster-val').textContent = cfg.cluster + 't';
      setEl('ov-cluster', cfg.cluster);
      dirty = true;
    });

    document.getElementById('fp-imb-thr').addEventListener('input', e => {
      cfg.imbalanceThreshold = parseFloat(e.target.value);
      localStorage.setItem('fp_imb_thr', cfg.imbalanceThreshold);
      document.getElementById('fp-imb-thr-val').textContent =
        Math.round(cfg.imbalanceThreshold * 100) + '%';
      dirty = true;
    });

    document.getElementById('fp-show-vwap').addEventListener('change', e => {
      cfg.showVWAP = e.target.checked;
      localStorage.setItem('fp_show_vwap', cfg.showVWAP);
      dirty = true;
    });
    document.getElementById('fp-show-imb').addEventListener('change', e => {
      cfg.showImbalance = e.target.checked;
      localStorage.setItem('fp_show_imb', cfg.showImbalance);
      dirty = true;
    });
  }

  // ─ Y-axis drag ───────────────────────────────────────────────
  function bindAxisDrag() {
    const strip = document.getElementById('fp-axis-drag');
    if (!strip) return;
    strip.addEventListener('mousedown', e => {
      e.preventDefault();
      axisDragging   = true;
      axisDragStartY = e.clientY;
      axisDragStartH = windowHalf ?? windowHalfAuto ?? 500;
      strip.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!axisDragging) return;
      const dy   = e.clientY - axisDragStartY;
      const sens = axisDragStartH / 150;
      const newH = Math.max(tickSize ? tickSize * 3 : 1, axisDragStartH + dy * sens);
      windowHalf = newH; userZoomY = true;
      setEl('ov-range', newH.toFixed(newH > 100 ? 0 : 2));
      dirty = true;
    });
    window.addEventListener('mouseup', () => {
      if (!axisDragging) return;
      axisDragging = false;
      document.getElementById('fp-axis-drag')?.classList.remove('dragging');
    });
    strip.addEventListener('dblclick', () => {
      userZoomY = false; windowHalf = windowHalfAuto; dirty = true;
    });
  }

  function bindScrollZoom() {
    if (!mainWrap) return;
    mainWrap.addEventListener('wheel', e => {
      e.preventDefault();
      xZoomMul = Math.max(0.15, Math.min(10, xZoomMul * (e.deltaY > 0 ? 0.9 : 1.1)));
      dirty = true;
    }, { passive: false });
  }

  // ─ Resize ────────────────────────────────────────────────────
  function resize() {
    if (!mainWrap) return;
    W = mainWrap.clientWidth;
    H = mainWrap.clientHeight;
    mainCanvas.width  = W;
    mainCanvas.height = H;
    const cvdRow = document.getElementById('fp-cvd-row');
    if (cvdRow) {
      cvdCanvas.width  = cvdRow.clientWidth - 44;
      cvdCanvas.height = CVD_H;
    }
    if (vpCanvas) {
      vpCanvas.width  = VP_W;
      vpCanvas.height = document.getElementById('fp-vp')?.clientHeight || H;
    }
    dirty = true;
  }

  // ─ Coordinate helpers ────────────────────────────────────────
  function py(price) {
    if (midPrice === null || !windowHalf) return H / 2;
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    return (H - TS_BAR_H) - ((price - lo) / (hi - lo)) * (H - TS_BAR_H);
  }

  function py_vp(price, vH) {
    if (!midPrice || !windowHalf) return vH / 2;
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    return vH - ((price - lo) / (hi - lo)) * vH;
  }

  // ─ WS handlers ───────────────────────────────────────────────
  function onFootprintUpdate(msg) {
    candles = msg.candles || [];
    if (candles.length) {
      midPrice = candles[candles.length - 1].close || candles[candles.length - 1].open;
      autoFitY();
    }
    setEl('ov-candles', candles.length);
    dirty = true;
  }

  function onCandleTick(msg) {
    const c = msg.candle; if (!c) return;
    if (!candles.length) {
      candles.push(c);
    } else {
      const last = candles[candles.length - 1];
      if (last.open_ts === c.open_ts) {
        candles[candles.length - 1] = c;
      } else {
        candles[candles.length - 1].closed = true;
        candles.push(c);
        if (candles.length > 500) candles.shift();
      }
    }
    midPrice = c.close || c.open;
    if (!userZoomY) autoFitY();
    updatePriceDisplay(c);
    dirty = true;
  }

  function onCVDUpdate(msg)       { cvdHistory = msg.cvd_history || []; FP.drawCVD(cvdCtx, cvdCanvas.width, cvdCanvas.height, cvdHistory); }
  function onImbalanceUpdate(msg) { imbalance = msg; updateImbBar(msg.current || 0); dirty = true; }
  function onSessionUpdate(msg)   { session = msg; dirty = true; }

  function onLargeTrade(msg) {
    showLargeTradeAlert(msg);
    if (midPrice === null) return;
    const y = py(msg.price || midPrice);
    if (y < 0 || y > H - TS_BAR_H) return;
    const r = Math.min(cfg.maxBubble, Math.max(5, Math.sqrt(msg.notional / 10000)));
    bubbles.push({ x: Math.floor((W - AXIS_W) * 0.8), y, r, side: msg.side, alpha: 1.0 });
    if (bubbles.length > 300) bubbles.splice(0, bubbles.length - 300);
    dirty = true;
  }

  // ─ Helpers ───────────────────────────────────────────────────
  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  function updatePriceDisplay(c) {
    const p = c.close || c.open;
    setEl('fp-price', p.toFixed(p > 100 ? 1 : 4));
    const badge = document.getElementById('fp-delta-badge');
    if (!badge) return;
    const d = c.delta || 0;
    badge.textContent = 'Δ ' + (d >= 0 ? '+' : '') + d.toFixed(p > 100 ? 2 : 6);
    badge.className   = 'fp-delta-badge ' + (d >= 0 ? 'delta-pos' : 'delta-neg');
  }

  function autoFitY() {
    if (!candles.length || !midPrice) return;
    const prices = candles.slice(-100).flatMap(c => [c.high, c.low]).filter(Boolean);
    if (!prices.length) return;
    const half = Math.max(
      (Math.max(...prices) - Math.min(...prices)) / 2,
      tickSize ? tickSize * 10 : 1
    ) * 1.1;
    windowHalfAuto = half;
    if (!userZoomY) { windowHalf = half; setEl('ov-range', half.toFixed(half > 100 ? 0 : 2)); }
  }

  function updateImbBar(val) {
    const fill = document.getElementById('fp-imb-fill');
    if (!fill) return;
    const pct = Math.abs(val) * 50;
    fill.style.background = val >= 0 ? 'rgba(50,255,100,0.6)' : 'rgba(255,50,50,0.6)';
    if (val >= 0) { fill.style.bottom = '50%'; fill.style.top    = 'auto'; fill.style.height = pct + '%'; }
    else          { fill.style.top    = '50%'; fill.style.bottom = 'auto'; fill.style.height = pct + '%'; }
  }

  function showLargeTradeAlert(msg) {
    const strip = document.getElementById('fp-alert-strip');
    if (!strip) return;
    const badge  = document.createElement('div');
    const isBid  = msg.side === 'B';
    badge.className = 'lt-badge ' + (isBid ? 'lt-bid' : 'lt-ask');
    const usd = msg.notional >= 1e6
      ? (msg.notional / 1e6).toFixed(1) + 'M'
      : (msg.notional / 1e3).toFixed(0) + 'K';
    badge.textContent = (isBid ? '▲ BUY ' : '▼ SELL ') + usd +
      ' @ ' + (msg.price?.toFixed(midPrice > 100 ? 1 : 4) || '?');
    strip.appendChild(badge);
    setTimeout(() => badge.remove(), 6000);
    if (strip.children.length > 6) strip.removeChild(strip.firstChild);
  }

  function resetState() {
    candles = []; session = {}; cvdHistory = [];
    imbalance = { current: 0, history: [] };
    midPrice = null; tickSize = null;
    windowHalf = null; windowHalfAuto = null; userZoomY = false;
    xZoomMul = 1.0; bubbles.length = 0;
    setEl('fp-price','—'); setEl('ov-tick','—'); setEl('ov-range','—'); setEl('ov-candles','0');
  }

  // ─ RAF loop ──────────────────────────────────────────────────
  function startLoop() {
    (function loop() {
      if (dirty) { render(); dirty = false; }
      requestAnimationFrame(loop);
    })();
  }

  // ─ Main render ───────────────────────────────────────────────
  function render() {
    if (!mainCtx || !W || !H || !candles.length || !windowHalf || midPrice === null) return;
    mainCtx.clearRect(0, 0, W, H);

    const CHART_H  = H - TS_BAR_H;
    const HEAT_W   = W - AXIS_W;
    const colPx    = Math.max(12, Math.round(36 * xZoomMul));
    const visCols  = Math.floor(HEAT_W / colPx);
    const startIdx = Math.max(0, candles.length - visCols);

    // Auto-detect tick size once
    if (!tickSize && candles.length) {
      const lvObj = candles[candles.length - 1].levels;
      if (lvObj) {
        const keys = Object.keys(lvObj).map(parseFloat).sort((a, b) => a - b);
        if (keys.length >= 2) {
          const t = keys[1] - keys[0];
          if (t > 0) { tickSize = t; setEl('ov-tick', t.toFixed(t < 10 ? 2 : 1)); }
        }
      }
    }

    const effectiveTick = (tickSize || 1) * cfg.cluster;
    const rowH          = Math.max(2, (CHART_H / (windowHalf * 2)) * effectiveTick);

    // Pass shared context to FP renderer
    const ctx = {
      mainCtx, W, H, CHART_H, HEAT_W, AXIS_W, TS_BAR_H,
      colPx, visCols, startIdx,
      tickSize, effectiveTick, rowH,
      midPrice, windowHalf, session, cfg, candles, bubbles,
      py, py_vp,
      vpCtx, vpCanvas, VP_W,
    };

    FP.render(ctx);

    // Fade bubbles
    if (bubbles.length) dirty = true;
  }

  // ─ Lifecycle ─────────────────────────────────────────────────
  function onShow()         { resize(); dirty = true; }
  function onConnected()    {
    document.getElementById('fp-dot')?.classList.add('live');
    setEl('fp-status-text', 'Live');
    document.getElementById('fp-waiting')?.classList.add('hidden');
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
  }
  function onDisconnected() {
    document.getElementById('fp-dot')?.classList.remove('live');
    setEl('fp-status-text', 'Reconnecting…');
    document.getElementById('fp-waiting')?.classList.remove('hidden');
  }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected, onDisconnected };
})();