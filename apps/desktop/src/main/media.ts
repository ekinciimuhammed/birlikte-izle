// Medya: ffmpeg ile her dosyayı oynatılabilir hale getirir.
//
//   probe     → dosyanın kapsayıcısı, izleri, dilleri
//   file      → dosyayı olduğu gibi sunar (Range destekli; ileri/geri sarma çalışır)
//   prepare   → görüntüyü olduğu gibi bırakıp sesi AAC'ye çevirir, MP4'e koyar (önbelleğe)
//   live      → her şeyi anında H.264/AAC'ye çevirir (sarınca baştan başlar)
//   subtitles → yanındaki altyazı dosyalarını ve MKV içindeki metin altyazıları bulur
//
// Arayüz dosya yollarına doğrudan erişemez; sadece burada açılmış dosyalara verilen
// kimliklerle "birlikte-media://" adresinden ulaşabilir.

import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fs,
  readdirSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  MEDIA_SCHEME,
  mediaUrl,
  type AudioMode,
  type AudioStream,
  type FileRef,
  type MediaInfo,
  type SubtitleSource,
  type SubtitleStream,
  type VideoStream,
} from '../shared/media';

const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'wmv', 'flv', 'ts', 'm2ts', 'mpg', 'mpeg', 'ogv', '3gp'];
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
};

const opened = new Map<string, MediaInfo>();
const prepared = new Map<string, string>(); // önbellek anahtarı → dosya yolu
const jobs = new Map<string, ChildProcess>(); // medya kimliği → çalışan hazırlama
const live = new Map<string, ChildProcess>(); // medya kimliği → çalışan canlı dönüştürme

export function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (app.isPackaged) return join(process.resourcesPath, 'bin', exe);
  // Geliştirmede ffmpeg-static paketinin indirdiği dosya
  return createRequire(__filename)('ffmpeg-static') as string;
}

const cacheDir = () => join(app.getPath('temp'), 'birlikte-izle');

/** app.ready'den ÖNCE çağrılmalı. */
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

export function setupMedia() {
  cleanCache();
  protocol.handle(MEDIA_SCHEME, handleRequest);

  ipcMain.handle('media:open-dialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = {
      title: 'Bir bölüm seç',
      properties: ['openFile' as const],
      filters: [
        { name: 'Videolar', extensions: VIDEO_EXTENSIONS },
        { name: 'Tüm dosyalar', extensions: ['*'] },
      ],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return res.canceled || !res.filePaths[0] ? null : openPath(res.filePaths[0]);
  });
  ipcMain.handle('media:open-path', (_e, path: unknown) => (typeof path === 'string' ? openPath(path) : null));
  ipcMain.handle('media:prepare', (e, id: string, audio: number, mode: AudioMode) =>
    prepare(id, audio, mode, (ratio) => e.sender.send('media:progress', { id, ratio })),
  );
  ipcMain.handle('media:cancel', (_e, id: string) => {
    jobs.get(id)?.kill('SIGKILL');
    live.get(id)?.kill('SIGKILL');
  });
  ipcMain.handle('media:subtitles', (_e, id: string) => findSubtitles(id));
  ipcMain.handle('media:find', (_e, ref: FileRef, dirs: unknown) =>
    findCopy(ref, Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string') : []),
  );
  ipcMain.handle('media:read', (_e, id: string, offset: number, length: number) => readChunk(id, offset, length));
  ipcMain.handle('transfer:begin', (_e, ref: FileRef) => beginReceive(ref));
  ipcMain.on('transfer:chunk', (_e, fingerprint: string, chunk: Uint8Array) => receiving.get(fingerprint)?.write(chunk));
  ipcMain.handle('transfer:finish', (_e, fingerprint: string) => finishReceive(fingerprint));
  ipcMain.handle('transfer:abort', (_e, fingerprint: string) => abortReceive(fingerprint));

  app.on('will-quit', () => {
    for (const p of [...jobs.values(), ...live.values()]) p.kill('SIGKILL');
  });
}

// --- Dosya bilgisi -------------------------------------------------------------------------

