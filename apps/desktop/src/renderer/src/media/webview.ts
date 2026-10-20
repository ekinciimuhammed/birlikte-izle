// Uygulamanın içindeki sayfa (Kanallar, YouTube): sitenin kendisi uygulama penceresinde, gömülü bir
// tarayıcı görünümünde (<webview>) açılır; tarayıcıya gitmeye gerek kalmaz. Sayfadaki videoyu
// preload/web.ts bulur ve tarayıcı eklentisiyle aynı mesajları gönderir: BrowserPlayer'a bir TabLink
// olarak bağlanır. Güvenlik kuralları (hangi siteler, izinler, açılır pencereler) ana süreçte.

import { create } from 'zustand';
import { WEB_PARTITION } from '../../../shared/web';
import { samePage, type BrowserVideo, type TabLink } from './browser';

const CHANNEL = 'birlikte-web';

/** Uygulamanın içindeki sayfada şu an bulunan video; sayfada geri gidilebilir mi */
export const useWebPage = create<{ video: BrowserVideo | null; canGoBack: boolean }>(() => ({ video: null, canGoBack: false }));

type WebviewElement = HTMLElement & {
  getURL(): string;
  canGoBack(): boolean;
  goBack(): void;
  clearHistory(): void;
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
  /** Açtığımız sayfa yüklenince geçmişi sil: "geri" siteden boş sayfaya çıkmasın */
  private freshHistory = false;

  constructor() {
    const el = document.createElement('webview') as WebviewElement;
    el.setAttribute('partition', WEB_PARTITION);
    el.setAttribute('src', 'about:blank');
    // İzleme ekranından çıkınca görünüm pencereden ayrılır ve Electron sayfayı kapatır; geri takılınca
    // sayfa baştan yüklenir. O yüklenene kadar görünüme mesaj gönderilemez (gönderen hata alır).
    el.addEventListener('did-attach', () => (this.ready = false));
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
      if (msg.t === 'video' && this.focus) this.post({ t: 'focus', on: true });
      this.emit(msg);
    });
    // Sayfa değişince eski sayfanın videosu gider; yeni sayfanın betiği videoyu bulunca bildirir.
    el.addEventListener('did-start-navigation', (e) => {
      const nav = e as Event & { isMainFrame: boolean; isInPlace: boolean };
      if (nav.isMainFrame && !nav.isInPlace) this.emit({ t: 'gone' });
    });
    el.addEventListener('did-navigate', () => {
      if (this.freshHistory) {
        this.freshHistory = false;
        this.el.clearHistory();
      }
      this.updateHistory();
    });
    el.addEventListener('did-navigate-in-page', (e) => (e as Event & { isMainFrame: boolean }).isMainFrame && this.updateHistory());
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
    if (!this.live) {
      this.pending = url;
      return;
    }
    if (samePage(this.currentUrl(), url)) return;
    this.freshHistory = true;
    this.el.setAttribute('src', url);
  }

  /** Sayfada bir önceki sayfaya dön (ör. YouTube'da başka videolara bakmak için) */
  goBack() {
    if (this.live && this.el.canGoBack()) this.el.goBack();
  }

  setFocus(on: boolean) {
    if (on === this.focus) return;
    this.focus = on;
    this.post({ t: 'focus', on });
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
    useWebPage.setState({ canGoBack: false });
    if (this.currentUrl() === 'about:blank') return;
    this.freshHistory = true;
    this.el.setAttribute('src', 'about:blank');
  }

  /** Sayfa yüklendi ve görünüm hâlâ pencerede */
  private get live() {
    return this.ready && this.el.isConnected;
  }

  /** Sayfaya mesaj; sayfa o an yeniden yükleniyorsa sessizce vazgeç (yeni sayfa durumu kendisi ister) */
  private post(msg: Record<string, unknown>) {
    if (!this.live) return;
    try {
      this.el.send(CHANNEL, msg).catch(() => {});
    } catch {
      // görünüm tam bu sırada pencereden ayrıldı
    }
  }

  private updateHistory() {
    let canGoBack = false;
    try {
      canGoBack = this.currentUrl() !== 'about:blank' && this.el.canGoBack();
    } catch {
      // görünüm pencerede değil
    }
    if (useWebPage.getState().canGoBack !== canGoBack) useWebPage.setState({ canGoBack });
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
    this.post(msg);
  }

  private emit(m: Record<string, unknown>) {
    for (const fn of this.listeners) fn(m);
  }
}
