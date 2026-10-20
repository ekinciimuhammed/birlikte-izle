// Gerçek Electron testi: uygulamayı üretim ayarlarıyla derler, iki ayrı profille iki pencere
// açar (A ve B), eşleştirir ve birlikte izletir.  →  npm run test:electron
// Not: test sırasında ekranda iki pencere kısa süreliğine görünür.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..');
const OUT = join(import.meta.dirname, 'output');
const SIGNAL_PORT = 8790;
const VIDEO = join(tmpdir(), 'birlikte-izle-test-30sn.webm');
const RUN = Date.now().toString(36);
const PROFILES = [`test-a-${RUN}`, `test-b-${RUN}`];
const APPDATA = process.env.APPDATA ?? join(process.env.HOME ?? '', 'Library/Application Support');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

if (!existsSync(VIDEO)) {
  console.error('Önce `npm test` çalıştır: test videosunu o üretir.');
  process.exit(1);
}

const build = spawnSync('npx electron-vite build', {
  cwd: ROOT,
  shell: true,
  env: { ...process.env, VITE_SIGNAL_URL: `http://127.0.0.1:${SIGNAL_PORT}` },
  encoding: 'utf8',
});
check('üretim derlemesi', build.status === 0, build.status === 0 ? '' : build.stderr.slice(-300));

const signal = spawn(`npx wrangler dev --port ${SIGNAL_PORT} --ip 127.0.0.1`, {
  cwd: join(ROOT, '../../services/signal'),
  shell: true,
  detached: process.platform !== 'win32', // macOS/Linux: süreç grubu olarak kapatabilmek için
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Sinyal sunucusu açılmadı')), 90_000);
  signal.stdout.on('data', (d) => d.toString().includes('Ready on') && (clearTimeout(timer), resolve()));
});

const apps = [];
const errors = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const app of apps) await app.close().catch(() => {});
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(signal.pid), '/T', '/F']);
  else killGroup(signal);
  for (const p of PROFILES) rmSync(join(APPDATA, `Birlikte İzle (${p})`), { recursive: true, force: true });
}
// Ne olursa olsun arkada sunucu ya da pencere kalmasın.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
}

