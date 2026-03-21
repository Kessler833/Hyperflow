window.SessionPage = (() => {
  let sess = {};

  function init() {
    const page = document.getElementById('page-session');
    page.innerHTML = `
      <div id="session-header">
        <span style="color:var(--accent);font-weight:700">Session Stats</span>
        <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
          <div class="status-dot" id="sess-dot"></div>
          <span id="sess-status" style="color:var(--muted);font-size:11px">Connecting…</span>
        </div>
      </div>
      <div id="session-wrap">
        <div id="sess-stats-grid">
          <div class="s-stat"><div class="s-stat-label">VWAP</div>
            <div class="s-stat-value" id="s-vwap" style="color:var(--purple)">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Session Volume</div>
            <div class="s-stat-value" id="s-vol">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Session Delta</div>
            <div class="s-stat-value" id="s-delta">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Open Interest</div>
            <div class="s-stat-value" id="s-oi">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Funding Rate</div>
            <div class="s-stat-value" id="s-fr">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Session High</div>
            <div class="s-stat-value" id="s-high" style="color:var(--green)">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Session Low</div>
            <div class="s-stat-value" id="s-low" style="color:var(--red)">—</div></div>
          <div class="s-stat"><div class="s-stat-label">Session Open</div>
            <div class="s-stat-value" id="s-open">—</div></div>
        </div>
        <div class="sess-card">
          <div class="sess-card-title">Value Area (70%)</div>
          <div id="va-bar-wrap">
            <div id="va-bar-bg">
              <div id="va-bar-fill"></div>
              <div id="va-poc-marker" class="va-poc-marker"></div>
            </div>
            <div class="va-label">
              <span id="va-low-label">VAL —</span>
              <span id="va-range-label">—</span>
              <span id="va-high-label">VAH —</span>
            </div>
          </div>
        </div>
        <div class="sess-card">
          <div class="sess-card-title">Key Levels</div>
          <table id="sess-levels-table">
            <thead><tr><th>Level</th><th>Price</th><th>Note</th></tr></thead>
            <tbody id="sess-levels-body"></tbody>
          </table>
        </div>
      </div>
    `;

    BackendWS.on('session_update', onSession);
    BackendWS.on('meta_update',    onMeta);
  }

  function onSession(msg) {
    sess = msg;
    const p  = msg.close || msg.vwap || 0;
    const dp = p > 100 ? 1 : 4;
    const fmt = v => v != null ? v.toFixed(dp) : '—';

    setEl('s-vwap', fmt(msg.vwap));
    setEl('s-vol',  fmtVol(msg.volume));
    setEl('s-high', fmt(msg.high));
    setEl('s-low',  fmt(msg.low));
    setEl('s-open', fmt(msg.open));

    const d   = msg.delta || 0;
    const dEl = document.getElementById('s-delta');
    if (dEl) { dEl.textContent = (d>=0?'+':'')+d.toFixed(2); dEl.style.color = d>=0?'#a6e3a1':'#f38ba8'; }

    if (msg.open_interest) setEl('s-oi', fmtVol(msg.open_interest));
    if (msg.funding_rate != null) updateFR(msg.funding_rate);

    updateValueAreaBar(msg);
    updateLevelsTable(msg);
  }

  function onMeta(msg) {
    if (msg.open_interest) setEl('s-oi', fmtVol(msg.open_interest));
    if (msg.funding_rate != null) updateFR(msg.funding_rate);
  }

  function updateFR(fr) {
    const el = document.getElementById('s-fr');
    if (!el) return;
    el.textContent = (fr >= 0 ? '+' : '') + (fr * 100).toFixed(4) + '%';
    el.style.color = fr >= 0 ? '#a6e3a1' : '#f38ba8';
  }

  function updateValueAreaBar(msg) {
    const { vah, val, poc, high: hi, low: lo } = msg;
    if (!hi || !lo || hi === lo) return;
    const range  = hi - lo;
    const fillEl = document.getElementById('va-bar-fill');
    const pocEl  = document.getElementById('va-poc-marker');
    if (fillEl && vah && val) {
      fillEl.style.left  = ((val - lo) / range * 100).toFixed(1) + '%';
      fillEl.style.width = ((vah - val) / range * 100).toFixed(1) + '%';
    }
    if (pocEl && poc) pocEl.style.left = ((poc - lo) / range * 100).toFixed(1) + '%';
    const dp = hi > 100 ? 1 : 4;
    setEl('va-high-label', 'VAH ' + (vah?.toFixed(dp) || '—'));
    setEl('va-low-label',  'VAL ' + (val?.toFixed(dp) || '—'));
    setEl('va-range-label','POC ' + (poc?.toFixed(dp) || '—'));
  }

  function updateLevelsTable(msg) {
    const tbody = document.getElementById('sess-levels-body');
    if (!tbody) return;
    const dp = (msg.close || msg.vwap || 0) > 100 ? 1 : 4;
    const rows = [
      { cls:'vah-row',  label:'VAH',  price: msg.vah,  note:'Value Area High (70%)' },
      { cls:'poc-row',  label:'POC',  price: msg.poc,  note:'Point of Control' },
      { cls:'vwap-row', label:'VWAP', price: msg.vwap, note:'Volume Weighted Average Price' },
      { cls:'val-row',  label:'VAL',  price: msg.val,  note:'Value Area Low (70%)' },
    ];
    tbody.innerHTML = rows.map(r => `
      <tr class="${r.cls}">
        <td>${r.label}</td>
        <td>${r.price != null ? r.price.toFixed(dp) : '—'}</td>
        <td style="color:var(--faint);font-size:11px">${r.note}</td>
      </tr>`).join('');
  }

  function fmtVol(v) {
    if (!v) return '—';
    if (v >= 1e9) return (v/1e9).toFixed(2)+'B';
    if (v >= 1e6) return (v/1e6).toFixed(2)+'M';
    if (v >= 1e3) return (v/1e3).toFixed(1)+'K';
    return v.toFixed(2);
  }

  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  function onShow() {}
  function onConnected() {
    document.getElementById('sess-dot')?.classList.add('live');
    setEl('sess-status', 'Live');
  }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected };
})();