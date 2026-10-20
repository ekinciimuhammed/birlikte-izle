// Uygulama içinde izleme testi (gerçek Electron ×2 + yerel bir video sitesi; tarayıcı ve eklenti yok):
// A Kanallar'dan bir kanal seçer; sayfa iki uygulamanın içinde de açılır, A'da video belirince birlikte
// izleme kendiliğinden başlar. Canlı yayında oynat/durdur, normal bölümde konum (ms) eşitleniyor mu?
// Sayfanın kendi oynatıcısında yapılanlar karşıya geçiyor mu? A uygulama içinde başka sayfaya gidince
// B takip ediyor mu (oynatıcı iframe içinde de olsa)?   →  npm run test:web

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { makeBigFixture } from './lib/fixtures.mjs';
import { createChecks, enterWatch, OUT, pair, startPair, until, visible } from './lib/harness.mjs';

const { check, finish, fail } = createChecks();
const VIDEO = makeBigFixture(); // 60 sn
const SITE_PORT = 8798;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PAGE = `${SITE}/izle/bolum-1`;
const PAGE_IFRAME = `${SITE}/izle/bolum-2`; // oynatıcı iframe içinde
const PAGE_LIVE = `${SITE}/canli/kanal-1`; // canlı yayın gibi (süresi yok)

const site = createServer((req, res) => {
  if (req.url.startsWith('/video.mp4')) {
    const size = statSync(VIDEO).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(m && { 'content-range': `bytes ${start}-${end}/${size}` }),
    });
    return createReadStream(VIDEO, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url.startsWith('/canli/')) {
    return res.end(`<!doctype html><title>Yerel Kanal Canlı</title>
      <body style="margin:0;background:#000">
      <canvas width="640" height="360" style="position:absolute;left:-9999px"></canvas>
      <video style="width:960px;height:540px" muted></video>
      <script>
        const c = document.querySelector('canvas');
        const x = c.getContext('2d');
        let i = 0;
        setInterval(() => { x.fillStyle = 'hsl(' + (i++ % 360) + ' 60% 40%)'; x.fillRect(0, 0, 640, 360); }, 33);
        document.querySelector('video').srcObject = c.captureStream(30);
      </script></body>`);
  }
  if (req.url.startsWith('/izle/bolum-2')) {
    return res.end(`<!doctype html><title>Deneme Dizisi 2. Bölüm</title>
      <body style="margin:0;background:#000"><iframe src="/oynatici/bolum-2" style="width:960px;height:540px;border:0"></iframe></body>`);
  }
  if (req.url.startsWith('/oynatici/')) {
    return res.end(`<!doctype html><title>Oynatıcı</title>
      <body style="margin:0;background:#000"><video src="/video.mp4" style="width:100%;height:100%" preload="auto"></video></body>`);
  }
  res.end(`<!doctype html><title>Deneme Dizisi 1. Bölüm</title>
    <body style="margin:0;background:#000"><video src="/video.mp4" style="width:960px;height:540px" preload="auto"></video></body>`);
}).listen(SITE_PORT, '127.0.0.1');

// Yerel test sayfaları da uygulamanın içinde açılsın (normalde sadece izin verilen siteler)
const EMBED = { BIRLIKTE_EMBED_LOCAL: '1' };
const { A, B, errors, cleanup } = await startPair({ port: 8794, env: { A: EMBED, B: EMBED } });

