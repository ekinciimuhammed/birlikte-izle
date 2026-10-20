// Birlikte İzle sinyal sunucusu (Cloudflare Worker)
//
//   POST /pair/start   → 6 haneli kod + oda bilgisi (kodu oluşturan)
//   POST /pair/join    → koddan oda bilgisi (kodu giren)
//   GET  /ice          → STUN/TURN sunucuları (oda anahtarı gerekir)
//   GET  /room/:id     → WebSocket: varlık + P2P sinyalleri (oda anahtarı gerekir)
//   diğer her şey      → web sürümü (statik dosyalar, ./web)
//
// Film, kamera ve kontrol mesajları buradan geçmez; doğrudan P2P akar.

import { DurableObject } from 'cloudflare:workers';
import {
  ClientMessage,
  CloseCode,
  DeviceId,
  Name,
  PairJoinRequest,
  PairStartRequest,
  parseJson,
  type ApiErrorCode,
  type IceResponse,
  type PairJoinResponse,
  type PairStartResponse,
  type PeerInfo,
  type PeerStatus,
  type ServerMessage,
} from '@birlikte/protocol';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  PAIRING: DurableObjectNamespace<Pairing>;
  ROOM_KEY: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const fail = (error: ApiErrorCode, status: number) => json({ error }, status);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!env.ROOM_KEY) return fail('server', 500);

    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') ?? 'yerel';
    const pairing = env.PAIRING.get(env.PAIRING.idFromName('global'));

    try {
      if (url.pathname === '/api/health') return json({ ok: true, service: 'birlikte-izle-signal' });

      if (url.pathname === '/pair/start' && req.method === 'POST') {
        const body = PairStartRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return fail('invalid-request', 400);
        const coupleId = randomId(16);
        const token = await sign(env.ROOM_KEY, coupleId);
        const { code, expiresAt } = await pairing.start({ coupleId, token, creator: body.data });
        return json({ code, coupleId, token, expiresAt } satisfies PairStartResponse);
      }

      if (url.pathname === '/pair/join' && req.method === 'POST') {
        const body = PairJoinRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return fail('invalid-request', 400);
        const result = await pairing.join(body.data.code, body.data.deviceId, ip);
        if (!result.ok) return fail(result.error, result.error === 'rate-limited' ? 429 : 404);
        return json({
          coupleId: result.coupleId,
          token: result.token,
          partner: result.creator,
        } satisfies PairJoinResponse);
      }

      if (url.pathname === '/ice' && req.method === 'GET') {
        const couple = url.searchParams.get('couple') ?? '';
        if (!(await verify(env.ROOM_KEY, couple, url.searchParams.get('token') ?? ''))) {
          return fail('unauthorized', 401);
        }
        return json({ iceServers: await iceServers(env) } satisfies IceResponse);
      }

      const room = url.pathname.match(/^\/room\/([\w-]{8,64})$/);
      if (room) {
        if (req.headers.get('upgrade') !== 'websocket') return new Response('WebSocket bekleniyor', { status: 426 });
        const coupleId = room[1]!;
        if (!(await verify(env.ROOM_KEY, coupleId, url.searchParams.get('token') ?? ''))) {
          return fail('unauthorized', 401);
        }
        const deviceId = DeviceId.safeParse(url.searchParams.get('deviceId'));
        const name = Name.safeParse(url.searchParams.get('name'));
        if (!deviceId.success || !name.success) return fail('invalid-request', 400);
        return env.ROOM.get(env.ROOM.idFromName(coupleId)).fetch(req);
      }

      return new Response('Bulunamadı', { status: 404, headers: CORS });
    } catch (err) {
      console.error(err);
      return fail('server', 500);
    }
  },
} satisfies ExportedHandler<Env>;

// --- Eşleşme kodları ----------------------------------------------------------------

interface PairEntry {
  coupleId: string;
  token: string;
  creator: { deviceId: string; name: string };
  expiresAt: number;
}

type JoinResult =
  | { ok: true; coupleId: string; token: string; creator: { deviceId: string; name: string } }
  | { ok: false; error: 'invalid-code' | 'rate-limited' };

const CODE_TTL = 10 * 60_000;
const MAX_FAILED_ATTEMPTS = 10;

export class Pairing extends DurableObject<Env> {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  async start(entry: Omit<PairEntry, 'expiresAt'>): Promise<{ code: string; expiresAt: number }> {
    await this.sweep();
    let code: string;
    do code = randomCode();
    while (await this.ctx.storage.get(`code:${code}`));
    const expiresAt = Date.now() + CODE_TTL;
    await this.ctx.storage.put(`code:${code}`, { ...entry, expiresAt } satisfies PairEntry);
    return { code, expiresAt };
  }

