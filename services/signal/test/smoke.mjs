// Sinyal sunucusu duman testi: kendi yerel sunucusunu açar, uçları ve odayı dener.  →  npm test
// Yayındaki sunucuyu denemek için: SIGNAL_BASE=https://….workers.dev npm test
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8788;
const REMOTE = process.env.SIGNAL_BASE?.replace(/\/+$/, '');
const BASE = REMOTE ?? `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

let server = null;
if (!REMOTE) {
  mkdirSync(new URL('../web', import.meta.url), { recursive: true });
  server = spawn(`npx wrangler dev --port ${PORT} --ip 127.0.0.1`, {
    cwd: new URL('..', import.meta.url),
    shell: true,
    detached: process.platform !== 'win32', // macOS/Linux: süreç grubu olarak kapatabilmek için
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sunucu 60 sn içinde açılmadı')), 60_000);
    server.stdout.on('data', (d) => d.toString().includes('Ready on') && (clearTimeout(timer), resolve()));
  });
} else {
  console.log(`Yayındaki sunucu: ${BASE}`);
}

const post = (path, body) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Odaya bağlanır; gelen mesajları sıraya koyar. */
function connect(pairing, deviceId, name) {
  const q = new URLSearchParams({ token: pairing.token, deviceId, name });
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/room/${pairing.coupleId}?${q}`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  };
  const next = (match, timeout = 5000) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => resolve(null), timeout);
    });
  };
  const opened = new Promise((r) => (ws.onopen = r));
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  return { ws, next, opened, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

try {
  const alice = { deviceId: randomUUID(), name: 'Ali' };
  const bade = { deviceId: randomUUID(), name: 'Bade' };

  check('sağlık ucu', (await fetch(`${BASE}/api/health`)).ok);
  if (REMOTE || existsSync(new URL('../web/index.html', import.meta.url))) {
    const page = await fetch(`${BASE}/bir/sayfa`);
    check('web sürümü sunuluyor (tek sayfa uygulaması)', page.ok && /<div id="root">/.test(await page.text()));
  }

  const startRes = await post('/pair/start', alice);
  const start = await startRes.json();
  check('kod oluşturuldu', startRes.ok && /^\d{6}$/.test(start.code), start.code);

  const bad = await post('/pair/join', { ...bade, code: start.code === '000000' ? '111111' : '000000' });
  check('yanlış kod reddedildi', bad.status === 404);

  const own = await post('/pair/join', { ...alice, code: start.code });
  check('kendi kodunu giremez', own.status === 404);

  const joinRes = await post('/pair/join', { ...bade, code: start.code });
  const join = await joinRes.json();
  check('kodla eşleşildi', joinRes.ok && join.coupleId === start.coupleId && join.partner.name === 'Ali');

  const reuse = await post('/pair/join', { ...bade, code: start.code });
  check('kod tek kullanımlık', reuse.status === 404);

  const badBody = await post('/pair/start', { deviceId: 'x', name: '' });
  check('geçersiz istek reddedildi', badBody.status === 400);

  const iceBad = await fetch(`${BASE}/ice?couple=${start.coupleId}&token=yanlis`);
  check('yanlış anahtarla ICE yok', iceBad.status === 401);
  const ice = await (await fetch(`${BASE}/ice?couple=${start.coupleId}&token=${start.token}`)).json();
  check('ICE sunucuları geldi', Array.isArray(ice.iceServers) && ice.iceServers.length > 0);

  const intruder = connect({ coupleId: start.coupleId, token: 'yanlis' }, randomUUID(), 'X');
  const intruderCode = await intruder.closed;
  check('yanlış anahtarla odaya girilemez', intruderCode === 1006, String(intruderCode));

  // Oda: varlık ve sinyal iletimi
  const a = connect(start, alice.deviceId, alice.name);
  const helloA = await a.next((m) => m.type === 'hello');
  check('A odada yalnız', helloA?.peer === null);

  const b = connect(join, bade.deviceId, bade.name);
  const helloB = await b.next((m) => m.type === 'hello');
  check('B, A\'yı görüyor', helloB?.peer?.name === 'Ali');
  const peerB = await a.next((m) => m.type === 'peer');
  check('A, B\'nin geldiğini gördü', peerB?.peer?.name === 'Bade');

  a.send({ type: 'status', status: { screen: 'watch', title: 'Bölüm 1' } });
  const st = await b.next((m) => m.type === 'peer' && m.peer.status.screen === 'watch');
  check('ekran durumu iletildi', st?.peer?.status?.title === 'Bölüm 1');

  b.send({ type: 'signal', data: { session: 's1', candidate: null } });
  const sig = await a.next((m) => m.type === 'signal');
  check('sinyal iletildi', sig?.data?.session === 's1');

  // Aynı cihaz yeniden bağlanınca eski bağlantı kapanır, karşıya "ayrıldı" gitmez.
  const a2 = connect(start, alice.deviceId, alice.name);
  const replacedCode = await a.closed;
  check('eski bağlantı devredildi', replacedCode === 4000, String(replacedCode));
  await a2.next((m) => m.type === 'hello');
  const leftWrongly = await b.next((m) => m.type === 'peer-left', 800);
  check('devirde "ayrıldı" gitmedi', leftWrongly === null);

  // Üçüncü bir cihaz giremez.
  const c = connect(start, randomUUID(), 'Üçüncü');
  check('oda en fazla 2 cihaz', (await c.closed) === 4001);

  b.ws.close();
  const left = await a2.next((m) => m.type === 'peer-left');
  check('B çıkınca A haber aldı', left !== null);
  a2.ws.close();
} finally {
  // Windows'ta önce bütün süreç ağacı (cmd → npx → wrangler → workerd) kapatılmalı;
  // kabuk önce ölürse taskkill çocukları bulamaz ve sunucu arkada kalır.
  if (server && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else if (server) killGroup(server);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} başarılı`);
process.exit(failed ? 1 : 0);

/** macOS/Linux: kabuk, npx, wrangler ve workerd aynı süreç grubunda; hepsini birden kapat. */
function killGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    proc.kill();
  }
}