async function openPath(path: string): Promise<MediaInfo> {
  const st = statSync(path);
  if (!st.isFile()) throw new Error('Bu bir dosya değil');
  const [info, print] = await Promise.all([probe(path), fingerprint(path, st.size)]);
  const media: MediaInfo = {
    id: randomUUID(),
    path,
    name: basename(path, extname(path)),
    size: st.size,
    fingerprint: print,
    ...info,
  };
  opened.set(media.id, media);
  return media;
}

type Probe = Pick<MediaInfo, 'container' | 'duration' | 'video' | 'audio' | 'subtitles'>;

/** `ffmpeg -i` çıktısını okur (ayrı bir ffprobe taşımamak için). */
function probe(path: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', reject);
    proc.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const parsed = parseProbe(text);
      if (!parsed) reject(new Error(text.split('\n').filter(Boolean).at(-1) ?? 'Dosya okunamadı'));
      else resolve(parsed);
    });
  });
}

export function parseProbe(text: string): Probe | null {
  const input = /^Input #0, ([^,]+(?:,[^,]+)*?), from /m.exec(text);
  if (!input) return null;
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;

  let video: VideoStream | null = null;
  const audio: AudioStream[] = [];
  const subtitles: SubtitleStream[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*Stream #0:\d+(?:\[0x[0-9a-f]+\])?(?:\(([a-z]{2,3})\))?: (Video|Audio|Subtitle): ([\w-]+)(?: \(([^)]*)\))?(.*)$/.exec(
      lines[i]!,
    );
    if (!m) continue;
    const [, lang, kind, codec, profile, rest = ''] = m;
    // Akışın altındaki "Metadata:" bloğundan başlık
    let title: string | null = null;
    for (let j = i + 1; j < lines.length && /^\s{4,}/.test(lines[j]!) && !/Stream #/.test(lines[j]!); j++) {
      const t = /^\s+title\s*:\s*(.+)$/.exec(lines[j]!);
      if (t) title = t[1]!.trim();
    }
    const language = lang && lang !== 'und' ? lang : null;
    const isDefault = /\(default\)/.test(rest);

    if (kind === 'Video' && !video && !/attached pic/.test(rest)) {
      const size = /(\d{2,5})x(\d{2,5})/.exec(rest);
      const fps = /([\d.]+) fps/.exec(rest);
      const pix = /, (\w*?(?:yuv|nv|p0|gray)\w*)/.exec(rest)?.[1] ?? '';
      const depth = /(?:p|le|be)(10|12)/.exec(pix) ?? /(10|12)(?:le|be)/.exec(pix);
      video = {
        codec: codec!,
        profile: profile ?? null,
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        fps: fps ? Number(fps[1]) : null,
        bitDepth: depth ? Number(depth[1]) : /10/.test(profile ?? '') ? 10 : 8,
      };
    } else if (kind === 'Audio') {
      audio.push({ index: audio.length, codec: codec!, channels: channelCount(rest), language, title, isDefault });
    } else if (kind === 'Subtitle') {
      subtitles.push({
        index: subtitles.length,
        codec: codec!,
        language,
        title,
        isDefault,
        text: !/pgs|dvd_sub|dvb_sub|xsub|dvb_teletext/.test(codec!),
      });
    }
  }
  return { container: input[1]!, duration, video, audio, subtitles };
}

function channelCount(rest: string) {
  if (/\bmono\b/.test(rest)) return 1;
  if (/\bstereo\b/.test(rest)) return 2;
  const layout = /(\d+)\.(\d+)/.exec(rest);
  if (layout) return Number(layout[1]) + Number(layout[2]);
  const n = /(\d+) channels/.exec(rest);
  return n ? Number(n[1]) : 2;
}

// --- birlikte-media:// istekleri --------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.pathname.slice(1);
  try {
    if (url.hostname === 'file') {
      const media = opened.get(id);
      return media ? serveFile(media.path, req) : notFound();
    }
    if (url.hostname === 'prepared') {
      const path = prepared.get(id);
      return path ? serveFile(path, req) : notFound();
    }
    if (url.hostname === 'live') {
      const media = opened.get(id);
      if (!media) return notFound();
      return serveLive(media, Number(url.searchParams.get('start') ?? 0), Number(url.searchParams.get('audio') ?? 0));
    }
  } catch (err) {
    console.error('Medya isteği', err);
    return new Response(null, { status: 500 });
  }
  return notFound();
}

