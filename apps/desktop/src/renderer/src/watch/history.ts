// "Kaldığınız yerden": son açılan bölümler ve kaldığın saniye (sadece masaüstünde; dosya yolu gerekir).

import { getSetting, setSetting } from '../settings/store';

export interface HistoryItem {
  path: string;
  name: string;
  position: number;
  duration: number;
  at: number;
}

const LIMIT = 8;

export function readHistory(raw = getSetting('history.items')): HistoryItem[] {
  try {
    const items = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(items) ? items.filter((i) => typeof i?.path === 'string') : [];
  } catch {
    return [];
  }
}

export function recordHistory(item: Omit<HistoryItem, 'at'>) {
  if (!item.path || !item.duration) return;
  // Sonuna gelindiyse "kaldığın yer" baştan sayılmaz; listede yine de dursun.
  const finished = item.position > item.duration - 60;
  const entry: HistoryItem = { ...item, position: finished ? 0 : Math.floor(item.position), at: Date.now() };
  const rest = readHistory().filter((i) => i.path !== item.path);
  setSetting('history.items', JSON.stringify([entry, ...rest].slice(0, LIMIT)));
}

export function forgetHistory(path: string) {
  setSetting('history.items', JSON.stringify(readHistory().filter((i) => i.path !== path)));
}
