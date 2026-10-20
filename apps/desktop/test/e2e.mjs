// Uçtan uca test: sinyal sunucusunu ve arayüzü (tarayıcı modunda) kendisi başlatır.
// İki ayrı tarayıcı bağlamı ilk açılıştan eşleşmeye, birlikte izlemeye, kopmaya kadar
// gerçek kullanıcı gibi tıklar.  →  npm test   (ekran görüntüleri: test/output/)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(import.meta.dirname, 'output');
const SIGNAL_PORT = 8789;
const WEB_PORT = 5299;
const VIDEO = join(tmpdir(), 'birlikte-izle-test-30sn.webm');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

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
  if (!found) throw new Error('Chrome/Edge bulunamadı. CHROME_PATH ile yolunu ver.');
  return found;
}

function start(command, cwd, ready, env = {}) {
  const proc = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, ...env } });
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Başlamadı: ${command}`)), 90_000);
    const onData = (d) => {
      // Renk kodları (FORCE_COLOR açıksa) "Local:" gibi metinleri böler: önce temizle.
      if (d.toString().replace(/\x1b\[[0-9;]*m/g, '').includes(ready)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
  return { proc, ready: promise };
}

function kill(proc) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
  else killGroup(proc);
}

const signal = start(`npx wrangler dev --port ${SIGNAL_PORT} --ip 127.0.0.1`, join(ROOT, '../../services/signal'), 'Ready on', {
  WRANGLER_SEND_METRICS: 'false',
});
const web = start(`npx vite --config vite.web.config.ts --port ${WEB_PORT} --strictPort`, ROOT, 'Local:', {
  VITE_SIGNAL_URL: `http://127.0.0.1:${SIGNAL_PORT}`,
});

