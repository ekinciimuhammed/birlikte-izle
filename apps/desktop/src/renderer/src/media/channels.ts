// Kanallar paneli: canlı TV ve platformlar. Seçilen kanal iki tarafın tarayıcısında birden açılır
// (tarayıcı eklentisi). Bağlantılar eklentinin desteklediği sitelerden olmalı (apps/extension/sites.js).

export interface Channel {
  name: string;
  url: string;
}

export const LIVE_CHANNELS: Channel[] = [
  { name: 'atv', url: 'https://www.atv.com.tr/canli-yayin' },
  { name: 'Kanal D', url: 'https://www.kanald.com.tr/canli-yayin' },
  { name: 'Show TV', url: 'https://www.showtv.com.tr/canli-yayin' },
  { name: 'Star TV', url: 'https://www.startv.com.tr/canli-yayin' },
  { name: 'NOW', url: 'https://www.nowtv.com.tr/canli-yayin' },
  { name: 'TV8', url: 'https://www.tv8.com.tr/canli-yayin' },
];

/** Bölüm platformun kendi sitesinde seçilir; video açılınca birlikte izlemeye geçilir. */
export const PLATFORMS: Channel[] = [
  { name: 'Netflix', url: 'https://www.netflix.com/browse' },
  { name: 'TV+', url: 'https://tvplus.com.tr/' },
  { name: 'Disney+', url: 'https://www.disneyplus.com/' },
  { name: 'Prime Video', url: 'https://www.primevideo.com/' },
  { name: 'HBO Max', url: 'https://www.hbomax.com/tr' }, // eski BluTV
  { name: 'Exxen', url: 'https://www.exxen.com/' },
  { name: 'Gain', url: 'https://www.gain.tv/' },
  { name: 'tabii', url: 'https://www.tabii.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' },
];

/** İki bağlantı aynı siteden mi? (www. ve alt alan adı farkı önemsiz: player.kanald.com.tr = kanald.com.tr) */
export function sameSite(a: string, b: string) {
  try {
    const base = (url: string) => new URL(url).hostname.split('.').slice(-3).join('.').replace(/^www\./, '');
    const x = base(a);
    const y = base(b);
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
}
