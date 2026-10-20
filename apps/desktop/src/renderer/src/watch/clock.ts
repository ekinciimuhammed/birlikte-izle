// İki bilgisayarın saat farkı (NTP'nin küçük kardeşi): ping → pong ile gidiş-dönüş süresi ve
// karşının saati ölçülür. Gidiş-dönüşü en kısa ölçümler en güvenilirdir; fark onlardan alınır.
// Senkron modda guest, host'un "şu saniyede şuradaydım" bilgisini kendi saatine çevirir.

import type { PeerMessage } from '@birlikte/protocol';

/** Milisaniye hassasiyetli duvar saati */
export const now = () => performance.timeOrigin + performance.now();

type Ping = Extract<PeerMessage, { t: 'ping' }>;
type Pong = Extract<PeerMessage, { t: 'pong' }>;

export class ClockSync {
  private samples: { rtt: number; offset: number }[] = [];
  private nextId = 1;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly send: (msg: PeerMessage) => void) {}

  /** Bağlantı açılınca: önce hızlı bir seri, sonra arada bir. */
  start() {
    this.stop();
    this.samples = [];
    for (let i = 0; i < 6; i++) this.timers.push(setTimeout(() => this.ping(), i * 150));
    this.timers.push(setInterval(() => this.ping(), 3000));
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  /** Karşının saati − benim saatim (ms). Henüz ölçüm yoksa 0. */
  get offset() {
    if (!this.samples.length) return 0;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    return best.reduce((sum, s) => sum + s.offset, 0) / best.length;
  }

  get ready() {
    return this.samples.length >= 3;
  }

  onPing(m: Ping) {
    this.send({ t: 'pong', id: m.id, t0: m.t0, t1: now() });
  }

  onPong(m: Pong) {
    const t3 = now();
    const rtt = t3 - m.t0;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, offset: m.t1 - (m.t0 + rtt / 2) });
    if (this.samples.length > 16) this.samples.shift();
  }

  private ping() {
    this.send({ t: 'ping', id: this.nextId++, t0: now() });
  }
}
