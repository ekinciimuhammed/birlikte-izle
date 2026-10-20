// Altyazı okuma: SRT, WebVTT, ASS/SSA → zamanlı satırlar.
// Metin içinde sadece <i>, <b>, <u> biçimleri korunur; gerisi temizlenir.

export interface Cue {
  start: number; // saniye
  end: number;
  text: string;
}

/**
 * Baytları metne çevirir. Türkçe altyazıların çoğu eski Windows-1254 kodlamasıyla gelir;
 * önce UTF-8 dener, geçersizse 1254'e düşer. Böylece "ş, ğ, ı, İ" bozulmaz.
 */
export function decodeText(bytes: Uint8Array): string {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const body = bytes.subarray(start);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1254').decode(body);
  }
}

export function parseSubtitles(raw: string): Cue[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = /^\s*WEBVTT/.test(text)
    ? parseTimedBlocks(text)
    : /^\s*\[Script Info\]/im.test(text) || /^Dialogue:/m.test(text)
      ? parseAss(text)
      : parseTimedBlocks(text);
  return cues.filter((c) => c.end > c.start && c.text.trim()).sort((a, b) => a.start - b.start);
}

// --- SRT ve WebVTT ------------------------------------------------------------------------------

const TIME = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})`;
const TIMING = new RegExp(`${TIME}\\s*-->\\s*${TIME}`);

function parseTimedBlocks(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue;
    const m = TIMING.exec(lines[at]!)!;
    cues.push({
      start: toSeconds(m[1], m[2]!, m[3]!, m[4]!),
      end: toSeconds(m[5], m[6]!, m[7]!, m[8]!),
      text: cleanMarkup(lines.slice(at + 1).join('\n')),
    });
  }
  return cues;
}

function toSeconds(h: string | undefined, m: string, s: string, frac: string) {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(frac.padEnd(3, '0')) / 1000;
}

/** <i>/<b>/<u> kalır; <font>, {\an8}, VTT ses etiketleri vb. temizlenir. */
function cleanMarkup(s: string) {
  return s
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(\/?)([ibu])(?:\.[^>]*)?>/gi, '\u0001$1$2\u0002')
    .replace(/<[^>]*>/g, '')
    .replace(/\u0001(\/?)([ibu])\u0002/gi, (_, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}>`)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// --- ASS / SSA -------------------------------------------------------------------------------------

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let format: string[] = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let inEvents = false;
  for (const line of text.split('\n')) {
    if (/^\[.*\]\s*$/.test(line)) {
      inEvents = /^\[events\]/i.test(line.trim());
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      format = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    const parts = line.slice(9).split(',');
    const textAt = format.indexOf('text');
    const fields = [...parts.slice(0, textAt), parts.slice(textAt).join(',')];
    const get = (name: string) => fields[format.indexOf(name)]?.trim() ?? '';
    const start = assTime(get('start'));
    const end = assTime(get('end'));
    if (start == null || end == null) continue;
    const body = fields[textAt] ?? '';
    // {\i1}…{\i0} italik olarak kalsın; diğer biçim komutları temizlenir.
    const cleaned = body
      .replace(/\{[^}]*\\i1[^}]*\}/g, '<i>')
      .replace(/\{[^}]*\\i0[^}]*\}/g, '</i>')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    // Çizim komutları (\p1) metin değildir.
    if (/\\p[1-9]/.test(body)) continue;
    cues.push({ start, end, text: cleaned });
  }
  return cues;
}

function assTime(s: string) {
  const m = /(\d+):(\d{2}):(\d{2})[.:](\d{1,3})/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0').slice(0, 3)) / 1000;
}

// --- Arama -------------------------------------------------------------------------------------------

/** t anında görünen satırlar (sıralı dizide ikili arama). */
export function activeCues(cues: Cue[], t: number): Cue[] {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: Cue[] = [];
  // Üst üste binen satırlar için geriye doğru kısa bir tarama yeter.
  for (let i = lo - 1; i >= 0 && i >= lo - 8; i--) {
    const c = cues[i]!;
    if (c.end > t) out.unshift(c);
  }
  return out;
}
