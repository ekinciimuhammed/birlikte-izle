// build/icon.svg → ../extension/icons/{16,48,128}.png (tarayıcı eklentisinin simgeleri)
//   →  node scripts/make-extension-icons.mjs
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SVG = readFileSync(join(import.meta.dirname, '..', 'build', 'icon.svg'), 'utf8');
const OUT = join(import.meta.dirname, '..', '..', 'extension', 'icons');
mkdirSync(OUT, { recursive: true });
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

const browser = await chromium.launch({ executablePath: chrome, headless: true });
for (const size of [16, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: join(OUT, `${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
}
await browser.close();
console.log('eklenti simgeleri hazır');
