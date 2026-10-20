// Faz 0 uçtan uca test: kendi sunucusunu başlatır, iki ayrı tarayıcı bağlamı aynı
// odaya girer, A test videosunu yayınlar, B kontrol eder.  →  npm test
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error('Chrome/Edge bulunamadı. CHROME_PATH ortam değişkeniyle yolunu ver.');
  return found;
}

const CHROME = findBrowser();
const ROOM = `e2e-${Date.now() % 100000}`;
const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const URL = `${BASE}/?oda=${ROOM}`;
const VIDEO = join(tmpdir(), 'birlikte-izle-test.webm');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const wait = (page, fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true, () => false);

const server = spawn(process.execPath, ['server.js'], {
  cwd: join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), CF_TURN_KEY_ID: '' },
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes('http://localhost') && resolve());
  server.on('exit', (code) => reject(new Error(`Sunucu başlamadı (çıkış kodu ${code})`)));
});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--mute-audio',
  ],
});

try {
  // 1) Test videosu üret: renk değiştiren kareler + 440 Hz ton, 8 sn
  const gen = await browser.newPage();
  await gen.goto(BASE);
  const b64 = await gen.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    const ctx = c.getContext('2d');
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    let f = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = `hsl(${(f * 4) % 360},70%,45%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff';
      ctx.font = '48px sans-serif';
      ctx.fillText(`Kare ${f++}`, 40, 200);
    }, 33);
    rec.start(500);
    await new Promise((r) => setTimeout(r, 8000));
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    clearInterval(timer);
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await writeFile(VIDEO, Buffer.from(b64, 'base64'));
  await gen.close();
  check('test videosu üretildi', b64.length > 1000, `${Math.round((b64.length * 0.75) / 1024)} KB`);

  // 2) İki ayrı bağlam (ayrı localStorage) aynı odaya katılır
  const join = async (name) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(URL);
    await page.$eval('#nameInput', (el, n) => (el.value = n), name);
    await page.click('#joinForm button[type=submit]');
    return { page, errors };
  };
  const A = await join('Ali'); // host olacak
  const B = await join('Bade'); // guest olacak

  check(
    'P2P bağlandı, kanal açık (A tarafı)',
    await wait(A.page, () => document.getElementById('presenceText').textContent.includes('burada')),
  );
  check(
    'P2P bağlandı, kanal açık (B tarafı)',
    await wait(B.page, () => document.getElementById('presenceText').textContent.includes('burada')),
  );

  // 3) Kameralar karşılıklı
  check(
    'B, A\'nın kamerasını görüyor',
    await wait(B.page, () => document.getElementById('camRemote').videoWidth > 0),
  );
  check(
    'A, B\'nin kamerasını görüyor',
    await wait(A.page, () => document.getElementById('camRemote').videoWidth > 0),
  );

  // 4) A dosya açar → B'de film görünür
  const input = await A.page.$('#fileInput');
  await input.uploadFile(VIDEO);
  check('A dosyayı yükledi', await wait(A.page, () => document.getElementById('localMovie').readyState >= 1));
  check(
    'B izleyen moduna geçti',
    await wait(B.page, () => !document.getElementById('remoteMovie').hidden),
  );

  // 5) B oynat'a basar → A'nın oynatıcısı başlar, B'ye görüntü gelir
  await B.page.click('#playBtn');
  check('B oynat → A oynatıyor', await wait(A.page, () => !document.getElementById('localMovie').paused));
  check(
    'B filmin görüntüsünü alıyor',
    await wait(B.page, () => document.getElementById('remoteMovie').videoWidth > 0),
  );
  const t0 = await B.page.$eval('#remoteMovie', (v) => v.currentTime);
  await new Promise((r) => setTimeout(r, 1500));
  const t1 = await B.page.$eval('#remoteMovie', (v) => v.currentTime);
  check('B tarafında yayın akıyor', t1 > t0, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);
  check(
    'B arayüzü "oynatılıyor" gösteriyor',
    await wait(B.page, () => document.getElementById('playBtn').dataset.rendered.startsWith('pause')),
  );

  // 6) B durdurur → A durur
  await B.page.click('#playBtn');
  check('B durdur → A durdu', await wait(A.page, () => document.getElementById('localMovie').paused));
  check(
    'A tarafında "Bade durdurdu" bildirimi',
    await wait(A.page, () => document.getElementById('hud').textContent.includes('Bade durdurdu')),
  );

  // 7) A oynatır → B'nin arayüzü güncellenir
  await A.page.click('#playBtn');
  check(
    'A oynat → B arayüzü oynatılıyor',
    await wait(B.page, () => document.getElementById('playBtn').dataset.rendered.startsWith('pause')),
  );
  check(
    'B tarafında "Ali oynattı" bildirimi',
    await wait(B.page, () => document.getElementById('hud').textContent.includes('Ali oynattı')),
  );

  // 8) B geri sarar (−10 sn) → A başa yakın
  await new Promise((r) => setTimeout(r, 1500));
  await B.page.click('#backBtn');
  check(
    'B geri sar → A başa döndü',
    await wait(A.page, () => document.getElementById('localMovie').currentTime < 1.5),
  );

  // 9) Kalp tepkisi
  await A.page.click('#heartBtn');
  check('Kalp B\'ye ulaştı', await wait(B.page, () => document.querySelector('#hearts .heart') !== null, null, 3000));

  // 10) Bağlantı bilgisi paneli
  await B.page.click('#statsBtn');
  await new Promise((r) => setTimeout(r, 2500));
  const statsB = await B.page.$$eval('#statsBody .row', (rows) => rows.map((r) => r.innerText.replace('\n', ': ')));
  console.log('\n  B bağlantı bilgisi:\n   ' + statsB.join('\n   '));
  check('İstatistiklerde film görüntüsü ↓ var', statsB.some((r) => r.startsWith('Film görüntü ↓')));
  check('Yayın gecikmesi ölçülüyor', statsB.some((r) => /Yayın gecikmesi: \d+ ms/.test(r)));

  // 11) Codec değiştir → VP9
  await A.page.click('#settingsBtn');
  await A.page.$$eval('#settingsBody .row', (rows) => {
    const row = rows.find((r) => r.textContent.startsWith('Codec'));
    const sel = row.querySelector('select');
    sel.value = 'vp9';
    sel.dispatchEvent(new Event('change'));
  });
  await A.page.click('#settingsDone');
  await A.page.click('#statsBtn');
  const vp9 = await wait(
    A.page,
    () => [...document.querySelectorAll('#statsBody .row')].some((r) => /Film görüntü ↑.*VP9/.test(r.innerText.replace('\n', ' '))),
    null,
    10000,
  );
  const statsA = await A.page.$$eval('#statsBody .row', (rows) => rows.map((r) => r.innerText.replace('\n', ': ')));
  console.log('\n  A bağlantı bilgisi:\n   ' + statsA.join('\n   '));
  check('Codec VP9\'a geçti', vp9);

  // 12) B ayrılır → A durur
  await B.page.browserContext().close();
  check('B ayrıldı → A durdu', await wait(A.page, () => document.getElementById('localMovie').paused, null, 10000));

  const errs = [...A.errors];
  check('Sayfada JS hatası yok', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} başarılı`);
process.exit(failed ? 1 : 0);
