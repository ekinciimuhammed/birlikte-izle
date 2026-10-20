// Tarayıcı eklentisi testi (gerçek Electron ×2 + eklentili gerçek Edge ×2 + Netflix'i taklit eden
// yerel bir video sitesi): A tarayıcıda bölüm açar, uygulamada "Birlikte izle"ye basar; B'nin
// tarayıcısında aynı sayfa kendiliğinden açılır ve senkron oynar. Uygulamadan da tarayıcıdan da
// (elle durdurma/oynatma/sarma) kontrol iki tarafa geçiyor mu?   →  npm run test:extension
// Not: Chrome 137+ komut satırından eklenti yüklemeyi kapattı; test Edge ile çalışır (yoksa atlanır).

import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { makeBigFixture } from './lib/fixtures.mjs';
import { createChecks, enterWatch, OUT, pair, ROOT, startPair, until, visible } from './lib/harness.mjs';

const EDGE = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
].find((p) => p && existsSync(p));
if (!EDGE) {
  console.log('ATLANDI  Microsoft Edge bulunamadı (EDGE_PATH ile yolunu ver)');
  process.exit(0);
}

const { check, finish, fail } = createChecks();
const EXT = join(ROOT, '..', 'extension');
const VIDEO = makeBigFixture(); // 60 sn
const SITE_PORT = 8797;
const PAGE = `http://127.0.0.1:${SITE_PORT}/izle/bolum-1`;

// "Video sitesi": izleme sayfası + parça parça (Range) video
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
  res.end(`<!doctype html><title>Deneme Dizisi 1. Bölüm | Yerel sunucu</title>
    <body style="margin:0;background:#000"><video src="/video.mp4" style="width:960px;height:540px" preload="auto"></video></body>`);
}).listen(SITE_PORT, '127.0.0.1');

const { A, B, errors, cleanup } = await startPair({
  port: 8795,
  env: { A: { BIRLIKTE_EXT_PORT: '47711' }, B: { BIRLIKTE_EXT_PORT: '47712' } },
});
const profiles = [];
const browsers = [];

/** Eklentili Edge; eklenti, verilen kapıdaki uygulamaya bağlanır */
async function launchEdge(port) {
  const dir = mkdtempSync(join(tmpdir(), 'birlikte-edge-'));
  profiles.push(dir);
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1000, height: 600 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  browsers.push(ctx);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate((p) => chrome.storage.local.set({ port: p }).then(() => connect()), port);
  return ctx;
}

const videoState = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video');
    return { t: v.currentTime, w: Date.now(), playing: !v.paused };
  });
/** İki tarayıcı aynı bilgisayarın saatini görür: A'yı B'nin ölçüldüğü ana taşı. */
const drift = async (pa, pb) => {
  const a = await videoState(pa);
  const b = await videoState(pb);
  return a.t + (a.playing ? (b.w - a.w) / 1000 : 0) - b.t;
};
const fmt = (d) => `${Math.round(d * 1000)} ms`;
const cmd = (page, action, value) => page.evaluate(([a, v]) => window.__birlikte.watch.command(a, v), [action, value]);
const playing = (page) => page.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 8000 }).then(() => true, () => false);
const paused = (page) => page.waitForFunction(() => document.querySelector('video').paused, null, { timeout: 8000 }).then(() => true, () => false);

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));

  const EA = await launchEdge(47711);
  const EB = await launchEdge(47712);
  check('A uygulaması eklentiyi gördü', await until(A, () => window.__birlikte.extension().connected, null, 15_000));
  check('B uygulaması eklentiyi gördü', await until(B, () => window.__birlikte.extension().connected, null, 15_000));
  check('tarayıcı adı geldi (Edge)', (await A.evaluate(() => window.__birlikte.extension().browser)) === 'Edge');

  // --- A tarayıcıda bölümü açar, uygulamada "Birlikte izle" ---------------------------------
  const pa = await EA.newPage();
  await pa.goto(PAGE);
  check('A: tarayıcıdaki video bulundu', await until(A, () => window.__birlikte.extension().video?.url.includes('/izle/bolum-1'), null, 15_000));
  check('A: başlık sekmeden geldi', /Deneme Dizisi 1\. Bölüm/.test(await A.evaluate(() => window.__birlikte.extension().video?.title ?? '')));
  await A.getByRole('button', { name: 'Birlikte izle' }).click();
  check('A: tarayıcı modunda host', await until(A, () => window.__birlikte.state().role === 'host' && window.__birlikte.state().source === 'browser', null, 5000));

  // --- B'nin tarayıcısında aynı sayfa kendiliğinden açılır ------------------------------------
  const pbPromise = EB.pages().find((p) => p.url().includes('/izle/bolum-1')) ?? EB.waitForEvent('page', { timeout: 15_000 });
  const pb = await pbPromise;
  await pb.waitForLoadState('domcontentloaded');
  check('B: aynı bölüm B\'nin tarayıcısında açıldı', pb.url().startsWith(PAGE));
  check('B: senkron modda (kendi tarayıcısından)', await until(B, () => window.__birlikte.state().syncMode && window.__birlikte.state().source === 'browser', null, 20_000));
  check('B: ekranda "Tarayıcında oynuyor"', await visible(B.locator('.browser-stage', { hasText: 'Tarayıcında oynuyor' }), 5000));

  // --- Uygulamadan kontrol ---------------------------------------------------------------------
  await cmd(A, 'play');
  check('A uygulamadan oynattı → A tarayıcısı oynuyor', await playing(pa));
  check('B tarayıcısı da oynuyor', await playing(pb));
  await A.waitForTimeout(4000);
  let d = await drift(pa, pb);
  check('iki tarayıcı arasındaki fark < 120 ms', Math.abs(d) < 0.12, fmt(d));

  await cmd(B, 'seek', 30);
  await A.waitForTimeout(2500);
  const at = await videoState(pa);
  d = await drift(pa, pb);
  check('B uygulamadan sardı → ikisi de 30. saniyede', at.t > 30 && at.t < 34 && Math.abs(d) < 0.15, `${at.t.toFixed(1)} sn, fark ${fmt(d)}`);

  // --- Tarayıcıda elle (Netflix'te boşluk tuşu gibi) -------------------------------------------
  await pa.evaluate(() => document.querySelector('video').pause());
  check('A tarayıcıda elle durdurdu → B de durdu', await paused(pb));
  await pb.evaluate(() => document.querySelector('video').play());
  check('B tarayıcıda elle oynattı → A da oynadı', await playing(pa));
  await pb.waitForTimeout(1500);
  await pb.evaluate(() => (document.querySelector('video').currentTime = 10));
  check(
    'B tarayıcıda elle sardı → A da 10. saniyeye geldi',
    await pa.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 11) < 2, null, { timeout: 8000 }).then(() => true, () => false),
  );
  await A.waitForTimeout(2500);
  d = await drift(pa, pb);
  check('sonra yine aynı anda (fark < 150 ms)', Math.abs(d) < 0.15, fmt(d));

  await cmd(A, 'pause');
  check('A uygulamadan durdurdu → iki tarayıcı da durdu', (await paused(pa)) && (await paused(pb)));

  await A.screenshot({ path: join(OUT, 'eklenti-A.png') });
  await B.screenshot({ path: join(OUT, 'eklenti-B.png') });
  const real = errors.filter((e) => !/favicon|Autofill/.test(e));
  check('konsolda hata yok', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  fail();
} finally {
  for (const ctx of browsers) await ctx.close().catch(() => {});
  for (const dir of profiles) rmSync(dir, { recursive: true, force: true });
  site.close();
  await cleanup();
}
process.exit(finish());
