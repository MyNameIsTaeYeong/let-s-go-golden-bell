// 공통 유틸 (Socket.IO 클라이언트는 각 페이지에서 /socket.io/socket.io.js 로 로드)

function connect() {
  // socket.io 글로벌(io)은 페이지에서 스크립트 태그로 로드됨
  return io();
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v != null) {
      node.setAttribute(k, v);
    }
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', { class: 'toast' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// 타이머 바 갱신 (timerEndsAt, timeLimitSec 기반)
function startTimerBar(barEl, labelEl, endsAt, limitSec) {
  if (!barEl) return null;
  function tick() {
    const remain = Math.max(0, endsAt - Date.now());
    const pct = limitSec > 0 ? (remain / (limitSec * 1000)) * 100 : 0;
    barEl.style.width = pct + '%';
    barEl.classList.toggle('low', pct < 30);
    if (labelEl) labelEl.textContent = Math.ceil(remain / 1000) + '초';
    if (remain <= 0) { clearInterval(handle); }
  }
  tick();
  const handle = setInterval(tick, 250);
  return handle;
}
