// Tarayıcıdaki oynatıcı (Netflix, Disney+, Prime…): Birlikte İzle eklentisi o sekmedeki videoyu bu
// uygulamaya bağlar. Aynı sınıf uygulamanın içindeki sayfalar (Kanallar, YouTube; media/webview.ts) için
// de kullanılır: ikisi de aynı mesajlarla (video / state / gone, cmd / open) konuşur. İkimiz de kendi tarayıcımızda, kendi hesabımızla izleriz; uygulama sadece
// oynat/durdur/sar'ı eşitler (senkron mod). Kamera ve ses yine uygulamada.
//
// Tarayıcıda elle yapılanlar da (Netflix'te boşluk tuşu, zaman çubuğu) yakalanır: host'ta bu
// zaten oynatıcının kendi olayıdır; guest'te "userpause/userplay/userseek" olarak komuta dönüşür.

import { create } from 'zustand';
import { bridge, type ExtensionStatus } from '../platform/bridge';
import { compareVersions } from '../util/version';
import type { Playable } from './player';

export interface BrowserVideo {
  site: string;
  title: string;
  url: string;
  duration: number;
}

interface ExtensionState extends ExtensionStatus {
  /** Masaüstü uygulamasında mıyız? (eklenti sadece ona bağlanır) */
  available: boolean;
  /** Tarayıcıda şu an kontrol edilen video */
  video: BrowserVideo | null;
}

export const useExtension = create<ExtensionState>(() => ({
  available: !!bridge.extension,
  connected: false,
  browser: null,
  version: null,
  latest: null,
  video: null,
}));

/**
 * Tarayıcıdaki eklenti uygulamanınkinden eskiyse kurulu sürüm (yoksa null). Eklenti çoğu zaman bir
 * kopyadan yüklenir; uygulama güncellenince o kopya eski kalır ve yenilikler (sitedeki kameralar) gelmez.
 */
export function outdatedExtension({ connected, version, latest }: ExtensionStatus): string | null {
  if (!connected || !latest) return null;
  if (!version) return '0.3.4 ya da öncesi';
  return compareVersions(version, latest) < 0 ? version : null;
}

/** Oynatıcının konuştuğu sekme: tarayıcıdaki (eklenti) ya da uygulamanın içindeki sayfa */
export interface TabLink {
  send(msg: Record<string, unknown>): void;
  onMessage(fn: (m: Record<string, unknown>) => void): void;
  /** Sekmedeki güncel video */
  getVideo(): BrowserVideo | null;
  setVideo(video: BrowserVideo | null): void;
}

/** Tarayıcı eklentisi: bu bilgisayardaki eklenti yerel WebSocket ile ana sürece bağlanır */
export function extensionLink(): TabLink | null {
  const ext = bridge.extension;
  if (!ext) return null;
  ext.status().then((s) => useExtension.setState(s), () => {});
  ext.onStatus((s) => useExtension.setState({ ...s, ...(!s.connected && { video: null }) }));
  return {
    send: (msg) => ext.send(msg),
    onMessage: (fn) =>
      ext.onMessage((m) => {
        if (m.t === 'hello') {
          useExtension.setState({
            connected: true,
            browser: typeof m.browser === 'string' ? m.browser : null,
            version: typeof m.version === 'string' ? m.version : null,
          });
        }
        else fn(m);
      }),
    getVideo: () => useExtension.getState().video,
    setVideo: (video) => useExtension.setState({ video }),
  };
}

interface TabState {
  playing: boolean;
  time: number;
  duration: number;
  rate: number;
  /** Canlı yayın (süresi yok): iki tarafın zamanı karşılaştırılamaz, konum eşitlenmez */
  live: boolean;
  seeking: boolean;
  buffering: boolean;
  ended: boolean;
  /** Ölçüm anı (Date.now(); tarayıcı ve uygulama aynı bilgisayarın saatini kullanır) */
  at: number;
}

export const samePage = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.searchParams.get('v') === y.searchParams.get('v');
  } catch {
    return false;
  }
};

export class BrowserPlayer implements Playable {
  readonly kind = 'browser';
  readonly fineRate = true;
  readonly events = new EventTarget();
  title = '';

