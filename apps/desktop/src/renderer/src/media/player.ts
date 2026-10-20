// Film oynatıcısı: <video> öğesinin üzerine ince bir katman.
// Canlı dönüştürmede ileri/geri sarmak ffmpeg'i o noktadan yeniden başlatmak demektir;
// öğenin kendi zamanı 0'dan başlar. Bu katman aradaki kaydırmayı gizler: dışarıdan her zaman
// filmin gerçek zamanı görülür.

import { mediaUrl } from '../../../shared/media';

/**
 * Controller'ın oynatıcıdan beklediği yüz. Dosya oynatıcısı (<video>) ve YouTube aynı yüzü sunar;
 * olaylar da <video>'nunkilerle aynı adlardadır: playing, pause, seeked, ended, waiting, canplay,
 * loadedmetadata.
 */
export interface Playable {
  readonly kind: 'file' | 'youtube' | 'browser';
  readonly events: EventTarget;
  readonly hasSource: boolean;
  readonly isLive: boolean;
  readonly time: number;
  readonly duration: number;
  readonly playing: boolean;
  readonly rate: number;
  readonly seeking: boolean;
  /** Oynaması gerekirken veri bekliyor (takıldı) */
  readonly buffering: boolean;
  readonly ended: boolean;
  /** Hız ±%5 içinde ince ayarlanabiliyor mu? (değilse kayma sadece sararak kapatılır) */
  readonly fineRate: boolean;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): Promise<void>;
  setRate(r: number): void;
  unload(): void;
}

/** Video sitesindeki bölüm (tarayıcı eklentisiyle izlenir) */
export interface WebVideo {
  site: string;
  url: string;
  title: string;
}

export interface LoadOptions {
  /** birlikte-media:// kaynakları için true (captureStream CORS uyumlu kaynak ister) */
  crossOrigin: boolean;
  duration?: number;
  live?: { id: string; audio: number };
  startAt?: number;
}

export class MoviePlayer implements Playable {
  readonly kind = 'file';
  readonly fineRate = true;
  private offset = 0;
  private live: { id: string; audio: number } | null = null;
  private knownDuration = 0;
  /** Canlı kaynak yeniden yüklenirken hedef oynatma durumu */
  private resumeAfterReload: boolean | null = null;

  constructor(readonly el: HTMLVideoElement) {}

  get events() {
    return this.el;
  }

  get seeking() {
    return this.el.seeking;
  }

  get ended() {
    return this.el.ended;
  }

  get buffering() {
    return !this.el.paused && this.el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  get hasSource() {
    return !!this.el.getAttribute('src');
  }

  get isLive() {
    return !!this.live;
  }

  get time() {
    return this.offset + (this.el.currentTime || 0);
  }

  get duration() {
    return this.knownDuration || (Number.isFinite(this.el.duration) ? this.el.duration : 0);
  }

  get playing() {
    return this.resumeAfterReload ?? (!this.el.paused && !this.el.ended);
  }

  get rate() {
    return this.el.playbackRate;
  }

  /** Senkron modda kaymayı fark ettirmeden kapatmak için (±%5; ses perdesi korunur) */
  setRate(r: number) {
    if (Math.abs(this.el.playbackRate - r) > 0.001) this.el.playbackRate = r;
  }

  async load(url: string, opts: LoadOptions) {
    this.live = opts.live ?? null;
    this.offset = opts.live ? (opts.startAt ?? 0) : 0;
    this.knownDuration = opts.duration ?? 0;
    this.resumeAfterReload = null;
    this.el.crossOrigin = opts.crossOrigin ? 'anonymous' : null;
    this.el.src = url;
    await whenLoaded(this.el, opts.live ? 30_000 : 15_000);
    if (!opts.live && opts.startAt) this.el.currentTime = opts.startAt;
  }

  play() {
    if (this.resumeAfterReload !== null) {
      this.resumeAfterReload = true;
      return Promise.resolve();
    }
    return this.el.play();
  }

  pause() {
    if (this.resumeAfterReload !== null) this.resumeAfterReload = false;
    this.el.pause();
  }

  async seek(t: number) {
    const target = Math.min(Math.max(0, t), this.duration || Infinity);
    if (!this.live) {
      this.el.currentTime = target;
      return;
    }
    // Canlı: o noktadan yeni bir dönüştürme başlat.
    this.resumeAfterReload = this.playing;
    this.offset = target;
    this.el.src = mediaUrl.live(this.live.id, target, this.live.audio);
    try {
      await whenLoaded(this.el, 30_000);
    } finally {
      const resume = this.resumeAfterReload;
      this.resumeAfterReload = null;
      if (resume) await this.el.play().catch(() => {});
    }
  }

  unload() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el.playbackRate = 1;
    this.live = null;
    this.offset = 0;
    this.knownDuration = 0;
    this.resumeAfterReload = null;
  }
}

function whenLoaded(el: HTMLVideoElement, timeout: number) {
  return new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      el.removeEventListener('loadedmetadata', ok);
      el.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => done();
    const fail = () => done(new Error(el.error?.message || 'Dosya açılamadı'));
    const timer = setTimeout(() => done(new Error('Zaman aşımı')), timeout);
    el.addEventListener('loadedmetadata', ok);
    el.addEventListener('error', fail);
  });
}
