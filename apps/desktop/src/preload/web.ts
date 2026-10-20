/// <reference lib="dom" />
// Uygulama içindeki sayfanın (Kanallar, YouTube) oynatıcısı: tarayıcı eklentisinin sayfa betiğinin
// (apps/extension/content.js) uygulama içi karşılığı. Sayfadaki asıl videoyu bulur, durumunu uygulamaya
// bildirir, uygulamanın komutlarını (oynat, durdur, sar, hız, ses) uygular. Mesajlar eklentiyle aynı
// (video / state / gone, cmd); uygulamada aynı oynatıcı sınıfı (BrowserPlayer) kullanılır.

import { ipcRenderer } from 'electron';

const CHANNEL = 'birlikte-web';
const send = (msg: Record<string, unknown>) => ipcRenderer.sendToHost(CHANNEL, msg);

// Kanalların canlı yayın sayfaları (atv.com.tr/canli-yayin…): oradaki video canlıdır
const livePage = /(^|\/)(canli|canli-yayin|live)(\/|$|-|\?)/i.test(location.pathname);

let video: HTMLVideoElement | null = null;
let announced = '';
let lastReport = 0;
// Canlı yayınlar süreyi sonsuz değil kayan pencere olarak da bildirebiliyor: oynarken süre büyüyorsa canlıdır.
let growing = false;
let lastDuration = 0;

/** Sayfadaki videolar: aynı kökenden iframe'ler (Kanal D, TV8) ve gölge DOM'lar dahil */
function videos(): HTMLVideoElement[] {
  const found = [...document.querySelectorAll('video')];
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      const doc = frame.contentDocument;
      if (doc) found.push(...doc.querySelectorAll('video'));
    } catch {
      // başka kökenden: erişilemez
    }
  }
  if (found.length) return found;
  // Gölge DOM'daki oynatıcılar (ağır: yalnızca hiç video bulunamazsa)
  const walk = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      found.push(...el.shadowRoot.querySelectorAll('video'));
      walk(el.shadowRoot);
    }
  };
  walk(document);
  return found;
}

