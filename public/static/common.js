// Hàm dùng chung cho trang khách và trang Admin
const $ = (s, el = document) => el.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
}

function fmtDur(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
function fmtTime(t) {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

let toastTimer;
function toast(text, isErr = false) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = text;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Lỗi ' + r.status); e.status = r.status; throw e; }
  return j;
}

function getClientId() {
  let id = localStorage.getItem('jb_cid');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('jb_cid', id);
  }
  return id;
}

// Giống hàm sha() trên server: dùng để nhận ra bài nào là của mình
async function ownerHash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function songRow(s, { num, mine, actions = [] } = {}) {
  return el('div', { class: 'song' },
    num != null ? el('div', { class: 'num' }, String(num)) : null,
    el('img', { src: s.thumb || '', alt: '', loading: 'lazy' }),
    el('div', { class: 'meta' },
      el('div', { class: 'title', title: s.title }, s.title),
      el('div', { class: 'sub' },
        s.addedBy ? el('span', { class: 'badge' + (mine ? ' me' : '') }, s.addedBy) : null,
        s.addedBy ? ' ' : null,
        s.channel)),
    el('div', { class: 'dur' }, fmtDur(s.duration)),
    actions.length ? el('div', { class: 'actions' }, actions) : null);
}

// Lấy màu chủ đạo của ảnh bìa để tô nền khung "Đang phát".
// Ảnh được tải riêng (crossOrigin) để không ảnh hưởng ảnh đang hiển thị nếu bị chặn CORS.
const tintCache = new Map();
function artTint(url) {
  if (!url) return Promise.resolve(null);
  if (tintCache.has(url)) return Promise.resolve(tintCache.get(url));
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 14;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0, 24, 14);
        const d = x.getImageData(0, 0, 24, 14).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2];
          const sat = Math.max(R, G, B) - Math.min(R, G, B);
          const lum = (R + G + B) / 3;
          if (lum < 18 || lum > 240) continue;          // bỏ viền đen / trắng
          const w = 1 + sat / 24;                         // ưu tiên màu rực
          r += R * w; g += G * w; b += B * w; n += w;
        }
        if (!n) return resolve(null);
        let rgb = [r / n, g / n, b / n];
        const max = Math.max(...rgb);
        const k = max > 150 ? 150 / max : max < 70 ? 70 / Math.max(max, 1) : 1; // giữ độ sáng vừa phải để chữ trắng dễ đọc
        rgb = rgb.map((v) => Math.round(v * k));
        tintCache.set(url, rgb);
        resolve(rgb);
      } catch (e) { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = url;
  });
}
function applyNowTint(panel, url) {
  artTint(url).then((rgb) => {
    panel.style.setProperty('--np-tint', (rgb || [83, 83, 83]).join(', '));
  });
}