  private active = false;
  /** Guest: açılmasını beklediğimiz sayfa (başka sekmedeki videoyu takip etmeyelim) */
  private expected: string | null = null;
  private st: TabState = blank();
  private seekTarget: number | null = null;
  /** Gönderdiğimiz son oynat/durdur ve sekmede gerçekleşti mi? (değilse elle yapılan değişikliktir) */
  private want: { playing: boolean; settled: boolean; since: number } | null = null;
  /** Kendi sarmamızın sekmede bitmesi için tanınan süre */
  private seekUntil = 0;
  /** Sarma dışındaki son durum: elle sarmayı buna göre anlarız */
  private stable: TabState | null = null;
  private lastRate = 1;
  private volume = { v: -1, muted: false };
  private waiters: { test: () => boolean; done: () => void }[] = [];
  private opening: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly tab: TabLink | null) {
    tab?.onMessage((m) => this.onMessage(m));
  }

  get hasSource() {
    return this.active;
  }

  get isLive() {
    return this.active && this.st.live;
  }

  get duration() {
    return this.st.duration;
  }

  get rate() {
    return this.st.rate;
  }

  get playing() {
    return this.st.playing && !this.st.buffering;
  }

  get buffering() {
    return this.st.playing && this.st.buffering;
  }

  get seeking() {
    return this.seekTarget !== null || this.st.seeking;
  }

  get ended() {
    return this.st.ended;
  }

  get time() {
    if (this.seekTarget !== null) return this.seekTarget;
    if (!this.playing) return this.st.time;
    const t = this.st.time + ((Date.now() - this.st.at) / 1000) * this.st.rate;
    return this.st.duration ? Math.min(t, this.st.duration) : t;
  }

  /** Host: tarayıcıdaki videoyu kullan (o sekmede ne oynuyorsa) */
  attach() {
    const video = this.tab?.getVideo();
    this.active = true;
    this.expected = null;
    this.title = video?.title ?? '';
    this.st = { ...blank(), duration: video?.duration ?? 0 };
  }

  /** Guest: karşının açtığı sayfayı kendi tarayıcımda aç (izlediğim sekmede) ve video gelene kadar bekle */
  open(url: string): Promise<void> {
    this.finishOpening(new Error('İptal edildi'));
    this.active = true;
    this.expected = url;
    this.title = '';
    this.st = blank();
    this.tab?.send({ t: 'open', url, replace: true });
    const current = this.tab?.getVideo();
    if (current && samePage(current.url, url)) {
      this.title = current.title;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      // Giriş yapmak gerekebilir: uzun bekle.
      const timer = setTimeout(() => this.finishOpening(new Error('Tarayıcıda video açılmadı.')), 120_000);
      this.opening = { resolve, reject, timer };
    });
  }

  play() {
    this.want = { playing: true, settled: false, since: Date.now() };
    this.command('play');
    return this.until(() => this.st.playing, 5000);
  }

  pause() {
    this.want = { playing: false, settled: false, since: Date.now() };
    if (this.st.playing) this.st = { ...this.st, playing: false, time: this.time, at: Date.now() };
    this.command('pause');
  }

  async seek(t: number) {
    if (this.st.live) {
      // Canlı yayında sarma yok (iki oynatıcının zaman çizelgesi farklı)
      this.events.dispatchEvent(new Event('seeked'));
      return;
    }
    const target = Math.max(0, Math.min(t, this.st.duration || Infinity));
    this.seekTarget = target;
    this.seekUntil = Date.now() + 2500;
    this.command('seek', target);
    await this.until(() => Math.abs(this.st.time - target) < 1.5 && !this.st.seeking, 6000);
    if (this.seekTarget === target) {
      this.seekTarget = null;
      this.events.dispatchEvent(new Event('seeked'));
    }
  }

  setRate(r: number) {
    if (Math.abs(this.lastRate - r) < 0.001) return;
    this.lastRate = r;
    this.command('rate', r);
  }

  setVolume(volume: number, muted: boolean) {
    if (!this.active || (Math.abs(volume - this.volume.v) < 0.01 && muted === this.volume.muted)) return;
    this.volume = { v: volume, muted };
    this.tab?.send({ t: 'cmd', cmd: 'volume', value: volume, muted });
  }

  unload() {
    // Tarayıcıdaki videoya dokunma: sadece takibi bırak.
    this.finishOpening(new Error('İptal edildi'));
    this.active = false;
    this.expected = null;
    this.title = '';
    this.st = blank();
    this.seekTarget = null;
    this.want = null;
    this.stable = null;
    this.volume = { v: -1, muted: false };
    this.release();
  }

  // ---------------------------------------------------------------------------------------------

  private command(cmd: string, value?: number) {
    this.tab?.send({ t: 'cmd', cmd, value });
  }

  private onMessage(m: Record<string, unknown>) {
    if (m.t === 'video') {
      const video: BrowserVideo = {
        site: String(m.site ?? '').slice(0, 40),
        title: String(m.title ?? '').slice(0, 200),
        url: String(m.url ?? ''),
        duration: Number(m.duration) || 0,
      };
      this.tab?.setVideo(video);
      if (!this.active || (this.expected && !samePage(video.url, this.expected))) return;
      if (video.title && video.title !== this.title) {
        this.title = video.title;
        this.events.dispatchEvent(new Event('titlechange'));
      }
      if (this.expected && this.opening) {
        // Yeni açılan sekme kendiliğinden oynamaya başlayabilir: bunu "elle oynattı" sanmayalım.
        this.want = null;
        this.stable = null;
        this.finishOpening();
      }
    } else if (m.t === 'state') {
      const video = this.tab?.getVideo();
      if (!this.active || (this.expected && !(video && samePage(video.url, this.expected)))) return;
      this.onState(m as unknown as TabState);
    } else if (m.t === 'gone') {
      this.tab?.setVideo(null);
      if (this.active && this.st.playing) {
        this.st = { ...this.st, playing: false, time: this.time, at: Date.now() };
        this.events.dispatchEvent(new Event('pause'));
      }
    }
  }

  private onState(next: TabState) {
    const prev = this.st;
    this.st = {
      playing: !!next.playing,
      time: Number(next.time) || 0,
      duration: Number(next.duration) || prev.duration,
      rate: Number(next.rate) || 1,
      live: !!next.live,
      seeking: !!next.seeking,
      buffering: !!next.buffering,
      ended: !!next.ended,
      at: Number(next.at) || Date.now(),
    };
    const fire = (type: string, detail?: unknown) => this.events.dispatchEvent(new CustomEvent(type, { detail }));
    if (!prev.duration && this.st.duration) fire('loadedmetadata');
    this.detectUser(prev, fire);
    if (prev.playing !== this.st.playing) fire(this.st.playing ? 'playing' : this.st.ended ? 'ended' : 'pause');
    if (!prev.buffering && this.st.buffering) fire('waiting');
    if (prev.buffering && !this.st.buffering) fire('canplay');
    if (prev.seeking && !this.st.seeking) fire('seeked');
    this.release();
  }

  /** Sekmedeki değişiklik bizim komutumuz değilse kullanıcı tarayıcıda elle yaptı. */
  private detectUser(prev: TabState, fire: (type: string, detail?: unknown) => void) {
    const st = this.st;
    const now = Date.now();
    if (!st.ended) {
      const w = this.want;
      if (!w) {
        if (prev.at && prev.playing !== st.playing) fire(st.playing ? 'userplay' : 'userpause');
      } else if (st.playing === w.playing) {
        w.settled = true;
      } else if (w.settled || now - w.since > 3000) {
        // İstediğimiz duruma gelmişti (ya da hiç gelmedi) ve şimdi farklı: elle değişti.
        this.want = { playing: st.playing, settled: true, since: now };
        fire(st.playing ? 'userplay' : 'userpause');
      }
    }
    // Canlı yayında oynatıcı canlıya yetişmek için kendisi atlayabilir: elle sarma sayılmaz.
    if (st.seeking || st.live) return;
    const base = this.stable;
    this.stable = st;
    if (!base || this.seekTarget !== null || now < this.seekUntil) return;
    const predicted = base.time + (base.playing && !base.buffering ? ((st.at - base.at) / 1000) * base.rate : 0);
    if (Math.abs(st.time - predicted) > 2) fire('userseek', st.time);
  }

  private finishOpening(err?: Error) {
    const job = this.opening;
    if (!job) return;
    this.opening = null;
    clearTimeout(job.timer);
    if (err) job.reject(err);
    else job.resolve();
  }

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
    const ready = this.waiters.filter((w) => !this.active || w.test());
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    ready.forEach((w) => w.done());
  }
}

function blank(): TabState {
  return { playing: false, time: 0, duration: 0, rate: 1, live: false, seeking: false, buffering: false, ended: false, at: 0 };
}
