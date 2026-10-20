// Çizgi simgeler (24×24). Birkaçı Lucide'den (ISC lisansı) uyarlandı.

const filled = 'fill="currentColor" stroke="none"';
const skipText = (n) =>
  `<text x="12" y="15.4" text-anchor="middle" font-size="7.2" font-weight="700" ${filled} font-family="system-ui, sans-serif">${n}</text>`;
const speaker =
  '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/>';
const mic =
  '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>';
const video =
  '<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>';
const slash = '<path d="M3 3l18 18"/>';

const PATHS = {
  play: () =>
    `<path ${filled} d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.79-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z"/>`,
  pause: () =>
    `<rect ${filled} x="6" y="4.5" width="4" height="15" rx="1.3"/><rect ${filled} x="14" y="4.5" width="4" height="15" rx="1.3"/>`,
  back: (n = 10) => `<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3"/><path d="M3 3.5v4.8h4.8"/>${skipText(n)}`,
  forward: (n = 10) => `<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8.3"/><path d="M21 3.5v4.8h-4.8"/>${skipText(n)}`,
  volume: () => `${speaker}<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>`,
  volumeOff: () => `${speaker}<path d="M22 9l-6 6"/><path d="M16 9l6 6"/>`,
  mic: () => mic,
  micOff: () => mic + slash,
  video: () => video,
  videoOff: () => video + slash,
  maximize: () =>
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  minimize: () =>
    '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  folder: () =>
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  activity: () => '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  sliders: () =>
    '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  heart: () =>
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  heartFilled: () =>
    `<path ${filled} d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>`,
  link: () =>
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

export function icon(name, arg) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name](arg)}</svg>`;
}

export function setIcon(el, name, arg) {
  const id = `${name}:${arg ?? ''}`;
  if (el.dataset.rendered === id) return;
  el.dataset.rendered = id;
  el.innerHTML = icon(name, arg);
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => setIcon(el, el.dataset.icon));
}
