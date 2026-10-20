// build/icon.svg → build/icon.png (1024×1024). electron-builder bundan Windows .ico,
// macOS .icns ve Linux simgelerini kendisi üretir.  →  node scripts/make-icon.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BUILD = join(import.meta.dirname, '..', 'build');
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<html><body style="margin:0;background:transparent">${readFileSync(join(BUILD, 'icon.svg'), 'utf8').replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`,
);
await page.screenshot({ path: join(BUILD, 'icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
console.log('build/icon.png hazır');
