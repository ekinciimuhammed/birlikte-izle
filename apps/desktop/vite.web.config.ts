// Arayüzü Electron olmadan, düz tarayıcıda çalıştırır (geliştirme ve otomatik test için).
// Ayarlar bu modda tarayıcının localStorage'ında tutulur.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  // MediaPipe modeli (kamera arka planı)
  assetsInclude: ['**/*.tflite'],
  server: { port: 5199, strictPort: true },
  build: { outDir: '../../out/web', emptyOutDir: true },
});
