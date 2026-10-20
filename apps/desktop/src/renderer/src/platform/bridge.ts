// Electron'da preload'ın açtığı köprüyü, düz tarayıcıda localStorage'ı kullanır.
// Böylece arayüz iki ortamda da aynı kodla çalışır. Tarayıcıda ffmpeg yoktur:
// medya ve güncelleme köprüleri sadece Electron'da bulunur.

import type { AudioMode, FileRef, MediaInfo, PrepareProgress, SubtitleSource } from '../../../shared/media';

export interface MediaBridge {
  openDialog(): Promise<MediaInfo | null>;
  openPath(path: string): Promise<MediaInfo>;
  pathForFile(file: File): string;
  prepare(id: string, audio: number, mode: AudioMode): Promise<string>;
  cancel(id: string): Promise<void>;
  subtitles(id: string): Promise<SubtitleSource[]>;
  onProgress(fn: (p: PrepareProgress) => void): () => void;
  find(ref: FileRef, dirs: string[]): Promise<MediaInfo | null>;
  read(id: string, offset: number, length: number): Promise<Uint8Array>;
  receive: {
    begin(ref: FileRef): Promise<{ offset: number }>;
    chunk(fingerprint: string, chunk: Uint8Array): void;
    finish(fingerprint: string): Promise<MediaInfo>;
    abort(fingerprint: string): Promise<void>;
  };
}

export interface ExtensionStatus {
  connected: boolean;
  browser: string | null;
}

export interface ExtensionBridge {
  status(): Promise<ExtensionStatus>;
  onStatus(fn: (s: ExtensionStatus) => void): () => void;
  onMessage(fn: (msg: Record<string, unknown>) => void): () => void;
  send(msg: Record<string, unknown>): void;
  reveal(): Promise<string | null>;
}

export interface Bridge {
  platform: string;
  testMode?: boolean;
  version?(): Promise<string>;
  settings: {
    load(): Promise<Record<string, unknown>>;
    save(values: Record<string, unknown>): Promise<void>;
  };
  media?: MediaBridge;
  extension?: ExtensionBridge;
  updates?: {
    onReady(fn: (version: string) => void): () => void;
    install(): Promise<void>;
  };
}

declare global {
  interface Window {
    birlikte?: Bridge;
  }
}

const STORAGE_KEY = 'birlikte-izle:ayarlar';

const webBridge: Bridge = {
  platform: 'web',
  settings: {
    async load() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      } catch {
        return {};
      }
    },
    async save(values) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      } catch {
        // Gizli pencere vb.: ayarlar bu oturumla sınırlı kalır.
      }
    },
  },
};

export const bridge: Bridge = window.birlikte ?? webBridge;
export const platform = bridge.platform;
export const isDesktop = platform !== 'web';
