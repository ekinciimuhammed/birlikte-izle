// Altyazı izleri: kim eklediyse (dosyanın yanındaki, MKV içindeki ya da elle eklenen) iki
// tarafa da gider. Her taraf kendi seçimini ve görünümünü yapar; zaman kaydırması ortaktır.

import type { PeerMessage } from '@birlikte/protocol';
import { getSetting } from '../settings/store';
import { activeCues, decodeText, parseSubtitles, type Cue } from './parse';

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string | null;
  cues: Cue[];
  /** Bu taraf mı ekledi? (Sadece kendi eklediklerimizi karşıya göndeririz.) */
  mine: boolean;
}

export interface SubtitleView {
  tracks: { id: string; label: string; language: string | null }[];
  selected: string | null;
  offset: number;
}

type SubsMessage = Extract<PeerMessage, { t: 'subs' }>;

// UTF-16 karakter; Türkçe karakterler UTF-8'de 2 bayt, sınırın (256 KB) çok altında kalır.
const CHUNK = 30_000;

export class SubtitleManager {
  private tracks = new Map<string, SubtitleTrack>();
  private incoming = new Map<string, { parts: string[]; received: number }>();
  private selected: string | null = null;
  /** Kullanıcı elle seçtiyse otomatik seçim karışmaz */
  private chosen = false;
  private offset = 0;

  constructor(
    private readonly send: (msg: PeerMessage) => void,
    private readonly onChange: (view: SubtitleView) => void,
  ) {}

  get view(): SubtitleView {
    return {
      tracks: [...this.tracks.values()].map(({ id, label, language }) => ({ id, label, language })),
      selected: this.selected,
      offset: this.offset,
    };
  }

  /** Yeni bölüm: her şey sıfırlanır. */
  clear() {
    this.tracks.clear();
    this.incoming.clear();
    this.selected = null;
    this.chosen = false;
    this.offset = 0;
    this.emit();
  }

  /** Ham metin ya da baytlardan iz ekler; satır yoksa false döner. */
  add(source: { id: string; label: string; language: string | null; text?: string; bytes?: Uint8Array }, mine = true) {
    const raw = source.text ?? (source.bytes ? decodeText(source.bytes) : '');
    const cues = parseSubtitles(raw);
    if (!cues.length) return false;
    const track: SubtitleTrack = { id: source.id, label: source.label, language: source.language, cues, mine };
    this.tracks.set(track.id, track);
    if (mine) this.share(track);
    this.autoSelect();
    this.emit();
    return true;
  }

  async addFile(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = `el:${file.name}:${file.size}`;
    const ok = this.add({ id, label: file.name.replace(/\.[^.]+$/, ''), language: guessLanguage(file.name), bytes });
    if (ok) this.select(id);
    return ok;
  }

  select(id: string | null) {
    this.chosen = true;
    this.selected = id && this.tracks.has(id) ? id : null;
    this.emit();
  }

  /** Altyazıyı aç/kapat: kapalıysa son seçileni ya da ilkini açar. */
  toggle() {
    if (this.selected) return this.select(null);
    const first = this.pickByLanguage() ?? this.tracks.keys().next().value ?? null;
    this.select(first);
  }

  setOffset(seconds: number, fromPeer = false) {
    this.offset = Math.round(seconds * 100) / 100;
    if (!fromPeer) this.send({ t: 'subs-offset', seconds: this.offset });
    this.emit();
  }

  get currentOffset() {
    return this.offset;
  }

  /** Film zamanı t'de gösterilecek satırlar */
  cuesAt(t: number): Cue[] {
    const track = this.selected ? this.tracks.get(this.selected) : null;
    return track ? activeCues(track.cues, t - this.offset) : [];
  }

  /** Bağlantı (yeniden) açıldı: kendi eklediğimiz izleri ve ortak kaydırmayı gönder. */
  resend() {
    for (const track of this.tracks.values()) if (track.mine) this.share(track);
    if (this.offset) this.send({ t: 'subs-offset', seconds: this.offset });
  }

  receive(msg: SubsMessage) {
    const entry = this.incoming.get(msg.id) ?? { parts: new Array<string>(msg.parts), received: 0 };
    if (entry.parts.length !== msg.parts) return;
    if (entry.parts[msg.part] === undefined) entry.received++;
    entry.parts[msg.part] = msg.data;
    this.incoming.set(msg.id, entry);
    if (entry.received < msg.parts) return;
    this.incoming.delete(msg.id);
    try {
      const rows = JSON.parse(entry.parts.join('')) as [number, number, string][];
      const cues = rows
        .filter((r) => Array.isArray(r) && typeof r[2] === 'string')
        .map(([start, end, text]) => ({ start: Number(start), end: Number(end), text: String(text).slice(0, 500) }));
      this.tracks.set(msg.id, { id: msg.id, label: msg.label, language: msg.language, cues, mine: false });
      this.autoSelect();
      this.emit();
    } catch {
      // bozuk parça: yok say
    }
  }

  private share(track: SubtitleTrack) {
    const json = JSON.stringify(track.cues.map((c) => [Math.round(c.start * 1000) / 1000, Math.round(c.end * 1000) / 1000, c.text]));
    const parts = Math.max(1, Math.ceil(json.length / CHUNK));
    if (parts > 200) return; // aşırı büyük: paylaşma
    for (let i = 0; i < parts; i++) {
      this.send({
        t: 'subs',
        id: track.id,
        label: track.label.slice(0, 100),
        language: track.language,
        part: i,
        parts,
        data: json.slice(i * CHUNK, (i + 1) * CHUNK),
      });
    }
  }

  /** Ayardaki dile göre ilk uygun iz */
  private pickByLanguage(): string | null {
    const pref = getSetting('subtitles.language');
    const list = [...this.tracks.values()];
    if (pref === 'tur' || pref === 'eng') return list.find((t) => t.language === pref)?.id ?? null;
    return list.find((t) => t.language === 'tur')?.id ?? list[0]?.id ?? null;
  }

  private autoSelect() {
    if (this.chosen || this.selected || getSetting('subtitles.language') === 'off') return;
    this.selected = this.pickByLanguage();
  }

  private emit() {
    this.onChange(this.view);
  }
}

function guessLanguage(name: string): string | null {
  const n = name.toLowerCase();
  if (/(^|[._\s-])(tr|tur|turkish|türkçe|turkce)([._\s-]|$)/.test(n)) return 'tur';
  if (/(^|[._\s-])(en|eng|english)([._\s-]|$)/.test(n)) return 'eng';
  return null;
}
