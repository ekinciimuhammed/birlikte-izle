// YouTube senkron testi (gerçek Electron, iki pencere, gerçek YouTube — internet gerekir):
// bağlantı yapıştırılınca iki taraf da YouTube'dan aynı videoyu açıyor mu, birlikte oynatma,
// sarma ve durdurma çalışıyor mu, aradaki fark ne kadar?  →  npm run test:youtube
// İnternet yoksa test atlanır.

import { join } from 'node:path';
import { createChecks, enterWatch, OUT, pair, startPair, until, visible } from './lib/harness.mjs';

// YouTube'un kendi geliştirici videosu (gömmeye açık, uzun)
const LINK = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
// Bir dizi kanalının videosu: IP adresinden (127.0.0.1) gömülünce hata 150 veriyor, localhost'tan oynuyor
const TV_LINK = 'https://www.youtube.com/watch?v=tVuz-7n_eeA';

const online = await fetch('https://www.youtube.com/iframe_api', { signal: AbortSignal.timeout(8000) }).then(
  (r) => r.ok,
  () => false,
);
if (!online) {
  console.log('ATLANDI  YouTube\'a ulaşılamıyor (internet yok?)');
  process.exit(0);
}

const { check, finish, fail } = createChecks();
const { A, B, errors, cleanup } = await startPair({ port: 8793, web: true });

const yt = (page) =>
  page.evaluate(() => {
    const p = window.__birlikte.watch.youtube;
    return { time: p.time, playing: p.playing, duration: p.duration, w: performance.timeOrigin + performance.now() };
  });
/** Aynı makinede iki süreç aynı duvar saatini görür: A'yı B'nin ölçüldüğü ana taşı. */
const drift = async () => {
  const a = await yt(A);
  const b = await yt(B);
  return a.time + (a.playing ? (b.w - a.w) / 1000 : 0) - b.time;
};
const fmt = (d) => `${Math.round(d * 1000)} ms`;
const cmd = (page, action, value) => page.evaluate(([a, v]) => window.__birlikte.watch.command(a, v), [action, value]);

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));

  await A.getByLabel('YouTube bağlantısı').fill(LINK);
  await A.getByRole('button', { name: 'Aç', exact: true }).click();
  check('A: YouTube videosu açıldı', await until(A, () => window.__birlikte.watch.youtube.duration > 0, null, 40_000));
  check('A: başlık YouTube\'dan geldi', await until(A, () => !['', 'YouTube'].includes(window.__birlikte.state().title), null, 10_000), await A.evaluate(() => window.__birlikte.state().title));
  check('B: aynı videoyu kendi YouTube\'unda açtı', await until(B, () => window.__birlikte.state().source === 'youtube' && window.__birlikte.state().syncMode, null, 40_000));
  check('film yayını yok (ikisi de YouTube\'dan)', !(await A.evaluate(() => !!window.__birlikte.watch.link?.senders.get('movie-video')?.track)));

  await cmd(A, 'play');
  check('A oynuyor', await until(A, () => window.__birlikte.watch.youtube.playing, null, 20_000));
  check('B de oynuyor', await until(B, () => window.__birlikte.watch.youtube.playing, null, 20_000));
  await A.waitForTimeout(9000);
  let d = await drift();
  check('birlikte oynarken fark < 250 ms', Math.abs(d) < 0.25, fmt(d));

  await cmd(B, 'seek', 120);
  check('B sardı → A 2. dakikada', await until(A, () => Math.abs(window.__birlikte.watch.youtube.time - 121) < 3, null, 15_000));
  await A.waitForTimeout(4000);
  d = await drift();
  check('sardıktan sonra fark < 250 ms', Math.abs(d) < 0.25, fmt(d));

  await cmd(B, 'pause');
  check('B durdurdu → A da durdu', await until(A, () => !window.__birlikte.watch.youtube.playing, null, 5000));
  await A.waitForTimeout(1500);
  d = await drift();
  check('durunca aynı yerde (fark < 300 ms)', Math.abs(d) < 0.3, fmt(d));

  await A.screenshot({ path: join(OUT, 'youtube-A.png') });
  await B.screenshot({ path: join(OUT, 'youtube-B.png') });

  check('YouTube oynatıcısı ekranda', await visible(B.locator('.youtube iframe'), 2000));

  // Yerel sunucu 127.0.0.1'de; aracı sayfa yine de localhost'tan açılmalı (yoksa bu video hata 150)
  check("aracı sayfa localhost'tan",/^http:\/\/localhost:8793\/yt/.test(await A.evaluate(() => document.querySelector('.youtube iframe').src)));
  await A.evaluate((l) => window.__birlikte.watch.openYouTube(l), TV_LINK);
  check('dizi kanalının videosu da açıldı (hata 150 yok)', await until(A, () => window.__birlikte.watch.youtube.duration > 300 && /Altı Üstü/.test(window.__birlikte.state().title), null, 40_000), await A.evaluate(() => window.__birlikte.state().notice ?? window.__birlikte.state().title));
  check('B de aynı videoyu açtı', await until(B, () => window.__birlikte.state().syncMode && /Altı Üstü/.test(window.__birlikte.state().title), null, 40_000));
  // YouTube'un kendi oynatıcısının (iç çerçeve) uyarıları bizim kodumuz değil.
  const real = errors.filter((e) => !/favicon|Autofill|youtube|googlevideo|doubleclick|ERR_BLOCKED|Permissions[- ]policy/i.test(e));
  check('konsolda hata yok', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  fail();
} finally {
  await cleanup();
}
process.exit(finish());