const notFound = () => new Response(null, { status: 404 });

// captureStream() için kaynak "CORS uyumlu" olmalı; aksi halde tarayıcı yayını kirli sayar.
const BASE_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

function serveFile(path: string, req: Request): Response {
  const size = statSync(path).size;
  const headers = { ...BASE_HEADERS, 'content-type': MIME[extname(path).toLowerCase()] ?? 'video/mp4', 'accept-ranges': 'bytes' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  if (!range) {
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      status: 200,
      headers: { ...headers, 'content-length': String(size) },
    });
  }
  let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  start = Math.max(0, start);
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
  });
}

/** Her şeyi anında H.264 + AAC'ye çevirir; parçalı MP4 olarak akıtır. Sarınca baştan çağrılır. */
function serveLive(media: MediaInfo, start: number, audio: number): Response {
  live.get(media.id)?.kill('SIGKILL'); // dosya başına tek canlı dönüştürme
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(Math.max(0, start)),
    '-i', media.path,
    '-map', '0:v:0',
    ...(media.audio.length ? ['-map', `0:a:${Math.min(audio, media.audio.length - 1)}`] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', '10M', '-bufsize', '20M',
    '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-g', '48',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-sn', '-dn', '-map_metadata', '-1',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
  ];
  const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  live.set(media.id, proc);
  proc.stderr.on('data', (d: Buffer) => console.warn('[canlı]', d.toString().trim()));
  proc.on('close', () => live.get(media.id) === proc && live.delete(media.id));
  return new Response(Readable.toWeb(proc.stdout) as ReadableStream, {
    status: 200,
    headers: { ...BASE_HEADERS, 'content-type': 'video/mp4' },
  });
}

// --- Hazırlama: görüntü olduğu gibi, ses AAC, kapsayıcı MP4 -----------------------------------

async function prepare(id: string, audio: number, mode: AudioMode, onProgress: (ratio: number | null) => void) {
  const media = opened.get(id);
  if (!media) throw new Error('Dosya bulunamadı');
  const st = statSync(media.path);
  const key = createHash('sha1')
    .update([media.path, st.size, st.mtimeMs, audio, mode, 2].join('|'))
    .digest('hex')
    .slice(0, 20);
  const out = join(cacheDir(), `${key}.mp4`);
  if (existsSync(out)) {
    prepared.set(key, out);
    return mediaUrl.prepared(key);
  }

  mkdirSync(cacheDir(), { recursive: true });
  const part = `${out}.part`;
  const hevc = media.video?.codec === 'hevc';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', media.path,
    '-map', '0:v:0',
    ...(media.audio.length ? ['-map', `0:a:${Math.min(audio, media.audio.length - 1)}`] : []),
    '-c:v', 'copy', ...(hevc ? ['-tag:v', 'hvc1'] : []),
    ...(mode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-avoid_negative_ts', 'make_zero',
    '-progress', 'pipe:1', '-nostats',
    '-f', 'mp4', part,
  ];

  jobs.get(id)?.kill('SIGKILL');
  const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  jobs.set(id, proc);
  let errors = '';
  proc.stderr.on('data', (d: Buffer) => (errors += d.toString()));
  proc.stdout.on('data', (d: Buffer) => {
    const t = /out_time_(?:us|ms)=(\d+)/.exec(d.toString());
    if (t && media.duration) onProgress(Math.min(1, Number(t[1]) / 1e6 / media.duration));
  });
  onProgress(media.duration ? 0 : null);

  const code: number | null = await new Promise((resolve) => proc.on('close', resolve));
  if (jobs.get(id) === proc) jobs.delete(id);
  if (code !== 0) {
    rmSync(part, { force: true });
    throw new Error(errors.trim().split('\n').at(-1) || `ffmpeg çıkış kodu ${code}`);
  }
  await fs.rename(part, out);
  prepared.set(key, out);
  onProgress(1);
  return mediaUrl.prepared(key);
}

