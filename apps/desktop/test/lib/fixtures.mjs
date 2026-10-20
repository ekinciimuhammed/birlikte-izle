// Gerçek hayattaki "zor" dizi dosyalarını taklit eden test dosyaları (ffmpeg ile üretilir).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');
export const FIXTURES = join(tmpdir(), 'birlikte-izle-dosyalar-v1');

// Windows-1254 (eski Türkçe altyazıların çoğu böyle kaydedilmiştir)
const CP1254 = { ş: 0xfe, Ş: 0xde, ğ: 0xf0, Ğ: 0xd0, ı: 0xfd, İ: 0xdd, ç: 0xe7, Ç: 0xc7, ö: 0xf6, Ö: 0xd6, ü: 0xfc, Ü: 0xdc };
const toCp1254 = (text) => Buffer.from([...text].map((ch) => CP1254[ch] ?? ch.charCodeAt(0)));

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Merhaba aşkım, şöyle güzel bir gün!',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  '<i>Işığı kapat,</i> çay demlensin.',
  '',
].join('\r\n');

const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });

export function makeFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  const files = {
    /** İki ses (AC3 5.1 Türkçe dublaj varsayılan + AAC İngilizce), içinde Türkçe altyazı */
    mkv: join(FIXTURES, 'Dizi.S01E01.iki-dil.mkv'),
    /** Eski tip: MPEG-4 Part 2 (Xvid benzeri) + MP3 — tarayıcı görüntüyü çözemez */
    avi: join(FIXTURES, 'Eski.Dizi.S02E05.avi'),
    /** Sıradan MP4 + yanında Windows-1254 kodlu "….tr.srt" */
    mp4: join(FIXTURES, 'Altyazili.Bolum.mp4'),
  };
  if (Object.values(files).every(existsSync)) return files;

  const srt = join(FIXTURES, 'gomulu.srt');
  writeFileSync(srt, SRT, 'utf8');
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=30'];

  ff(
    ...src,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=30',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a:0', 'ac3', '-ac:a:0', '6', '-c:a:1', 'aac', '-ac:a:1', '2', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=tur', '-metadata:s:a:0', 'title=Türkçe Dublaj', '-disposition:a:0', 'default',
    '-metadata:s:a:1', 'language=eng', '-disposition:a:1', '0',
    '-metadata:s:s:0', 'language=tur',
    files.mkv,
  );
  ff(
    ...src,
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=30',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-b:a', '128k',
    files.avi,
  );
  ff(
    ...src,
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
    files.mp4,
  );
  writeFileSync(join(FIXTURES, 'Altyazili.Bolum.tr.srt'), toCp1254(SRT));
  return files;
}

/** Aktarımı yarıda kesip kaldığı yerden devam ettirmek için büyükçe bir bölüm (~60 MB) */
export function makeBigFixture() {
  mkdirSync(FIXTURES, { recursive: true });
  const path = join(FIXTURES, 'Buyuk.Bolum.S01E02.mp4');
  if (existsSync(path)) return path;
  ff(
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=600:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart',
    path,
  );
  return path;
}
