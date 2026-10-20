// Ana süreç (ffmpeg) ile arayüz arasında paylaşılan medya tipleri.

export interface VideoStream {
  codec: string; // h264, hevc, vp9, av1, mpeg4, …
  profile: string | null; // "High", "Main 10", …
  width: number;
  height: number;
  fps: number | null;
  /** Renk derinliği (8, 10, 12) — 10-bit H.264 tarayıcıda çalmaz */
  bitDepth: number;
}

export interface AudioStream {
  /** Ses izleri arasındaki sırası (ffmpeg: 0:a:N) */
  index: number;
  codec: string; // aac, ac3, eac3, dts, truehd, mp3, opus, …
  channels: number;
  language: string | null; // ISO 639-2: tur, eng, …
  title: string | null;
  isDefault: boolean;
}

export interface SubtitleStream {
  /** Altyazı izleri arasındaki sırası (ffmpeg: 0:s:N) */
  index: number;
  codec: string; // subrip, ass, mov_text, webvtt, hdmv_pgs_subtitle, …
  language: string | null;
  title: string | null;
  isDefault: boolean;
  /** Metin tabanlı mı? (resim tabanlı PGS/VobSub çevrilemez) */
  text: boolean;
}

export interface MediaInfo {
  /** Bu oturumda dosyaya verilen kimlik; dosyanın kendisine sadece bu kimlikle ulaşılır */
  id: string;
  path: string;
  name: string;
  size: number;
  container: string; // "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2", "avi", …
  duration: number;
  /** Boyut + baştan/ortadan/sondan 1'er MB'ın SHA-1'i: iki bilgisayarda aynı dosya mı? */
  fingerprint: string;
  video: VideoStream | null;
  audio: AudioStream[];
  subtitles: SubtitleStream[];
}

export interface SubtitleSource {
  id: string;
  label: string;
  language: string | null;
  /** Dosyadan geldiyse ham baytlar (kodlama arayüzde çözülür), gömülüyse WebVTT metni */
  bytes?: Uint8Array;
  text?: string;
}

export interface PrepareProgress {
  id: string;
  /** 0–1 arası; bilinmiyorsa null */
  ratio: number | null;
}

export type AudioMode = 'copy' | 'aac';

/** Karşıya tarif edilen dosya (yol değil; sadece adı, boyutu ve parmak izi) */
export interface FileRef {
  name: string;
  size: number;
  fingerprint: string;
}

export const MEDIA_SCHEME = 'birlikte-media';

export const mediaUrl = {
  file: (id: string) => `${MEDIA_SCHEME}://file/${id}`,
  prepared: (key: string) => `${MEDIA_SCHEME}://prepared/${key}`,
  live: (id: string, start: number, audio: number) =>
    `${MEDIA_SCHEME}://live/${id}?start=${start.toFixed(3)}&audio=${audio}`,
};
