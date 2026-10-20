// Medya uyumluluk testi (gerçek Electron, iki pencere):
// zor dosyalar doğru yoldan açılıyor mu, altyazı iki tarafta da doğru mu, ses dili değişiyor mu,
// canlı dönüştürmede sarma çalışıyor mu, film sesi stereo mu, "o konuşunca kıs" çalışıyor mu?
//   →  npm run test:media

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtures } from './lib/fixtures.mjs';
import { createChecks, enterWatch, OUT, pair, startPair, until, visible } from './lib/harness.mjs';

const { check, finish, fail } = createChecks();
const STEREO = join(tmpdir(), 'birlikte-izle-test-30sn.webm'); // sol 440 Hz, sağ 660 Hz (npm test üretir)

const files = makeFixtures();
check('test dosyaları üretildi', Object.values(files).every(existsSync));

const { A, B, errors, cleanup, settingsFile } = await startPair({ port: 8791 });

const open = (page, path) => page.evaluate((p) => window.__birlikte.watch.openPath(p), path);
const src = (page) => page.evaluate(() => document.querySelectorAll('.media-slot')[0].querySelector('video').getAttribute('src') ?? '');
const hostTime = () => A.evaluate(() => window.__birlikte.watch.mediaTime());
const subtitleText = (page) => page.evaluate(() => document.querySelector('.subtitles')?.textContent ?? '');
const guestHasVideo = () => until(B, () => document.querySelectorAll('.media-slot')[1]?.querySelector('video')?.videoWidth > 0, null, 30_000);
const seekPause = async (t) => {
  await A.evaluate((t) => window.__birlikte.watch.command('seek', t), t);
  await A.evaluate(() => window.__birlikte.watch.command('pause'));
  await A.waitForTimeout(800);
};

