import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// Üretim derlemesinde sayfaya sıkı bir İçerik Güvenliği Politikası ekler.
// (Geliştirmede Vite'ın anında yenileme betikleri için eklenmez.)
const CSP = [
  "default-src 'self'",
  // wasm-unsafe-eval: kamera arka planı için MediaPipe (WebAssembly)
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // birlikte-media: ana sürecin sunduğu (gerekirse ffmpeg ile dönüştürülmüş) film dosyaları
  "media-src 'self' blob: mediastream: birlikte-media:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  // YouTube aracı sayfası (yt.html) sinyal sunucusundan çerçevede açılır
  "frame-src https: http://localhost:* http://127.0.0.1:*",
].join('; ');

function productionCsp(): Plugin {
  return {
    name: 'birlikte-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), productionCsp()],
    // MediaPipe modeli (kamera arka planı)
    assetsInclude: ['**/*.tflite'],
    build: { minify: true },
  },
});