/** İki günden eski ve yarım kalmış hazırlıkları siler. */
function cleanCache() {
  const dir = cacheDir();
  if (!existsSync(dir)) return;
  const limit = Date.now() - 2 * 24 * 3600 * 1000;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (name.endsWith('.part') || statSync(p).mtimeMs < limit) rmSync(p, { force: true });
    } catch {
      // kullanımda olabilir
    }
  }
}

// --- Altyazılar ---------------------------------------------------------------------------------

const LANGUAGE_HINTS: [RegExp, string, string][] = [
  [/^(tr|tur|turkish|türkçe|turkce)$/i, 'tur', 'Türkçe'],
  [/^(en|eng|english|ingilizce)$/i, 'eng', 'İngilizce'],
  [/^(de|ger|deu|german|almanca)$/i, 'deu', 'Almanca'],
  [/^(fr|fre|fra|french|fransızca)$/i, 'fra', 'Fransızca'],
  [/^(es|spa|spanish|ispanyolca)$/i, 'spa', 'İspanyolca'],
];

async function findSubtitles(id: string): Promise<SubtitleSource[]> {
  const media = opened.get(id);
  if (!media) return [];
  const [external, embedded] = await Promise.all([sidecarSubtitles(media), embeddedSubtitles(media)]);
  return [...external, ...embedded];
}

/** Videonun yanındaki "Dizi.S01E01.srt", "Dizi.S01E01.tr.srt" gibi dosyalar. */
async function sidecarSubtitles(media: MediaInfo): Promise<SubtitleSource[]> {
  const dir = dirname(media.path);
  const base = basename(media.path, extname(media.path)).toLowerCase();
  const out: SubtitleSource[] = [];
  for (const name of readdirSync(dir)) {
    const ext = extname(name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) continue;
    const stem = basename(name, extname(name));
    if (!stem.toLowerCase().startsWith(base)) continue;
    const tag = stem.slice(base.length).replace(/^[._\s-]+/, '');
    const hint = LANGUAGE_HINTS.find(([re]) => re.test(tag));
    const bytes = await fs.readFile(join(dir, name));
    if (bytes.length > 5_000_000) continue;
    out.push({
      id: `dosya:${name}`,
      label: hint ? hint[2] : tag || 'Altyazı dosyası',
      language: hint ? hint[1] : null,
      bytes: new Uint8Array(bytes),
    });
  }
  return out;
}

/** MKV/MP4 içindeki metin altyazıları tek geçişte WebVTT'ye çevirir. */
async function embeddedSubtitles(media: MediaInfo): Promise<SubtitleSource[]> {
  const text = media.subtitles.filter((s) => s.text);
  if (!text.length) return [];
  const dir = join(cacheDir(), `alt-${media.id}`);
  mkdirSync(dir, { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', media.path];
  for (const s of text) args.push('-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', join(dir, `${s.index}.vtt`));
  const code: number | null = await new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), args, { stdio: 'ignore' });
    proc.on('close', resolve);
    proc.on('error', () => resolve(-1));
  });
  const out: SubtitleSource[] = [];
  for (const s of text) {
    const file = join(dir, `${s.index}.vtt`);
    if (!existsSync(file)) continue;
    const hint = LANGUAGE_HINTS.find(([, code]) => code === s.language);
    out.push({
      id: `gomulu:${s.index}`,
      label: s.title || hint?.[2] || s.language?.toUpperCase() || `Altyazı ${s.index + 1}`,
      language: s.language,
      text: await fs.readFile(file, 'utf8'),
    });
  }
  rmSync(dir, { recursive: true, force: true });
  if (code !== 0 && !out.length) console.warn('Gömülü altyazılar çıkarılamadı');
  return out;
}

// --- Senkron mod: parmak izi ve aynı dosyayı bulma ---------------------------------------------