/** İzlenen video: görünen en büyük, 45 saniyeden uzun olan (reklam/önizleme değil) */
function pick() {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of videos()) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    const long = !Number.isFinite(v.duration) || v.duration > 45;
    if (v.readyState >= 1 && long && area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** Paylaşılacak bağlantı: izleme sayfasının kendisi, kişisel parametreler olmadan */
function cleanUrl(href: string) {
  const url = new URL(href);
  const keep = new URLSearchParams();
  for (const k of ['v', 'list']) {
    const value = url.searchParams.get(k);
    if (value) keep.set(k, value);
  }
  url.search = keep.toString();
  url.hash = '';
  return url.href;
}

/** Canlı yayın mı? (zamanı karşılaştırılamaz; uygulama konumu eşitlemez) */
const isLive = (v: HTMLVideoElement) => livePage || growing || !Number.isFinite(v.duration);

function state(v: HTMLVideoElement) {
  return {
    t: 'state',
    playing: !v.paused && !v.ended,
    time: v.currentTime || 0,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    rate: v.playbackRate || 1,
    live: isLive(v),
    seeking: v.seeking,
    buffering: !v.paused && v.readyState < 3,
    ended: v.ended,
    at: Date.now(),
  };
}

function info(v: HTMLVideoElement) {
  const meta = navigator.mediaSession?.metadata;
  return {
    t: 'video',
    site: location.hostname.replace(/^www\./, ''),
    title: meta?.title || document.title,
    url: cleanUrl(location.href),
    // Canlıda süre (kayan pencere) sürekli değişir: bildirilmez, yoksa her yarım saniyede "yeni video" olur
    duration: !isLive(v) && Number.isFinite(v.duration) ? v.duration : 0,
  };
}

function report() {
  if (!video) return;
  lastReport = Date.now();
  send(state(video));
}

function announce() {
  if (!video) return;
  const current = info(video);
  const key = JSON.stringify(current);
  if (key === announced) return;
  announced = key;
  send(current);
  report();
}

// --- "Sadece video": oynatıcı kutusu alanın tamamını kaplar, sitenin menüleri ve reklam alanları gizlenir.
// Sitenin kendi kontrolleri ve reklam katmanı kutunun içinde olduğu için çalışmaya devam eder.
// (HTML tam ekranı uygulamanın kameralarını ve kontrollerini de örttüğü için kullanılmıyor.)
const FOCUS_CSS = `
  html, body { overflow: hidden !important; }
  [data-birlikte-odak] {
    position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
    max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; z-index: 2147483647 !important; background: #000 !important; transform: none !important;
  }
  /* Kutudan videoya giden yol: ara katmanların sabit boyutları (en-boy oranı kutuları, satır içi konumlar) iptal */
  [data-birlikte-odak-yol] {
    position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
    max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important;
    margin: 0 !important; padding: 0 !important; transform: none !important;
  }
  video[data-birlikte-odak], video[data-birlikte-odak-yol] { object-fit: contain !important; object-position: 50% 50% !important; }
  [data-birlikte-odak-ata] { transform: none !important; filter: none !important; contain: none !important; perspective: none !important; }
  body *:not([data-birlikte-odak], [data-birlikte-odak] *, [data-birlikte-odak-ata]) { visibility: hidden !important; }
`;
let focus = false;
let box: HTMLElement | null = null;

/** Videoyu saran oynatıcı kutusu: videoyla aşağı yukarı aynı boyuttaki en dış ata (sitenin kontrolleri onunla gelir) */
function playerBox(v: HTMLVideoElement): HTMLElement {
  // iframe'deki oynatıcı (Kanal D, TV8): iframe'in kendisi kaplanır, içindeki sayfa ona uyar
  const frame = v.ownerDocument.defaultView?.frameElement;
  if (v.ownerDocument !== document && frame) return frame as HTMLElement;
  const r = v.getBoundingClientRect();
  const base = Math.max(1, r.width * r.height);
  let found: HTMLElement = v;
  for (let el = v.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const b = el.getBoundingClientRect();
    if (b.width * b.height > base * 1.2) break;
    found = el;
  }
  return found;
}

const MARKS = ['data-birlikte-odak', 'data-birlikte-odak-ata', 'data-birlikte-odak-yol'];

/** Kutu hâlâ yerinde mi? (YouTube gibi siteler oynatıcıyı yeniden çizince işaret silinebiliyor) */
function intact() {
  if (!box || !video || !box.isConnected || !box.hasAttribute('data-birlikte-odak')) return false;
  return video.ownerDocument === document ? box.contains(video) : box === video.ownerDocument.defaultView?.frameElement;
}

function applyFocus() {
  if (focus && video ? intact() : !box) return;
  // Önce bütün işaretleri kaldır: kutu, sayfanın doğal yerleşimine göre bulunsun
  for (const name of MARKS) document.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
  box = focus && video ? playerBox(video) : null;
  let style = document.getElementById('birlikte-odak-stil');
  if (!box) return style?.remove();
  box.setAttribute('data-birlikte-odak', '');
  for (let el = box.parentElement; el; el = el.parentElement) el.setAttribute('data-birlikte-odak-ata', '');
  // iframe'deki oynatıcıda yol iframe'in içinde: oraya dokunmayız (gömülü sayfa iframe'e uyar)
  if (video!.ownerDocument === document) {
    for (let el: HTMLElement | null = video; el && el !== box; el = el.parentElement) el.setAttribute('data-birlikte-odak-yol', '');
  }
  if (!style) {
    style = document.createElement('style');
    style.id = 'birlikte-odak-stil';
    style.textContent = FOCUS_CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
}

// Fare olayları sayfaya gider; uygulamanın kontrolleri gösterilebilsin diye hareketi bildir (seyrek).
let lastPoke = 0;
document.addEventListener(
  'pointermove',
  () => {
    if (Date.now() - lastPoke < 400) return;
    lastPoke = Date.now();
    send({ t: 'poke' });
  },
  { capture: true, passive: true },
);

// Farenin "geri" tuşu sayfada geri gider (tarayıcıdaki gibi; uygulama ilk açılan sayfadan geriye geçmişi siler)
document.addEventListener(
  'mouseup',
  (e) => {
    if (e.button !== 3 || window.top !== window) return;
    e.preventDefault();
    history.back();
  },
  { capture: true },
);

const EVENTS = ['play', 'playing', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'canplay', 'ended', 'durationchange'];
function watch(v: HTMLVideoElement | null) {
  if (video === v) return;
  if (video) EVENTS.forEach((e) => video!.removeEventListener(e, report));
  video = v;
  announced = '';
  growing = false;
  lastDuration = 0;
  applyFocus();
  if (!v) return send({ t: 'gone' });
  EVENTS.forEach((e) => v.addEventListener(e, report));
  announce();
}

setInterval(() => {
  watch(pick());
  applyFocus(); // kutu kaybolduysa yeniden kur
  if (!video) return;
  const d = video.duration;
  if (Number.isFinite(d) && lastDuration && d > lastDuration + 0.5 && !video.paused && !growing) {
    growing = true;
    report();
  }
  if (Number.isFinite(d)) lastDuration = d;
  announce(); // başlık ya da süre sonradan gelebilir
  // Oynarken saniyede iki kez, dururken arada bir
  if (Date.now() - lastReport > (video.paused ? 3000 : 500)) report();
}, 500);

ipcRenderer.on(CHANNEL, (_e, msg: { t?: string; cmd?: string; value?: unknown; muted?: unknown; on?: unknown }) => {
  if (msg.t === 'focus') {
    focus = !!msg.on;
    applyFocus();
    return;
  }
  if (msg.t === 'probe') {
    if (video) {
      announced = '';
      announce();
    }
    return;
  }
  if (msg.t !== 'cmd' || !video) return;
  switch (msg.cmd) {
    case 'play':
      video.play().catch(() => {});
      break;
    case 'pause':
      video.pause();
      break;
    case 'seek':
      video.currentTime = Number(msg.value) || 0;
      break;
    case 'rate':
      video.playbackRate = Math.min(4, Math.max(0.25, Number(msg.value) || 1));
      break;
    case 'volume':
      video.volume = Math.min(1, Math.max(0, Number(msg.value) || 0));
      video.muted = !!msg.muted;
      break;
  }
  report();
});