let browser;
const pages = [];
try {
  await Promise.all([signal.ready, web.ready]);
  browser = await chromium.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  if (!existsSync(VIDEO)) await makeTestVideo(browser);
  check('30 sn test videosu hazır', existsSync(VIDEO));

  const errors = [];
  const open = async (who) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    pages.push(page);
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${who}: ${m.text()}`));
    if (process.env.DEBUG_RTC) page.on('console', (m) => m.type() === 'warning' && console.log(`   [${who} uyarı] ${m.text().slice(0, 300)}`));
    await page.goto(`http://localhost:${WEB_PORT}/`);
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
  const visible = (locator, timeout = 10_000) => locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  const until = (page, fn, arg, timeout = 15_000) =>
    page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
  const localMovie = 'document.querySelectorAll(".media-slot")[0].querySelector("video")';
  const remoteMovie = 'document.querySelectorAll(".media-slot")[1].querySelector("video")';

  const A = await open('Ali');
  const B = await open('Bade');

  // --- İlk açılış ve eşleşme ---------------------------------------------------------
  check('karşılama ekranı', await visible(A.getByText('Uzakta olsanız da yan yana gibi.')));
  await shot(A, '01-karsilama');
  for (const [page, name] of [[A, 'Ali'], [B, 'Bade']]) {
    await page.getByRole('button', { name: 'Başla' }).click();
    await page.getByLabel('Adın').fill(name);
    await page.getByRole('button', { name: 'Devam' }).click();
  }
  await A.getByRole('button', { name: /Kod oluştur/ }).click();
  check('kod oluştu', await until(A, () => document.querySelectorAll('.code-cell')[5]?.textContent?.length === 1));
  const code = await A.$$eval('.code-cell', (cells) => cells.map((c) => c.textContent).join(''));
  await shot(A, '02-kod');

  await B.getByRole('button', { name: /Kodum var/ }).click();
  await B.getByLabel('Eşleşme kodu').fill(code);
  check('B eşleşti', await visible(B.getByText('Eşleştiniz')), code);
  check('A eşleşti (kendiliğinden)', await visible(A.getByText('Eşleştiniz')));
  check('A, Bade adını görüyor', await visible(A.getByText('Artık Bade ile birlikte izleyebilirsin.')));
  await shot(B, '03-eslestiniz');
  await A.getByRole('button', { name: 'Başlayalım' }).click();
  await B.getByRole('button', { name: 'Başlayalım' }).click();

  // --- Ana ekran -----------------------------------------------------------------------
  check('A ana ekranda Bade çevrimiçi', await visible(A.locator('.home-status', { hasText: 'Çevrimiçi' })));
  check('B ana ekranda Ali çevrimiçi', await visible(B.locator('.home-status', { hasText: 'Çevrimiçi' })));
  await shot(A, '04-ana-ekran');

  // --- İzleme ekranı ve bağlantı -------------------------------------------------------
  await A.getByRole('button', { name: /Birlikte İzle/ }).click();
  check('B davet kartını görüyor', await visible(B.getByText('Ali izleme ekranında')));
  await shot(B, '05-davet');
  await B.getByRole('button', { name: 'Katıl' }).click();
  check('A: P2P bağlandı', await visible(A.locator('.watch-topbar .pill', { hasText: 'Bade burada' }), 20_000));
  check('B: P2P bağlandı', await visible(B.locator('.watch-topbar .pill', { hasText: 'Ali burada' }), 20_000));
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
  const camsOk = await until(B, () => document.querySelector('.cams .bubble:first-child .cam-video')?.videoWidth > 0);
  check('B, A\'nın kamerasını görüyor', camsOk);
  if (process.env.DEBUG_CAMS || !camsOk) {
    console.log('   B kameralar:', JSON.stringify(await B.evaluate(camState)));
    // Bağlantı durumu: hangi izler pazarlıkta, kim kibar, sinyal durumu ne?
    const rtc = () => {
      const link = window.__birlikte.watch.link;
      const pc = link?.pc;
      return {
        polite: link?.opts.polite,
        signaling: pc?.signalingState,
        conn: pc?.connectionState,
        setupPending: link?.setupPending,
        senders: [...(link?.senders ?? [])].map(([k, s]) => `${k}:${s.track?.readyState ?? 'yok'}`),
        local: [...(link?.local ?? [])].map(([k, e]) => `${k}:${e.track ? 'var' : 'yok'}`),
        tx: pc?.getTransceivers().map((t) => `${t.mid}:${t.receiver.track.kind}:${t.direction}/${t.currentDirection}`),
        streams: [...window.__birlikte.watch.remoteStreams.keys()].map((id) => id.slice(0, 8)),
        peer: window.__birlikte.watch.peerStreams,
      };
    };
    console.log('   A rtc:', JSON.stringify(await A.evaluate(rtc)));
    console.log('   B rtc:', JSON.stringify(await B.evaluate(rtc)));
    console.log('   A kameralar:', JSON.stringify(await A.evaluate(camState)));
  }
  await shot(A, '06-izleme-bos');

  // --- Film yayını ve iki yönlü kontrol ------------------------------------------------
  await A.setInputFiles('input[type=file]', VIDEO);
  check('A filmi açtı', await until(A, (s) => eval(s).readyState >= 1, localMovie));
  check('B izleyen moduna geçti', await visible(B.locator('.watch-title', { hasText: 'birlikte-izle-test-30sn' })));
  check('B filmin görüntüsünü alıyor', await until(B, (s) => eval(s).videoWidth > 0, remoteMovie));
  check('B süreyi biliyor (0:30)', await visible(B.locator('.time.end', { hasText: '-0:30' })));

  await B.getByRole('button', { name: /^Oynat/ }).click();
  check('B oynat → A oynatıyor', await until(A, (s) => !eval(s).paused, localMovie));
  await B.waitForTimeout(2500);
  check('B ekranında süre ilerliyor', await until(B, () => /^0:0[1-9]/.test(document.querySelector('.time').textContent)));
  await shot(B, '07-izleme-oynuyor');

  await B.getByRole('button', { name: /^Durdur/ }).click();
  check('B durdur → A durdu', await until(A, (s) => eval(s).paused, localMovie));
  check('A: "Bade durdurdu"', await visible(A.locator('.hud', { hasText: 'Bade durdurdu' }), 3000));
  await shot(A, '08-bildirim');

  const before = await A.evaluate((s) => eval(s).currentTime, localMovie);
  await B.keyboard.press('ArrowRight');
  check('B → tuşu: A 10 sn ileri', await until(A, ([s, t]) => eval(s).currentTime > t + 9, [localMovie, before]));

  await A.keyboard.press('Space');
  check('A Boşluk → B arayüzü oynuyor', await visible(B.getByRole('button', { name: /^Durdur/ }), 5000));
  check('B: "Ali oynattı"', await visible(B.locator('.hud', { hasText: 'Ali oynattı' }), 3000));
  await A.keyboard.press('Space');

  // --- Ayarlar: kontrol yetkisi ve ortak ayar ------------------------------------------
  await A.locator('.watch-topbar').getByRole('button', { name: 'Ayarlar' }).click();
  await shot(A, '09-ayarlar-genel');
  await A.getByRole('button', { name: 'Oynatma' }).click();
  await A.getByRole('radio', { name: 'Sadece paylaşan' }).click();
  await shot(A, '10-ayarlar-oynatma');
  await A.getByRole('button', { name: 'Görüntü' }).click();
  await A.getByRole('button', { name: 'Gelişmiş' }).click();
  await A.getByLabel('Codec').selectOption('vp9');
  await shot(A, '11-ayarlar-gelismis');
  await A.getByRole('button', { name: 'Bitti' }).click();

  await B.keyboard.press('Space');
  check('yetki: B oynatamıyor', await visible(B.locator('.hud', { hasText: 'Kontrol sadece Ali tarafında' }), 4000));
  check('yetki: A hâlâ durmuş', await A.evaluate((s) => eval(s).paused, localMovie));
  check(
    'ortak ayar: codec B\'ye geçti',
    await until(B, () => JSON.parse(localStorage.getItem('birlikte-izle:ayarlar') ?? '{}')['video.codec'] === 'vp9', null, 5000),
  );

  await A.locator('.watch-topbar').getByRole('button', { name: 'Ayarlar' }).click();
  await A.getByRole('button', { name: 'Oynatma' }).click();
  await A.getByRole('radio', { name: 'İkimiz de' }).click();
  await A.keyboard.press('Escape');

  // --- Kalp, bağlantı bilgisi ----------------------------------------------------------
  await A.keyboard.press('KeyH');
  check('kalp B\'ye ulaştı', await until(B, () => !!document.querySelector('.hearts .heart'), null, 3000));
  await B.getByRole('button', { name: 'Bağlantı bilgisi' }).click();
  check('B: film görüntüsü istatistiği', await visible(B.locator('.stats-panel .row', { hasText: 'Film görüntü ↓' }), 5000));
  check('B: yayın gecikmesi ölçülüyor', await visible(B.locator('.stats-panel .row', { hasText: /Yayın gecikmesi\s*\d+ ms/ }), 5000));
  await shot(B, '12-baglanti-bilgisi');
  await B.getByRole('button', { name: 'Bağlantı bilgisi' }).click();

  // --- Kamera kendiliğinden kapanırsa toparlanma --------------------------------------------
  const localCamTrackId = () => document.querySelectorAll('.cam-video')[1]?.srcObject?.getVideoTracks()[0]?.id;
  // Önce kamera gerçekten açık olsun (sahte kamera kendiliğinden düşüp toparlanıyor olabilir).
  await until(B, () => document.querySelectorAll('.cam-video')[1]?.srcObject?.getVideoTracks()[0]?.readyState === 'live', null, 10_000);
  const oldTrack = await B.evaluate(localCamTrackId);
  // Cihazın kendiliğinden kapanmasını taklit et (kablo çıktı, başka uygulama aldı…)
  await B.evaluate(() => document.querySelectorAll('.cam-video')[1].srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  check('kamera düşünce yeniden açıldı', await until(B, ([fn, old]) => {
    const id = eval(fn)();
    return !!id && id !== old;
  }, [`(${localCamTrackId})`, oldTrack], 8000));
  check("A, B'nin kamerasını yine görüyor", await until(A, () => {
    const v = document.querySelector('.cams .bubble:first-child .cam-video');
    return !document.querySelector('.cams .bubble:first-child.off') && v?.videoWidth > 0;
  }, null, 10_000));

  // --- Kopma ve geri gelme ----------------------------------------------------------------
  await A.keyboard.press('Space');
  check('A tekrar oynatıyor', await until(A, (s) => !eval(s).paused, localMovie));
  await B.getByRole('button', { name: 'Ana ekran' }).click();
  check('B çıkınca A durdu', await until(A, (s) => eval(s).paused, localMovie, 10_000));
  check('A: Bade ana ekranda', await visible(A.locator('.watch-topbar .pill', { hasText: 'Bade ana ekranda' })));
  const pausedAt = await A.evaluate((s) => eval(s).currentTime, localMovie);

  check('B ana ekranda daveti görüyor', await visible(B.getByText('Ali izleme ekranında')));
  await B.getByRole('button', { name: 'Katıl' }).click();
  check('B geri döndü, yayın yeniden geliyor', await until(B, (s) => eval(s)?.videoWidth > 0, remoteMovie.replace('[1].', '[1]?.'), 20_000));
  await visible(B.locator('.time'), 5000);
  const resumedAt = await B.evaluate(() => document.querySelector('.time')?.textContent ?? '');
  check('kaldığı yerden', resumedAt === formatTime(pausedAt), `${resumedAt} ~ ${formatTime(pausedAt)}`);

  // --- Eşleşmeyi kaldırma -------------------------------------------------------------------
  await B.locator('.watch-topbar').getByRole('button', { name: 'Ayarlar' }).click();
  await B.getByRole('button', { name: 'Eşleşme' }).click();
  await B.getByText('Eşleşmeyi kaldır').click();
  await B.getByRole('button', { name: 'Eşleşmeyi kaldır' }).click();
  check('eşleşme kaldırıldı → ilk açılış', await visible(B.getByText('Eşleşelim')));

  check('sayfalarda hata yok', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  // Hata anının ekran görüntüsü: test/output/hata-0.png (A), hata-1.png (B)
  for (const [i, page] of pages.entries()) await page.screenshot({ path: join(OUT, `hata-${i}.png`) }).catch(() => {});
  results.push(false);
} finally {
  await browser?.close();
  kill(signal.proc);
  kill(web.proc);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} başarılı`);
process.exit(failed ? 1 : 0);

function formatTime(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** WebCodecs ile 30 sn'lik, süresi ve sarma noktaları olan bir WebM üretir.
 *  Ses stereo: sol kanal 440 Hz, sağ kanal 660 Hz. */
async function makeTestVideo(browser) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${WEB_PORT}/`);
  await page.addScriptTag({ content: readFileSync(join(ROOT, '../../node_modules/webm-muxer/build/webm-muxer.js'), 'utf8') });
  const b64 = await page.evaluate(async () => {
    const W = 1280, H = 720, FPS = 30, SECONDS = 30, RATE = 48000;
    const { Muxer, ArrayBufferTarget } = window.WebMMuxer;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'V_VP8', width: W, height: H, frameRate: FPS },
      audio: { codec: 'A_OPUS', sampleRate: RATE, numberOfChannels: 2 },
    });
    const fail = (e) => { throw e; };
    const ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: fail });
    ve.configure({ codec: 'vp8', width: W, height: H, bitrate: 3_000_000, framerate: FPS });
    const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: fail });
    ae.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 2, bitrate: 128_000 });

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < FPS * SECONDS; i++) {
      const t = i / FPS;
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, `hsl(${(t * 24) % 360} 70% 42%)`);
      g.addColorStop(1, `hsl(${(t * 24 + 120) % 360} 70% 22%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(W / 2 + Math.cos(t * 2) * 360, H / 2 + Math.sin(t * 3) * 180, 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 72px system-ui';
      ctx.fillText(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`, 60, 120);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
      ve.encode(frame, { keyFrame: i % FPS === 0 });
      frame.close();
    }
    const CHUNK = 960;
    for (let n = 0; n < (RATE * SECONDS) / CHUNK; n++) {
      const data = new Float32Array(CHUNK * 2);
      for (let k = 0; k < CHUNK; k++) {
        const s = (n * CHUNK + k) / RATE;
        data[k] = 0.2 * Math.sin(2 * Math.PI * 440 * s);
        data[CHUNK + k] = 0.2 * Math.sin(2 * Math.PI * 660 * s);
      }
      ae.encode(new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: CHUNK, numberOfChannels: 2, timestamp: Math.round((n * CHUNK * 1e6) / RATE), data }));
    }
    await ve.flush();
    await ae.flush();
    muxer.finalize();
    const buf = new Uint8Array(muxer.target.buffer);
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await writeFile(VIDEO, Buffer.from(b64, 'base64'));
  await page.close();
}

/** macOS/Linux: kabuk, npx, wrangler ve workerd aynı süreç grubunda; hepsini birden kapat. */
function killGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    proc.kill();
  }
}