/** Uygulama içindeki sayfada çalışan kod (iframe'deki video dahil) */
const inPage = (page, code) => page.evaluate((c) => window.__birlikte.watch.webview.el.executeJavaScript(c), code);
/** Kullanıcı yapmış gibi (Chromium, kullanıcı dokunmadan yapılan geçişleri "geri"de atlar) */
const byUser = (page, code) => page.evaluate((c) => window.__birlikte.watch.webview.el.executeJavaScript(c, true), code);
const FIND = `(document.querySelector('video') || document.querySelector('iframe')?.contentDocument?.querySelector('video'))`;
const videoState = (page) => inPage(page, `(() => { const v = ${FIND}; return v ? { t: v.currentTime, w: Date.now(), playing: !v.paused } : null; })()`);
const pageUrl = (page) => page.evaluate(() => window.__birlikte.watch.webview.el.getURL());
/** Node tarafında yoklama: sayfanın içi Playwright'ın beklemeleriyle görünmez */
async function soon(fn, timeout = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const playing = (page) => soon(async () => (await videoState(page))?.playing === true);
const paused = (page) => soon(async () => (await videoState(page))?.playing === false);
const drift = async () => {
  const a = await videoState(A);
  const b = await videoState(B);
  return a.t + (a.playing ? (b.w - a.w) / 1000 : 0) - b.t;
};
const fmt = (d) => `${Math.round(d * 1000)} ms`;
const cmd = (page, action, value) => page.evaluate(([a, v]) => window.__birlikte.watch.command(a, v), [action, value]);
const channel = (page, name, url) => page.evaluate(([n, u]) => window.__birlikte.watch.openChannel({ name: n, url: u }), [name, url]);
const state = (page) => page.evaluate(() => window.__birlikte.state());
/** Fare sayfanın üstünde hareket etti (gerçekte fare olayları sayfaya gider; sayfa betiği uygulamaya bildirir) */
const moveMouseInPage = (page) => inPage(page, `document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))`);
const uiShown = (page) => soon(() => page.evaluate(() => !document.querySelector('.watch.ui-hidden')), 3000);
/** Karşının kamerası/sesi gerçekten geliyor mu (açık dediği izlerde 1,5 sn'de bayt artıyor) */
const camFlowing = (page) =>
  page.evaluate(async () => {
    const w = window.__birlikte.watch;
    const s = window.__birlikte.state();
    const pc = w.link?.pc;
    const ids = new Set(w.remoteStreams.get(w.peerStreams.cam)?.getTracks().map((t) => t.id));
    if (!pc || !s.peerHere || (!s.peerCamOn && !s.peerMicOn) || !ids.size) return false;
    const read = async () => {
      const out = { audio: 0, video: 0 };
      (await pc.getStats()).forEach((r) => r.type === 'inbound-rtp' && ids.has(r.trackIdentifier) && (out[r.kind] += r.bytesReceived || 0));
      return out;
    };
    const a = await read();
    await new Promise((r) => setTimeout(r, 1500));
    const b = await read();
    return (!s.peerCamOn || b.video > a.video) && (!s.peerMicOn || b.audio > a.audio);
  });
const followsPage = (page, url) =>
  until(page, (u) => window.__birlikte.state().syncMode && window.__birlikte.state().webVideo?.url === u, url, 20_000);

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));

  // --- Canlı kanal: iki uygulamanın içinde de açılır ---------------------------------------------
  await channel(A, 'Yerel Kanal', PAGE_LIVE);
  check('kanal: A\'da sayfa uygulamanın içinde açıldı', (await state(A)).source === 'web' && (await soon(async () => (await pageUrl(A)) === PAGE_LIVE)));
  check('kanal: B\'de de uygulamanın içinde açıldı', await soon(async () => (await pageUrl(B)) === PAGE_LIVE));
  check(
    'kanal: A video belirince kendiliğinden birlikte izlemeye geçti',
    await until(A, (u) => window.__birlikte.state().role === 'host' && window.__birlikte.state().webVideo?.url === u, PAGE_LIVE, 20_000),
  );
  check(
    'kanal: B onu takip ediyor (kendi uygulamasının içinden)',
    await until(B, () => window.__birlikte.state().syncMode && window.__birlikte.state().source === 'web', null, 20_000),
  );
  check('canlı: tanındı, zaman çubuğu yerine "CANLI"', (await A.evaluate(() => window.__birlikte.watch.web.isLive)) && (await visible(A.locator('.live-badge'), 5000)));
  await cmd(A, 'play');
  check('canlı: A oynattı → ikisinde de oynuyor', (await playing(A)) && (await playing(B)));
  await inPage(B, `${FIND}.pause()`);
  check('canlı: B sayfanın kendi oynatıcısında durdurdu → A da durdu', await paused(A));
  await inPage(B, `${FIND}.play()`);
  check('canlı: B oynattı → A da oynadı', await playing(A));

  // --- Normal bölüm: konum milisaniyeler içinde -------------------------------------------------
  await channel(A, 'Yerel Dizi', PAGE);
  check('bölüm: iki uygulamada da sayfa değişti', (await soon(async () => (await pageUrl(A)) === PAGE)) && (await soon(async () => (await pageUrl(B)) === PAGE)));
  check('bölüm: B yeni sayfayı takip ediyor', await until(B, (u) => window.__birlikte.state().syncMode && window.__birlikte.state().webVideo?.url === u, PAGE, 20_000));
  await cmd(A, 'play');
  check('bölüm: A oynattı → B de oynuyor', (await playing(A)) && (await playing(B)));
  await A.waitForTimeout(4000);
  let d = await drift();
  check('bölüm: birlikte oynarken fark < 150 ms', Math.abs(d) < 0.15, fmt(d));
  // "Sadece video": oynatıcı alanın tamamını kaplar; düğmeyle sayfaya dönülür
  const FILLS = `(() => { const el = document.querySelector('[data-birlikte-odak]'); if (!el) return false; const r = el.getBoundingClientRect(); return r.left <= 1 && r.top <= 1 && r.width >= innerWidth - 2 && r.height >= innerHeight - 2; })()`;
  check('sadece video: oynatıcı alanı kaplıyor (A ve B)', (await soon(() => inPage(A, FILLS), 5000)) && (await soon(() => inPage(B, FILLS), 5000)));
  await A.waitForTimeout(3500); // oynarken kontroller gizlenir
  await moveMouseInPage(A);
  check('fare sayfanın üstünde hareket edince kontroller görünüyor', await uiShown(A));
  await A.getByRole('button', { name: 'Sayfayı göster' }).click();
  check('sadece video: düğmeyle sayfaya dönüldü', await soon(async () => !(await inPage(A, `!!document.querySelector('[data-birlikte-odak]')`)), 5000));
  await moveMouseInPage(A);
  await A.getByRole('button', { name: 'Sadece video' }).click();
  check('sadece video: tekrar açıldı', await soon(() => inPage(A, FILLS), 5000));

  await inPage(B, `${FIND}.currentTime = 20`);
  check('bölüm: B sayfada sardı → A da 20. saniyeye geldi', await soon(async () => Math.abs((await videoState(A)).t - 21) < 2.5, 10_000));
  await A.waitForTimeout(3000);
  d = await drift();
  check('bölüm: sardıktan sonra yine aynı anda (fark < 150 ms)', Math.abs(d) < 0.15, fmt(d));

  // --- A uygulama içinde başka sayfaya geçer (oynatıcı iframe'de): B takip eder -------------------
  await byUser(A, `location.href = ${JSON.stringify(PAGE_IFRAME)}`);
  check(
    'kumanda: A sayfa değiştirdi → B de aynı sayfaya geçti',
    await until(B, (u) => window.__birlikte.state().syncMode && window.__birlikte.state().webVideo?.url === u, PAGE_IFRAME, 20_000),
  );
  await cmd(A, 'play');
  check('kumanda: iframe\'deki video ikisinde de oynuyor', (await playing(A)) && (await playing(B)));
  check('kumanda: iframe\'deki oynatıcı da alanı kaplıyor', await soon(() => inPage(B, FILLS), 5000));
  await cmd(A, 'pause');
  check('kumanda: A durdurdu → B de durdu', await paused(B));

  // --- Sayfada geri: başka videolara bakmak izleme ekranından çıkarmaz ----------------------------
  await moveMouseInPage(A);
  const pageBack = A.getByRole('button', { name: 'Sayfada geri' });
  check('geri: sayfada gezinince "Sayfada geri" düğmesi var', await visible(pageBack, 3000));
  await pageBack.click();
  check('geri: A önceki sayfaya döndü, hâlâ izleme ekranında', (await soon(async () => (await pageUrl(A)) === PAGE)) && (await state(A)).active);
  check('geri: B de o sayfaya geçti', await followsPage(B, PAGE));
  check('geri: ilk açılan sayfadan geriye gidilmiyor (boş sayfaya düşmez)', await soon(() => A.evaluate(() => !document.querySelector('[aria-label="Sayfada geri"]')), 3000));
  // Takip eden de sayfada gezinip başka bölüm seçebilir: kumanda ona geçer, öbürü takip eder
  await moveMouseInPage(B);
  await byUser(B, `location.href = ${JSON.stringify(PAGE_IFRAME)}`);
  check('kumanda: B sayfada başka bölüm seçti → A takip ediyor', await followsPage(A, PAGE_IFRAME));

  // --- Biri ana ekrana çıkıp geri gelince: sayfası açılır, takip eder, kamera/ses iki yönde ---------
  await moveMouseInPage(A);
  await A.getByRole('button', { name: 'Ana ekran' }).click();
  check('çıkıp dönünce: B "izleme ekranından çıktı" gördü', await visible(B.locator('.hud', { hasText: 'izleme ekranından çıktı' }), 5000));
  await A.getByRole('button', { name: 'Katıl' }).click();
  check(
    'çıkıp dönünce: A\'nın sayfası yeniden açıldı ve takip ediyor',
    await until(A, (u) => { try { return window.__birlikte.state().syncMode && window.__birlikte.watch.webview.el.getURL() === u; } catch { return false; } }, PAGE_IFRAME, 30_000),
  );
  check('çıkıp dönünce: B, A\'yı görüyor ve duyuyor', await soon(() => camFlowing(B), 15_000));
  check('çıkıp dönünce: A, B\'yi görüyor ve duyuyor', await soon(() => camFlowing(A), 15_000));

  // --- Pazarlık yarım kalırsa (kanal açık ama kamera/ses gelmiyor) bağlantı kendini sessizce yeniler ---
  await B.evaluate(() => window.__birlikte.watch.link.pc.getSenders().forEach((s) => s.track && s.replaceTrack(null)));
  check('yenileme: B\'nin görüntüsü/sesi kesildi', await soon(async () => !(await camFlowing(A)), 6000));
  check('yenileme: A fark edip bağlantıyı yeniledi, görüntü/ses geri geldi', await soon(() => camFlowing(A), 40_000));
  check('yenileme: kimse "bağlantı koptu" demedi', !(await A.locator('.hud').allInnerTexts()).concat(await B.locator('.hud').allInnerTexts()).some((t) => t.includes('koptu')));
  check('yenileme: ikisi de hâlâ birlikte izliyor', (await followsPage(A, PAGE_IFRAME)) && (await state(B)).role === 'host');

  await A.screenshot({ path: join(OUT, 'uygulama-ici-A.png') });
  await B.screenshot({ path: join(OUT, 'uygulama-ici-B.png') });

  // --- İzleme ekranından çıkınca sayfa kapanır (arkada ses kalmaz) --------------------------------
  await moveMouseInPage(A);
  await A.getByRole('button', { name: 'Ana ekran' }).click();
  check('çıkınca sayfa kapandı', await soon(async () => (await pageUrl(A)) === 'about:blank', 5000));

  const real = errors.filter((e) => !/favicon|Autofill/.test(e));
  check('konsolda hata yok', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  fail();
} finally {
  site.close();
  await cleanup();
}
process.exit(finish());
