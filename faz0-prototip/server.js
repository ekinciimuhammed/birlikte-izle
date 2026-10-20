// Faz 0 sunucusu: sayfayı sunar, iki kişiyi aynı odada tanıştırır (signaling).
// Film, kamera ve kontrol mesajları bu sunucudan geçmez; doğrudan P2P akar.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// --- ICE sunucuları -------------------------------------------------------
// Varsayılan: sadece STUN (ücretsiz). Doğrudan bağlantı kurulamazsa Cloudflare TURN
// için CF_TURN_KEY_ID ve CF_TURN_API_TOKEN ortam değişkenlerini ver.

const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let turnCache = { servers: null, expires: 0 };

async function iceServers() {
  const { CF_TURN_KEY_ID: keyId, CF_TURN_API_TOKEN: token } = process.env;
  if (!keyId || !token) return STUN_ONLY;
  if (turnCache.servers && Date.now() < turnCache.expires) return turnCache.servers;

  const ttl = 24 * 60 * 60;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { iceServers } = await res.json();
    // 53 numaralı port tarayıcılarda zaman aşımına düşebiliyor (Cloudflare önerisi).
    const servers = iceServers.map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    turnCache = { servers, expires: Date.now() + (ttl / 2) * 1000 };
    return servers;
  } catch (err) {
    console.warn('TURN bilgisi alınamadı, sadece STUN kullanılacak:', err.message);
    return STUN_ONLY;
  }
}

// --- HTTP -----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: await iceServers() }));
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bulunamadı');
  }
});

// --- Odalar (WebSocket) ---------------------------------------------------
// Oda = en fazla 2 kişi. İkinci kişi gelince oturum numarası artar; istemciler
// eski oturuma ait gecikmiş sinyalleri bu numarayla ayıklar.

const rooms = new Map(); // kod -> { peers: Set<ws>, session: number }
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

wss.on('connection', (ws) => {
  let code = null;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && !code) {
      const wanted = String(msg.room ?? '').trim().toLowerCase().slice(0, 32);
      if (!wanted) return;
      const room = rooms.get(wanted) ?? { peers: new Set(), session: 0 };
      if (room.peers.size >= 2) return send(ws, { type: 'full' });

      code = wanted;
      ws.name = String(msg.name ?? '').trim().slice(0, 32) || 'Misafir';
      room.peers.add(ws);
      rooms.set(code, room);

      const other = [...room.peers].find((p) => p !== ws);
      if (!other) return send(ws, { type: 'joined', peer: null });

      room.session += 1;
      // Yeni gelen "kibar" (polite) taraf olur: teklif çakışmasında geri çekilir.
      send(ws, { type: 'joined', peer: { name: other.name }, polite: true, session: room.session });
      send(other, { type: 'peer-joined', peer: { name: ws.name }, polite: false, session: room.session });
      return;
    }

    if (msg.type === 'signal' && code) {
      for (const p of rooms.get(code)?.peers ?? []) if (p !== ws) send(p, { type: 'signal', data: msg.data });
    }
  });

  ws.on('close', () => {
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.peers.delete(ws);
    if (room.peers.size === 0) rooms.delete(code);
    else for (const p of room.peers) send(p, { type: 'peer-left' });
  });
});

// Kopmuş bağlantıları temizle (tüneller boşta kalan WebSocket'i kesebiliyor).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25_000);

server.listen(PORT, () => {
  const turn = process.env.CF_TURN_KEY_ID ? 'Cloudflare TURN açık' : 'sadece STUN';
  console.log(`Birlikte İzle · Faz 0 → http://localhost:${PORT}  (${turn})`);
});
