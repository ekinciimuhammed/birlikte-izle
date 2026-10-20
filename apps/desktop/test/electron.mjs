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
    const app = await electron.launch({
      executablePath: require('electron'),
      args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
      cwd: ROOT,
      // VS Code eklentileri gibi bazı ortamlar bunu tanımlar; Electron'u düz Node'a çevirir.
      env: { ...withoutRunAsNode(), BIRLIKTE_PROFILE: profile, BIRLIKTE_TEST: '1', BIRLIKTE_TEST_SLOT: who === 'B' ? '1' : '0' },
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
  check('pencerelerde hata yok', errors.length === 0, errors.slice(0, 3).join(' | '));
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
