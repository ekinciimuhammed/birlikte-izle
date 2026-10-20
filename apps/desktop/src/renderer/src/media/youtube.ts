// YouTube oynatıcısı (senkron mod: ikimiz de kendi YouTube'umuzdan, host'un saatine göre).
//
// YouTube'un resmî IFrame API'si uygulamanın sayfasına alınmaz (uzak betik, köprüye erişimi olan
// sayfada çalışmasın). Bunun yerine kendi sunucumuzdaki küçük bir aracı sayfa (yt.html) çerçevede
// açılır; oynatıcıyı o kurar, komutlar ve durum postMessage ile gider gelir. Aracı sayfa gerçek
// bir http(s) adresinden geldiği için YouTube gömmeye izin verir (file:// sayfalara vermiyor).

import { getSetting } from '../settings/store';
import type { Playable } from './player';

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;
const ID = /^[A-Za-z0-9_-]{11}$/;

type Incoming =
  | { type: 'ready' }
  | { type: 'state'; state: number; time: number; duration: number; rate: number; title: string }
  | { type: 'error'; code: number };

/** youtube.com/watch?v=…, youtu.be/…, /shorts/…, /embed/…, /live/… ya da çıplak kimlik */
export function youtubeId(input: string): string | null {
  const text = input.trim();
  if (ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return id && ID.test(id) ? id : null;
}

/** Bağlantıdaki başlangıç: ?t=90, ?t=1m30s, &start=90 */
export function youtubeStart(input: string): number {
  const m = /[?&#](?:t|start)=([0-9hms]+)/.exec(input);
  if (!m) return 0;
  const v = m[1]!;
  if (/^\d+$/.test(v)) return Number(v);
  const part = (unit: string) => Number(new RegExp(`(\\d+)${unit}`).exec(v)?.[1] ?? 0);
  return part('h') * 3600 + part('m') * 60 + part('s');
}

function errorText(code: number) {
  if (code === 101 || code === 150) return 'Bu videonun sahibi başka yerlerde oynatılmasına izin vermiyor.';
  if (code === 100) return 'Bu video bulunamadı (kaldırılmış ya da gizli olabilir).';
  if (code === 2) return 'Bu bir YouTube bağlantısı değil gibi.';
  return 'YouTube videosu açılamadı.';
}

/** Aracı sayfanın adresi: web sürümü ve geliştirme sayfası http(s)'ten gelir, aracı da oradan. */
function relayUrl() {
  if (location.protocol.startsWith('http')) return new URL('yt.html', location.href).href;
  return `${getSetting('connection.server').replace(/\/+$/, '')}/yt.html`;
}

export class YouTubePlayer implements Playable {
  readonly kind = 'youtube';
  // getAvailablePlaybackRates() sadece 0,25'lik adımları sayar ama 1,05 / 0,95 de kabul ediliyor (ölçüldü).
  readonly fineRate = true;
  readonly isLive = false;
  readonly events = new EventTarget();
  /** Ekrana yerleştirilen kap (çerçeve bunun içinde) */
  readonly el = document.createElement('div');
  title = '';

  private frame: HTMLIFrameElement | null = null;
  private frameReady = false;
  private id: string | null = null;
  private st: { state: number; time: number; at: number; duration: number; rate: number } = this.blank(0);
  private wantPlaying = false;
  private seekTarget: number | null = null;
  private waiters: { test: () => boolean; done: () => void }[] = [];
  private loading: { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private volume = { v: 100, muted: false };

  constructor() {
    window.addEventListener('message', (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const data = e.data as (Incoming & { birlikteYT?: number }) | null;
      if (data?.birlikteYT) this.onMessage(data);
    });
  }

  get videoId() {
    return this.id;
  }

  get hasSource() {
    return !!this.id;
  }

  get duration() {
    return this.st.duration;
  }

  get rate() {
    return this.st.rate;
  }

  /** Yükleniyorken (takılma) "oynamıyor" sayılır: karşı taraf da beklesin. */
  get playing() {
    return this.st.state === STATE.PLAYING;
  }

  get buffering() {
    return this.st.state === STATE.BUFFERING;
  }

  get seeking() {
    return this.seekTarget !== null;
  }

  get ended() {
    return this.st.state === STATE.ENDED;
  }

  get time() {
    if (this.seekTarget !== null) return this.seekTarget;
    if (this.st.state !== STATE.PLAYING) return this.st.time;
    const t = this.st.time + ((performance.now() - this.st.at) / 1000) * this.st.rate;
    return this.st.duration ? Math.min(t, this.st.duration) : t;
  }

  load(id: string, startAt = 0): Promise<void> {
    this.finishLoading(new Error('İptal edildi'));
    this.id = id;
    this.title = '';
    this.st = this.blank(startAt);
    this.wantPlaying = false;
    this.seekTarget = null;
    this.ensureFrame();
    if (this.frameReady) this.post({ cmd: 'load', id, start: startAt, autoplay: false });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.finishLoading(new Error('YouTube yanıt vermedi.')), 25_000);
      this.loading = { resolve, reject, timer };
    });
  }

  play() {
    this.wantPlaying = true;
    this.post({ cmd: 'play' });
    return this.until(() => this.st.state === STATE.PLAYING, 5000);
  }

  pause() {
    this.wantPlaying = false;
    // Hemen durmuş say: arayüz ve karşıya giden durum beklemesin.
    if (this.st.state === STATE.PLAYING) this.st = { ...this.st, state: STATE.PAUSED, time: this.time, at: performance.now() };
    this.post({ cmd: 'pause' });
  }

  async seek(t: number) {
    const target = Math.max(0, Math.min(t, this.st.duration || Infinity));
    this.seekTarget = target;
    this.post({ cmd: 'seek', t: target });
    await this.until(() => Math.abs(this.st.time - target) < 1.5, 5000);
    if (this.seekTarget === target) {
      this.seekTarget = null;
      this.events.dispatchEvent(new Event('seeked'));
    }
  }

  setRate(r: number) {
    if (Math.abs(this.st.rate - r) > 0.01) this.post({ cmd: 'rate', r });
  }

  setVolume(volume: number, muted: boolean) {
    const v = Math.round(volume * 100);
    if (v === this.volume.v && muted === this.volume.muted) return;
    this.volume = { v, muted };
    this.post({ cmd: 'volume', v, muted });
  }

  unload() {
    this.finishLoading(new Error('İptal edildi'));
    if (this.id) this.post({ cmd: 'stop' });
    this.id = null;
    this.title = '';
    this.st = this.blank(0);
    this.wantPlaying = false;
    this.seekTarget = null;
    this.release();
  }

  // ---------------------------------------------------------------------------------------------

  private blank(time: number) {
    return { state: STATE.UNSTARTED as number, time, at: performance.now(), duration: 0, rate: 1 };
  }

  private ensureFrame() {
    if (this.frame) return;
    const frame = document.createElement('iframe');
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.title = 'YouTube';
    frame.src = relayUrl();
    // Çerçeve DOM'da yer değiştirirse yeniden yüklenir: "ready" yine gelir, kaldığı yerden devam.
    this.el.appendChild(frame);
    this.frame = frame;
  }

  private post(msg: Record<string, unknown>) {
    if (this.frameReady) this.frame?.contentWindow?.postMessage({ birlikteYT: 1, ...msg }, '*');
  }

  private onMessage(m: Incoming) {
    if (m.type === 'ready') {
      this.frameReady = true;
      this.post({ cmd: 'volume', ...this.volume });
      if (this.id) this.post({ cmd: 'load', id: this.id, start: this.time, autoplay: this.wantPlaying });
      return;
    }
    if (m.type === 'error') {
      this.finishLoading(new Error(errorText(m.code)));
      this.events.dispatchEvent(new CustomEvent('error', { detail: errorText(m.code) }));
      return;
    }
    if (!this.id) return;
    const prev = this.st;
    this.st = { state: m.state, time: m.time, at: performance.now(), duration: m.duration || prev.duration, rate: m.rate || 1 };
    if (m.title && m.title !== this.title) {
      this.title = m.title;
      this.events.dispatchEvent(new Event('titlechange'));
    }
    if (!prev.duration && this.st.duration) this.events.dispatchEvent(new Event('loadedmetadata'));
    if (this.loading && this.st.duration > 0) this.finishLoading();
    if (prev.state !== m.state) {
      const fire = (type: string) => this.events.dispatchEvent(new Event(type));
      if (m.state === STATE.PLAYING) fire('playing');
      else if (m.state === STATE.PAUSED) fire('pause');
      else if (m.state === STATE.ENDED) fire('ended');
      else if (m.state === STATE.BUFFERING) fire('waiting');
      if (prev.state === STATE.BUFFERING && m.state !== STATE.BUFFERING) fire('canplay');
    }
    this.release();
  }

  private finishLoading(err?: Error) {
    const job = this.loading;
    if (!job) return;
    this.loading = null;
    clearTimeout(job.timer);
    if (err) job.reject(err);
    else job.resolve();
  }

  /** Durum koşulu sağlanınca (ya da süre dolunca) biten söz */
  private until(test: () => boolean, ms: number) {
    if (test()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = { test, done: () => (clearTimeout(timer), resolve()) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve();
      }, ms);
      this.waiters.push(waiter);
    });
  }

  private release() {
    const ready = this.waiters.filter((w) => !this.id || w.test());
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    ready.forEach((w) => w.done());
  }
}
