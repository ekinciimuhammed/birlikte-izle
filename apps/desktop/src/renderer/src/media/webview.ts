// Uygulamanın içindeki sayfa (Kanallar, YouTube): sitenin kendisi uygulama penceresinde, gömülü bir
// tarayıcı görünümünde (<webview>) açılır; tarayıcıya gitmeye gerek kalmaz. Sayfadaki videoyu
// preload/web.ts bulur ve tarayıcı eklentisiyle aynı mesajları gönderir: BrowserPlayer'a bir TabLink
// olarak bağlanır. Güvenlik kuralları (hangi siteler, izinler, açılır pencereler) ana süreçte.

import { create } from 'zustand';
import { WEB_PARTITION } from '../../../shared/web';
import { samePage, type BrowserVideo, type TabLink } from './browser';

const CHANNEL = 'birlikte-web';

/** Uygulamanın içindeki sayfada şu an bulunan video */
export const useWebPage = create<{ video: BrowserVideo | null }>(() => ({ video: null }));

type WebviewElement = HTMLElement & {
  getURL(): string;
  send(channel: string, ...args: unknown[]): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
};

export class WebView {
  readonly el: WebviewElement;
  readonly link: TabLink;
  private ready = false;
  private listeners: ((m: Record<string, unknown>) => void)[] = [];
  private pokes: (() => void)[] = [];
  /** "Sadece video": oynatıcı kutusu alanın tamamını kaplar (sayfa değişince yeni sayfaya da uygulanır) */
  private focus = false;
  /** İlk boş sayfa yüklenmeden verilen adres (o sırada değiştirilen adresi Electron yok sayıyor) */
  private pending: string | null = null;

  constructor() {
    const el = document.createElement('webview') as WebviewElement;
    el.setAttribute('partition', WEB_PARTITION);
    el.setAttribute('src', 'about:blank');
    el.addEventListener('dom-ready', () => {
      this.ready = true;
      const url = this.pending;
      this.pending = null;
      if (url) this.open(url);
    });
    el.addEventListener('ipc-message', (e) => {
      const { channel, args } = e as Event & { channel: string; args: unknown[] };
      if (channel !== CHANNEL || !args[0] || typeof args[0] !== 'object') return;
      const msg = args[0] as Record<string, unknown>;
      if (msg.t === 'poke') return this.pokes.forEach((fn) => fn());
      // Yeni sayfanın betiği videoyu buldu: görünüm tercihini ona da bildir
      if (msg.t === 'video' && this.focus) this.el.send(CHANNEL, { t: 'focus', on: true }).catch(() => {});
      this.emit(msg);
    });
    // Sayfa değişince eski sayfanın videosu gider; yeni sayfanın betiği videoyu bulunca bildirir.
    el.addEventListener('did-start-navigation', (e) => {
      const nav = e as Event & { isMainFrame: boolean; isInPlace: boolean };
      if (nav.isMainFrame && !nav.isInPlace) this.emit({ t: 'gone' });
    });
    this.el = el;
    this.link = {
      send: (msg) => this.onSend(msg),
      onMessage: (fn) => void this.listeners.push(fn),
      getVideo: () => useWebPage.getState().video,
      setVideo: (video) => useWebPage.setState({ video }),
    };
  }

  /** Sayfayı aç. Aynı sayfa zaten açıksa yeniden yükleme (reklamlar baştan başlamasın). */
  open(url: string) {
    if (!this.ready) {
      this.pending = url;
      return;
    }
    if (samePage(this.currentUrl(), url)) return;
    this.el.setAttribute('src', url);
  }

  setFocus(on: boolean) {
    if (on === this.focus) return;
    this.focus = on;
    if (this.ready) this.el.send(CHANNEL, { t: 'focus', on }).catch(() => {});
  }

  /** Fare sayfanın üstünde hareket etti (uygulamanın kontrolleri gösterilsin) */
  onPoke(fn: () => void) {
    this.pokes.push(fn);
    return () => {
      this.pokes = this.pokes.filter((f) => f !== fn);
    };
  }

  /** Sayfayı kapat: arkada ses kalmasın */
  close() {
    this.pending = null;
    if (this.currentUrl() === 'about:blank') return;
    this.el.setAttribute('src', 'about:blank');
  }

  private currentUrl() {
    try {
      return this.el.getURL();
    } catch {
      return this.el.getAttribute('src') ?? 'about:blank';
    }
  }

  private onSend(msg: Record<string, unknown>) {
    if (msg.t === 'open' && typeof msg.url === 'string') return this.open(msg.url);
    if (this.ready) this.el.send(CHANNEL, msg).catch(() => {});
  }

  private emit(m: Record<string, unknown>) {
    for (const fn of this.listeners) fn(m);
  }
}
