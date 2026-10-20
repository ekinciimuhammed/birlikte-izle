// Desteklenen siteler: adları ve bağlantı temizleme. Hem sayfa betiği (content.js) hem arka plan
// (background.js) kullanır. Yeni site eklemek: buraya bir satır + manifest.json'daki iki listeye.
/* exported BIRLIKTE_SITES, birlikteSite, birlikteAllowedUrl, birlikteCleanUrl, birlikteCleanTitle */

var BIRLIKTE_SITES = [
  { host: 'netflix.com', name: 'Netflix' },
  { host: 'disneyplus.com', name: 'Disney+' },
  { host: 'primevideo.com', name: 'Prime Video' },
  { host: 'amazon.com', name: 'Prime Video', path: '/gp/video/' },
  { host: 'amazon.com.tr', name: 'Prime Video', path: '/gp/video/' },
  { host: 'amazon.de', name: 'Prime Video', path: '/gp/video/' },
  { host: 'amazon.co.uk', name: 'Prime Video', path: '/gp/video/' },
  { host: 'max.com', name: 'Max' },
  { host: 'hbomax.com', name: 'HBO Max' },
  { host: 'youtube.com', name: 'YouTube' },
  { host: 'blutv.com', name: 'BluTV' },
  { host: 'exxen.com', name: 'Exxen' },
  { host: 'gain.tv', name: 'Gain' },
  { host: 'tabii.com', name: 'tabii' },
  { host: 'puhutv.com', name: 'puhutv' },
  { host: 'mubi.com', name: 'MUBI' },
  { host: 'tv.apple.com', name: 'Apple TV+' },
  { host: 'crunchyroll.com', name: 'Crunchyroll' },
  { host: 'tvplus.com.tr', name: 'TV+' },
  // Kanalların kendi siteleri: bölümler ücretsiz (reklamlı). Kanal D ve TV8'de oynatıcı iframe içinde.
  { host: 'atv.com.tr', name: 'atv' },
  { host: 'kanald.com.tr', name: 'Kanal D' },
  { host: 'showtv.com.tr', name: 'Show TV' },
  { host: 'startv.com.tr', name: 'Star TV' },
  { host: 'nowtv.com.tr', name: 'NOW' },
  { host: 'tv8.com.tr', name: 'TV8' },
  // Bu bilgisayardaki ya da evdeki sunucular (Jellyfin, Plex…) ve test sayfası
  { host: 'localhost', name: 'Yerel sunucu', http: true },
  { host: '127.0.0.1', name: 'Yerel sunucu', http: true },
];

/** Bu adres desteklenen bir siteye mi ait? */
function birlikteSite(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return (
    BIRLIKTE_SITES.find(
      (s) =>
        (host === s.host || host.endsWith(`.${s.host}`)) &&
        (!s.path || url.pathname.startsWith(s.path)) &&
        (url.protocol === 'https:' || (s.http && url.protocol === 'http:')),
    ) ?? null
  );
}

/** Karşı tarafın gönderdiği bağlantı açılabilir mi? (sadece desteklenen siteler) */
function birlikteAllowedUrl(href) {
  return !!birlikteSite(href);
}

/** Paylaşılacak bağlantı: izleme sayfasının kendisi, kişisel parametreler olmadan */
function birlikteCleanUrl(href) {
  const url = new URL(href);
  const keep = new URLSearchParams();
  // YouTube'da video kimliği parametrede; diğerlerinde yol yeterli.
  for (const k of ['v', 'list']) if (url.searchParams.has(k)) keep.set(k, url.searchParams.get(k));
  url.search = keep.toString();
  url.hash = '';
  return url.href;
}

/** Sekme başlığından site adıyla biten son kısmı atar: "Bölüm | Netflix", "Bölüm | … Son Bölüm İzle atv" */
function birlikteCleanTitle(title, siteName) {
  const name = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`\\s*[|\\-–—][^|\\-–—]*?\\b${name}\\s*$`, 'i'), '').trim();
}
