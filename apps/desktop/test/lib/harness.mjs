// Electron testlerinin ortak altyapısı: derleme, yerel sinyal sunucusu, iki pencere (A ve B),
// eşleştirme, izleme ekranına girme ve ne olursa olsun temizlik.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium, _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
export const ROOT = join(import.meta.dirname, '..', '..');
export const OUT = join(ROOT, 'test', 'output');
const SIGNAL_DIR = join(ROOT, '../../services/signal');
/** Uygulama verisinin kök klasörü (Windows: %APPDATA%, macOS: ~/Library/Application Support, Linux: ~/.config) */
export const APPDATA =
  process.env.APPDATA ??
  (process.platform === 'darwin' ? join(process.env.HOME ?? '', 'Library/Application Support') : process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'));
mkdirSync(OUT, { recursive: true });

export function createChecks() {
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(!!ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} başarılı`);
    return failed ? 1 : 0;
  };
  return { check, finish, fail: () => results.push(false) };
}

export const visible = (locator, timeout = 15_000) =>
  locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

export const until = (page, fn, arg, timeout = 20_000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);

function withoutRunAsNode(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE; // VS Code eklentileri gibi ortamlar Electron'u düz Node'a çevirir
  return env;
}

/**
 * Üretim derlemesi (sinyal adresi gömülü) + yerel sinyal sunucusu + iki taraf.
 * guest: 'electron' → B de masaüstü uygulaması; 'phone' → B, sunucunun yayınladığı web
 * sürümünü iPhone boyutunda, dokunmatik, görünmez bir Chrome'da açar.
 */
export async function startPair({ port, run = Date.now().toString(36), guest = 'electron', env = {}, web = guest === 'phone' }) {
  const build = spawnSync('npx electron-vite build', {
    cwd: ROOT,
    shell: true,
    env: withoutRunAsNode({ VITE_SIGNAL_URL: `http://127.0.0.1:${port}` }),
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`Derleme olmadı:\n${build.stderr.slice(-500)}`);

  // Web sürümü (telefon testi, YouTube aracı sayfası) sunucunun kendi adresini kullanır:
  // VITE_SIGNAL_URL olmadan derlenir.
  if (web) {
    const webEnv = withoutRunAsNode();
    delete webEnv.VITE_SIGNAL_URL;
    const out = spawnSync('npm run build:web', { cwd: ROOT, shell: true, env: webEnv, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`Web derlemesi olmadı: ${out.stderr.slice(-500)}`);
  }

  mkdirSync(join(SIGNAL_DIR, 'web'), { recursive: true });
  const signal = spawn(`npx wrangler dev --port ${port} --ip 127.0.0.1`, {
    cwd: SIGNAL_DIR,
    shell: true,
    detached: process.platform !== 'win32', // macOS/Linux: süreç grubu olarak kapatabilmek için
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const profiles = [`test-a-${run}`, `test-b-${run}`];
  const apps = [];
  const errors = [];
  let browser = null;

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const app of apps) await app.close().catch(() => {});
    await browser?.close().catch(() => {});
    // Windows'ta önce bütün süreç ağacı kapatılmalı (cmd → npx → wrangler → workerd).
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(signal.pid), '/T', '/F']);
    else killGroup(signal);
    for (const p of profiles) rmSync(join(APPDATA, `Birlikte İzle (${p})`), { recursive: true, force: true });
  };
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, async (err) => {
      console.error(err);
      await cleanup();
      process.exit(1);
    });
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sinyal sunucusu açılmadı')), 90_000);
    signal.stdout.on('data', (d) => d.toString().includes('Ready on') && (clearTimeout(timer), resolve()));
  });

  const openPhone = async () => {
    browser = await chromium.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      permissions: ['camera', 'microphone'],
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`Telefon: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`Telefon: ${m.text()}`));
    await page.goto(`http://127.0.0.1:${port}/`);
    return page;
  };

  const launch = async (profile, who) => {
    const options = {
      executablePath: require('electron'),
      // --mute-audio: hiçbir ses hoparlöre gitmez (analizler yine çalışır)
      args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
      cwd: ROOT,
      env: withoutRunAsNode({
        BIRLIKTE_PROFILE: profile,
        BIRLIKTE_TEST: '1',
        BIRLIKTE_TEST_SLOT: who === 'B' ? '1' : '0',
        ...env[who],
      }),
    };
    // Windows'ta art arda çalıştırınca Playwright bazen ilk denemede bağlanamıyor: bir kez daha dene.
    const app = await electron.launch(options).catch(async (err) => {
      if (!/failed to launch|Timeout/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 2000));
      return electron.launch(options);
    });
    apps.push(app);
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${who}: ${m.text()}`));
    await page.waitForLoadState('domcontentloaded');
    return page;
  };

  const A = await launch(profiles[0], 'A');
  const B = guest === 'phone' ? await openPhone() : await launch(profiles[1], 'B');
  return { A, B, apps, errors, cleanup, profiles, settingsFile: (i) => join(APPDATA, `Birlikte İzle (${profiles[i]})`, 'ayarlar.json') };
}

function findChrome() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find((p) => p && existsSync(p));
}

/** İlk açılış → ad → kod ile eşleşme → ana ekran */
export async function pair(A, B) {
  for (const [page, name] of [[A, 'Ali'], [B, 'Bade']]) {
    await page.getByRole('button', { name: 'Başla' }).click();
    await page.getByLabel('Adın').fill(name);
    await page.getByRole('button', { name: 'Devam' }).click();
  }
  await A.getByRole('button', { name: /Kod oluştur/ }).click();
  if (!(await until(A, () => document.querySelectorAll('.code-cell')[5]?.textContent?.length === 1))) return false;
  const code = await A.$$eval('.code-cell', (cells) => cells.map((c) => c.textContent).join(''));
  await B.getByRole('button', { name: /Kodum var/ }).click();
  await B.getByLabel('Eşleşme kodu').fill(code);
  const ok = (await visible(B.getByText('Eşleştiniz'))) && (await visible(A.getByText('Eşleştiniz')));
  await A.getByRole('button', { name: 'Başlayalım' }).click();
  await B.getByRole('button', { name: 'Başlayalım' }).click();
  return ok;
}

/** İkisi de izleme ekranına girer ve P2P bağlanır */
export async function enterWatch(A, B) {
  await A.getByRole('button', { name: /Birlikte İzle/ }).click();
  await B.getByRole('button', { name: 'Katıl' }).click();
  return visible(A.locator('.watch-topbar .pill', { hasText: 'Bade burada' }), 25_000);
}

/** macOS/Linux: kabuk, npx, wrangler ve workerd aynı süreç grubunda; hepsini birden kapat. */
function killGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    proc.kill();
  }
}
