// "Birlikte izlediğimiz saatler": ikiniz de bağlıyken ve film oynarken geçen süre.
// Her iki taraf kendi sayar (aynı anları saydıkları için sonuç aynıdır). Ayarlarda, gizli bir
// alanda saklanır; ana ekrandaki kart buradan okur.

import { getSetting, setSetting } from '../settings/store';

export interface TogetherStats {
  /** Toplam (sn) */
  total: number;
  /** Gün gün (yerel tarih "YYYY-AA-GG" → sn), son 120 gün */
  days: Record<string, number>;
  /** Bölüm/film başına süre (sn) */
  titles: Record<string, number>;
  sessions: number;
  /** En uzun kesintisiz oturum (sn) */
  longest: number;
  /** İlk birlikte izleme (ms) */
  since: number;
}

/** Bu kadar birlikte izlenen bölüm "izlendi" sayılır */
export const EPISODE_MIN = 5 * 60;

const empty = (): TogetherStats => ({ total: 0, days: {}, titles: {}, sessions: 0, longest: 0, since: 0 });

export function readStats(raw = getSetting('stats.together')): TogetherStats {
  try {
    const v = JSON.parse(raw) as Partial<TogetherStats>;
    return { ...empty(), ...v, days: { ...v.days }, titles: { ...v.titles } };
  } catch {
    return empty();
  }
}

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Son 7 gün (bugün en sağda) */
export function lastWeek(stats: TogetherStats) {
  const out: { key: string; date: Date; seconds: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = dayKey(date);
    out.push({ key, date, seconds: stats.days[key] ?? 0 });
  }
  return out;
}

export function episodeCount(stats: TogetherStats) {
  return Object.values(stats.titles).filter((s) => s >= EPISODE_MIN).length;
}

/** 12 sa 40 dk · 40 dk · 1 dk'dan az */
export function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 1) return "1 dk'dan az";
  const h = Math.floor(m / 60);
  return h ? `${h} sa${m % 60 ? ` ${m % 60} dk` : ''}` : `${m} dk`;
}

export class TogetherCounter {
  private pending = 0;
  private pendingTitles: Record<string, number> = {};
  private session = 0;
  private counted = false;
  private lastFlush = 0;

  /** İzleme ekranına girildi: yeni oturum */
  begin() {
    this.session = 0;
    this.counted = false;
  }

  add(seconds: number, title: string) {
    this.pending += seconds;
    if (title) this.pendingTitles[title] = (this.pendingTitles[title] ?? 0) + seconds;
    this.session += seconds;
    if (performance.now() - this.lastFlush > 15_000) this.flush();
  }

  /** Biriken süreyi kaydet (15 sn'de bir ve ekrandan çıkarken) */
  flush() {
    this.lastFlush = performance.now();
    if (this.pending < 0.5) return;
    const s = readStats();
    const add = this.pending;
    s.total += add;
    const today = dayKey();
    s.days[today] = (s.days[today] ?? 0) + add;
    for (const [title, sec] of Object.entries(this.pendingTitles)) s.titles[title] = (s.titles[title] ?? 0) + sec;
    if (!this.counted) {
      s.sessions += 1;
      this.counted = true;
    }
    s.longest = Math.max(s.longest, this.session);
    if (!s.since) s.since = Date.now();
    s.days = Object.fromEntries(Object.entries(s.days).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 120));
    s.titles = Object.fromEntries(Object.entries(s.titles).sort(([, a], [, b]) => b - a).slice(0, 300));
    this.pending = 0;
    this.pendingTitles = {};
    setSetting('stats.together', JSON.stringify(roundAll(s)));
  }
}

function roundAll(s: TogetherStats): TogetherStats {
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    ...s,
    total: r(s.total),
    longest: r(s.longest),
    days: Object.fromEntries(Object.entries(s.days).map(([k, v]) => [k, r(v)])),
    titles: Object.fromEntries(Object.entries(s.titles).map(([k, v]) => [k, r(v)])),
  };
}