try {
  check('eşleşti', await pair(A, B));
  check('P2P bağlandı', await enterWatch(A, B));

  // --- 1) MKV: AC3 5.1 ses → "hazırla" yolu; gömülü Türkçe altyazı ---------------------------
  await open(A, files.mkv);
  check('MKV + AC3: "hazırla" yoluyla açıldı', (await src(A)).startsWith('birlikte-media://prepared/'), await src(A));
  const hostAudio = await A.evaluate(() => {
    const s = window.__birlikte.state();
    return { count: s.audioTracks.length, label: s.audioLabel };
  });
  check('iki ses izi bulundu, Türkçe dublaj seçili', hostAudio.count === 2 && /Türkçe Dublaj · 5\.1/.test(hostAudio.label ?? ''), JSON.stringify(hostAudio));
  check('B yayını alıyor', await guestHasVideo());
  check('B çalan sesin adını görüyor', await until(B, () => /Türkçe Dublaj/.test(window.__birlikte.state().audioLabel ?? ''), null, 5000));

  await seekPause(1.5);
  check('A: gömülü Türkçe altyazı görünüyor', /Merhaba aşkım, şöyle güzel bir gün!/.test(await subtitleText(A)), await subtitleText(A));
  check('B: altyazı ona da geldi ve aynı anda görünüyor', await until(B, () => /Merhaba aşkım/.test(document.querySelector('.subtitles')?.textContent ?? ''), null, 8000));

  await A.keyboard.press('BracketRight');
  check('zaman kaydırma ikisine de geçti', await until(B, () => /\+0,25/.test(document.querySelector('.hud')?.textContent ?? ''), null, 3000));
  await A.keyboard.press('BracketLeft');

  // Ses dilini İngilizceye çevir → yeniden hazırlanır, aynı yerden devam eder
  const before = await hostTime();
  await A.evaluate(() => window.__birlikte.watch.setAudioTrack(1));
  check('ses dili değişti (İngilizce)', await until(A, () => /İngilizce/.test(document.querySelector('.hud')?.textContent ?? ''), null, 30_000));
  const after = await hostTime();
  check('aynı saniyeden devam etti', before > 1 && Math.abs(after - before) < 1, `${before.toFixed(1)} → ${after.toFixed(1)}`);
  await A.screenshot({ path: join(OUT, 'medya-A-mkv-altyazi.png') });
  await B.screenshot({ path: join(OUT, 'medya-B-mkv-altyazi.png') });

  // --- 2) AVI (MPEG-4 + MP3): tarayıcı çözemez → canlı dönüştürme; sarma ----------------------
  await open(A, files.avi);
  check('AVI: canlı dönüştürmeyle açıldı', (await src(A)).startsWith('birlikte-media://live/'), await src(A));
  await A.evaluate(() => window.__birlikte.watch.command('play'));
  check('B, AVI yayınını alıyor', await guestHasVideo());
  await A.waitForTimeout(1500);
  await A.evaluate(() => window.__birlikte.watch.command('seek', 15));
  check('canlıda 15. saniyeye sarıldı', await until(A, () => Math.abs(window.__birlikte.watch.mediaTime() - 15) < 2.5, null, 20_000), (await hostTime()).toFixed(1));
  check('canlıda sarınca oynamaya devam ediyor', await until(A, () => window.__birlikte.watch.mediaTime() > 15.5, null, 15_000));
  check('B de 15. saniye civarını görüyor', await until(B, () => /^0:1[4-9]/.test(document.querySelector('.time')?.textContent ?? ''), null, 15_000));

  // --- 3) MP4 + yanında Windows-1254 kodlu altyazı → doğrudan oynatma -------------------------
  await open(A, files.mp4);
  check('MP4: doğrudan açıldı (dönüştürme yok)', (await src(A)).startsWith('birlikte-media://file/'), await src(A));
  await guestHasVideo();
  await seekPause(6);
  check('Windows-1254 altyazı doğru çözüldü (ı, ş, ğ)', /Işığı kapat, çay demlensin\./.test(await subtitleText(A)), await subtitleText(A));
  check('italik korunuyor', await A.evaluate(() => !!document.querySelector('.subtitles i')));
  check('B de aynı altyazıyı görüyor', await until(B, () => /Işığı kapat/.test(document.querySelector('.subtitles')?.textContent ?? ''), null, 8000));

  // --- 4) Film sesi stereo mu? (sol 440 Hz, sağ 660 Hz) ---------------------------------------
  if (existsSync(STEREO)) {
    await open(A, STEREO);
    await guestHasVideo();
    await A.evaluate(() => window.__birlikte.watch.command('play'));
    const peaks = await B.evaluate(async () => {
      const v = document.querySelectorAll('.media-slot')[1].querySelector('video');
      const ac = new AudioContext();
      const source = ac.createMediaStreamSource(v.srcObject);
      const split = ac.createChannelSplitter(2);
      source.connect(split);
      const make = (ch) => {
        const an = ac.createAnalyser();
        an.fftSize = 8192;
        split.connect(an, ch);
        return an;
      };
      const L = make(0);
      const R = make(1);
      await new Promise((r) => setTimeout(r, 2500));
      const rms = (an) => {
        const d = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(d);
        return Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length).toFixed(3);
      };
      const audioIn = window.__birlikte.state().stats?.streams.find((x) => x.role === 'movie' && x.kind === 'audio' && x.dir === 'in');
      const debug = {
        ctx: ac.state,
        tracks: v.srcObject.getAudioTracks().map((t) => `${t.readyState}/${t.muted ? 'muted' : 'live'}`),
        rms: [rms(L), rms(R)],
        kbps: audioIn?.kbps ?? null,
      };
      const peak = (an) => {
        const d = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(d);
        let best = 0;
        for (let i = 1; i < d.length; i++) if (d[i] > d[best]) best = i;
        return Math.round((best * ac.sampleRate) / an.fftSize);
      };
      return { left: peak(L), right: peak(R), debug };
    });
    const hostAudio = await A.evaluate(async () => {
      const w = window.__birlikte.watch; // (testte iç durumu okumak için)
      const sender = w.link?.senders?.get('movie-audio');
      const t = sender?.track;
      let rms = null;
      if (t) {
        const ac = new AudioContext();
        const an = ac.createAnalyser();
        ac.createMediaStreamSource(new MediaStream([t])).connect(an);
        await new Promise((r) => setTimeout(r, 500));
        const d = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(d);
        rms = Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length).toFixed(3);
        ac.close();
      }
      const tr = w.link?.pc?.getTransceivers().find((x) => x.sender === sender);
      const stats = await w.link?.pc?.getStats();
      const outAudio = [...(stats?.values() ?? [])].filter((s) => s.type === 'outbound-rtp' && s.kind === 'audio').map((s) => `${s.mid}:${s.packetsSent}p:${s.active}`);
      return {
        sender: t ? `${t.id.slice(0, 6)}:${t.readyState}:${t.muted ? 'muted' : 'açık'}:${t.enabled}` : 'yok',
        rms,
        dir: tr ? `${tr.direction}/${tr.currentDirection}/mid ${tr.mid}` : '-',
        enc: JSON.stringify(sender?.getParameters().encodings),
        outAudio,
        playing: !w.localMovie.paused,
      };
    });
    const stereoOk = Math.abs(peaks.left - 440) < 25 && Math.abs(peaks.right - 660) < 25;
    if (!stereoOk) console.log('   A (paylaşan):', JSON.stringify(hostAudio));
    check('karşıya giden film sesi gerçekten stereo', stereoOk, `sol ${peaks.left} Hz, sağ ${peaks.right} Hz ${JSON.stringify(peaks.debug)}`);

    // --- 5) "O konuşunca kıs": A'nın (sahte) mikrofonu bip sesi çıkarır → B'de film sesi kısılmalı
    const minVolume = await B.evaluate(async () => {
      const v = document.querySelectorAll('.media-slot')[1].querySelector('video');
      let min = 1;
      for (let i = 0; i < 60; i++) {
        min = Math.min(min, v.volume);
        await new Promise((r) => setTimeout(r, 80));
      }
      return min;
    });
    check('o konuşunca film sesi kısılıyor (sadece dinleyende)', minVolume < 0.8, `en düşük ${minVolume.toFixed(2)}`);
  } else {
    console.log('  (stereo testi atlandı: önce `npm test` çalıştır)');
  }

  // --- 6) Kaldığınız yerden --------------------------------------------------------------------
  await A.getByRole('button', { name: 'Ana ekran' }).click();
  check('ana ekranda "Kaldığınız yerden"', await visible(A.getByText('Kaldığınız yerden'), 5000));
  const saved = JSON.parse(readFileSync(settingsFile(0), 'utf8'));
  const history = JSON.parse(saved['history.items'] ?? '[]');
  check('geçmişe kaydedildi', history.some((h) => h.path === files.avi) && history.some((h) => h.path === files.mp4), `${history.length} kayıt`);
  await A.screenshot({ path: join(OUT, 'medya-A-ana-ekran-gecmis.png') });

  check('pencerelerde hata yok', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  fail();
} finally {
  await cleanup();
}

process.exit(finish());
