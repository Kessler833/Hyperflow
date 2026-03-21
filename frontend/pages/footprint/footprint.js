/* =============================================================
   HYPERFLOW — Footprint Canvas
   ============================================================= */

window.FootprintPage = (() => {

  let cfg = {
    coin:     localStorage.getItem('fp_coin') || 'BTC',
    interval: parseInt(localStorage.getItem('fp_interval') || '60'),
    imbalanceThreshold: parseFloat(localStorage.getItem('fp_imb_thr') || '0.70'),
    showImbalance:   localStorage.getItem('fp_show_imb')  !== 'false',
    showVWAP:        localStorage.getItem('fp_show_vwap') !== 'false',
    showLargeTrades: true,
    maxBubble: 18,
  };

  let candles     = [];
  let session     = {};
  let imbalance   = { current: 0, history: [] };
  let cvdHistory  = [];

  let windowHalf = null, windowHalfAuto = null;
  let userZoomY  = false;
  let midPrice   = null;
  let tickSize   = null;
  let xZoomMul   = 1.0;

  let axisDragging = false, axisDragStartY = 0, axisDragStartH = 0;

  let mainCanvas, mainCtx, mainWrap;
  let cvdCanvas,  cvdCtx;
  let vpCanvas,   vpCtx;
  let W = 0, H = 0;
  const CVD_H = 80, VP_W = 100, TS_BAR_H = 18, AXIS_W = 64;

  let dirty = false;
  const bubbles = [];

  // helper: get total from a plain JSON level object
  function lvTotal(lv) {
    return lv.total !== undefined
      ? lv.total
      : (lv.bid_vol || 0) + (lv.ask_vol || 0);
  }

  // ─ Init ────────────────────────────────────────────────────
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
            <option value="15"   ${cfg.interval==15?'selected':''}>15s</option>
            <option value="60"   ${cfg.interval==60?'selected':''}>1m</option>
            <option value="300"  ${cfg.interval==300?'selected':''}>5m</option>
            <option value="900"  ${cfg.interval==900?'selected':''}>15m</option>
            <option value="1800" ${cfg.interval==1800?'selected':''}>30m</option>
            <option value="3600" ${cfg.interval==3600?'selected':''}>1h</option>
          </select>
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
            <div id="fp-zoom-hint">↕ drag<br>to zoom</div>
            <div id="fp-alert-strip"></div>
            <div id="fp-overlay">
              Tick: <span id="ov-tick">—</span> &nbsp;
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
    const goBtn  = document.getElementById('fp-coin-go');
    coinIn.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
    const applyCoin = () => {
      const c = coinIn.value.trim().toUpperCase() || 'BTC';
      cfg.coin = c;
      localStorage.setItem('fp_coin', c);
      setEl('fp-coin-badge', c + '-PERP');
      BackendWS.send({ type: 'set_coin', coin: c });
    };
    goBtn.addEventListener('click', applyCoin);
    coinIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyCoin(); });

    document.getElementById('fp-interval').addEventListener('change', e => {
      cfg.interval = parseInt(e.target.value);
      localStorage.setItem('fp_interval', cfg.interval);
      BackendWS.send({ type: 'set_interval', seconds: cfg.interval });
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
      xZoomMul = Math.max(0.15, Math.min(10, xZoomMul * (e.deltaY > 0 ? 1.1 : 0.9)));
      dirty = true;
    }, { passive: false });
  }

  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

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

  // ─ Price → Y ─────────────────────────────────────────────────
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

  // ─ Data handlers ─────────────────────────────────────────────
  function onFootprintUpdate(msg) {
    candles = msg.candles || [];
    if (candles.length) {
      const last = candles[candles.length - 1];
      midPrice = last.close || last.open;
      autoFitY();
    }
    setEl('ov-candles', candles.length);
    dirty = true;
  }

  function onCandleTick(msg) {
    const c = msg.candle;
    if (!c) return;
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

  function onCVDUpdate(msg) {
    cvdHistory = msg.cvd_history || [];
    drawCVD();
  }

  function onImbalanceUpdate(msg) {
    imbalance = msg;
    updateImbBar(msg.current || 0);
    dirty = true;
  }

  function onSessionUpdate(msg) {
    session = msg;
    dirty = true;
  }

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

  function updatePriceDisplay(c) {
    const p = c.close || c.open;
    setEl('fp-price', p.toFixed(p > 100 ? 1 : 4));
    const badge = document.getElementById('fp-delta-badge');
    if (badge) {
      const d = c.delta || 0;
      badge.textContent = 'Δ ' + (d >= 0 ? '+' : '') + d.toFixed(p > 100 ? 2 : 6);
      badge.className = 'fp-delta-badge ' + (d >= 0 ? 'delta-pos' : 'delta-neg');
    }
  }

  function autoFitY() {
    if (!candles.length || !midPrice) return;
    const vis    = candles.slice(-100);
    const prices = vis.flatMap(c => [c.high, c.low]).filter(Boolean);
    if (!prices.length) return;
    const lo   = Math.min(...prices);
    const hi   = Math.max(...prices);
    const half = Math.max((hi - lo) / 2, tickSize ? tickSize * 10 : 1) * 1.1;
    windowHalfAuto = half;
    if (!userZoomY) {
      windowHalf = half;
      setEl('ov-range', half.toFixed(half > 100 ? 0 : 2));
    }
  }

  function updateImbBar(val) {
    const fill = document.getElementById('fp-imb-fill');
    if (!fill) return;
    const pct = Math.abs(val) * 50;
    fill.style.background = val >= 0 ? 'rgba(166,227,161,0.6)' : 'rgba(243,139,168,0.6)';
    if (val >= 0) {
      fill.style.bottom = '50%'; fill.style.top  = 'auto'; fill.style.height = pct + '%';
    } else {
      fill.style.top    = '50%'; fill.style.bottom = 'auto'; fill.style.height = pct + '%';
    }
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
    setEl('fp-price','—'); setEl('ov-tick','—');
    setEl('ov-range','—'); setEl('ov-candles','0');
  }

  // ─ Render loop ───────────────────────────────────────────────
  function startLoop() {
    (function loop() { if (dirty) { render(); dirty = false; } requestAnimationFrame(loop); })();
  }

  const fmtTime = ms => {
    const d = new Date(ms);
    return d.getHours().toString().padStart(2,'0') + ':' +
           d.getMinutes().toString().padStart(2,'0') + ':' +
           d.getSeconds().toString().padStart(2,'0');
  };

  // ─ Main render ───────────────────────────────────────────────
  function render() {
    if (!mainCtx || !W || !H) return;
    mainCtx.clearRect(0, 0, W, H);
    if (!candles.length || !windowHalf || midPrice === null) return;

    const CHART_H = H - TS_BAR_H;
    const HEAT_W  = W - AXIS_W;
    const colPx   = Math.max(12, Math.round(36 * xZoomMul));
    const visCols = Math.floor(HEAT_W / colPx);
    const startIdx = Math.max(0, candles.length - visCols);

    // Detect tick size from level keys
    if (!tickSize && candles.length) {
      const lv = candles[candles.length - 1].levels;
      if (lv) {
        const prices = Object.keys(lv).map(parseFloat).sort((a, b) => a - b);
        if (prices.length >= 2) {
          const t = prices[1] - prices[0];
          if (t > 0) { tickSize = t; setEl('ov-tick', t.toFixed(t < 10 ? 2 : 1)); }
        }
      }
    }

    const rowH = tickSize ? Math.max(1, (CHART_H / (windowHalf * 2)) * tickSize) : 4;

    // Grid lines
    mainCtx.strokeStyle = 'rgba(30,30,50,0.45)'; mainCtx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const y = Math.round((i / 10) * CHART_H);
      mainCtx.beginPath(); mainCtx.moveTo(0, y); mainCtx.lineTo(HEAT_W, y); mainCtx.stroke();
    }

    // VWAP line
    if (cfg.showVWAP && session.vwap) {
      const vy = py(session.vwap);
      if (vy >= 0 && vy <= CHART_H) {
        mainCtx.save();
        mainCtx.setLineDash([6, 3]);
        mainCtx.strokeStyle = 'rgba(201,162,234,0.8)'; mainCtx.lineWidth = 1.5;
        mainCtx.beginPath(); mainCtx.moveTo(0, vy); mainCtx.lineTo(HEAT_W, vy); mainCtx.stroke();
        mainCtx.font = '9px Inter,monospace'; mainCtx.fillStyle = 'rgba(201,162,234,0.9)';
        mainCtx.textAlign = 'left';
        mainCtx.fillText('VWAP ' + session.vwap.toFixed(session.vwap > 100 ? 1 : 4), 4, vy - 3);
        mainCtx.setLineDash([]); mainCtx.restore();
      }
    }

    // Session levels
    const drawLevel = (price, label, color) => {
      if (!price) return;
      const y = py(price);
      if (y < 0 || y > CHART_H) return;
      mainCtx.save();
      mainCtx.strokeStyle = color; mainCtx.lineWidth = 1; mainCtx.setLineDash([3, 4]);
      mainCtx.beginPath(); mainCtx.moveTo(0, y); mainCtx.lineTo(HEAT_W, y); mainCtx.stroke();
      mainCtx.setLineDash([]);
      mainCtx.font = '9px Inter,monospace'; mainCtx.fillStyle = color; mainCtx.textAlign = 'left';
      mainCtx.fillText(label + ' ' + price.toFixed(price > 100 ? 1 : 4), 4, y + 9);
      mainCtx.restore();
    };
    drawLevel(session.poc, 'POC', 'rgba(229,192,123,0.8)');
    drawLevel(session.vah, 'VAH', 'rgba(137,220,235,0.6)');
    drawLevel(session.val, 'VAL', 'rgba(137,220,235,0.6)');

    // ── Candles ───────────────────────────────────────────────
    for (let col = 0; col < visCols; col++) {
      const si = startIdx + col;
      if (si >= candles.length) break;
      const candle = candles[si];
      const cx     = col * colPx;
      const levels = candle.levels || {};
      const prices = Object.keys(levels).map(parseFloat).sort((a, b) => a - b);

      if (!prices.length) {
        drawBareCandle(mainCtx, candle, cx, colPx, CHART_H);
        continue;
      }

      const maxTotal = Math.max(...prices.map(p => lvTotal(levels[p])), 1);
      const poc      = candle.poc;

      for (const p of prices) {
        const lv    = levels[p];
        const y     = py(p);
        if (y < 0 || y > CHART_H) continue;
        const total = lvTotal(lv);
        const n     = Math.min(1, total / maxTotal);
        const d     = (lv.delta !== undefined) ? lv.delta : (lv.bid_vol || 0) - (lv.ask_vol || 0);
        const cellW = colPx - 1;
        const cellH = Math.max(2, rowH - 0.5);

        let r, g, b, alpha;
        if (d > 0) {
          r = Math.round(40  + n*126); g = Math.round(150 + n*77); b = Math.round(60 + n*61);
          alpha = 0.18 + n * 0.72;
        } else if (d < 0) {
          r = Math.round(120 + n*123); g = Math.round(30  + n*45); b = Math.round(50 + n*58);
          alpha = 0.18 + n * 0.72;
        } else {
          r=80; g=80; b=100; alpha=0.15;
        }

        mainCtx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
        mainCtx.fillRect(cx, y - cellH/2, cellW, cellH);

        if (String(p) === String(poc) || p === poc) {
          mainCtx.strokeStyle = 'rgba(229,192,123,0.95)'; mainCtx.lineWidth = 1.5;
          mainCtx.strokeRect(cx, y - cellH/2, cellW, cellH);
        }

        if (cfg.showImbalance) {
          const imb = lv.imbalance !== undefined
            ? lv.imbalance
            : (total > 0 ? (lv.bid_vol || 0) / total : 0.5);
          if (imb >= cfg.imbalanceThreshold) {
            mainCtx.strokeStyle = 'rgba(166,227,161,0.9)'; mainCtx.lineWidth = 1;
            mainCtx.beginPath();
            mainCtx.moveTo(cx + cellW - 5, y - cellH/2);
            mainCtx.lineTo(cx + cellW,     y + cellH/2);
            mainCtx.stroke();
          } else if (imb <= (1 - cfg.imbalanceThreshold)) {
            mainCtx.strokeStyle = 'rgba(243,139,168,0.9)'; mainCtx.lineWidth = 1;
            mainCtx.beginPath();
            mainCtx.moveTo(cx + cellW - 5, y + cellH/2);
            mainCtx.lineTo(cx + cellW,     y - cellH/2);
            mainCtx.stroke();
          }
        }

        if (colPx >= 44 && cellH >= 8) {
          const bidStr = (lv.bid_vol||0).toFixed((lv.bid_vol||0) < 10 ? 3 : 1);
          const askStr = (lv.ask_vol||0).toFixed((lv.ask_vol||0) < 10 ? 3 : 1);
          mainCtx.font = '7px Inter,monospace'; mainCtx.fillStyle = 'rgba(205,214,244,0.85)';
          mainCtx.textAlign = 'left';  mainCtx.fillText(bidStr, cx + 2,        y + 3);
          mainCtx.textAlign = 'right'; mainCtx.fillText(askStr, cx + cellW - 2, y + 3);
          mainCtx.textAlign = 'left';
        }
      }

      drawBareCandle(mainCtx, candle, cx, colPx, CHART_H);

      if (colPx >= 30 && candle.delta !== undefined) {
        const topY = py(candle.high) - 10;
        const d    = candle.delta;
        mainCtx.font = '8px Inter,monospace';
        mainCtx.fillStyle = d >= 0 ? 'rgba(166,227,161,0.85)' : 'rgba(243,139,168,0.85)';
        mainCtx.textAlign = 'center';
        mainCtx.fillText((d >= 0 ? '+' : '') + d.toFixed(d < 10 ? 2 : 0), cx + colPx/2, topY);
        mainCtx.textAlign = 'left';
      }
    }

    // Current price line
    const midY = py(midPrice);
    mainCtx.strokeStyle = 'rgba(122,162,247,0.9)'; mainCtx.lineWidth = 1;
    mainCtx.setLineDash([4, 4]);
    mainCtx.beginPath(); mainCtx.moveTo(0, midY); mainCtx.lineTo(HEAT_W, midY);
    mainCtx.stroke(); mainCtx.setLineDash([]);

    // Timestamp bar
    mainCtx.fillStyle = 'rgba(13,13,30,0.9)';
    mainCtx.fillRect(0, CHART_H, HEAT_W, TS_BAR_H);
    mainCtx.beginPath(); mainCtx.strokeStyle = 'rgba(30,30,50,0.8)'; mainCtx.lineWidth = 1;
    mainCtx.moveTo(0, CHART_H); mainCtx.lineTo(HEAT_W, CHART_H); mainCtx.stroke();

    const tsInterval = Math.max(1, Math.round(100 / colPx));
    mainCtx.font = '9px Inter,monospace'; mainCtx.textAlign = 'center';
    mainCtx.fillStyle = 'rgba(108,112,134,0.9)';
    for (let col = 0; col < visCols; col += tsInterval) {
      const si = startIdx + col;
      if (si >= candles.length) break;
      const x = col * colPx + colPx / 2;
      if (x < 20 || x > HEAT_W - 10) continue;
      mainCtx.fillText(fmtTime(candles[si].open_ts * 1000), x, CHART_H + 13);
    }

    // Price axis
    mainCtx.fillStyle = 'rgba(10,10,20,0.85)';
    mainCtx.fillRect(HEAT_W, 0, AXIS_W, H);
    mainCtx.beginPath(); mainCtx.strokeStyle = 'rgba(30,30,50,0.9)'; mainCtx.lineWidth = 1;
    mainCtx.moveTo(HEAT_W, 0); mainCtx.lineTo(HEAT_W, H); mainCtx.stroke();
    const lo    = midPrice - windowHalf;
    const range = windowHalf * 2;
    mainCtx.font = '10px Inter,monospace'; mainCtx.textAlign = 'left';
    for (let i = 0; i <= 12; i++) {
      const price = lo + (range / 12) * i;
      const y     = CHART_H - (i / 12) * CHART_H;
      mainCtx.fillStyle = 'rgba(108,112,134,0.9)';
      mainCtx.fillText(price.toFixed(price > 100 ? 1 : 4), HEAT_W + 4, y + 3);
    }
    mainCtx.fillStyle = 'rgba(122,162,247,1)'; mainCtx.font = '11px Inter,monospace';
    mainCtx.fillText(midPrice.toFixed(midPrice > 100 ? 1 : 4), HEAT_W + 4, midY + 4);

    // Trade bubbles
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i, 1); continue; }
      mainCtx.beginPath(); mainCtx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      const rgb = b.side === 'B' ? '166,227,161' : '243,139,168';
      mainCtx.fillStyle   = `rgba(${rgb},${b.alpha.toFixed(2)})`;
      mainCtx.strokeStyle = `rgba(${rgb},0.9)`;
      mainCtx.lineWidth = 2; mainCtx.fill(); mainCtx.stroke();
      b.alpha -= 0.004;
    }
    if (bubbles.length) dirty = true;

    drawVolumeProfile(startIdx, visCols, CHART_H);
  }

  function drawBareCandle(ctx, c, cx, colPx, CHART_H) {
    if (!c.open) return;
    const x     = cx + colPx / 2;
    const bodyT = py(Math.max(c.open, c.close));
    const bodyB = py(Math.min(c.open, c.close));
    const wickT = py(c.high);
    const wickB = py(c.low);
    const col   = c.close >= c.open ? 'rgba(166,227,161,0.6)' : 'rgba(243,139,168,0.6)';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, wickT); ctx.lineTo(x, wickB); ctx.stroke();
    ctx.strokeRect(cx + 1, bodyT, colPx - 3, Math.max(1, bodyB - bodyT));
  }

  function drawVolumeProfile(startIdx, visCols, CHART_H) {
    if (!vpCtx || !midPrice || !windowHalf) return;
    const vH = vpCanvas.height;
    vpCtx.clearRect(0, 0, VP_W, vH);
    const volMap = {};
    for (let col = 0; col < visCols; col++) {
      const si = startIdx + col;
      if (si >= candles.length) break;
      const lv = candles[si].levels || {};
      for (const [p, l] of Object.entries(lv)) {
        volMap[p] = (volMap[p] || 0) + lvTotal(l);   // ← uses lvTotal()
      }
    }
    const prices = Object.keys(volMap).map(parseFloat).sort((a, b) => a - b);
    const maxVol = Math.max(...Object.values(volMap), 1);
    const rh     = tickSize ? Math.max(1, (vH / (windowHalf * 2)) * tickSize) : 4;
    for (const p of prices) {
      const y = py_vp(p, vH);
      if (y < 0 || y > vH) continue;
      const w = Math.floor((volMap[p] / maxVol) * (VP_W - 4));
      vpCtx.fillStyle = 'rgba(122,162,247,0.35)';
      vpCtx.fillRect(0, y - rh/2, w, Math.max(1, rh - 0.5));
      if (session.poc && Math.abs(p - session.poc) < (tickSize || 0.01)) {
        vpCtx.fillStyle = 'rgba(229,192,123,0.7)';
        vpCtx.fillRect(w, y - rh/2, 3, Math.max(1, rh - 0.5));
      }
    }
  }

  function drawCVD() {
    if (!cvdCtx) return;
    const cW = cvdCanvas.width, cH = cvdCanvas.height;
    if (!cW || !cH || cvdHistory.length < 2) return;
    cvdCtx.clearRect(0, 0, cW, cH);
    const data  = cvdHistory;
    const min   = Math.min(...data);
    const max   = Math.max(...data);
    const range = max - min || 1;
    const xStep = cW / (data.length - 1);

    cvdCtx.beginPath();
    data.forEach((v, i) => {
      const x = i * xStep, y = cH - ((v - min) / range) * (cH - 4) - 2;
      i === 0 ? cvdCtx.moveTo(x, y) : cvdCtx.lineTo(x, y);
    });
    cvdCtx.lineTo(cW, cH); cvdCtx.lineTo(0, cH); cvdCtx.closePath();
    const lv = data[data.length - 1];
    const gr = cvdCtx.createLinearGradient(0, 0, 0, cH);
    if (lv >= 0) {
      gr.addColorStop(0, 'rgba(166,227,161,0.3)'); gr.addColorStop(1, 'rgba(166,227,161,0.02)');
    } else {
      gr.addColorStop(0, 'rgba(243,139,168,0.02)'); gr.addColorStop(1, 'rgba(243,139,168,0.3)');
    }
    cvdCtx.fillStyle = gr; cvdCtx.fill();

    cvdCtx.beginPath();
    data.forEach((v, i) => {
      const x = i * xStep, y = cH - ((v - min) / range) * (cH - 4) - 2;
      i === 0 ? cvdCtx.moveTo(x, y) : cvdCtx.lineTo(x, y);
    });
    cvdCtx.strokeStyle = lv >= 0 ? 'rgba(166,227,161,0.9)' : 'rgba(243,139,168,0.9)';
    cvdCtx.lineWidth = 1.5; cvdCtx.stroke();

    if (min < 0 && max > 0) {
      const zy = cH - ((0 - min) / range) * (cH - 4) - 2;
      cvdCtx.strokeStyle = 'rgba(108,112,134,0.4)'; cvdCtx.lineWidth = 1;
      cvdCtx.setLineDash([3, 3]);
      cvdCtx.beginPath(); cvdCtx.moveTo(0, zy); cvdCtx.lineTo(cW, zy);
      cvdCtx.stroke(); cvdCtx.setLineDash([]);
    }

    cvdCtx.font = '9px Inter,monospace'; cvdCtx.fillStyle = 'rgba(108,112,134,0.9)';
    cvdCtx.textAlign = 'right';
    cvdCtx.fillText(lv.toFixed(3), cW - 4, 10);
    cvdCtx.textAlign = 'left';
  }

  // ─ Public ──────────────────────────────────────────────────
  function onShow() { resize(); dirty = true; }

  function onConnected() {
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