// Bağlantı testi: "neden bağlanamıyoruz?" sorusunu bu bilgisayarın tarafından cevaplar.
//
//   sunucu   → eşleşme/tanışma sunucusuna ulaşılıyor mu, ne kadar sürede
//   doğrudan → bu ağda P2P bağlantı kurulabilir mi: iki ayrı STUN sunucusunun gördüğü dış kapı
//              aynıysa evet; farklıysa (her hedefe ayrı kapı, mobil veri/CGNAT'ta sık) çoğu zaman
//              hayır; hiç dış adres gelmiyorsa UDP kapalıdır
//   TURN     → sunucu aktarma bilgisi veriyor mu, bu ağdan aktarma sunucusuna ulaşılıyor mu
//
// Sadece bu bilgisayarın ağını ölçer; karşı tarafın ağı için onda da çalıştırılmalı.

import { getSetting } from '../settings/store';
import { ApiFailure, requestIceServers } from './api';

export type Verdict = 'ok' | 'warn' | 'fail';

export interface HealthItem {
  label: string;
  verdict: Verdict;
  text: string;
}

export interface HealthReport {
  items: HealthItem[];
  verdict: Verdict;
  summary: string;
}

type Nat = 'open' | 'strict' | 'blocked';

const STUN_A = 'stun:stun.cloudflare.com:3478';
const STUN_B = 'stun:stun.l.google.com:19302';

const urlsOf = (s: RTCIceServer) => [s.urls].flat();
const isTurn = (s: RTCIceServer) => urlsOf(s).some((u) => /^turns?:/i.test(u));
export const hasTurn = (servers: RTCIceServer[]) => servers.some(isTurn);

export async function checkConnection(): Promise<HealthReport> {
  const items: HealthItem[] = [];

  let servers: RTCIceServer[] | null = null;
  const started = performance.now();
  try {
    servers = await requestIceServers();
    items.push({ label: 'Sunucu', verdict: 'ok', text: `Ulaşılıyor · ${Math.round(performance.now() - started)} ms` });
  } catch (err) {
    const code = err instanceof ApiFailure ? err.code : 'network';
    const text = code === 'network' ? 'Ulaşılamıyor' : code === 'unauthorized' ? 'Eşleşme kabul edilmedi' : 'Hata verdi';
    items.push({ label: 'Sunucu', verdict: 'fail', text });
  }

  const turnSetting = getSetting('connection.turn');
  const turnOff = turnSetting === 'never';
  const turnServers = servers?.filter(isTurn) ?? [];
  const [nat, relay] = await Promise.all([probeNat(), turnServers.length && !turnOff ? probeTurn(turnServers) : null]);

  items.push({
    label: 'Doğrudan bağlantı',
    verdict: nat === 'open' ? 'ok' : nat === 'strict' ? 'warn' : 'fail',
    text: nat === 'open' ? 'Mümkün' : nat === 'strict' ? 'Zor (mobil veri / CGNAT)' : 'Kapalı (UDP engelli)',
  });

  const turnWorks = !!relay;
  items.push({
    label: 'Aktarma (TURN)',
    verdict: turnWorks ? 'ok' : nat === 'open' ? 'warn' : 'fail',
    text: !servers
      ? 'Denenemedi'
      : !turnServers.length
        ? 'Sunucuda tanımlı değil'
        : turnOff
          ? "Ayarlar'da kapalı"
          : !relay
            ? 'Ulaşılamıyor'
            : relay.length
              ? `Çalışıyor · ${relay.join(', ')}`
              : 'Çalışıyor',
  });

  if (!servers) return { items, verdict: 'fail', summary: 'Sunucuya ulaşılamıyor; önce internet bağlantını kontrol et.' };
  if (turnSetting === 'always' && !turnWorks) {
    const why = turnServers.length ? 'aktarma sunucusuna ulaşılamıyor' : 'sunucuda TURN tanımlı değil';
    return { items, verdict: 'fail', summary: `Ayarlar → Bağlantı'da aktarma "Her zaman" seçili ama ${why}; "Otomatik"e al.` };
  }
  if (nat === 'open') {
    return {
      items,
      verdict: 'ok',
      summary: turnWorks
        ? 'Bu ağ sorunsuz: doğrudan bağlantı kurulur, gerekirse aktarma da hazır.'
        : 'Bu ağda doğrudan bağlantı kurulabilir. Karşı tarafta da test edin; o mobil verideyse aktarma (TURN) gerekebilir.',
    };
  }
  if (turnWorks) {
    return { items, verdict: 'warn', summary: 'Bu ağda doğrudan bağlantı zor ama aktarma (TURN) çalışıyor; bağlanabilirsiniz.' };
  }
  const why = !turnServers.length ? 'sunucuda tanımlı değil' : turnOff ? "Ayarlar → Bağlantı'da kapalı" : 'bu ağdan ulaşılamıyor';
  return { items, verdict: 'fail', summary: `Bu ağdan bağlanmak için aktarma (TURN) gerekiyor ama ${why}.` };
}

/** Bu ağda doğrudan bağlantı kurulabilir mi? */
async function probeNat(): Promise<Nat> {
  const candidates = await gather({ iceServers: [{ urls: STUN_A }, { urls: STUN_B }] }, 4000);
  const srflx = candidates.filter((c) => c.type === 'srflx' && c.protocol === 'udp');
  if (!srflx.length) return 'blocked';
  // Aynı yerel kapıdan çıkıp iki sunucuya farklı dış kapıyla görünmek: her hedefe ayrı kapı
  const ports = new Map<string, Set<number | null>>();
  for (const c of srflx) {
    const base = c.relatedPort ? `${c.relatedAddress}:${c.relatedPort}` : String(c.address);
    ports.set(base, (ports.get(base) ?? new Set()).add(c.port));
  }
  return [...ports.values()].some((p) => p.size > 1) ? 'strict' : 'open';
}

/** Aktarma sunucusuna ulaşıldıysa hangi yollarla (UDP, TCP, TLS); ulaşılamadıysa null */
async function probeTurn(servers: RTCIceServer[]): Promise<string[] | null> {
  const candidates = await gather({ iceServers: servers, iceTransportPolicy: 'relay' }, 6000);
  // relayProtocol Chromium'da var ama TypeScript'in DOM tiplerinde henüz yok
  const relays = candidates.filter((c) => c.type === 'relay') as (RTCIceCandidate & { relayProtocol?: string | null })[];
  if (!relays.length) return null;
  return [...new Set(relays.map((c) => c.relayProtocol?.toUpperCase()).filter((p): p is string => !!p))];
}

/** Bağlantı kurmadan ICE adaylarını toplar (en fazla `ms` kadar) */
async function gather(config: RTCConfiguration, ms: number): Promise<RTCIceCandidate[]> {
  const pc = new RTCPeerConnection(config);
  const found: RTCIceCandidate[] = [];
  try {
    pc.createDataChannel('test');
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) return void found.push(candidate);
        clearTimeout(timer);
        resolve();
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
  } catch (err) {
    console.warn('Bağlantı testi: adaylar toplanamadı', err);
  } finally {
    pc.close();
  }
  return found;
}
