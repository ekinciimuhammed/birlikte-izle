/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Derlemede gömülecek sinyal sunucusu adresi (ör. https://birlikte-izle-signal.….workers.dev) */
  readonly VITE_SIGNAL_URL?: string;
}

// Chromium'da var, TypeScript'in DOM tanımlarında henüz yok.
interface HTMLMediaElement {
  captureStream(): MediaStream;
}
