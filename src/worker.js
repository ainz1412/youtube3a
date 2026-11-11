// Chillwith3A – bản chạy trên Cloudflare Workers + Durable Objects
// - Trang tĩnh trong /public do Cloudflare phục vụ trực tiếp
// - Mọi /api/* đi vào 1 Durable Object "Room" (giữ hàng chờ, chat, WebSocket)

import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.ROOM.get(env.ROOM.idFromName('main'));
      return stub.fetch(request);
    }
    return new Response('Không tìm thấy trang', { status: 404 });
  },
};

// ---------- Tiện ích ----------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24);
// Lời nhắn kèm bài: chạy trên đầu trang trong lúc bài đó phát
const cleanNote = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 120);

function extractVideoId(input) {
  input = String(input || '').trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') { const id = u.pathname.slice(1, 12); return /^[\w-]{11}$/.test(id) ? id : null; }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}/.test(v)) return v.slice(0, 11);
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch (e) {}
  return null;
}

function parseISODuration(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const decodeEntities = (s) => String(s || '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Hạn mức YouTube API reset lúc 0h giờ Thái Bình Dương (America/Los_Angeles)
function ptInfo(now = Date.now()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    const secs = (+parts.hour % 24) * 3600 + +parts.minute * 60 + +parts.second;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, resetAt: now + (86400 - secs) * 1000 };
  } catch (e) {
    const d = new Date(now - 8 * 3600e3);
    const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    return { day: d.toISOString().slice(0, 10), resetAt: now + (86400 - secs) * 1000 };
  }
}
const SEARCH_EXHAUSTED_MSG = 'Hôm nay đã hết lượt tìm kiếm YouTube. Bạn vẫn thêm được bài bằng cách dán link YouTube.';
const VIDEO_UNITS_PER_DAY = 10000;
const REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'];
// Phiên bản giao diện: tăng mỗi lần cập nhật để tab cũ hiện nút "Tải lại" (phải giống APP_VERSION trong common.js)
const APP_VERSION = '2026-11-11.5';
// Dữ liệu lấy từ YouTube API (tên bài, ảnh bìa…) trong chat và lịch sử được xóa sau tối đa 30 ngày
const RETENTION_MS = 30 * 24 * 3600e3;

