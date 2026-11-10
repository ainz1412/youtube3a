// Hàm dùng chung cho trang khách và trang Admin
// Phiên bản giao diện: phải giống APP_VERSION trong src/worker.js
const APP_VERSION = '2026-11-10.1';
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
// opts.isMine(m)   -> tin nhắn của chính mình (hiện bên phải)
// opts.myOwner()   -> mã người dùng hiện tại (để tô cảm xúc mình đã thả)
// opts.onTyping()  -> gọi khi mình đang gõ (đã giới hạn tần suất)
const REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'];

function setupChat(container, getName, getExtra = () => ({}), opts = {}) {
  const msgs = $('.msgs', container);
  const form = $('form', container);
  const input = $('input', form);
  const typingEl = $('.typing', container);
  const isMine = opts.isMine || (() => false);
  const myOwner = opts.myOwner || (() => '');
  let prev = null;          // tin trước đó (để gộp tin liên tiếp của cùng 1 người)
  let lastEl = null;
  let unread = 0, newBtn = null;
  const typers = new Map(); // name -> hết hạn lúc
  const nodes = new Map();  // id tin nhắn -> phần tử
  const byId = new Map();   // id tin nhắn -> dữ liệu
  let replyTo = null;       // tin đang được trả lời

  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const toBottom = () => { msgs.scrollTop = msgs.scrollHeight; };
  const displayName = (m) => (m.host ? 'Admin' : m.name);

  // ----- cảm xúc -----
  function drawReactions(box, m) {
    box.innerHTML = '';
    const r = m.reactions || {};
    const me = myOwner();
    for (const e of REACTIONS) {
      const list = r[e];
      if (!list || !list.length) continue;
      const mineR = list.some((x) => x.owner === me);
      box.append(el('button', {
        type: 'button', class: mineR ? 'mine' : '',
        title: list.map((x) => x.name).join(', ') + ' đã thả ' + e,
        onclick: (ev) => { ev.stopPropagation(); react(m.id, e); },
      }, e, list.length > 1 ? ' ' + list.length : ''));
    }
    box.classList.toggle('hidden', !box.children.length);
  }
  async function react(id, emoji) {
    closePicker();
    try { await api('/api/react', { id, emoji, name: getName(), cid: getClientId(), ...getExtra() }); }
    catch (err) { toast(err.message, true); }
  }
  let picker = null;
  function closePicker() { if (picker) { picker.remove(); picker = null; } }
  function openPicker(anchor, m) {
    closePicker();
    picker = el('div', { class: 'react-picker', role: 'menu' },
      REACTIONS.map((e) => el('button', { type: 'button', title: 'Thả ' + e, onclick: (ev) => { ev.stopPropagation(); react(m.id, e); } }, e)));
    document.body.append(picker);
    const r = anchor.getBoundingClientRect(), pw = picker.offsetWidth, ph = picker.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
    const top = r.top - ph - 8 < 8 ? r.bottom + 8 : r.top - ph - 8;
    picker.style.left = left + 'px'; picker.style.top = top + 'px';
  }
  document.addEventListener('click', (e) => { if (picker && !picker.contains(e.target)) closePicker(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); cancelReply(); } });
  msgs.addEventListener('scroll', closePicker);

  // ----- trả lời -----
  let replyBar = null;
  function startReply(m) {
    replyTo = { id: m.id, name: displayName(m), text: m.text };
    if (!replyBar) {
      replyBar = el('div', { class: 'replying' });
      form.parentNode.insertBefore(replyBar, form);
    }
    replyBar.innerHTML = '';
    replyBar.append(
      el('span', { class: 'rtext' }, 'Đang trả lời ', el('b', {}, replyTo.name), ': ', replyTo.text),
      el('button', { type: 'button', class: 'icon', title: 'Hủy trả lời', onclick: cancelReply }, '✕'));
    input.focus();
  }
  function cancelReply() { replyTo = null; if (replyBar) { replyBar.remove(); replyBar = null; } }
  function jumpTo(id) {
    const n = nodes.get(id);
    if (!n) return toast('Tin gốc đã cũ, không còn trong khung chat');
    n.scrollIntoView({ block: 'center', behavior: 'smooth' });
    n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
  }

  function render(m) {
    if (m.system) { prev = null; return el('div', { class: 'msg sys' }, m.text); }
    const mine = isMine(m);
    const key = m.owner || m.name;
    const grouped = prev && !prev.system && (prev.owner || prev.name) === key && m.t - prev.t < 3 * 60 * 1000;
    prev = m;
    const reactBox = el('div', { class: 'reactions hidden' });
    const node = el('div', { class: 'msg' + (mine ? ' mine' : '') + (m.host ? ' host' : '') + (grouped && !m.reply ? '' : ' gap'), 'data-id': m.id },
      grouped && !m.reply ? null : (m.host ? el('div', { class: 'who' }, '👑 Admin') : el('div', { class: 'who' }, m.name)),
      m.reply ? el('div', { class: 'reply-quote' + (m.reply.host ? ' host-q' : ''), title: 'Xem tin gốc', onclick: () => jumpTo(m.reply.id) },
        '↩ ', el('b', {}, m.reply.name), ': ', m.reply.text) : null,
      el('div', { class: 'brow' },
        el('div', { class: 'bubble' }, m.text),
        el('div', { class: 'msg-actions' },
          el('button', { type: 'button', title: 'Thả cảm xúc', onclick: (ev) => { ev.stopPropagation(); openPicker(ev.currentTarget, m); } }, '☺'),
          el('button', { type: 'button', title: 'Trả lời', onclick: (ev) => { ev.stopPropagation(); startReply(m); } }, '↩'))),
      reactBox,
      el('time', {}, fmtTime(m.t)));
    // Điện thoại không có rê chuột: chạm vào tin để hiện nút
    node.querySelector('.bubble').addEventListener('click', () => {
      const on = !node.classList.contains('show-actions');
      msgs.querySelectorAll('.msg.show-actions').forEach((x) => x.classList.remove('show-actions'));
      node.classList.toggle('show-actions', on);
    });
    drawReactions(reactBox, m);
    return node;
  }

  function add(m, { initial = false } = {}) {
    const stick = initial || nearBottom() || isMine(m);
    if (lastEl) lastEl.classList.remove('last');
    if (prev && !m.system && !m.reply && (prev.owner || prev.name) === (m.owner || m.name) && lastEl) lastEl.querySelector('time')?.remove();
    const node = render(m);
    if (newBtn) msgs.insertBefore(node, newBtn); else msgs.append(node);
    if (!m.system) { node.classList.add('last'); lastEl = node; nodes.set(m.id, node); byId.set(m.id, m); }
    while (msgs.children.length > 200) {
      const f = msgs.firstChild; if (f.dataset && f.dataset.id) { nodes.delete(f.dataset.id); byId.delete(f.dataset.id); } f.remove();
    }
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
    const reply = replyTo;
    input.value = '';
    cancelReply();
    lastTypingSent = 0;
    input.focus();
    try { await api('/api/chat', { name: getName(), text, cid: getClientId(), replyTo: reply ? reply.id : undefined, ...getExtra() }); }
    catch (err) { toast(err.message, true); input.value = text; if (reply) startReply(byId.get(reply.id) || reply); }
  });

  return {
    add: (m) => add(m),
    reset(list) {
      msgs.innerHTML = ''; prev = null; lastEl = null; newBtn = null; unread = 0; nodes.clear(); byId.clear();
      list.forEach((m) => add(m, { initial: true }));
      toBottom();
    },
    typing({ name }) {
      if (!name) return;
      typers.set(name, Date.now() + 4000);
      drawTyping();
    },
    react({ id, reactions }) {
      const m = byId.get(id), n = nodes.get(id);
      if (!m || !n) return;
      m.reactions = reactions;
      const stick = nearBottom();
      drawReactions(n.querySelector('.reactions'), m);
      if (stick) toBottom();
    },
  };
}

