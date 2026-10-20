// Uygulamanın içinde (gömülü sayfa) açılabilen siteler: şifresiz (DRM'siz) video siteleri. Netflix,
// TV+, Disney+ gibi platformlar Widevine ister; onlar tarayıcıda, eklentiyle izlenir.
// Ana süreç (hangi sayfa gömülebilir) ve arayüz (uygulamada mı tarayıcıda mı açılsın) birlikte kullanır.

export const EMBED_HOSTS = ['atv.com.tr', 'kanald.com.tr', 'showtv.com.tr', 'startv.com.tr', 'nowtv.com.tr', 'tv8.com.tr', 'youtube.com'];

/** Gömülü sayfaların oturumu: çerez onayı ve site ayarları uygulama kapanınca da kalsın */
export const WEB_PARTITION = 'persist:siteler';

/** Bu bağlantı uygulamanın içinde açılabilir mi? local: uygulama içi izleme testindeki yerel sayfalar */
export function isEmbeddable(href: string, local = false) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (local && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return true;
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && EMBED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