  async join(code: string, deviceId: string, ip: string): Promise<JoinResult> {
    const now = Date.now();
    const tries = this.attempts.get(ip);
    if (tries && tries.resetAt > now && tries.count >= MAX_FAILED_ATTEMPTS) {
      return { ok: false, error: 'rate-limited' };
    }

    const key = `code:${code}`;
    const entry = await this.ctx.storage.get<PairEntry>(key);
    // Kendi kodunu girmek de geçersiz sayılır.
    if (!entry || entry.expiresAt < now || entry.creator.deviceId === deviceId) {
      this.attempts.set(
        ip,
        tries && tries.resetAt > now
          ? { count: tries.count + 1, resetAt: tries.resetAt }
          : { count: 1, resetAt: now + CODE_TTL },
      );
      if (entry && entry.expiresAt < now) await this.ctx.storage.delete(key);
      return { ok: false, error: 'invalid-code' };
    }

    await this.ctx.storage.delete(key); // tek kullanımlık
    return { ok: true, coupleId: entry.coupleId, token: entry.token, creator: entry.creator };
  }

  private async sweep() {
    const now = Date.now();
    const all = await this.ctx.storage.list<PairEntry>({ prefix: 'code:' });
    const expired = [...all].filter(([, v]) => v.expiresAt < now).map(([k]) => k);
    if (expired.length) await this.ctx.storage.delete(expired);
  }
}

// --- Oda: en fazla iki cihaz ---------------------------------------------------------
// WebSocket Hibernation: boşta beklerken ücret işlemez; bağlantı bilgisi soketin
// "attachment"ında durur, bellek silinse de kaybolmaz.

interface Attachment {
  deviceId: string;
  name: string;
  status: PeerStatus;
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // İstemcinin canlı tutma pingine, nesneyi uyandırmadan cevap ver.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const me: Attachment = {
      deviceId: url.searchParams.get('deviceId')!,
      name: url.searchParams.get('name')!.trim(),
      status: { screen: 'home', title: null },
    };

    // Aynı cihazın eski bağlantısı varsa kapat (ağ değişimi, yeniden başlatma…).
    for (const ws of this.open()) {
      if (attachment(ws).deviceId === me.deviceId) ws.close(CloseCode.Replaced, 'replaced');
    }
    const others = this.open().filter((ws) => attachment(ws).deviceId !== me.deviceId);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(me);

    if (others.length >= 2) {
      server.close(CloseCode.Full, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const peer = others[0];
    send(server, { type: 'hello', peer: peer ? info(attachment(peer)) : null });
    if (peer) send(peer, { type: 'peer', peer: info(me) });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const msg = parseJson(ClientMessage, typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (!msg) return;
    const me = attachment(ws);

    if (msg.type === 'status') {
      me.status = msg.status;
      ws.serializeAttachment(me);
      for (const peer of this.othersThan(me)) send(peer, { type: 'peer', peer: info(me) });
    } else if (msg.type === 'signal') {
      for (const peer of this.othersThan(me)) send(peer, { type: 'signal', data: msg.data });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.left(ws);
    try {
      ws.close(code, reason);
    } catch {
      // zaten kapalı
    }
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  private left(ws: WebSocket) {
    const me = attachment(ws);
    // Aynı cihaz yeni bir bağlantıyla döndüyse "ayrıldı" deme.
    const replaced = this.open().some((s) => s !== ws && attachment(s).deviceId === me.deviceId);
    if (replaced) return;
    for (const peer of this.othersThan(me)) send(peer, { type: 'peer-left' });
  }

  private open() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private othersThan(me: Attachment) {
    return this.open().filter((ws) => attachment(ws).deviceId !== me.deviceId);
  }
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function info(a: Attachment): PeerInfo {
  return { deviceId: a.deviceId, name: a.name, status: a.status };
}

function send(ws: WebSocket, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // kapanmakta olan soket
  }
}

// --- STUN / TURN -----------------------------------------------------------------------

const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let turnCache: { servers: IceResponse['iceServers']; expires: number } | null = null;

async function iceServers(env: Env): Promise<IceResponse['iceServers']> {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) return STUN_ONLY;
  if (turnCache && Date.now() < turnCache.expires) return turnCache.servers;

  const ttl = 24 * 60 * 60;
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
    },
  );
  if (!res.ok) {
    console.error('TURN bilgisi alınamadı', res.status);
    return STUN_ONLY;
  }
  const { iceServers } = (await res.json()) as IceResponse;
  // 53 numaralı port tarayıcılarda zaman aşımına düşebiliyor (Cloudflare önerisi).
  const servers = iceServers.map((s) => ({
    ...s,
    urls: ([] as string[]).concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
  }));
  turnCache = { servers, expires: Date.now() + (ttl / 2) * 1000 };
  return servers;
}

// --- Kriptografi yardımcıları ----------------------------------------------------------------

function randomId(bytes: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function randomCode() {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n! % 1_000_000).padStart(6, '0');
}

function base64url(data: Uint8Array) {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmac(key: string, message: string) {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
}

/** Oda anahtarı = HMAC(ROOM_KEY, coupleId). Sunucu hiçbir oda listesi tutmaz. */
async function sign(key: string, coupleId: string) {
  return base64url(await hmac(key, coupleId));
}

async function verify(key: string, coupleId: string, token: string) {
  if (!coupleId || !token) return false;
  const expected = await sign(key, coupleId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
