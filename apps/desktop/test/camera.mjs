// Kamera arka planı testi (gerçek Electron, iki pencere): "Arkamı bulanıklaştır" açılınca hem
// kendi önizlemem hem de karşıya giden görüntü bulanıklaşıyor mu, kapatınca geri geliyor mu?
// Sahte kamerada kişi yok: bütün kare "arka plan" sayılır ve bulanıklaşmalıdır.
//   →  npm run test:camera

import { join } from 'node:path';
import { createChecks, enterWatch, OUT, pair, startPair, until } from './lib/harness.mjs';

const { check, finish, fail } = createChecks();
const { A, B, errors, cleanup } = await startPair({ port: 8794 });

/** Karedeki keskin kenarların oranı: yan yana iki piksel arasında belirgin parlaklık sıçraması (bulanıkta kaybolur; sıkıştırma gürültüsü buna takılmaz) */
const sharpness = (page, which) =>
  page.evaluate(async (which) => {
    const v = window.__birlikte.watch[which];
    if (!v.videoWidth) return -1;
    const c = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    let total = 0;
    for (let k = 0; k < 3; k++) {
      ctx.drawImage(v, 0, 0, 320, 180);
      const d = ctx.getImageData(0, 0, 320, 180).data;
      let sum = 0;
      for (let y = 0; y < 180; y++) {
        for (let x = 0; x < 319; x++) {
          const i = (y * 320 + x) * 4;
          const l1 = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
          const l2 = d[i + 4] * 0.3 + d[i + 5] * 0.59 + d[i + 6] * 0.11;
          if (Math.abs(l1 - l2) > 18) sum++;
        }
      }
      total += (sum / (319 * 180)) * 1000;
      await new Promise((r) => setTimeout(r, 120));
    }
    return total / 3;
  }, which);
const set = (page, key, value) => page.evaluate(([k, v]) => window.__birlikte.setSetting(k, v), [key, value]);
const fmt = (n) => n.toFixed(2);

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));
  await A.evaluate(() => window.__birlikte.watch.setCam(true));
  check('A kamerası açık, B görüyor', await until(B, () => window.__birlikte.watch.remoteCam.videoWidth > 0, null, 20_000));
  await A.waitForTimeout(1500);
  const before = { mine: await sharpness(A, 'localCam'), theirs: await sharpness(B, 'remoteCam') };

  await set(A, 'camera.background', 'strong');
  check(
    'bulanık kopya hazırlandı ve gönderiliyor',
    await until(A, () => {
      const w = window.__birlikte.watch;
      return !!w.camOut && w.camOut !== w.camTrack && w.camOut.readyState === 'live';
    }, null, 20_000),
  );
  await A.waitForTimeout(2500);
  const after = { mine: await sharpness(A, 'localCam'), theirs: await sharpness(B, 'remoteCam') };
  check('kendi önizlemem bulanıklaştı', after.mine >= 0 && after.mine < before.mine * 0.3, `${fmt(before.mine)} → ${fmt(after.mine)} ‰ keskin kenar`);
  check('karşıya giden görüntü bulanıklaştı', after.theirs >= 0 && after.theirs < before.theirs * 0.3, `${fmt(before.theirs)} → ${fmt(after.theirs)} ‰ keskin kenar`);
  await A.screenshot({ path: join(OUT, 'kamera-bulanik-A.png') });
  await B.screenshot({ path: join(OUT, 'kamera-bulanik-B.png') });

  await set(A, 'camera.background', 'none');
  check('kapatınca kameranın kendisi gidiyor', await until(A, () => window.__birlikte.watch.camOut === window.__birlikte.watch.camTrack, null, 5000));
  await A.waitForTimeout(2000);
  const off = await sharpness(B, 'remoteCam');
  check('karşıda yine net', off > before.theirs * 0.6, `${fmt(off)} ‰`);

  const real = errors.filter((e) => !/favicon|Autofill/.test(e));
  check('konsolda hata yok', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  fail();
} finally {
  await cleanup();
}
process.exit(finish());
