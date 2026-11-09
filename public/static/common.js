// Hàm dùng chung cho trang khách và trang máy phát
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
        fmtDur(s.duration), ' · ', s.channel,
        s.addedBy ? ' · ' : null,
        s.addedBy ? el('span', { class: 'badge' + (mine ? ' me' : '') }, s.addedBy) : null)),
    actions.length ? el('div', { class: 'actions' }, actions) : null);
}

function renderChatMsg(m) {
  if (m.system) return el('div', { class: 'msg sys' }, m.text);
  return el('div', { class: 'msg' + (m.host ? ' host' : '') },
    el('b', {}, m.name + (m.host ? ' (DJ)' : '')), ': ', m.text, el('time', {}, fmtTime(m.t)));
}

// getExtra() trả về các trường gửi kèm (mã phòng / mật khẩu chủ phòng)
function setupChat(container, getName, getExtra = () => ({})) {
  const msgs = $('.msgs', container);
  const form = $('form', container);
  const input = $('input', form);
  const add = (m) => {
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
    msgs.append(renderChatMsg(m));
    while (msgs.children.length > 150) msgs.firstChild.remove();
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await api('/api/chat', { name: getName(), text, cid: getClientId(), ...getExtra() }); }
    catch (err) { toast(err.message, true); input.value = text; }
  });
  return {
    add,
    reset(list) { msgs.innerHTML = ''; list.forEach(add); msgs.scrollTop = msgs.scrollHeight; },
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
    close() { closed = true; clearTimeout(timer); clearInterval(ping); document.removeEventListener('visibilitychange', onVisible); ws && ws.close(); },
  };
}
