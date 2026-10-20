// Senkron mod ve "Bölümü ona gönder" testi (gerçek Electron, iki pencere):
// bölüm P2P gidiyor mu, gelince ikisi de kendi kopyasından mı oynatıyor (yayın kapanıyor mu),
// konumlar ne kadar yakın, sarma/durdurma/kayma düzeltme/takılınca bekleme çalışıyor mu,
// yarıda kesilen aktarım kaldığı yerden devam ediyor mu, aynı dosya kendiliğinden bulunuyor mu?
//   →  npm run test:sync

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBigFixture, makeFixtures } from './lib/fixtures.mjs';
import { createChecks, enterWatch, OUT, pair, startPair, until, visible } from './lib/harness.mjs';

const { check, finish, fail } = createChecks();
const files = makeFixtures();
const big = makeBigFixture();
check('test dosyaları üretildi', existsSync(files.mp4) && existsSync(big));

const run = Date.now().toString(36);
// Gelen bölümler her iki taraf için ayrı, boş bir geçici klasöre (gerçek İndirilenler'e değil).
const DL = { A: join(tmpdir(), `birlikte-izle-indirilen-${run}-a`), B: join(tmpdir(), `birlikte-izle-indirilen-${run}-b`) };
const { A, B, errors, cleanup, settingsFile } = await startPair({
  port: 8792,
  run,
  env: { A: { BIRLIKTE_DOWNLOADS: DL.A }, B: { BIRLIKTE_DOWNLOADS: DL.B } },
});

const state = (page) => page.evaluate(() => window.__birlikte.state());
const open = (page, path) => page.evaluate((p) => window.__birlikte.watch.openPath(p), path);
const cmd = (page, action, value) => page.evaluate(([a, v]) => window.__birlikte.watch.command(a, v), [action, value]);
const movieSending = () => A.evaluate(() => !!window.__birlikte.watch.link?.senders.get('movie-video')?.track);
const guestStreamVideo = () => until(B, () => document.querySelectorAll('.media-slot')[1]?.querySelector('video')?.videoWidth > 0, null, 30_000);
const received = () => (existsSync(DL.B) ? readdirSync(DL.B) : []);

/** İki süreç aynı makinede aynı duvar saatini görür: A'nın konumunu B'nin ölçüldüğü ana taşıyıp karşılaştır. */
const drift = async () => {
  const at = (page) =>
    page.evaluate(() => ({
      t: window.__birlikte.watch.mediaTime(),
      w: performance.timeOrigin + performance.now(),
      playing: !window.__birlikte.watch.localMovie.paused,
    }));
  const a = await at(A);
  const b = await at(B);
  return a.t + (a.playing ? (b.w - a.w) / 1000 : 0) - b.t;
};
const fmt = (d) => `${Math.round(d * 1000)} ms`;

