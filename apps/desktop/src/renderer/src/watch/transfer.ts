// "Bölümü ona gönder": açık dosyayı P2P olarak karşıya gönderir. Alan taraf diske yazar
// (İndirilenler/Birlikte İzle); yarım kalırsa bir sonraki denemede kaldığı yerden devam eder.
// Gelince iki taraf da kendi kopyasından, kayıpsız izler (senkron mod).

import type { FileRef, PeerMessage } from '@birlikte/protocol';
import type { MediaInfo } from '../../../shared/media';
import type { Link } from '../net/link';
import { bridge } from '../platform/bridge';

export interface TransferView {
  direction: 'send' | 'receive';
  name: string;
  size: number;
  done: number;
  /** bayt/sn (son birkaç saniyenin ortalaması) */
  rate: number;
}

const READ_SIZE = 1 << 20; // diskten 1 MB
const CHUNK = 64 << 10; // kanala 64 KB

export class Transfer {
  private sending: { ref: FileRef; mediaId: string; cancelled: boolean } | null = null;
  private receiving: { ref: FileRef; done: number } | null = null;
  private meter = { at: 0, done: 0, rate: 0 };

  constructor(
    private readonly getLink: () => Link | null,
    private readonly send: (msg: PeerMessage) => void,
    private readonly onView: (view: TransferView | null) => void,
    /** Alım bitti: dosya açılmaya hazır */
    private readonly onReceived: (info: MediaInfo) => void,
    private readonly onError: (text: string) => void,
  ) {}

  get busy() {
    return !!(this.sending || this.receiving);
  }

  // --- Gönderen ---------------------------------------------------------------------------

  offer(media: MediaInfo) {
    if (this.busy) return;
    const ref = fileRefOf(media);
    this.sending = { ref, mediaId: media.id, cancelled: false };
    this.update('send', 0);
    this.send({ t: 'file-offer', file: ref });
  }

  /** Karşı kabul etti: kaldığı yerden gönder */
  async onAccept(fingerprint: string, offset: number) {
    const job = this.sending;
    const link = this.getLink();
    if (!job || job.ref.fingerprint !== fingerprint || !link || !bridge.media) return;
    let pos = offset;
    this.meter = { at: performance.now(), done: pos, rate: 0 };
    try {
      while (pos < job.ref.size && !job.cancelled) {
        const block = await bridge.media.read(job.mediaId, pos, READ_SIZE);
        if (!block.byteLength) throw new Error('Dosya okunamadı');
        for (let i = 0; i < block.byteLength && !job.cancelled; i += CHUNK) {
          await link.sendChunk(block.subarray(i, i + CHUNK));
        }
        pos += block.byteLength;
        this.update('send', pos);
      }
    } catch {
      if (!job.cancelled) this.onError('Gönderim yarıda kaldı; tekrar gönderince kaldığı yerden devam eder.');
    } finally {
      if (this.sending === job) {
        this.sending = null;
        this.onView(null);
      }
    }
  }

  // --- Alan --------------------------------------------------------------------------------------

  async onOffer(ref: FileRef) {
    if (!bridge.media || this.busy) return this.send({ t: 'file-cancel', fingerprint: ref.fingerprint });
    const { offset } = await bridge.media.receive.begin(ref);
    this.receiving = { ref, done: offset };
    this.meter = { at: performance.now(), done: offset, rate: 0 };
    this.update('receive', offset);
    this.send({ t: 'file-accept', fingerprint: ref.fingerprint, offset });
  }

  async onChunk(data: ArrayBuffer) {
    const job = this.receiving;
    if (!job || !bridge.media) return;
    bridge.media.receive.chunk(job.ref.fingerprint, new Uint8Array(data));
    job.done += data.byteLength;
    this.update('receive', job.done);
    if (job.done < job.ref.size) return;
    this.receiving = null;
    this.onView(null);
    try {
      this.onReceived(await bridge.media.receive.finish(job.ref.fingerprint));
    } catch {
      this.onError('Bölüm bozuk geldi; tekrar gönderilmesi gerek.');
    }
  }

  // --- İki taraf --------------------------------------------------------------------------------

  /** Kullanıcı vazgeçti: karşıya da haber ver */
  cancel() {
    const ref = this.sending?.ref ?? this.receiving?.ref;
    if (!ref) return;
    this.send({ t: 'file-cancel', fingerprint: ref.fingerprint });
    this.onCancel(ref.fingerprint);
  }

  /** Karşı vazgeçti ya da bağlantı koptu. Alan tarafta yarım dosya kalır (kaldığı yerden devam). */
  onCancel(fingerprint?: string) {
    if (this.sending && (!fingerprint || this.sending.ref.fingerprint === fingerprint)) {
      this.sending.cancelled = true;
      this.sending = null;
    }
    if (this.receiving && (!fingerprint || this.receiving.ref.fingerprint === fingerprint)) {
      bridge.media?.receive.abort(this.receiving.ref.fingerprint);
      this.receiving = null;
    }
    this.onView(null);
  }

  private lastEmit = 0;

  private update(direction: 'send' | 'receive', done: number) {
    const ref = direction === 'send' ? this.sending?.ref : this.receiving?.ref;
    if (!ref) return;
    const t = performance.now();
    // Arayüzü saniyede en fazla 4 kez güncelle (her 64 KB'da değil).
    if (t - this.lastEmit < 250 && done > 0 && done < ref.size) return;
    this.lastEmit = t;
    if (t - this.meter.at > 1000) {
      const inst = ((done - this.meter.done) * 1000) / (t - this.meter.at);
      this.meter = { at: t, done, rate: this.meter.rate ? this.meter.rate * 0.6 + inst * 0.4 : inst };
    }
    this.onView({ direction, name: ref.name, size: ref.size, done, rate: this.meter.rate });
  }
}

/** Karşıya tarif edilen dosya: yol değil, sadece adı, boyutu ve parmak izi */
export function fileRefOf(media: MediaInfo): FileRef {
  return { name: `${media.name.slice(0, 200)}${extOf(media.path)}`, size: media.size, fingerprint: media.fingerprint };
}

function extOf(path: string) {
  const m = /\.[^./\\]+$/.exec(path);
  return m ? m[0] : '';
}