// Website vừa được cập nhật mà tab này còn bản cũ -> mời tải lại (không tự tải lại để không ngắt nhạc đang phát)
function showUpdateBar() {
  if ($('#updateBar')) return;
  document.body.append(el('div', { id: 'updateBar', class: 'update-bar' },
    'Website vừa được cập nhật.',
    el('button', { class: 'primary', onclick: () => location.reload() }, 'Tải lại'),
    el('button', { class: 'icon', title: 'Để sau', onclick: () => $('#updateBar').remove() }, '✕')));
}

// Thông báo chạy ngang trên đầu trang
function drawNotice(notice) {
  const box = $('#marquee');
  if (!box) return;
  const text = notice && notice.text ? notice.text : '';
  box.classList.toggle('hidden', !text);
  const track = $('#marqueeTrack');
  if (track.dataset.text === text) return;
  track.dataset.text = text;
  track.textContent = text;
  requestAnimationFrame(() => {
    const dist = box.clientWidth + track.scrollWidth;  // quãng đường chữ chạy (px)
    track.style.setProperty('--dur', Math.max(8, dist / 80) + 's');  // ~80px mỗi giây
    track.style.animation = 'none'; void track.offsetWidth; track.style.animation = '';
  });
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
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'hello') { if (m.data && m.data.version && m.data.version !== APP_VERSION) showUpdateBar(); return; }
        handlers[m.type] && handlers[m.type](m.data);
      } catch (err) {}
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
