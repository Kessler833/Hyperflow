window.DeltaPage = (() => {
  let cvdData      = [];
  let candleDeltas = [];
  let divergence   = 'none';
  let imbHistory   = [];
  let largeTrades  = [];
  const MAX_LT = 50;

  function init() {
    const page = document.getElementById('page-delta');
    page.innerHTML = `
      <div id="delta-wrap">
        <div id="delta-header">
          <span style="color:var(--accent);font-weight:700">Delta / CVD</span>
          <span id="delta-div-badge" class="tag tag-none">No Divergence</span>
          <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
            <div class="status-dot" id="delta-dot"></div>
            <span id="delta-status" style="color:var(--muted);font-size:11px">Connecting…</span>
          </div>
        </div>
        <div id="delta-body">
          <div id="delta-stats-grid">
            <div class="d-stat"><div class="d-stat-label">CVD</div>
              <div class="d-stat-value" id="d-cvd">—</div></div>
            <div class="d-stat"><div class="d-stat-label">Last Candle Δ</div>
              <div class="d-stat-value" id="d-last-delta">—</div></div>
            <div class="d-stat"><div class="d-stat-label">OB Imbalance</div>
              <div class="d-stat-value" id="d-imb">—</div></div>
            <div class="d-stat"><div class="d-stat-label">Divergence</div>
              <div class="d-stat-value" id="d-div-text">—</div></div>
          </div>
          <div class="delta-card">
            <div class="delta-card-title">
              Cumulative Volume Delta (CVD)
              <span id="div-tag" class="tag tag-none">—</span>
            </div>
            <div class="delta-chart-wrap">
              <canvas id="cvd-big-chart" height="120"></canvas>
            </div>
          </div>
          <div class="delta-card">
            <div class="delta-card-title">Per-Candle Delta Histogram</div>
            <div class="delta-chart-wrap">
              <canvas id="delta-hist-chart" height="90"></canvas>
            </div>
          </div>
          <div class="delta-card">
            <div class="delta-card-title">Order Book Imbalance History</div>
            <div id="imb-chart-wrap">
              <canvas id="imb-chart" height="70"></canvas>
            </div>
          </div>
          <div class="delta-card">
            <div class="delta-card-title">Large Trades ( ≥ $50K )</div>
            <table id="lt-table">
              <thead>
                <tr><th>Side</th><th>Price</th><th>Qty</th><th>Notional</th><th>Time</th></tr>
              </thead>
              <tbody id="lt-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    BackendWS.on('cvd_update',       onCVD);
    BackendWS.on('imbalance_update', onImbalance);
    BackendWS.on('large_trade',      onLT);
  }

  function onCVD(msg) {
    cvdData      = msg.cvd_history   || [];
    candleDeltas = msg.candle_deltas || [];
    divergence   = msg.divergence    || 'none';

    const cvdVal = cvdData.length      ? cvdData[cvdData.length - 1]           : 0;
    const lastD  = candleDeltas.length ? candleDeltas[candleDeltas.length - 1] : 0;

    setEl('d-cvd',        fmtD(cvdVal));
    setEl('d-last-delta', fmtD(lastD));
    setEl('d-div-text',   divergence === 'bull' ? '🟢 Bullish'
                        : divergence === 'bear' ? '🔴 Bearish' : '—');

    const badge = document.getElementById('delta-div-badge');
    const tag2  = document.getElementById('div-tag');
    if (badge) {
      badge.textContent = divergence === 'bull' ? '🟢 Bull Divergence'
                        : divergence === 'bear' ? '🔴 Bear Divergence'
                        : 'No Divergence';
      badge.className = 'tag ' + (divergence === 'bull' ? 'tag-bull'
                                : divergence === 'bear' ? 'tag-bear' : 'tag-none');
    }
    if (tag2) {
      tag2.textContent = divergence === 'bull' ? 'Bull Div'
                       : divergence === 'bear' ? 'Bear Div' : 'None';
      tag2.className = 'tag ' + (divergence === 'bull' ? 'tag-bull'
                               : divergence === 'bear' ? 'tag-bear' : 'tag-none');
    }

    const cvdEl = document.getElementById('d-cvd');
    if (cvdEl) cvdEl.style.color = cvdVal >= 0 ? '#a6e3a1' : '#f38ba8';
    const ldEl = document.getElementById('d-last-delta');
    if (ldEl) ldEl.style.color = lastD >= 0 ? '#a6e3a1' : '#f38ba8';

    drawCVDBig();
    drawDeltaHist();
  }

  function onImbalance(msg) {
    imbHistory = msg.history || [];
    const cur  = msg.current || 0;
    const el   = document.getElementById('d-imb');
    if (el) {
      el.textContent = (cur >= 0 ? '+' : '') + (cur * 100).toFixed(1) + '%';
      el.style.color = cur >= 0 ? '#a6e3a1' : '#f38ba8';
    }
    drawImbChart();
  }

  function onLT(msg) {
    largeTrades.unshift(msg);
    if (largeTrades.length > MAX_LT) largeTrades.length = MAX_LT;
    renderLTTable();
  }

  function renderLTTable() {
    const tbody = document.getElementById('lt-tbody');
    if (!tbody) return;
    tbody.innerHTML = largeTrades.map(t => {
      const isBid = t.side === 'B';
      const usd = t.notional >= 1e6
        ? (t.notional/1e6).toFixed(2)+'M'
        : (t.notional/1e3).toFixed(1)+'K';
      const ts = new Date(t.ts * 1000).toLocaleTimeString();
      return `<tr class="${isBid ? 'lt-bid-row' : 'lt-ask-row'}">
        <td>${isBid ? '▲ BUY' : '▼ SELL'}</td>
        <td>${t.price?.toFixed(t.price > 100 ? 1 : 4)}</td>
        <td>${t.qty?.toFixed(4)}</td>
        <td>$${usd}</td>
        <td>${ts}</td>
      </tr>`;
    }).join('');
  }

  function drawCVDBig() {
    const cv = document.getElementById('cvd-big-chart');
    if (!cv || cvdData.length < 2) return;
    const ctx = cv.getContext('2d');
    const w = cv.offsetWidth || cv.width;
    cv.width = w;
    lineChart(ctx, cvdData, w, cv.height, true);
  }

  function drawDeltaHist() {
    const cv = document.getElementById('delta-hist-chart');
    if (!cv || !candleDeltas.length) return;
    const ctx = cv.getContext('2d');
    const w = cv.offsetWidth || cv.width;
    const h = cv.height;
    cv.width = w; ctx.clearRect(0, 0, w, h);
    const data   = candleDeltas.slice(-120);
    const maxAbs = Math.max(...data.map(Math.abs), 1);
    const barW   = Math.max(1, w / data.length - 1);
    const midY   = h / 2;
    data.forEach((v, i) => {
      const x  = i * (w / data.length);
      const bh = (Math.abs(v) / maxAbs) * (h / 2 - 2);
      ctx.fillStyle = v >= 0 ? 'rgba(166,227,161,0.7)' : 'rgba(243,139,168,0.7)';
      if (v >= 0) ctx.fillRect(x, midY - bh, barW, bh);
      else        ctx.fillRect(x, midY,      barW, bh);
    });
    ctx.strokeStyle = 'rgba(108,112,134,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();
  }

  function drawImbChart() {
    const cv = document.getElementById('imb-chart');
    if (!cv || imbHistory.length < 2) return;
    const ctx = cv.getContext('2d');
    const w = cv.offsetWidth || cv.width;
    const h = cv.height;
    cv.width = w; ctx.clearRect(0, 0, w, h);
    const data  = imbHistory.slice(-200);
    const xStep = w / (data.length - 1);
    const midY  = h / 2;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i*xStep, y = midY - v*(h/2-2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(w, midY); ctx.lineTo(0, midY); ctx.closePath();
    ctx.fillStyle = 'rgba(122,162,247,0.15)'; ctx.fill();
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i*xStep, y = midY - v*(h/2-2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(122,162,247,0.8)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(108,112,134,0.3)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY);
    ctx.stroke(); ctx.setLineDash([]);
  }

  function lineChart(ctx, data, w, h, fill = false) {
    ctx.clearRect(0, 0, w, h);
    const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
    const xStep = w / (data.length - 1);
    if (fill) {
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = i*xStep, y = h - ((v-min)/range)*(h-4) - 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      const lv = data[data.length-1];
      const gr = ctx.createLinearGradient(0, 0, 0, h);
      if (lv >= 0) { gr.addColorStop(0,'rgba(166,227,161,0.25)'); gr.addColorStop(1,'rgba(166,227,161,0.02)'); }
      else         { gr.addColorStop(0,'rgba(243,139,168,0.02)'); gr.addColorStop(1,'rgba(243,139,168,0.25)'); }
      ctx.fillStyle = gr; ctx.fill();
    }
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i*xStep, y = h - ((v-min)/range)*(h-4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    const lv = data[data.length-1];
    ctx.strokeStyle = lv >= 0 ? 'rgba(166,227,161,0.9)' : 'rgba(243,139,168,0.9)';
    ctx.lineWidth = 1.5; ctx.stroke();
    if (min < 0 && max > 0) {
      const zy = h - ((0-min)/range)*(h-4) - 2;
      ctx.strokeStyle = 'rgba(108,112,134,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(w, zy); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  const fmtD  = v => (v >= 0 ? '+' : '') + v.toFixed(4);
  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  function onShow() { drawCVDBig(); drawDeltaHist(); drawImbChart(); }
  function onConnected() {
    document.getElementById('delta-dot')?.classList.add('live');
    setEl('delta-status', 'Live');
  }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected };
})();