// ---------- Chat thời gian thực ----------
// opts.isMine(m)  -> tin nhắn của chính mình (hiện bên phải)
// opts.onTyping() -> gọi khi mình đang gõ (đã giới hạn tần suất)
function setupChat(container, getName, getExtra = () => ({}), opts = {}) {
  const msgs = $('.msgs', container);
  const form = $('form', container);
  const input = $('input', form);
  const typingEl = $('.typing', container);
  const isMine = opts.isMine || (() => false);
  let prev = null;          // tin trước đó (để gộp tin liên tiếp của cùng 1 người)
  let lastEl = null;
  let unread = 0, newBtn = null;
  const typers = new Map(); // name -> hết hạn lúc

  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const toBottom = () => { msgs.scrollTop = msgs.scrollHeight; };

  function render(m) {
    if (m.system) { prev = null; return el('div', { class: 'msg sys' }, m.text); }
    const mine = isMine(m);
    const key = m.owner || m.name;
    const grouped = prev && !prev.system && (prev.owner || prev.name) === key && m.t - prev.t < 3 * 60 * 1000;
    prev = m;
    return el('div', { class: 'msg' + (mine ? ' mine' : '') + (m.host ? ' host' : '') + (grouped ? '' : ' gap') },
      grouped ? null : (m.host
        ? el('div', { class: 'who' }, '👑 Admin')
        : el('div', { class: 'who' }, m.name)),
      el('div', { class: 'bubble' }, m.text),
      el('time', {}, fmtTime(m.t)));
  }

  function add(m, { initial = false } = {}) {
    const stick = initial || nearBottom() || isMine(m);
    if (lastEl) lastEl.classList.remove('last');
    if (prev && !m.system && (prev.owner || prev.name) === (m.owner || m.name) && lastEl) lastEl.querySelector('time')?.remove();
    const node = render(m);
    if (newBtn) msgs.insertBefore(node, newBtn); else msgs.append(node);
    if (!m.system) { node.classList.add('last'); lastEl = node; }
    while (msgs.children.length > 200) msgs.firstChild.remove();
    if (m.name) { typers.delete(m.name); drawTyping(); }
    if (stick) toBottom();
    else if (!initial) {
      unread++;
      if (!newBtn) { newBtn = el('div', { class: 'newmsg', onclick: () => { toBottom(); } }); msgs.append(newBtn); }
      newBtn.textContent = `⬇ ${unread} tin nhắn mới`;
    }
  }
  msgs.addEventListener('scroll', () => {
    if (newBtn && nearBottom()) { newBtn.remove(); newBtn = null; unread = 0; }
  });

  function drawTyping() {
    if (!typingEl) return;
    const now = Date.now();
    for (const [n, exp] of typers) if (exp < now) typers.delete(n);
    const names = [...typers.keys()];
    typingEl.innerHTML = '';
    if (!names.length) return;
    const who = names.length > 2 ? `${names.slice(0, 2).join(', ')} và ${names.length - 2} người khác` : names.join(' và ');
    typingEl.append(who + ' đang nhập ', el('span', { class: 'dots' }, el('i'), el('i'), el('i')));
  }
  setInterval(drawTyping, 1000);

  let lastTypingSent = 0;
  input.addEventListener('input', () => {
    if (!opts.onTyping || !input.value.trim()) return;
    const now = Date.now();
    if (now - lastTypingSent > 2500) { lastTypingSent = now; opts.onTyping(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    lastTypingSent = 0;
    input.focus();
    try { await api('/api/chat', { name: getName(), text, cid: getClientId(), ...getExtra() }); }
    catch (err) { toast(err.message, true); input.value = text; }
  });

  return {
    add: (m) => add(m),
    reset(list) {
      msgs.innerHTML = ''; prev = null; lastEl = null; newBtn = null; unread = 0;
      list.forEach((m) => add(m, { initial: true }));
      toBottom();
    },
    typing({ name }) {
      if (!name) return;
      typers.set(name, Date.now() + 4000);
      drawTyping();
    },
  };
}

// Kết nối WebSocket thời gian thực, tự nối lại khi rớt mạng
function connectWS(getParams, handlers) {
  let ws, timer, ping, delay = 1000, closed = false;
  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws?` + new URLSearchParams(getParams()));
    ws.onopen = () => {
      delay = 1000;
      handlers.connect && handlers.connect();
      clearInterval(ping);
      ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 30000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try { const m = JSON.parse(e.data); handlers[m.type] && handlers[m.type](m.data); } catch (err) {}
    };
    ws.onclose = () => {
      clearInterval(ping);
      handlers.disconnect && handlers.disconnect();
      if (!closed) { clearTimeout(timer); timer = setTimeout(open, delay); delay = Math.min(delay * 2, 15000); }
    };
  };
  const onVisible = () => {
    if (!closed && document.visibilityState === 'visible' && ws && ws.readyState > 1) { clearTimeout(timer); delay = 1000; open(); }
  };
  document.addEventListener('visibilitychange', onVisible);
  open();
  return {
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(timer); clearInterval(ping); document.removeEventListener('visibilitychange', onVisible); ws && ws.close(); },
  };
}
