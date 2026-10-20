// Paketlenmiş uygulama testi: kurulum dosyasına girecek hali (release/…-unpacked) açılıyor mu,
// içindeki ffmpeg çalışıyor mu, uygulama içi sayfanın betiği paketten yükleniyor mu?
//   →  npm run dist:dir && npm run test:packaged

import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { makeBigFixture, makeFixtures } from './lib/fixtures.mjs';
import { APPDATA, createChecks, ROOT } from './lib/harness.mjs';

const { check, finish, fail } = createChecks();
const exe = {
  win32: join(ROOT, 'release/win-unpacked/birlikte-izle.exe'),
  darwin: macExecutable(),
  linux: join(ROOT, 'release/linux-unpacked/birlikte-izle'),
}[process.platform];

/** release/mac-arm64 (Apple Silicon), release/mac (Intel) ya da release/mac-universal içindeki .app */
function macExecutable() {
  const release = join(ROOT, 'release');
  const dirs = existsSync(release) ? readdirSync(release).filter((d) => d.startsWith('mac')) : [];
  // Bu Mac'in kendi mimarisi önce (Apple Silicon'da Intel paketi de varsa Rosetta'ya düşmesin)
  dirs.sort((a, b) => Number(b === `mac-${process.arch}`) - Number(a === `mac-${process.arch}`));
  for (const dir of dirs) {
    const app = readdirSync(join(release, dir)).find((f) => f.endsWith('.app'));
    const bin = app && join(release, dir, app, 'Contents', 'MacOS');
    const name = bin && existsSync(bin) && readdirSync(bin)[0];
    if (name) return join(bin, name);
  }
  return join(release, 'mac-arm64', '*.app');
}

if (!existsSync(exe)) {
  console.error(`Paket yok: ${exe}\nÖnce: npm run dist:dir`);
  process.exit(1);
}

const files = makeFixtures();
// Uygulama içi sayfa için yerel bir video sayfası (gerçekte Kanallar/YouTube)
const VIDEO = makeBigFixture();
const site = createServer((req, res) => {
  if (!req.url.startsWith('/video.mp4')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>Deneme</title><video src="/video.mp4" style="width:100%;height:100%" preload="auto"></video>');
  }
  const size = statSync(VIDEO).size;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : size - 1;
  res.writeHead(m ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(m && { 'content-range': `bytes ${start}-${end}/${size}` }) });
  createReadStream(VIDEO, { start, end }).pipe(res);
}).listen(8789, '127.0.0.1');
const env = { ...process.env, BIRLIKTE_TEST: '1', BIRLIKTE_EMBED_LOCAL: '1', BIRLIKTE_PROFILE: `paket-${Date.now().toString(36)}` };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: exe, args: ['--mute-audio'], env });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const pkg = await import('../package.json', { with: { type: 'json' } });
  check('paketlenmiş uygulama açıldı', await page.evaluate(() => !!window.birlikte));
  check('sürüm doğru', (await page.evaluate(() => window.birlikte.version())) === pkg.default.version);

  const info = await page.evaluate((p) => window.birlikte.media.openPath(p), files.mkv);
  check('içindeki ffmpeg dosyayı okudu', info.audio.length === 2 && info.video?.codec === 'h264', `${info.audio.length} ses, ${info.video?.codec}`);
  const url = await page.evaluate((id) => window.birlikte.media.prepare(id, 0, 'aac'), info.id);
  check('içindeki ffmpeg AC3 sesi dönüştürdü', url.startsWith('birlikte-media://prepared/'), url);
  const subs = await page.evaluate((id) => window.birlikte.media.subtitles(id), info.id);
  check('gömülü altyazıyı çıkardı', subs.some((s) => /Merhaba/.test(s.text ?? '')), `${subs.length} altyazı`);
  // Tarayıcı eklentisi pakette (Ayarlar → "Klasörü aç" bunu gösterir)
  const resources = process.platform === 'darwin' ? join(dirname(exe), '..', 'Resources') : join(dirname(exe), 'resources');
  check('tarayıcı eklentisi pakette', existsSync(join(resources, 'extension', 'manifest.json')) && !existsSync(join(resources, 'extension', 'package.json')));

  // Uygulama içi sayfa (Kanallar, YouTube): paketin içindeki sayfa betiği (preload/web.js) yükleniyor mu?
  await page.evaluate(() => {
    const view = window.__birlikte.watch.webview;
    view.el.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px';
    document.body.appendChild(view.el);
    view.open('http://127.0.0.1:8789/izle');
  });
  check(
    'uygulama içi sayfada video bulundu (paketteki betik çalışıyor)',
    await page.waitForFunction(() => !!window.__birlikte.watch.webview.link.getVideo(), null, { timeout: 20_000 }).then(() => true, () => false),
  );
} catch (err) {
  console.error(err);
  fail();
} finally {
  await app.close().catch(() => {});
  site.close();
  rmSync(join(APPDATA, `Birlikte İzle (${env.BIRLIKTE_PROFILE})`), { recursive: true, force: true });
}
process.exit(finish());
