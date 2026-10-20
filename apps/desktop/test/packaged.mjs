// Paketlenmiş uygulama testi: kurulum dosyasına girecek hali (release/…-unpacked) açılıyor mu,
// içindeki ffmpeg çalışıyor mu?  →  npm run dist:dir && npm run test:packaged

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { makeFixtures } from './lib/fixtures.mjs';
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
const env = { ...process.env, BIRLIKTE_TEST: '1', BIRLIKTE_PROFILE: `paket-${Date.now().toString(36)}` };
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
} catch (err) {
  console.error(err);
  fail();
} finally {
  await app.close().catch(() => {});
  rmSync(join(APPDATA, `Birlikte İzle (${env.BIRLIKTE_PROFILE})`), { recursive: true, force: true });
}
process.exit(finish());