const openMenu = async (page) => {
  await page.mouse.move(500, 300);
  await page.mouse.move(520, 320);
  await page.getByRole('button', { name: 'Altyazı ve ses (S)' }).click();
};
const closeMenu = (page) => page.keyboard.press('Escape');

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));
  check('A, onun masaüstü uygulamasında olduğunu biliyor', await until(A, () => window.__birlikte.state().peerDesktop, null, 5000));

  // --- 1) B'de dosya yok: yayından izler ------------------------------------------------------
  await open(A, files.mp4);
  check('B yayını alıyor (dosya onda yok)', await guestStreamVideo());
  check('B dosyanın kimliğini aldı', await until(B, () => !!window.__birlikte.state().peerFile, null, 5000));
  check('henüz senkron mod yok', !(await state(B)).syncMode && (await movieSending()));

  // --- 2) "Bölümü ona gönder" (arayüzden) ----------------------------------------------------
  await openMenu(A);
  await A.getByRole('button', { name: 'Bölümü ona gönder' }).click();
  await closeMenu(A);
  check('B: bölüm geldi ve kendi kopyasından oynatıyor', await until(B, () => window.__birlikte.state().syncMode, null, 60_000));
  const got = received().filter((n) => n.endsWith('.mp4'));
  check(
    'dosya "Birlikte İzle" klasörüne tam boyutta yazıldı',
    got.length === 1 && statSync(join(DL.B, got[0])).size === statSync(files.mp4).size,
    got.join(', '),
  );
  check('yarım dosya (.part) kalmadı', !received().some((n) => n.endsWith('.part')));
  check('A: senkron modda, film yayını kapandı', await until(A, () => window.__birlikte.state().syncMode && !window.__birlikte.watch.link?.senders.get('movie-video')?.track, null, 5000));
  check('B: kendi oynatıcısı görünüyor, yayın gizli', await B.evaluate(() => {
    const [local, remote] = document.querySelectorAll('.media-slot');
    return !local.hidden && local.querySelector('video')?.src.startsWith('birlikte-media://') && remote.hidden;
  }));
  check('"Tam kalite" rozeti iki tarafta da var', (await visible(A.locator('.quality-badge'), 3000)) && (await visible(B.locator('.quality-badge'), 3000)));

  // --- 3) Konumlar ne kadar yakın? -------------------------------------------------------------
  await cmd(A, 'play');
  await A.waitForTimeout(3000);
  let d = await drift();
  check('birlikte oynarken fark < 80 ms', Math.abs(d) < 0.08, fmt(d));

  await cmd(B, 'seek', 20); // B sarıyor: host uygular, B'nin kopyası takip eder
  await A.waitForTimeout(1500);
  d = await drift();
  check('B sardı → ikisi de 20. saniyede (fark < 80 ms)', Math.abs(d) < 0.08 && (await A.evaluate(() => window.__birlikte.watch.mediaTime())) > 20, fmt(d));

  await cmd(B, 'pause');
  check('B durdurdu → A da durdu', await until(A, () => window.__birlikte.watch.localMovie.paused, null, 3000));
  await A.waitForTimeout(600);
  d = await drift();
  check('durunca aynı karede (fark < 100 ms)', Math.abs(d) < 0.1, fmt(d));

  // --- 4) Kayma düzeltme -----------------------------------------------------------------------
  await cmd(A, 'seek', 5);
  await cmd(A, 'play');
  await A.waitForTimeout(1500);
  await B.evaluate(() => (window.__birlikte.watch.localMovie.currentTime += 3)); // büyük kayma → sarar
  await B.waitForTimeout(1500);
  d = await drift();
  check('3 sn kayma sarılarak düzeldi', Math.abs(d) < 0.12, fmt(d));

  await B.evaluate(() => (window.__birlikte.watch.localMovie.currentTime -= 0.3)); // küçük kayma → hız
  await B.waitForTimeout(700);
  const rate = await B.evaluate(() => window.__birlikte.watch.localMovie.playbackRate);
  check('küçük kaymada hız ayarlanıyor (sarma yok)', rate > 1 && rate <= 1.05, rate.toFixed(3));
  check(
    'hız ayarıyla düzeldi ve hız 1\'e döndü',
    await until(B, () => window.__birlikte.watch.localMovie.playbackRate === 1, null, 12_000),
  );
  d = await drift();
  check('düzeldikten sonra fark < 60 ms', Math.abs(d) < 0.06, fmt(d));

  // --- 5) B'nin kopyası takılırsa A bekler ----------------------------------------------------
  await B.evaluate(() => window.__birlikte.watch.localMovie.dispatchEvent(new Event('waiting')));
  check('B 1 sn takılınca A bekliyor', await until(A, () => window.__birlikte.watch.localMovie.paused, null, 3000));
  check('A ekranında "bekleniyor" yazıyor', /Bade için bekleniyor/.test(await A.evaluate(() => document.querySelector('.hud')?.textContent ?? '')));
  await B.evaluate(() => window.__birlikte.watch.localMovie.dispatchEvent(new Event('canplay')));
  check('B hazır olunca A devam ediyor', await until(A, () => !window.__birlikte.watch.localMovie.paused, null, 3000));

  // --- 6) Yayına dönüş (arayüzden) -----------------------------------------------------------
  await openMenu(B);
  await B.getByRole('button', { name: 'Yayından izle' }).click();
  await closeMenu(B);
  check('B yayına döndü', await until(B, () => !window.__birlikte.state().syncMode, null, 3000));
  check('A yayını yeniden açtı', await until(A, () => !!window.__birlikte.watch.link?.senders.get('movie-video')?.track, null, 5000));
  check('B yine yayını görüyor', await guestStreamVideo());

  // --- 7) Aynı dosya B'de artık var: yeniden açılınca kendiliğinden bulunur ---------------------
  await open(A, files.avi);
  check('başka bölüm: senkron mod yok', await until(B, () => !window.__birlikte.state().syncMode && window.__birlikte.state().title.startsWith('Eski'), null, 10_000));
  await open(A, files.mp4);
  check('aynı bölüm: B kendi kopyasını kendiliğinden buldu', await until(B, () => window.__birlikte.state().syncMode, null, 20_000));
  check('bu sefer aktarım olmadı', received().filter((n) => n.endsWith('.mp4')).length === 1);

  // --- 8) Yarıda kesilen aktarım kaldığı yerden devam eder ----------------------------------------
  await open(A, big);
  check('büyük bölüm açıldı', await until(B, () => window.__birlikte.state().title.startsWith('Buyuk'), null, 15_000));
  await A.evaluate(() => window.__birlikte.watch.sendFile());
  const half = await until(B, () => {
    const t = window.__birlikte.state().transfer;
    return t && t.done > t.size * 0.2;
  }, null, 30_000);
  check('aktarım başladı', half);
  await B.evaluate(() => window.__birlikte.watch.cancelTransfer());
  check('B durdurdu → A da durdu', await until(A, () => !window.__birlikte.state().transfer, null, 5000));
  await A.waitForTimeout(500);
  const part = received().find((n) => n.endsWith('.part'));
  const partSize = part ? statSync(join(DL.B, part)).size : 0;
  check('yarım dosya duruyor', partSize > 0, `${(partSize / 1e6).toFixed(1)} MB`);

  // Yeniden gönder: alan taraf kaldığı yeri bildirir; ilk ilerleme bildirimi oradan başlar.
  const resumeFrom = B.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const poll = () => {
          const t = window.__birlikte.state().transfer;
          if (t) return resolve(t.done);
          if (Date.now() - t0 > 10_000) return resolve(-1);
          setTimeout(poll, 2);
        };
        poll();
      }),
  );
  await A.evaluate(() => window.__birlikte.watch.sendFile());
  const from = await resumeFrom;
  check('ikinci gönderim kaldığı yerden başladı', from >= partSize * 0.9 && from > 0, `${(from / 1e6).toFixed(1)} MB`);
  check('tamamlandı ve B kendi kopyasından izliyor', await until(B, () => window.__birlikte.state().syncMode, null, 60_000));
  const bigCopy = received().find((n) => n.startsWith('Buyuk') && n.endsWith('.mp4'));
  check('büyük dosya tam boyutta', !!bigCopy && statSync(join(DL.B, bigCopy)).size === statSync(big).size);

  await A.screenshot({ path: join(OUT, 'senkron-A.png') });
  await B.screenshot({ path: join(OUT, 'senkron-B.png') });

  // --- 9) "Birlikte izlediğimiz saatler" ---------------------------------------------------------
  await A.getByRole('button', { name: 'Ana ekran' }).click();
  await B.getByRole('button', { name: 'Ana ekran' }).click();
  await A.waitForTimeout(800);
  const stats = (i) => {
    try {
      return JSON.parse(JSON.parse(readFileSync(settingsFile(i), 'utf8'))['stats.together'] ?? '{}');
    } catch {
      return {};
    }
  };
  const [sa, sb] = [stats(0), stats(1)];
  check('birlikte izlenen süre sayıldı (iki tarafta da)', sa.total > 8 && sb.total > 8, `${sa.total} sn / ${sb.total} sn`);
  check('iki tarafın saydığı süre aynı (±3 sn)', Math.abs(sa.total - sb.total) < 3);
  check('bölüm bazında da tutuluyor', Object.keys(sa.titles ?? {}).some((t) => t.startsWith('Altyazili')));
  // Kart 1 dakikadan sonra görünür: biraz ekleyip ana ekrana bak
  await A.evaluate(() => {
    const s = JSON.parse(window.__birlikte.getSetting('stats.together'));
    s.total += 3 * 3600;
    window.__birlikte.setSetting('stats.together', JSON.stringify(s));
  });
  check('ana ekranda "birlikte" kartı', await visible(A.locator('.together', { hasText: 'Bade ile birlikte' }), 3000), await A.locator('.together').textContent().catch(() => ''));
  await A.screenshot({ path: join(OUT, 'senkron-A-ana-ekran.png') });

  const real = errors.filter((e) => !/favicon|Autofill/.test(e));
  check('konsolda hata yok', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  fail();
} finally {
  await cleanup();
  for (const dir of Object.values(DL)) rmSync(dir, { recursive: true, force: true });
}
process.exit(finish());
