// Bir dosyanın nasıl oynatılacağına karar verir.
//
//   direct  → olduğu gibi (en hızlı, kayıpsız)
//   prepare → görüntü olduğu gibi, ses gerekirse AAC, kapsayıcı MP4 (birkaç saniye–dakika, önbelleğe)
//   live    → her şey anında H.264/AAC (görüntü kodeki desteklenmiyorsa: AVI/Xvid, 10-bit H.264…)
//
// Sırayla denenir: biri olmazsa sıradakine geçilir.

import type { AudioMode, AudioStream, MediaInfo, VideoStream } from '../../../shared/media';

export type Step = 'direct' | 'prepare' | 'live';

/** Tarayıcının (Chromium) doğrudan çözebildiği sesler */
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const DIRECT_CONTAINERS = /\b(mp4|mov|webm|matroska)\b/;

const supported = (type: string) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);

export function canDecodeVideo(v: VideoStream): boolean {
  switch (v.codec) {
    case 'h264':
      return v.bitDepth === 8; // 10-bit H.264 (Hi10P) tarayıcılarda çalmaz
    case 'vp8':
      return true;
    case 'vp9':
      return v.bitDepth === 8 || supported('video/mp4; codecs="vp09.02.10.10"');
    case 'av1':
      return supported(`video/mp4; codecs="av01.0.08M.${v.bitDepth >= 10 ? '10' : '08'}"`);
    case 'hevc':
      // Donanım çözücüsü varsa (çoğu yeni bilgisayarda var)
      return supported(`video/mp4; codecs="${v.bitDepth >= 10 ? 'hvc1.2.4.L120.90' : 'hvc1.1.6.L120.90'}"`);
    default:
      return false;
  }
}

export function planPlayback(info: MediaInfo, audioIndex: number): { steps: Step[]; audioMode: AudioMode } {
  const audio = info.audio[audioIndex];
  const audioOk = !audio || PLAYABLE_AUDIO.has(audio.codec);
  const audioMode: AudioMode = audioOk ? 'copy' : 'aac';
  if (!info.video || !canDecodeVideo(info.video)) return { steps: ['live'], audioMode };

  // Tarayıcı birden çok ses izinden sadece ilkini çalar; başka dil seçildiyse hazırlamak gerekir.
  const firstTrack = info.audio.length <= 1 || audioIndex === 0;
  // MKV içindeki HEVC'yi Chromium her zaman açamıyor; MP4'e aktarmak (birkaç saniye) daha güvenli.
  const direct = DIRECT_CONTAINERS.test(info.container) && audioOk && firstTrack && info.video.codec !== 'hevc';
  return { steps: direct ? ['direct', 'prepare', 'live'] : ['prepare', 'live'], audioMode };
}

const LANGUAGES: Record<string, string> = {
  tur: 'Türkçe',
  eng: 'İngilizce',
  deu: 'Almanca',
  ger: 'Almanca',
  fra: 'Fransızca',
  fre: 'Fransızca',
  spa: 'İspanyolca',
  ita: 'İtalyanca',
  jpn: 'Japonca',
  kor: 'Korece',
  rus: 'Rusça',
  ara: 'Arapça',
};

export const languageName = (code: string | null) => (code ? (LANGUAGES[code] ?? code.toUpperCase()) : null);

export function audioLabel(a: AudioStream): string {
  const name = a.title || languageName(a.language) || `Ses ${a.index + 1}`;
  const layout = a.channels >= 6 ? `${a.channels - 1}.1` : a.channels === 1 ? 'Mono' : 'Stereo';
  return `${name} · ${layout}`;
}

/** Tercih edilen dile göre ses izi: "auto" → işaretli olan, yoksa ilki. */
export function pickAudio(info: MediaInfo, preference: string): number {
  if (!info.audio.length) return 0;
  if (preference === 'tur' || preference === 'eng') {
    const match = info.audio.find((a) => a.language === preference);
    if (match) return match.index;
  }
  if (preference === 'original') return 0;
  return info.audio.find((a) => a.isDefault)?.index ?? 0;
}
