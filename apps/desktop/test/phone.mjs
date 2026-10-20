// Karma test: A masaüstü uygulamasında, B telefonunda (sunucunun yayınladığı web sürümü,
// iPhone boyutunda, dokunmatik). Hiçbir şey kurmadan katılabiliyor mu?  →  npm run test:phone

import { join } from 'node:path';
import { makeFixtures } from './lib/fixtures.mjs';
import { createChecks, enterWatch, OUT, pair, startPair, until, visible } from './lib/harness.mjs';

const { check, finish, fail } = createChecks();
const files = makeFixtures();
const { A, B, errors, cleanup } = await startPair({ port: 8792, guest: 'phone' });

try {
  check('telefon web sürümünü açtı (kurulum yok)', await visible(B.getByText('Uzakta olsanız da yan yana gibi.')));
  await B.screenshot({ path: join(OUT, 'telefon-1-karsilama.png') });
  check('masaüstü ↔ telefon eşleşti', await pair(A, B));
  check('telefonda ana ekran', await visible(B.locator('.home-status', { hasText: 'Çevrimiçi' })));
  await B.screenshot({ path: join(OUT, 'telefon-2-ana-ekran.png') });
  check('P2P bağlandı', await enterWatch(A, B));

  await A.evaluate((p) => window.__birlikte.watch.openPath(p), files.mp4);
  check(
    'telefon filmi alıyor',
    await until(B, () => document.querySelectorAll('.media-slot')[1]?.querySelector('video')?.videoWidth > 0, null, 30_000),
  );

  await B.getByRole('button', { name: /^Oynat/ }).tap();
  check('telefondan dokunarak oynattı', await until(A, () => !document.querySelectorAll('.media-slot')[0].querySelector('video').paused));

  // Dokunmatikte filme dokunmak oynat/durdur değil, kontrolleri açıp kapatır.
  await B.waitForTimeout(400);
  await B.locator('.movie-hit').tap();
  await B.waitForTimeout(400);
  const stillPlaying = await A.evaluate(() => !document.querySelectorAll('.media-slot')[0].querySelector('video').paused);
  check('filme dokunmak filmi durdurmuyor, kontrolleri gizliyor', stillPlaying && (await B.evaluate(() => !!document.querySelector('.watch.ui-hidden'))));
  await B.locator('.movie-hit').tap();
  check('tekrar dokununca kontroller geri geliyor', await until(B, () => !document.querySelector('.watch.ui-hidden'), null, 3000));

  await A.evaluate(() => window.__birlikte.watch.command('seek', 6));
  await A.evaluate(() => window.__birlikte.watch.command('pause'));
  check('telefonda Türkçe altyazı', await until(B, () => /Işığı kapat/.test(document.querySelector('.subtitles')?.textContent ?? ''), null, 10_000));
  if (process.env.DEBUG_TIME) {
    for (let i = 0; i < 10; i++) {
      const a = await A.evaluate(() => [window.__birlikte.watch.mediaTime().toFixed(2), document.querySelector('.hud')?.textContent]);
      const b = await B.evaluate(() => [document.querySelector('.time')?.textContent, document.querySelector('.timeline .range')?.value, document.querySelector('.hud')?.textContent]);
      console.log(`   ${i}: A ${JSON.stringify(a)}  B ${JSON.stringify(b)}`);
      await B.waitForTimeout(300);
    }
  }
  // Durdurma bildirimi birkaç yüz ms sonra gelir; o arada tahmini konum gösterilir.
  await until(B, () => document.querySelector('.time')?.textContent === '0:06', null, 3000);
  const timeShown = await B.evaluate(() => ({
    label: document.querySelector('.time')?.textContent,
    range: document.querySelector('.timeline .range')?.value,
    max: document.querySelector('.timeline .range')?.max,
  }));
  check('telefonda süre doğru (0:06)', timeShown.label === '0:06', JSON.stringify(timeShown));
  check('telefonda yatay taşma yok', await B.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await B.screenshot({ path: join(OUT, 'telefon-3-izleme.png') });

  check('hata yok', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  await B.screenshot({ path: join(OUT, 'telefon-hata.png') }).catch(() => {});
  fail();
} finally {
  await cleanup();
}
process.exit(finish());
