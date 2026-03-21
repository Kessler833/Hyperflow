// ── Router ────────────────────────────────────────────────────────────────
const pages = ['footprint', 'delta', 'session'];

function showPage(name) {
  pages.forEach(p => {
    document.getElementById('page-' + p)?.classList.toggle('active', p === name);
    document.querySelector('.nav-item[data-page="' + p + '"]')?.classList.toggle('active', p === name);
  });
  if (name === 'footprint' && window.FootprintPage) FootprintPage.onShow();
  if (name === 'delta'     && window.DeltaPage)     DeltaPage.onShow();
  if (name === 'session'   && window.SessionPage)   SessionPage.onShow();
}

document.querySelectorAll('.nav-item[data-page]').forEach(el => {
  el.addEventListener('click', () => showPage(el.dataset.page));
});

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const WS_URL = 'ws://127.0.0.1:8766/ws';
let _ws             = null;
let _reconnectTimer = null;
let _sendQueue      = [];

window.BackendWS = {
  handlers: {},
  on(type, fn) { this.handlers[type] = fn; },
  send(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(obj));
    } else {
      _sendQueue.push(obj);
    }
  }
};

function connectBackend() {
  _ws = new WebSocket(WS_URL);
  _ws.onopen = () => {
    console.log('[WS] connected');
    while (_sendQueue.length) _ws.send(JSON.stringify(_sendQueue.shift()));
    if (window.FootprintPage) FootprintPage.onConnected();
    if (window.DeltaPage)     DeltaPage.onConnected();
    if (window.SessionPage)   SessionPage.onConnected();
  };
  _ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      const h   = BackendWS.handlers[msg.type];
      if (h) h(msg);
    } catch(e) {}
  };
  _ws.onclose = () => {
    console.warn('[WS] disconnected, retry in 2s');
    if (window.FootprintPage) FootprintPage.onDisconnected();
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connectBackend, 2000);
  };
  _ws.onerror = () => _ws.close();
}

document.addEventListener('DOMContentLoaded', () => {
  showPage('footprint');
  connectBackend();
});