try {
  const launch = async (profile, who) => {
    const options = {
      executablePath: require('electron'),
      args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
      cwd: ROOT,
      // VS Code eklentileri gibi bazı ortamlar bunu tanımlar; Electron'u düz Node'a çevirir.
      env: { ...withoutRunAsNode(), BIRLIKTE_PROFILE: profile, BIRLIKTE_TEST: '1', BIRLIKTE_TEST_SLOT: who === 'B' ? '1' : '0' },
    };
    // Windows'ta Playwright bazen ilk denemede bağlanamıyor: bir kez daha dene.
    const app = await electron.launch(options).catch(async (err) => {
      if (!/failed to launch|Timeout|ETIMEDOUT|WebSocket error/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 2000));
      return electron.launch(options);
    });
    apps.push(app);
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${who}: ${m.text()}`));
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
  };
  const visible = (locator, timeout = 15_000) => locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  const until = (page, fn, arg, timeout = 20_000) =>
    page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);

  const { page: A } = await launch(PROFILES[0], 'A');
  const { page: B } = await launch(PROFILES[1], 'B');

  check('köprü (preload) çalışıyor', (await A.evaluate(() => window.birlikte?.platform)) === process.platform);
  check('üretimde güvenlik politikası var', await A.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')));

  for (const [page, name] of [[A, 'Ali'], [B, 'Bade']]) {
    await page.getByRole('button', { name: 'Başla' }).click();
    await page.getByLabel('Adın').fill(name);
    await page.getByRole('button', { name: 'Devam' }).click();
  }
  await A.getByRole('button', { name: /Kod oluştur/ }).click();
  check('kod oluştu', await until(A, () => document.querySelectorAll('.code-cell')[5]?.textContent?.length === 1));
  const code = await A.$$eval('.code-cell', (cells) => cells.map((c) => c.textContent).join(''));
  await B.getByRole('button', { name: /Kodum var/ }).click();
  await B.getByLabel('Eşleşme kodu').fill(code);
  check('eşleşti', (await visible(B.getByText('Eşleştiniz'))) && (await visible(A.getByText('Eşleştiniz'))));
  await A.getByRole('button', { name: 'Başlayalım' }).click();
  await B.getByRole('button', { name: 'Başlayalım' }).click();

  const settingsFile = join(APPDATA, `Birlikte İzle (${PROFILES[0]})`, 'ayarlar.json');
  await A.waitForTimeout(600);
  const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  check('ayarlar dosyaya kaydedildi', saved['profile.name'] === 'Ali' && !!saved['pairing.coupleId']);

  // Ayarlar → Bağlantı → "Bağlantıyı test et" (yerel sunucuda TURN anahtarı yok)
  await A.getByRole('button', { name: 'Ayarlar' }).click();
  await A.getByRole('button', { name: 'Bağlantı', exact: true }).click();
  await A.getByRole('button', { name: 'Bağlantıyı test et' }).click();
  const healthRow = (text) => A.locator('.settings .row', { hasText: text });
  check('bağlantı testi: sunucuya ulaşılıyor', await visible(healthRow('Ulaşılıyor'), 20_000));
  check('bağlantı testi: doğrudan bağlantı ölçüldü', await visible(healthRow('Doğrudan bağlantı'), 1000));
  check('bağlantı testi: TURN olmadığını söylüyor', await visible(healthRow('Sunucuda tanımlı değil'), 1000));
  await A.getByRole('button', { name: 'Bitti' }).click();

  // Teşhis: kamera izleri kim tarafından, ne zaman durduruluyor?
  for (const page of [A, B]) {
    await page.evaluate(() => {
      window.__tracks = [];
      const t0 = performance.now();
      const log = (m) => window.__tracks.push(`${Math.round(performance.now() - t0)}ms ${m}`);
      const stop = MediaStreamTrack.prototype.stop;
      MediaStreamTrack.prototype.stop = function () {
        log(`stop() ${this.kind} ${this.label.slice(0, 20)} ← ${new Error().stack.split('\n').slice(2, 4).join(' ← ').replace(/\s+/g, ' ')}`);
        return stop.call(this);
      };
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await gum(c);
        for (const t of s.getTracks()) {
          log(`açıldı ${t.kind} ${t.label.slice(0, 20)}`);
          t.addEventListener('ended', () => log(`KENDİLİĞİNDEN bitti ${t.kind}`));
        }
        return s;
      };
    });
  }
  await A.getByRole('button', { name: /Birlikte İzle/ }).click();
  await B.getByRole('button', { name: 'Katıl' }).click();
  check('P2P bağlandı', await visible(A.locator('.watch-topbar .pill', { hasText: 'Bade burada' }), 25_000));
  check('kanallar: boş ekranda kanal düğmeleri var', await visible(A.locator('.channel-chip', { hasText: 'Kanal D' }), 3000));
  await A.getByRole('button', { name: 'Kanallar' }).click();
  check('kanallar: üst çubuktaki menü açılıyor', await visible(A.getByRole('menuitem', { name: 'Netflix' }), 3000));
  await A.keyboard.press('Escape');

  await A.setInputFiles('input[type=file]', VIDEO);
  check(
    'B filmi alıyor',
    await until(B, () => document.querySelectorAll('.media-slot')[1]?.querySelector('video')?.videoWidth > 0),
  );
  await B.evaluate(() => {
    window.__events = [];
    const t0 = performance.now();
    for (const type of ['click', 'dblclick', 'keydown', 'pointerdown', 'pointerup']) {
      document.addEventListener(
        type,
        (e) => window.__events.push(`${Math.round(performance.now() - t0)}ms ${type} ${e.target.className || e.target.tagName} ${e.key ?? ''} trusted=${e.isTrusted}`),
        true,
      );
    }
  });
  await B.getByRole('button', { name: /^Oynat/ }).click();
  check(
    'A oynatıyor (B başlattı)',
    await until(A, () => !document.querySelectorAll('.media-slot')[0]?.querySelector('video')?.paused),
  );
  const hostPaused = () => A.evaluate(() => document.querySelectorAll('.media-slot')[0]?.querySelector('video')?.paused);
  await B.waitForTimeout(4000);
  check('4 sn sonra hâlâ oynuyor', (await hostPaused()) === false);
  console.log('   B olayları:', JSON.stringify(await B.evaluate(() => window.__events)));
  // İlk koşuda film tam bu hareketlerden sonra durmuştu: aynısını tekrarla.
  await A.mouse.move(640, 400);
  await B.mouse.move(640, 400);
  await B.waitForTimeout(800);
  check('fare hareketi filmi durdurmuyor', (await hostPaused()) === false);
  console.log('   B olayları (fare sonrası):', JSON.stringify(await B.evaluate(() => window.__events)));
  await B.mouse.move(300, 300);
  await B.mouse.move(640, 400, { steps: 5 });
  await B.waitForTimeout(500);
  check('B fareyi gezdirince film durmuyor', (await hostPaused()) === false);
  await A.screenshot({ path: join(OUT, 'electron-A-paylasan.png') });
  await B.screenshot({ path: join(OUT, 'electron-B-izleyen.png') });

  const camState = () =>
    [...document.querySelectorAll('.bubble')].map((b) => {
      const v = b.querySelector('video');
      return {
        cls: b.className,
        paused: v?.paused,
        ready: v?.readyState,
        w: v?.videoWidth,
        tracks: v?.srcObject?.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'live'}`),
      };
    });
  console.log('   A izler:', JSON.stringify(await A.evaluate(() => window.__tracks)));
  console.log('   B izler:', JSON.stringify(await B.evaluate(() => window.__tracks)));
  console.log('   A kameralar:', JSON.stringify(await A.evaluate(camState)));
  console.log('   B kameralar:', JSON.stringify(await B.evaluate(camState)));
  await B.getByRole('button', { name: 'Bağlantı bilgisi' }).click();
  await B.waitForTimeout(2500);
  const rows = await B.locator('.stats-panel .row').allInnerTexts();
  console.log('   B bağlantı:', rows.map((t) => t.split(/\s*\n\s*/).join(': ')).join(' | '));

  // Her baloncuk ya canlı görüntü gösteriyor ya da düzgünce "kapalı" görünüyor; donmuş kare yok.
  // Not: Aynı bilgisayardaki iki Electron, Chromium'un sahte kamerasını birlikte kullanınca biri
  // kendiliğinden düşüyor (uygulama kodu olmadan da tekrarlanıyor). Bu yüzden burada "canlı"
  // değil "dürüst" bekliyoruz; kendini toparlama yolunu web testi (e2e.mjs) doğruluyor.
  const camsHonest = () =>
    [...document.querySelectorAll('.bubble')].every((b) => {
      if (b.classList.contains('off')) return true;
      const v = b.querySelector('video');
      return !v.paused && v.videoWidth > 0 && v.srcObject?.getVideoTracks().every((t) => t.readyState === 'live');
    });
  check('A kamera baloncukları dürüst (canlı ya da kapalı)', await until(A, camsHonest, null, 8000));
  check('B kamera baloncukları dürüst (canlı ya da kapalı)', await until(B, camsHonest, null, 8000));

  // Kamera baloncuğu köşedeki tutamaçtan çekilerek boyutlanır, hatırlanır; çift tıklayınca büyür
  const peerBubble = A.locator('.cams .bubble').first();
  const bubbleWidth = async () => Math.round((await peerBubble.boundingBox()).width);
  const w0 = await bubbleWidth();
  await peerBubble.hover();
  const grip = await peerBubble.locator('.bubble-resize').boundingBox();
  // Baloncuklar sağ altta: tutamaç sol üst köşede, sola/yukarı çekince büyür
  await A.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await A.mouse.down();
  await A.mouse.move(grip.x + grip.width / 2 - 140, grip.y + grip.height / 2 - 20, { steps: 10 });
  await A.mouse.up();
  await A.waitForTimeout(500);
  const w1 = await bubbleWidth();
  check('kamera: köşeden çekince büyüdü', w1 >= w0 + 100, `${w0} → ${w1} px`);
  check('kamera: boyut hatırlanıyor', Math.abs(Number(await A.evaluate(() => window.__birlikte.getSetting('ui.camPeerWidth'))) - w1) <= 2);
  await peerBubble.dblclick();
  await A.waitForTimeout(500);
  const w2 = await bubbleWidth();
  check('kamera: çift tıklayınca büyüdü', w2 > w1 + 40, `${w1} → ${w2} px`);
  await peerBubble.dblclick();
  await A.waitForTimeout(500);
  check('kamera: tekrar çift tıklayınca eski boyuna döndü', Math.abs((await bubbleWidth()) - w1) <= 2);
  const pb = await peerBubble.boundingBox();
  await A.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await A.mouse.down();
  await A.mouse.move(120, 160, { steps: 12 });
  await A.mouse.up();
  check('kamera: sürükleyince sol üst köşeye taşındı', await until(A, () => window.__birlikte.getSetting('ui.camCorner') === 'tl', null, 2000));

  // Gizle/göster: sadece bu ekranda; kamera açık kalır, onun görüntü/ses öğesi durmaz (sesi kesilmez)
  const peerVideo = () =>
    A.evaluate(() => {
      const v = document.querySelector('.cams .bubble video');
      return v ? { paused: v.paused, inDoc: v.isConnected } : null;
    });
  const before = await peerVideo();
  await A.keyboard.press('k');
  check('gizle: K ile iki baloncuk da gizlendi', await until(A, () => [...document.querySelectorAll('.cams .bubble')].every((b) => b.classList.contains('hidden')), null, 2000));
  check('gizle: köşede "Kameralar gizli · Göster" var', await visible(A.locator('.cams-hidden', { hasText: 'Kameralar gizli' }), 2000));
  const during = await peerVideo();
  check(
    'gizle: onun görüntü/ses öğesi yerinde ve durmadı, kamera açık',
    !!during?.inDoc && during.paused === before?.paused && (await A.evaluate(() => window.__birlikte.state().camOn)),
    JSON.stringify({ before, during }),
  );
  await A.locator('.cams-hidden').click();
  check('göster: tıklayınca geri geldi', await until(A, () => !document.querySelector('.cams .bubble.hidden') && !document.querySelector('.cams-hidden'), null, 2000));
  await peerBubble.hover();
  await peerBubble.locator('.bubble-hide').click();
  check(
    'tek tek: × ile sadece onunki gizlendi',
    await until(A, () => {
      const b = document.querySelectorAll('.cams .bubble');
      return b[0].classList.contains('hidden') && !b[1].classList.contains('hidden');
    }, null, 2000),
  );
  check('tek tek: köşede "Bade gizli · Göster"', await visible(A.locator('.cams-hidden', { hasText: 'Bade gizli' }), 2000));
  await A.locator('.cams-hidden').click();

  // Sürüm uyarısı: aynı sürümde yok (sürüm gerçekten gönderiliyor); biri eskiyse/yeniyse uyarır
  check('sürüm: aynı sürümde uyarı yok', (await A.evaluate(() => window.__birlikte.state().versionNotice)) === null);
  await A.evaluate(() => window.__birlikte.watch['checkVersions'](true, '0.3.0'));
  check('sürüm: karşı taraf eskiyse uyarıyor', await visible(A.locator('.connection-help', { hasText: 'eski bir sürüm' }), 2000));
  await A.evaluate(() => window.__birlikte.watch['checkVersions'](true, '99.0.0'));
  check('sürüm: karşı taraf yeniyse "sen de güncelle"', await visible(A.locator('.connection-help', { hasText: 'sen de güncelle' }), 2000));
  await A.evaluate(() => window.birlikte.version().then((v) => window.__birlikte.watch['checkVersions'](true, v)));
  check('sürüm: aynı sürüme dönünce uyarı kalktı', await until(A, () => !document.querySelector('.connection-help'), null, 2000));
  check('pencerelerde hata yok', errors.length === 0, errors.slice(0, 3).join(' | '));

  // Bağlanılamayınca sonsuz "bağlanıyor" yerine sebep: B aktarmayı "Her zaman" yapar ama sunucuda TURN yok.
  await B.evaluate(() => window.__birlikte.setSetting('connection.turn', 'always'));
  await B.getByRole('button', { name: 'Ana ekran' }).click();
  // Ayrılınca haber: "görüşürüz" gelir, film durur; ardından kapanan bağlantı "koptu" sayılmaz
  check('ayrılınca: A "izleme ekranından çıktı" diyor', await visible(A.locator('.hud', { hasText: 'izleme ekranından çıktı' }), 5000));
  check('ayrılınca: A\'nın filmi durdu', await until(A, () => window.__birlikte.watch.localMovie.paused, null, 3000));
  await A.waitForTimeout(1000);
  check('ayrılınca: "bağlantı koptu" demiyor', !(await A.locator('.hud').innerText().catch(() => '')).includes('koptu'));
  await B.getByRole('button', { name: 'Katıl' }).click();
  check('bağlanamayınca B sebebini söylüyor', await visible(B.locator('.connection-help', { hasText: 'Her zaman' }), 45_000));
  check('bağlanamayınca A da uyarıyor', await visible(A.locator('.connection-help', { hasText: 'bağlantı kurulamadı' }), 10_000));
  await B.evaluate(() => window.__birlikte.setSetting('connection.turn', 'auto'));
  await B.getByRole('button', { name: 'Ana ekran' }).click();
  await B.getByRole('button', { name: 'Katıl' }).click();
  check(
    'bağlanınca uyarı kalkıyor',
    (await visible(A.locator('.watch-topbar .pill', { hasText: 'Bade burada' }), 25_000)) &&
      (await until(A, () => !document.querySelector('.connection-help'), null, 2000)),
  );

  // Uygulamadan çıkış: pencere kapanırken "görüşürüz (quit)" gider
  await B.evaluate(() => window.__birlikte.watch['sayBye']('quit'));
  check('kapatınca: A "uygulamayı kapattı" diyor', await visible(A.locator('.hud', { hasText: 'uygulamayı kapattı' }), 5000));
  // "Görüşürüz" olmadan kapanan bağlantı: koptu
  await A.evaluate(() => (window.__birlikte.watch['peerBye'] = null));
  await B.evaluate(() => window.__birlikte.watch.link.pc.close());
  check('kopunca: A "bağlantı koptu" diyor', await visible(A.locator('.hud', { hasText: 'bağlantı koptu' }), 10_000));
} catch (err) {
  console.error(err);
  results.push(false);
} finally {
  await cleanup();
}

function withoutRunAsNode() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
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