// ---------- Phòng nhạc ----------
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = { nowPlaying: null, queue: [], history: [], paused: false };
    this.chat = [];
    this.searchCache = new Map();
    this.rate = new Map();
    this.typingAt = new WeakMap();
    this.usage = null;        // { day, keys: { [keyId]: { search, videos, exhausted, lastError, lastOk } } }
    this.usageHist = [];      // [{ day, search, videos }] các ngày trước
    this.keyOverride = '';    // key do Admin đặt trên trang /admin (ưu tiên hơn Cloudflare Secret)
    this.cfgOverride = {};
    this.kid = 'none';
    this.speaker = null;      // { id, label, since }: thiết bị Admin đang phát nhạc ra loa
    this.notice = null;       // { text, at }: thông báo chạy ngang trên đầu trang
    this.player = null;       // trạng thái trình phát do máy phát báo về: { paused, volume, t, d, at }
    ctx.blockConcurrencyWhile(async () => {
      const m = await ctx.storage.get(['state', 'chat', 'usage', 'usageHist', 'apiKeyOverride', 'cfgOverride', 'speaker', 'notice']);
      const s = m.get('state'), c = m.get('chat');
      if (s) Object.assign(this.state, s);
      if (Array.isArray(c)) this.chat = c;
      this.usage = m.get('usage') || null;
      this.usageHist = m.get('usageHist') || [];
      this.keyOverride = m.get('apiKeyOverride') || '';
      this.cfgOverride = m.get('cfgOverride') || {};
      this.speaker = m.get('speaker') || null;
      this.notice = m.get('notice') || null;
      this.prune();
      await this.refreshKeyId();
    });
    // Trả lời "ping" mà không cần đánh thức Durable Object (tiết kiệm hạn mức miễn phí)
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }

  get cfg() {
    const e = this.env;
    const int = (v, d) => { const n = parseInt(v ?? d, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
    return {
      apiKey: this.keyOverride || e.YOUTUBE_API_KEY || '',
      hostPw: e.HOST_PASSWORD || '',
      pin: String(e.ROOM_PIN || '').trim(),
      maxSongs: int(e.MAX_SONGS_PER_USER, '3'),
      maxDur: int(e.MAX_DURATION_MIN, '15'),
      maxSearch: Number.isFinite(this.cfgOverride.maxSearch) ? this.cfgOverride.maxSearch : int(e.MAX_SEARCHES_PER_DAY, '100'),
    };
  }

  // Giới hạn tần suất đơn giản trong bộ nhớ. Trả về true nếu VƯỢT giới hạn.
  limited(key, max, windowMs) {
    const now = Date.now();
    const arr = (this.rate.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this.rate.set(key, arr); return true; }
    arr.push(now);
    this.rate.set(key, arr);
    if (this.rate.size > 2000) this.rate.delete(this.rate.keys().next().value);
    return false;
  }

  isHost(pw) { const h = this.cfg.hostPw; return !!h && typeof pw === 'string' && pw === h; }
  pinOk(pin, pw) { const p = this.cfg.pin; return !p || String(pin || '').trim() === p || this.isHost(pw); }

  // ----- phát sóng -----
  publicState(exclude) {
    const online = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      let a = null;
      try { a = ws.deserializeAttachment(); } catch (e) {}
      if (a && a.name && !a.isHost && !online.includes(a.name)) online.push(a.name);
    }
    const c = this.cfg;
    return {
      nowPlaying: this.state.nowPlaying,
      queue: this.state.queue,
      history: this.state.history.slice(0, 10),
      paused: this.state.paused,
      online,
      limits: { maxSongsPerUser: c.maxSongs, maxDurationMin: c.maxDur },
      search: this.searchInfo(),
      notice: this.notice,
    };
  }

  // ----- Theo dõi hạn mức YouTube API -----
  async refreshKeyId() { this.kid = this.cfg.apiKey ? await sha('key:' + this.cfg.apiKey) : 'none'; }
  curUsage() {
    const { day } = ptInfo();
    if (!this.usage || this.usage.day !== day) {
      if (this.usage) {
        const tot = Object.values(this.usage.keys || {}).reduce((a, k) => ({ search: a.search + (k.search || 0), videos: a.videos + (k.videos || 0) }), { search: 0, videos: 0 });
        this.usageHist = [{ day: this.usage.day, ...tot }, ...this.usageHist.filter((h) => h.day !== this.usage.day)].slice(0, 14);
        this.ctx.storage.put('usageHist', this.usageHist);
      }
      this.usage = { day, keys: {} };
    }
    if (!this.usage.keys[this.kid]) this.usage.keys[this.kid] = { search: 0, videos: 0, exhausted: {}, lastError: null, lastOk: null };
    return this.usage.keys[this.kid];
  }
  saveUsage() { this.ctx.storage.put('usage', this.usage); }
  searchInfo() {
    const { day, resetAt } = ptInfo();
    const k = (this.usage && this.usage.day === day && this.usage.keys[this.kid]) || { search: 0, exhausted: {} };
    const limit = this.cfg.maxSearch, used = k.search || 0;
    const exhausted = !!(k.exhausted && k.exhausted.search) || (limit > 0 && used >= limit);
    return { used, limit, left: limit ? Math.max(0, limit - used) : null, available: !!this.cfg.apiKey && !exhausted, resetAt };
  }
  quotaInfo() {
    const { day, resetAt } = ptInfo();
    const k = (this.usage && this.usage.day === day && this.usage.keys[this.kid]) || { search: 0, videos: 0, exhausted: {}, lastError: null, lastOk: null };
    const key = this.cfg.apiKey;
    return {
      day, resetAt,
      key: key ? key.slice(0, 6) + '…' + key.slice(-4) : '',
      keySource: this.keyOverride ? 'admin' : (this.env.YOUTUBE_API_KEY ? 'cloudflare' : 'none'),
      hasEnvKey: !!this.env.YOUTUBE_API_KEY,
      search: { used: k.search || 0, limit: this.cfg.maxSearch, exhausted: !!(k.exhausted && k.exhausted.search) },
      videos: { used: k.videos || 0, limit: VIDEO_UNITS_PER_DAY, exhausted: !!(k.exhausted && k.exhausted.videos) },
      lastError: k.lastError || null,
      lastOk: k.lastOk || null,
      cachedSearches: this.searchCache.size,
      history: [{ day, search: k.search || 0, videos: k.videos || 0 }, ...this.usageHist].slice(0, 7),
    };
  }
  // Mọi lần gọi YouTube đều đi qua đây: đếm lượt + nhận biết hết hạn mức / key sai
  async ytCall(kind, url) {
    const u = this.curUsage();
    let j;
    try { j = await (await fetch(url)).json(); }
    catch (e) {
      u.lastError = { kind, reason: 'network', message: String((e && e.message) || e), at: Date.now() };
      this.saveUsage();
      throw new Error('Không kết nối được tới YouTube, thử lại sau.');
    }
    if (j.error) {
      const reason = (j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.status || 'error';
      u.lastError = { kind, reason, message: j.error.message, at: Date.now() };
      let msg = 'YouTube: ' + j.error.message, status = 502;
      if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
        u.exhausted[kind] = true; status = 429;
        msg = kind === 'search' ? SEARCH_EXHAUSTED_MSG : 'YouTube API đã hết hạn mức hôm nay. Thử lại sau khi reset.';
      } else if (/keyInvalid|keyExpired|API_KEY|forbidden|accessNotConfigured/i.test(reason) || /API key/i.test(j.error.message || '')) {
        msg = 'API key YouTube đang lỗi. Admin cần kiểm tra lại key trên trang /admin.';
      }
      this.saveUsage();
      this.broadcast('state', this.publicState());
      const err = new Error(msg); err.status = status; err.reason = reason; throw err;
    }
    u[kind] = (u[kind] || 0) + 1;
    u.lastOk = Date.now();
    this.saveUsage();
    if (kind === 'search') this.broadcast('state', this.publicState());
    return j;
  }
  // ----- Máy phát & điều khiển từ xa -----
  attachment(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  speakerInfo(exclude) {
    if (!this.speaker) return null;
    const online = this.ctx.getWebSockets().some((ws) => ws !== exclude && this.attachment(ws).isHost && this.attachment(ws).deviceId === this.speaker.id);
    return { ...this.speaker, online };
  }
  broadcastHosts(type, data, exclude) {
    const msg = JSON.stringify({ type, data });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude && this.attachment(ws).isHost) { try { ws.send(msg); } catch (e) {} }
    }
  }
  // Chỉ máy phát mới được báo hết bài / lỗi / tạm dừng. Tab Admin cũ (không gửi mã thiết bị) bị bỏ qua khi đã có máy phát.
  fromSpeaker(deviceId) { return !this.speaker || (!!deviceId && this.speaker.id === deviceId); }

  send(ws, type, data) { try { ws.send(JSON.stringify({ type, data })); } catch (e) {} }
  broadcast(type, data, exclude) {
    const msg = JSON.stringify({ type, data });
    for (const ws of this.ctx.getWebSockets()) if (ws !== exclude) { try { ws.send(msg); } catch (e) {} }
  }
  // Xóa tin nhắn và lịch sử bài cũ hơn 30 ngày (khớp với Chính sách quyền riêng tư)
  prune() {
    const cutoff = Date.now() - RETENTION_MS;
    const chatLen = this.chat.length, histLen = this.state.history.length;
    this.chat = this.chat.filter((m) => (m.t || 0) >= cutoff);
    this.state.history = this.state.history.filter((h) => (h.addedAt || 0) >= cutoff);
    if (this.chat.length !== chatLen) this.ctx.storage.put('chat', this.chat);
    if (this.state.history.length !== histLen) this.ctx.storage.put('state', this.state);
  }
  changed() { this.ctx.storage.put('state', this.state); this.broadcast('state', this.publicState()); }
  pushChat(msg) {
    this.prune();
    this.chat.push(msg);
    if (this.chat.length > 100) this.chat = this.chat.slice(-100);
    this.ctx.storage.put('chat', this.chat);
    this.broadcast('chat', msg);
  }
  systemMsg(text) { this.pushChat({ id: crypto.randomUUID(), system: true, text, t: Date.now() }); }

  playNext() {
    const s = this.state;
    if (s.nowPlaying) { s.history.unshift(s.nowPlaying); s.history = s.history.slice(0, 20); }
    s.nowPlaying = s.queue.shift() || null;
    s.paused = false;
    this.changed();
    if (s.nowPlaying) this.systemMsg(`▶️ Đang phát: ${s.nowPlaying.title} (${s.nowPlaying.addedBy} chọn)${s.nowPlaying.note ? ` — 🎁 "${s.nowPlaying.note}"` : ''}`);
  }

  // ----- YouTube Data API v3 -----
  async ytVideos(ids) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${ids.join(',')}&key=${this.cfg.apiKey}`;
    const j = await this.ytCall('videos', url);
    return (j.items || []).map((v) => ({
      videoId: v.id,
      title: decodeEntities(v.snippet.title),
      channel: decodeEntities(v.snippet.channelTitle),
      thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default || {}).url || '',
      duration: parseISODuration(v.contentDetails.duration),
      embeddable: v.status.embeddable !== false,
      live: v.snippet.liveBroadcastContent === 'live' || v.snippet.liveBroadcastContent === 'upcoming',
    }));
  }

  async ytSearch(q) {
    const key = q.toLowerCase();
    const cached = this.searchCache.get(key);
    if (cached && Date.now() - cached.t < 6 * 60 * 60 * 1000) return cached.items; // lưu đệm 6 giờ: tìm lại không tốn lượt

    const c = this.cfg;
    if (!this.searchInfo().available) { const e = new Error(SEARCH_EXHAUSTED_MSG); e.status = 429; throw e; }

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(q)}&key=${c.apiKey}`;
    const j = await this.ytCall('search', url);
    const ids = (j.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
    const items = ids.length ? (await this.ytVideos(ids)).filter((v) => !v.live) : [];
    this.searchCache.set(key, { t: Date.now(), items });
    if (this.searchCache.size > 300) this.searchCache.delete(this.searchCache.keys().next().value);
    return items;
  }

  // ----- HTTP -----
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const c = this.cfg;

    try {
      if (p === '/api/ws') return this.handleWs(request, url);

      if (request.method === 'GET' && p === '/api/config') {
        return json({ pinRequired: !!c.pin, hasKey: !!c.apiKey, hostConfigured: !!c.hostPw });
      }

      if (request.method === 'GET' && p === '/api/search') {
        if (!this.pinOk(url.searchParams.get('pin'))) return json({ error: 'Sai mã phòng' }, 403);
        if (!c.apiKey) return json({ error: 'Admin chưa cài YOUTUBE_API_KEY' }, 500);
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (!q) return json({ error: 'Thiếu từ khóa' }, 400);
        const id = extractVideoId(q);
        if (id && q.length > 11) return json({ items: await this.ytVideos([id]) });
        if (this.limited('search:' + ip, 10, 60_000)) return json({ error: 'Bạn tìm nhanh quá, chờ 1 phút nhé' }, 429);
        try { return json({ items: await this.ytSearch(q) }); }
        catch (e) { return json({ error: e.message }, e.status || 500); }
      }

      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const body = await request.json().catch(() => ({}));

      if (p === '/api/join') {
        if (this.pinOk(body.pin)) return json({ ok: true });
        if (this.limited('pinfail:' + ip, 10, 5 * 60_000)) return json({ error: 'Nhập sai quá nhiều, thử lại sau 5 phút' }, 429);
        return json({ error: 'Sai mã phòng' }, 403);
      }

      if (p === '/api/host/login') {
        if (!c.hostPw) return json({ error: 'Chưa cài HOST_PASSWORD trên Cloudflare (Settings → Variables and Secrets)' }, 500);
        if (this.isHost(body.pw)) return json({ ok: true, pin: c.pin });
        if (this.limited('pwfail:' + ip, 8, 10 * 60_000)) return json({ error: 'Sai quá nhiều lần, thử lại sau 10 phút' }, 429);
        return json({ error: 'Sai mật khẩu' }, 401);
      }

      if (p === '/api/add') {
        if (!this.pinOk(body.pin, body.pw)) return json({ error: 'Sai mã phòng' }, 403);
        const name = cleanName(body.name);
        if (!name) return json({ error: 'Hãy nhập tên trước' }, 400);
        const cid = String(body.cid || '').slice(0, 64);
        if (!cid) return json({ error: 'Thiếu mã thiết bị' }, 400);
        const videoId = extractVideoId(body.videoId || body.url);
        if (!videoId) return json({ error: 'Link YouTube không hợp lệ' }, 400);
        if (!c.apiKey) return json({ error: 'Admin chưa cài YOUTUBE_API_KEY' }, 500);
        if (this.limited('add:' + ip, 8, 60_000)) return json({ error: 'Bạn thêm nhanh quá, chờ chút nhé' }, 429);

        const owner = await sha(cid);
        const dupe = () => this.state.nowPlaying?.videoId === videoId || this.state.queue.some((s) => s.videoId === videoId);
        if (dupe()) return json({ error: 'Bài này đã có trong danh sách rồi' }, 409);
        if (c.maxSongs && !this.isHost(body.pw) && this.state.queue.filter((s) => s.owner === owner).length >= c.maxSongs)
          return json({ error: `Mỗi người chỉ được xếp tối đa ${c.maxSongs} bài trong hàng chờ` }, 429);

        const [v] = await this.ytVideos([videoId]);
        if (!v) return json({ error: 'Không tìm thấy video' }, 404);
        if (v.live) return json({ error: 'Không hỗ trợ video đang livestream' }, 400);
        if (c.maxDur && v.duration > c.maxDur * 60) return json({ error: `Video dài quá ${c.maxDur} phút` }, 400);
        if (dupe()) return json({ error: 'Bài này đã có trong danh sách rồi' }, 409);

        const song = {
          id: crypto.randomUUID(), videoId: v.videoId, title: v.title, channel: v.channel,
          thumb: v.thumb, duration: v.duration, addedBy: name, owner, addedAt: Date.now(),
          // Chủ video không cho phát nhúng -> máy phát sẽ mở bài này trên youtube.com
          ...(v.embeddable ? {} : { noEmbed: true }),
          ...(cleanNote(body.note) ? { note: cleanNote(body.note) } : {}),
        };
        this.state.queue.push(song);
        this.systemMsg(`🎵 ${name} đã thêm: ${song.title}${song.noEmbed ? ' (phát qua cửa sổ YouTube)' : ''}`);
        if (!this.state.nowPlaying) this.playNext(); else this.changed();
        return json({ ok: true, song });
      }

      if (p === '/api/skip') {
        // Người chọn bài đang phát tự bỏ qua bài của mình
        if (!this.pinOk(body.pin, body.pw)) return json({ error: 'Sai mã phòng' }, 403);
        const np = this.state.nowPlaying;
        if (!np || np.id !== body.id) return json({ error: 'Bài này không còn đang phát' }, 409);
        if (np.owner !== (await sha(body.cid || ''))) return json({ error: 'Bạn chỉ bỏ qua được bài do mình chọn' }, 403);
        if (this.limited('skip:' + ip, 5, 60_000)) return json({ error: 'Bạn chuyển bài nhanh quá, chờ chút nhé' }, 429);
        this.systemMsg(`⏭ ${np.addedBy} đã bỏ qua bài mình chọn: ${np.title}`);
        this.playNext();
        return json({ ok: true });
      }

      if (p === '/api/note') {
        // Sửa / xóa lời nhắn của bài: người thêm bài hoặc Admin
        if (!this.pinOk(body.pin, body.pw)) return json({ error: 'Sai mã phòng' }, 403);
        const host = this.isHost(body.pw);
        const st = this.state;
        const song = st.queue.find((x) => x.id === body.id) || (st.nowPlaying && st.nowPlaying.id === body.id ? st.nowPlaying : null);
        if (!song) return json({ error: 'Không tìm thấy bài' }, 404);
        if (!host && song.owner !== (await sha(body.cid || ''))) return json({ error: 'Bạn chỉ sửa được lời nhắn cho bài của mình' }, 403);
        if (!host && this.limited('note:' + ip, 10, 60_000)) return json({ error: 'Bạn sửa nhanh quá, chờ chút nhé' }, 429);
        const note = cleanNote(body.note);
        if (note) song.note = note; else delete song.note;
        this.changed();
        return json({ ok: true, note: song.note || '' });
      }

      if (p === '/api/remove') {
        const i = this.state.queue.findIndex((s) => s.id === body.id);
        if (i < 0) return json({ error: 'Không tìm thấy bài' }, 404);
        if (!this.isHost(body.pw) && this.state.queue[i].owner !== (await sha(body.cid || '')))
          return json({ error: 'Bạn chỉ xóa được bài của mình' }, 403);
        this.state.queue.splice(i, 1);
        this.changed();
        return json({ ok: true });
      }

      if (p === '/api/chat') {
        if (!this.pinOk(body.pin, body.pw)) return json({ error: 'Sai mã phòng' }, 403);
        const host = this.isHost(body.pw);
        const name = host ? 'Admin' : cleanName(body.name);
        const text = String(body.text || '').trim().slice(0, 500);
        if (!name || !text) return json({ error: 'Thiếu tên hoặc nội dung' }, 400);
        if (!host && this.limited('chat:' + ip + ':' + body.cid, 5, 10_000)) return json({ error: 'Bạn chat nhanh quá, chờ chút nhé' }, 429);
        const owner = host ? 'host' : await sha(body.cid || ip);
        // Trả lời 1 tin nhắn: lưu kèm trích dẫn ngắn của tin gốc
        let reply;
        if (body.replyTo) {
          const o = this.chat.find((m) => m.id === body.replyTo && !m.system);
          if (o) reply = { id: o.id, name: o.host ? 'Admin' : o.name, text: String(o.text).slice(0, 140), host: !!o.host };
        }
        this.pushChat({ id: crypto.randomUUID(), name, text, t: Date.now(), host, owner, ...(reply ? { reply } : {}) });
        return json({ ok: true });
      }

      if (p === '/api/react') {
        if (!this.pinOk(body.pin, body.pw)) return json({ error: 'Sai mã phòng' }, 403);
        const host = this.isHost(body.pw);
        const emoji = String(body.emoji || '');
        if (!REACTIONS.includes(emoji)) return json({ error: 'Cảm xúc không hợp lệ' }, 400);
        if (!host && this.limited('react:' + ip, 30, 10_000)) return json({ error: 'Bạn thả cảm xúc nhanh quá, chờ chút nhé' }, 429);
        const msg = this.chat.find((m) => m.id === body.id && !m.system);
        if (!msg) return json({ error: 'Tin nhắn này đã cũ, không thả cảm xúc được nữa' }, 404);
        const owner = host ? 'host' : await sha(body.cid || ip);
        const who = host ? 'Admin' : cleanName(body.name) || 'Ai đó';
        // Mỗi người 1 cảm xúc / tin: thả cái mới thì thay cái cũ, thả lại cái đang có thì gỡ
        const r = msg.reactions || {};
        let had = null;
        for (const e of Object.keys(r)) {
          const i = r[e].findIndex((x) => x.owner === owner);
          if (i >= 0) { had = e; r[e].splice(i, 1); if (!r[e].length) delete r[e]; }
        }
        if (had !== emoji) { (r[emoji] = r[emoji] || []).push({ owner, name: who }); if (r[emoji].length > 100) r[emoji].shift(); }
        if (Object.keys(r).length) msg.reactions = r; else delete msg.reactions;
        this.ctx.storage.put('chat', this.chat);
        this.broadcast('react', { id: msg.id, reactions: msg.reactions || {} });
        return json({ ok: true });
      }

      if (p.startsWith('/api/host/')) {
        if (!this.isHost(body.pw)) {
          this.limited('pwfail:' + ip, 8, 10 * 60_000);
          return json({ error: 'Chỉ Admin mới điều khiển được' }, 403);
        }
        const s = this.state;
        switch (p.slice(10)) {
          case 'next': this.playNext(); break;
          case 'ended': if (this.fromSpeaker(body.deviceId) && s.nowPlaying && body.id === s.nowPlaying.id) this.playNext(); break;
          case 'error':
            // Tab Admin đời cũ không gửi mã lỗi -> bỏ qua để nó không làm nhảy bài liên tục
            if (body.code === undefined || body.code === null || body.code === '') break;
            if (this.fromSpeaker(body.deviceId) && s.nowPlaying && body.id === s.nowPlaying.id) {
              const reasons = {
                2: 'mã video không hợp lệ',
                5: 'lỗi trình phát của trình duyệt',
                100: 'video đã bị xóa hoặc để riêng tư',
                101: 'chủ video không cho phát trên website khác',
                150: 'chủ video không cho phát trên website khác',
                152: 'video bị giới hạn khu vực hoặc độ tuổi',
                153: 'YouTube từ chối trình phát nhúng',
              };
              const code = Number(body.code);
              const why = reasons[code] ? `${reasons[code]}, mã ${code}` : (Number.isFinite(code) ? `mã lỗi ${code}` : 'không rõ lý do');
              this.systemMsg(`⚠️ Không phát được "${s.nowPlaying.title}" (${why}), chuyển bài.`);
              this.playNext();
            }
            break;
          case 'paused':
            if (this.fromSpeaker(body.deviceId) && s.paused !== !!body.paused) { s.paused = !!body.paused; this.changed(); }
            break;
          case 'move': {
            const i = s.queue.findIndex((x) => x.id === body.id);
            const j = body.dir === 'top' ? 0 : i + (body.dir === 'up' ? -1 : 1);
            if (i >= 0 && j >= 0 && j < s.queue.length && i !== j) {
              const [song] = s.queue.splice(i, 1);
              s.queue.splice(j, 0, song);
              this.changed();
            }
            break;
          }
          case 'clear': s.queue = []; this.changed(); break;
          case 'quota': return json(this.quotaInfo());
          case 'tabplay':
            if (this.fromSpeaker(body.deviceId) && s.nowPlaying && body.id === s.nowPlaying.id && this.tabNoted !== body.id) {
              this.tabNoted = body.id;
              this.systemMsg(`↗️ "${s.nowPlaying.title}" không cho phát nhúng, đang phát qua cửa sổ YouTube trên máy phát.`);
            }
            break;
          case 'notice': {
            if (body.text === undefined) {
              // Chỉ bật / tắt, giữ nguyên nội dung
              if (!this.notice) return json({ error: 'Chưa có nội dung thông báo' }, 400);
              this.notice.enabled = !!body.enabled;
            } else {
              const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
              this.notice = text ? { text, at: Date.now(), enabled: body.enabled !== false } : null;
            }
            if (this.notice) await this.ctx.storage.put('notice', this.notice); else await this.ctx.storage.delete('notice');
            this.broadcast('state', this.publicState());
            return json({ ok: true, notice: this.notice });
          }
          case 'claim': {
            // Thiết bị muốn làm máy phát. Nếu máy phát khác đang online thì hỏi lại trước (force).
            const id = String(body.deviceId || '').slice(0, 64);
            if (!id) return json({ error: 'Thiếu mã thiết bị' }, 400);
            const cur = this.speakerInfo();
            if (cur && cur.id !== id && cur.online && !body.force) return json({ conflict: true, speaker: cur });
            const label = String(body.label || 'Thiết bị').replace(/\s+/g, ' ').trim().slice(0, 40);
            const changedDevice = !cur || cur.id !== id;
            this.speaker = { id, label, since: Date.now() };
            await this.ctx.storage.put('speaker', this.speaker);
            this.broadcastHosts('speaker', this.speakerInfo());
            if (changedDevice && cur) this.systemMsg(`🔊 Nhạc chuyển sang phát trên: ${label}`);
            return json({ ok: true, speaker: this.speakerInfo() });
          }
          case 'testkey': {
            if (!c.apiKey) return json({ error: 'Chưa có API key' }, 400);
            try {
              await this.ytCall('videos', `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${c.apiKey}`);
              return json({ ok: true, info: this.quotaInfo() });
            } catch (e) { return json({ error: e.message, info: this.quotaInfo() }, 400); }
          }
          case 'setkey': {
            const key = String(body.key || '').trim();
            if (!/^AIza[0-9A-Za-z_-]{30,45}$/.test(key)) return json({ error: 'Key không đúng định dạng (key YouTube bắt đầu bằng "AIza")' }, 400);
            let j;
            try { j = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${key}`)).json(); }
            catch (e) { return json({ error: 'Không kết nối được YouTube để kiểm tra key' }, 502); }
            if (j.error) return json({ error: 'Key không dùng được: ' + j.error.message }, 400);
            this.keyOverride = key;
            await this.ctx.storage.put('apiKeyOverride', key);
            await this.refreshKeyId();
            const u = this.curUsage(); u.videos++; u.lastOk = Date.now(); this.saveUsage();
            this.searchCache.clear();
            this.broadcast('state', this.publicState());
            return json({ ok: true, info: this.quotaInfo() });
          }
          case 'resetkey': {
            if (!this.env.YOUTUBE_API_KEY) return json({ error: 'Không có YOUTUBE_API_KEY trong Cloudflare để quay lại' }, 400);
            this.keyOverride = '';
            await this.ctx.storage.delete('apiKeyOverride');
            await this.refreshKeyId();
            this.broadcast('state', this.publicState());
            return json({ ok: true, info: this.quotaInfo() });
          }
          case 'setlimit': {
            const n = parseInt(body.maxSearch, 10);
            if (!Number.isFinite(n) || n < 0 || n > 100000) return json({ error: 'Giới hạn không hợp lệ' }, 400);
            this.cfgOverride.maxSearch = n;
            await this.ctx.storage.put('cfgOverride', this.cfgOverride);
            this.broadcast('state', this.publicState());
            return json({ ok: true, info: this.quotaInfo() });
          }
          case 'clearchat':
            this.chat = [];
            this.ctx.storage.put('chat', this.chat);
            this.broadcast('chatHistory', []);
            break;
          default: return json({ error: 'Không rõ lệnh' }, 404);
        }
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Lỗi: ' + (e && e.message) }, 500);
    }
  }

  // ----- WebSocket (dùng Hibernation API để tiết kiệm) -----
  handleWs(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    const wantsHost = url.searchParams.get('role') === 'host';
    const isHost = wantsHost && this.isHost(url.searchParams.get('pw') || '');
    if (wantsHost && !isHost) return new Response('Sai mật khẩu', { status: 403 });
    if (!isHost && !this.pinOk(url.searchParams.get('pin'))) return new Response('Sai mã phòng', { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const deviceId = isHost ? String(url.searchParams.get('device') || '').slice(0, 64) : '';
    server.serializeAttachment({ name: cleanName(url.searchParams.get('name')), isHost, deviceId });
    this.send(server, 'hello', { version: APP_VERSION });
    this.send(server, 'state', this.publicState());
    this.send(server, 'chatHistory', this.chat.slice(-50));
    this.broadcast('state', this.publicState(), server); // cập nhật danh sách online cho người khác
    this.send(server, 'player', this.player); // vị trí bài đang phát, để xem video đồng bộ
    if (isHost) this.broadcastHosts('speaker', this.speakerInfo()); // báo máy phát online / offline
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (message === 'ping') { try { ws.send('pong'); } catch (e) {} return; }
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (m && m.type === 'typing') {
      // "… đang nhập": chuyển tiếp cho mọi người khác, tối đa 1 lần / 2 giây / người
      const now = Date.now();
      if (now - (this.typingAt.get(ws) || 0) < 2000) return;
      this.typingAt.set(ws, now);
      let a = null;
      try { a = ws.deserializeAttachment(); } catch (e) {}
      const name = a?.isHost ? 'Admin' : a?.name;
      if (name) this.broadcast('typing', { name }, ws);
      return;
    }
    const a = this.attachment(ws);
    if (!a.isHost || !m) return;
    if (m.type === 'cmd') {
      // Lệnh từ thiết bị điều khiển -> chuyển cho máy phát
      const actions = ['toggle', 'play', 'pause', 'volume', 'seek'];
      if (!actions.includes(m.action)) return;
      const value = Number.isFinite(+m.value) ? Math.max(0, Math.min(m.action === 'volume' ? 100 : 86400, +m.value)) : null;
      this.broadcastHosts('cmd', { action: m.action, value, from: a.deviceId });
    } else if (m.type === 'status' && this.speaker && a.deviceId === this.speaker.id) {
      // Máy phát báo trạng thái -> chuyển cho các thiết bị điều khiển
      const n = (v, max) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, +v)) : 0);
      this.player = { paused: !!m.paused, volume: n(m.volume, 100), t: n(m.t, 86400), d: n(m.d, 86400), videoId: String(m.videoId || '').slice(0, 11), tab: !!m.tab, at: Date.now() };
      this.broadcast('player', { ...this.player, tab: !!m.tab }, ws);
    }
  }
  webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (e) {}
    this.broadcast('state', this.publicState(ws), ws);
    if (this.attachment(ws).isHost) this.broadcastHosts('speaker', this.speakerInfo(ws), ws);
  }
  webSocketError(ws) {
    this.broadcast('state', this.publicState(ws), ws);
    if (this.attachment(ws).isHost) this.broadcastHosts('speaker', this.speakerInfo(ws), ws);
  }
}