/** Boyut + baştan, ortadan, sondan 1'er MB'ın SHA-1'i. Tüm dosyayı okumadan iki kopyayı eşler. */
async function fingerprint(path: string, size: number): Promise<string> {
  const MB = 1 << 20;
  const hash = createHash('sha1').update(String(size));
  const fd = await fs.open(path, 'r');
  try {
    for (const at of [0, Math.max(0, Math.floor(size / 2) - MB / 2), Math.max(0, size - MB)]) {
      const buf = Buffer.alloc(Math.min(MB, size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, at);
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  return hash.digest('hex').slice(0, 24);
}

/** Gönderilen bölümlerin kaydedildiği klasör */
export const transferDir = () => process.env['BIRLIKTE_DOWNLOADS'] ?? join(app.getPath('downloads'), 'Birlikte İzle');

/**
 * Karşının açtığı dosya bende de var mı? Gelenler klasörüne, İndirilenler'e ve daha önce izlenen
 * bölümlerin klasörlerine bakar; aynı boyuttaki dosyaların parmak izini karşılaştırır.
 */
async function findCopy(ref: FileRef, extraDirs: string[]): Promise<MediaInfo | null> {
  // Testte kullanıcının gerçek İndirilenler klasörüne bakma.
  const downloads = process.env['BIRLIKTE_DOWNLOADS'] ? [] : [app.getPath('downloads')];
  const dirs = new Set([transferDir(), ...downloads, ...extraDirs]);
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size !== ref.size) continue;
        if ((await fingerprint(path, st.size)) === ref.fingerprint) return openPath(path);
      } catch {
        // okunamayan dosyayı geç
      }
    }
  }
  return null;
}

// --- Dosya gönderme: okuma (gönderen) ve kaldığı yerden yazma (alan) ------------------------------

async function readChunk(id: string, offset: number, length: number): Promise<Uint8Array> {
  const media = opened.get(id);
  if (!media) throw new Error('Dosya bulunamadı');
  const fd = await fs.open(media.path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(length, 4 << 20));
    const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fd.close();
  }
}

interface Receiving {
  ref: FileRef;
  part: string;
  stream: WriteStream;
  write(chunk: Uint8Array): void;
}

const receiving = new Map<string, Receiving>();

function partPath(ref: FileRef) {
  const safe = ref.name.replace(/[\/:*?"<>|]/g, '_').slice(0, 180);
  return join(transferDir(), `${safe}.${ref.fingerprint.slice(0, 8)}.part`);
}

/** Alma başlar; yarım kalmış bir önceki deneme varsa kaldığı yerden devam eder. */
function beginReceive(ref: FileRef): { offset: number } {
  abortReceive(ref.fingerprint);
  mkdirSync(transferDir(), { recursive: true });
  const part = partPath(ref);
  const offset = existsSync(part) ? Math.min(statSync(part).size, ref.size) : 0;
  const stream = createWriteStream(part, offset ? { flags: 'r+', start: offset } : { flags: 'w' });
  receiving.set(ref.fingerprint, { ref, part, stream, write: (chunk) => stream.write(chunk) });
  return { offset };
}

async function finishReceive(fingerprintHex: string): Promise<MediaInfo> {
  const r = receiving.get(fingerprintHex);
  if (!r) throw new Error('Alınan dosya yok');
  receiving.delete(fingerprintHex);
  await new Promise<void>((resolve, reject) => r.stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
  const size = statSync(r.part).size;
  if (size !== r.ref.size || (await fingerprint(r.part, size)) !== r.ref.fingerprint) {
    rmSync(r.part, { force: true });
    throw new Error('Dosya bozuk geldi');
  }
  // Aynı adda başka bir dosya varsa üzerine yazma: "Ad (2).mkv"
  const ext = extname(r.ref.name);
  const stem = basename(r.ref.name, ext).replace(/[\/:*?"<>|]/g, '_');
  let target = join(transferDir(), `${stem}${ext}`);
  for (let n = 2; existsSync(target); n++) target = join(transferDir(), `${stem} (${n})${ext}`);
  await fs.rename(r.part, target);
  return openPath(target);
}

/** Yarım dosya silinmez: bir sonraki denemede kaldığı yerden devam edilir. */
function abortReceive(fingerprintHex: string) {
  const r = receiving.get(fingerprintHex);
  if (!r) return;
  receiving.delete(fingerprintHex);
  r.stream.end();
}
