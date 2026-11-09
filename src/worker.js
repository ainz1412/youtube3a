// YT Jukebox – bản chạy trên Cloudflare Workers + Durable Objects
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

// Hạn mức YouTube API reset lúc 0h giờ Thái Bình Dương
const quotaDay = () => new Date(Date.now() - 8 * 3600e3).toISOString().slice(0, 10);

// ---------- Phòng nhạc ----------
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = { nowPlaying: null, queue: [], history: [], paused: false };
    this.chat = [];
    this.searchCache = new Map();
    this.rate = new Map();
    this.typingAt = new WeakMap();
    ctx.blockConcurrencyWhile(async () => {
      const [s, c] = await Promise.all([ctx.storage.get('state'), ctx.storage.get('chat')]);
      if (s) Object.assign(this.state, s);
      if (Array.isArray(c)) this.chat = c;
    });
    // Trả lời "ping" mà không cần đánh thức Durable Object (tiết kiệm hạn mức miễn phí)
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }

  get cfg() {
    const e = this.env;
    const int = (v, d) => { const n = parseInt(v ?? d, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
    return {
      apiKey: e.YOUTUBE_API_KEY || '',
      hostPw: e.HOST_PASSWORD || '',
      pin: String(e.ROOM_PIN || '').trim(),
      maxSongs: int(e.MAX_SONGS_PER_USER, '3'),
      maxDur: int(e.MAX_DURATION_MIN, '15'),
      maxSearch: int(e.MAX_SEARCHES_PER_DAY, '90'),
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
    };
  }
  send(ws, type, data) { try { ws.send(JSON.stringify({ type, data })); } catch (e) {} }
  broadcast(type, data, exclude) {
    const msg = JSON.stringify({ type, data });
    for (const ws of this.ctx.getWebSockets()) if (ws !== exclude) { try { ws.send(msg); } catch (e) {} }
  }
  changed() { this.ctx.storage.put('state', this.state); this.broadcast('state', this.publicState()); }
  pushChat(msg) {
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
    if (s.nowPlaying) this.systemMsg(`▶️ Đang phát: ${s.nowPlaying.title} (${s.nowPlaying.addedBy} chọn)`);
  }

  // ----- YouTube Data API v3 -----
  async ytVideos(ids) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${ids.join(',')}&key=${this.cfg.apiKey}`;
    const j = await (await fetch(url)).json();
    if (j.error) throw new Error('YouTube: ' + j.error.message);
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
    if (cached && Date.now() - cached.t < 60 * 60 * 1000) return cached.items;

    const c = this.cfg;
    if (c.maxSearch) {
      const day = quotaDay();
      let quota = (await this.ctx.storage.get('quota')) || { day, count: 0 };
      if (quota.day !== day) quota = { day, count: 0 };
      if (quota.count >= c.maxSearch) {
        const e = new Error('Hôm nay đã hết lượt tìm kiếm miễn phí của YouTube. Hãy dán link YouTube để thêm bài nhé!');
        e.status = 429; throw e;
      }
      quota.count++;
      await this.ctx.storage.put('quota', quota);
    }

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=12&q=${encodeURIComponent(q)}&key=${c.apiKey}`;
    const j = await (await fetch(url)).json();
    if (j.error) throw new Error('YouTube: ' + j.error.message);
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
        if (!v.embeddable) return json({ error: 'Video này bị chủ sở hữu chặn phát ngoài YouTube' }, 400);
        if (v.live) return json({ error: 'Không hỗ trợ video đang livestream' }, 400);
        if (c.maxDur && v.duration > c.maxDur * 60) return json({ error: `Video dài quá ${c.maxDur} phút` }, 400);
        if (dupe()) return json({ error: 'Bài này đã có trong danh sách rồi' }, 409);

        const song = {
          id: crypto.randomUUID(), videoId: v.videoId, title: v.title, channel: v.channel,
          thumb: v.thumb, duration: v.duration, addedBy: name, owner, addedAt: Date.now(),
        };
        this.state.queue.push(song);
        this.systemMsg(`🎵 ${name} đã thêm: ${song.title}`);
        if (!this.state.nowPlaying) this.playNext(); else this.changed();
        return json({ ok: true, song });
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
        this.pushChat({ id: crypto.randomUUID(), name, text, t: Date.now(), host, owner });
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
          case 'ended': if (s.nowPlaying && body.id === s.nowPlaying.id) this.playNext(); break;
          case 'error':
            if (s.nowPlaying && body.id === s.nowPlaying.id) {
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
            if (s.paused !== !!body.paused) { s.paused = !!body.paused; this.changed(); }
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
    server.serializeAttachment({ name: cleanName(url.searchParams.get('name')), isHost });
    this.send(server, 'state', this.publicState());
    this.send(server, 'chatHistory', this.chat.slice(-50));
    this.broadcast('state', this.publicState(), server); // cập nhật danh sách online cho người khác
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
    }
  }
  webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (e) {}
    this.broadcast('state', this.publicState(ws), ws);
  }
  webSocketError(ws) {
    this.broadcast('state', this.publicState(ws), ws);
  }
}
