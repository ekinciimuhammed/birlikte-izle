// Tarayıcı eklentisi testi (gerçek Electron ×2 + eklentili gerçek Edge ×2 + Netflix'i taklit eden
// yerel bir video sitesi): A tarayıcıda bölüm açar, uygulamada "Birlikte izle"ye basar; B'nin
// tarayıcısında aynı sayfa kendiliğinden açılır ve senkron oynar. Uygulamadan da tarayıcıdan da
// (elle durdurma/oynatma/sarma) kontrol iki tarafa geçiyor mu? Oynatıcı iframe içindeyken de
// (Kanal D, TV8 gibi) bulunuyor mu?   →  npm run test:extension
// Not: Chrome 137+ komut satırından eklenti yüklemeyi kapattı; test Edge ile çalışır (yoksa atlanır).
// EDGE_PATH ile eklenti yükleyebilen başka bir Chromium da verilebilir (ör. Playwright'ın Chrome for Testing'i).

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
const BROWSER_NAME = /edge/i.test(EDGE) ? 'Edge' : 'Chrome';
const EXT = join(ROOT, '..', 'extension');
const VIDEO = makeBigFixture(); // 60 sn
const SITE_PORT = 8797;
const PAGE = `http://127.0.0.1:${SITE_PORT}/izle/bolum-1`;
const PAGE_IFRAME = `http://127.0.0.1:${SITE_PORT}/izle/bolum-2`; // oynatıcı iframe içinde
const PAGE_LIVE = `http://127.0.0.1:${SITE_PORT}/canli/kanal-1`; // canlı yayın gibi (süresi yok)

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
  if (req.url.startsWith('/izle/bolum-2')) {
    return res.end(`<!doctype html><title>Deneme Dizisi 2. Bölüm | Yerel sunucu</title>
      <body style="margin:0;background:#000"><iframe src="/oynatici/bolum-2" style="width:960px;height:540px;border:0"></iframe></body>`);
  }
  if (req.url.startsWith('/canli/')) {
    // Tuvalden akış: süresi sonsuz, zaman çizelgesi bu sayfaya özel (gerçek canlı yayın gibi)
    return res.end(`<!doctype html><title>Yerel Kanal Canlı | Yerel sunucu</title>
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
  if (req.url.startsWith('/oynatici/')) {
    return res.end(`<!doctype html><title>Oynatıcı</title>
      <body style="margin:0;background:#000"><video src="/video.mp4" style="width:100%;height:100%" preload="auto"></video></body>`);
  }
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
  // Eklenti açılır açılmaz varsayılan kapıyı dener; bu bilgisayarda gerçek uygulama açıksa ona
  // bağlanmış olabilir: test kapısını yazdıktan sonra o bağlantıyı bırakıp yeniden bağlan.
  await sw.evaluate(async (p) => {
    await chrome.storage.local.set({ port: p });
    while (connecting) await new Promise((r) => setTimeout(r, 100));
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
    }
    await connect();
  }, port);
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
const camsShown = (page) => until(page, () => !!document.querySelector('birlikte-kameralar'), null, 15_000);
/** Uygulamaya göre karşının kamerası açıksa sekmedeki baloncukta görüntü var (aynı bilgisayardaki iki
 * Electron'da sahte kameralardan biri bazen kendiliğinden düşüyor; o zaman baloncuk "kapalı" gösterir) */
const peerCamInTab = async (app, tab) => {
  if (!(await app.evaluate(() => window.__birlikte.state().peerCamOn))) return true;
  return until(tab, () => /^[1-9]/.test(document.querySelector('birlikte-kameralar')?.dataset.peer ?? ''), null, 20_000);
};
/** Baloncukların içinde (kapalı gölge) eklentinin kendi dünyasında çalışan kod; sayfanın betikleri oraya ulaşamaz */
async function inCams(page, code) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const ctx = contexts.find((c) => c.auxData?.frameId === frameTree.frame.id && !c.auxData?.isDefault && /Birlikte/.test(c.name));
  try {
    if (!ctx) throw new Error('eklentinin dünyası bulunamadı');
    const r = await cdp.send('Runtime.evaluate', { expression: `(() => { const root = window.__birlikteCams.root(); ${code} })()`, contextId: ctx.id, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
async function soonCams(page, code, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await inCams(page, code).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const playing = (page) => page.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 8000 }).then(() => true, () => false);
const paused = (page) => page.waitForFunction(() => document.querySelector('video').paused, null, { timeout: 8000 }).then(() => true, () => false);

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));

  const EA = await launchEdge(47711);
  const EB = await launchEdge(47712);
  check('A uygulaması eklentiyi gördü', await until(A, () => window.__birlikte.extension().connected, null, 15_000));
  check('B uygulaması eklentiyi gördü', await until(B, () => window.__birlikte.extension().connected, null, 15_000));
  check(`tarayıcı adı geldi (${BROWSER_NAME})`, (await A.evaluate(() => window.__birlikte.extension().browser)) === BROWSER_NAME);

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

  // --- Kameralar sitenin üstünde: eklenti baloncukları, görüntü uygulamadan (bilgisayarın içinden) ---
  check('kameralar: A\'nın sekmesinde baloncuklar var', await camsShown(pa));
  check('kameralar: B\'nin sekmesinde baloncuklar var', await camsShown(pb));
  check('kameralar: A\'nın sekmesinde Bade\'nin görüntüsü (açıksa) geliyor', await peerCamInTab(A, pa));
  check('kameralar: B\'nin sekmesinde Ali\'nin görüntüsü (açıksa) geliyor', await peerCamInTab(B, pb));
  check('kameralar: kendi görüntüsü de var', await until(pa, () => /^[1-9]/.test(document.querySelector('birlikte-kameralar')?.dataset.self ?? ''), null, 15_000));
  // Baloncuklardaki çubuk: kamera ve mikrofon uygulamadakiyle aynı aç/kapat; boyut köşeden; gizle/göster
  await inCams(pa, `root.querySelector('.bar .cam').click()`);
  check('çubuk: A sitede kamerayı kapattı → uygulamada da kapandı', await until(A, () => !window.__birlikte.state().camOn, null, 5000));
  check('çubuk: B\'nin sitesinde A\'nın baloncuğu "kapalı"', await soonCams(pb, `return root.querySelector('.cam.peer').classList.contains('is-off')`));
  await inCams(pa, `root.querySelector('.bar .cam').click()`);
  check('çubuk: tekrar açınca uygulamada da açıldı', await until(A, () => window.__birlikte.state().camOn, null, 10_000));
  await inCams(pa, `root.querySelector('.bar .mic').click()`);
  check('çubuk: mikrofonu kapattı → uygulamada kapandı, düğme kırmızı', (await until(A, () => !window.__birlikte.state().micOn, null, 5000)) && (await soonCams(pa, `return root.querySelector('.bar .mic').classList.contains('off')`)));
  check('çubuk: B\'nin sitesinde A\'nın baloncuğunda "sessiz" işareti', await soonCams(pb, `return root.querySelector('.cam.peer').classList.contains('muted')`));
  await inCams(pa, `root.querySelector('.bar .mic').click()`);
  check('çubuk: mikrofon yeniden açıldı', await until(A, () => window.__birlikte.state().micOn, null, 5000));
  const grip = await inCams(pa, `const r = root.querySelector('.grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: root.querySelector('.cam.peer').offsetWidth }`);
  await pa.mouse.move(grip.x, grip.y);
  await pa.mouse.down();
  await pa.mouse.move(grip.x - 90, grip.y + 40, { steps: 6 });
  await pa.mouse.up();
  const grown = await inCams(pa, `return root.querySelector('.cam.peer').offsetWidth`);
  check('boyut: köşeden çekince büyüdü', grown > grip.w + 40, `${grip.w} → ${grown} px`);
  await inCams(pa, `root.querySelector('.bar .hide-all').click()`);
  check('gizle: iki baloncuk da gizlendi, "Göster" var', await soonCams(pa, `return root.querySelector('.cam.peer').hidden && root.querySelector('.cam.self').hidden && !root.querySelector('.show').hidden`));
  await inCams(pa, `root.querySelector('.show').click()`);
  check('göster: geri geldi', await soonCams(pa, `return !root.querySelector('.cam.peer').hidden && !root.querySelector('.cam.self').hidden`));
  const peerBox = await inCams(pa, `const r = root.querySelector('.cam.peer').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`);
  await pa.mouse.move(peerBox.x, peerBox.y); // çubuk fareyle gelince görünür
  await pa.waitForTimeout(300);
  await pa.screenshot({ path: join(OUT, 'eklenti-sekme-cubuk.png') });

  // Eklenti uygulamanınkinden eskiyse (eski bir kopya yüklenmiş) uygulama söyler
  const helloAs = (ctx, version) => ctx.serviceWorkers()[0].evaluate((v) => toApp({ t: 'hello', browser: browserName(), version: v }), version);
  await helloAs(EB, '0.3.4');
  check('eski eklenti: B uyarıyor ("eklenti eski", güncelle düğmesi)', await visible(B.locator('.browser-warn', { hasText: 'eski (0.3.4' }), 5000));
  await helloAs(EB, await EB.serviceWorkers()[0].evaluate(() => VERSION));
  check('eski eklenti: güncel sürümde uyarı yok', await until(B, () => !document.querySelector('.browser-warn'), null, 5000));

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

  // --- Oynatıcı iframe içinde (Kanal D, TV8 gibi) ------------------------------------------------
  await pa.goto(PAGE_IFRAME);
  check(
    'iframe: video bulundu, paylaşılan bağlantı izleme sayfası',
    await until(A, (u) => window.__birlikte.extension().video?.url === u, PAGE_IFRAME, 15_000),
    await A.evaluate(() => window.__birlikte.extension().video?.url ?? '-'),
  );
  check('iframe: başlık izleme sayfasından', /Deneme Dizisi 2\. Bölüm/.test(await A.evaluate(() => window.__birlikte.extension().video?.title ?? '')));
  const player = pa.frames().find((f) => f.url().includes('/oynatici/'));
  await cmd(A, 'play');
  check(
    'iframe: uygulamadan oynatınca iframe\'deki video oynuyor',
    await player.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 8000 }).then(() => true, () => false),
  );
  await cmd(A, 'pause');
  check(
    'iframe: uygulamadan durdurunca duruyor',
    await player.waitForFunction(() => document.querySelector('video').paused, null, { timeout: 8000 }).then(() => true, () => false),
  );

  // --- Kanallar: A uygulamadan kanal seçer → iki tarafta da izlenen sekme o kanala geçer ---------
  const waitUrl = (page, url) => page.waitForURL(url, { timeout: 15_000 }).then(() => true, () => false);
  const tabs = [EA.pages().length, EB.pages().length];
  await A.evaluate((url) => window.__birlikte.watch.openChannel({ name: 'Yerel Kanal', url }), PAGE_LIVE);
  check('kanal: A\'nın sekmesi kanala geçti (yeni sekme açılmadı)', (await waitUrl(pa, PAGE_LIVE)) && EA.pages().length === tabs[0]);
  check('kanal: B\'nin sekmesi de geçti (yeni sekme açılmadı)', (await waitUrl(pb, PAGE_LIVE)) && EB.pages().length === tabs[1]);
  check(
    'kanal: A video belirince kendiliğinden birlikte izlemeye geçti',
    await until(A, (u) => window.__birlikte.state().role === 'host' && window.__birlikte.state().webVideo?.url === u, PAGE_LIVE, 20_000),
  );
  check('kanal: B onu takip ediyor (kendi tarayıcısından)', await until(B, () => window.__birlikte.state().syncMode && window.__birlikte.state().source === 'browser', null, 20_000));
  check('kanal: canlı yayın olarak tanındı', await A.evaluate(() => window.__birlikte.watch.browser.isLive));
  await cmd(A, 'play');
  check('canlı: A oynattı → iki tarayıcı da oynuyor', (await playing(pa)) && (await playing(pb)));
  await pb.evaluate(() => document.querySelector('video').pause());
  check('canlı: B tarayıcıda durdurdu → A da durdu', await paused(pa));
  await pb.evaluate(() => document.querySelector('video').play());
  check('canlı: B oynattı → A da oynadı', await playing(pa));

  // Normal bölüme dönüş: konum yine milisaniyeler içinde eşitleniyor
  await A.evaluate((url) => window.__birlikte.watch.openChannel({ name: 'Yerel Dizi', url }), PAGE);
  check('kanal değişti: iki sekme de bölüme geçti', (await waitUrl(pa, PAGE)) && (await waitUrl(pb, PAGE)));
  check(
    'kanal değişti: B yeni bölümü takip ediyor',
    await until(B, (u) => window.__birlikte.state().syncMode && window.__birlikte.state().webVideo?.url === u, PAGE, 20_000),
  );
  await cmd(A, 'play');
  await A.waitForTimeout(4000);
  d = await drift(pa, pb);
  check('kanal değişti: birlikte oynarken fark < 150 ms', (await playing(pb)) && Math.abs(d) < 0.15, fmt(d));
  await cmd(A, 'pause');
  check('kameralar: sekme yeni sayfaya geçince baloncuklar da geldi', (await camsShown(pa)) && (await peerCamInTab(A, pa)));
  await pa.screenshot({ path: join(OUT, 'eklenti-sekme-kameralar.png') });

  // İzleme ekranından çıkınca sitedeki baloncuklar da kalkar
  await A.getByRole('button', { name: 'Ana ekran' }).dispatchEvent('click');
  check('kameralar: A çıkınca kendi sekmesindeki baloncuklar kalktı', await until(pa, () => !document.querySelector('birlikte-kameralar'), null, 10_000));

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
