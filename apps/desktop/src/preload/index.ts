// Arayüze açılan tek kapı: sadece burada tanımlanan işlevler kullanılabilir.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AudioMode, FileRef, MediaInfo, PrepareProgress, SubtitleSource } from '../shared/media';

contextBridge.exposeInMainWorld('birlikte', {
  platform: process.platform,
  testMode: process.env['BIRLIKTE_TEST'] === '1',
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  settings: {
    load: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:load'),
    save: (values: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('settings:save', values),
  },
  media: {
    openDialog: (): Promise<MediaInfo | null> => ipcRenderer.invoke('media:open-dialog'),
    openPath: (path: string): Promise<MediaInfo> => ipcRenderer.invoke('media:open-path', path),
    /** Sürükle-bırak ile gelen dosyanın diskteki yolu */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    prepare: (id: string, audio: number, mode: AudioMode): Promise<string> =>
      ipcRenderer.invoke('media:prepare', id, audio, mode),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('media:cancel', id),
    subtitles: (id: string): Promise<SubtitleSource[]> => ipcRenderer.invoke('media:subtitles', id),
    /** Karşının açtığı dosya bende var mı? (senkron mod) */
    find: (ref: FileRef, dirs: string[]): Promise<MediaInfo | null> => ipcRenderer.invoke('media:find', ref, dirs),
    read: (id: string, offset: number, length: number): Promise<Uint8Array> =>
      ipcRenderer.invoke('media:read', id, offset, length),
    receive: {
      begin: (ref: FileRef): Promise<{ offset: number }> => ipcRenderer.invoke('transfer:begin', ref),
      // Sırayla yazılır; her parça için cevap beklemeyiz (hız için).
      chunk: (fingerprint: string, chunk: Uint8Array) => ipcRenderer.send('transfer:chunk', fingerprint, chunk),
      finish: (fingerprint: string): Promise<MediaInfo> => ipcRenderer.invoke('transfer:finish', fingerprint),
      abort: (fingerprint: string): Promise<void> => ipcRenderer.invoke('transfer:abort', fingerprint),
    },
    onProgress: (fn: (p: PrepareProgress) => void) => {
      const handler = (_e: unknown, p: PrepareProgress) => fn(p);
      ipcRenderer.on('media:progress', handler);
      return () => ipcRenderer.removeListener('media:progress', handler);
    },
  },
  /** Tarayıcı eklentisi (Netflix vb. tarayıcıda oynar, kontrol buradan) */
  extension: {
    status: (): Promise<{ connected: boolean; browser: string | null }> => ipcRenderer.invoke('ext:status'),
    onStatus: (fn: (s: { connected: boolean; browser: string | null }) => void) => {
      const handler = (_e: unknown, s: { connected: boolean; browser: string | null }) => fn(s);
      ipcRenderer.on('ext:status', handler);
      return () => ipcRenderer.removeListener('ext:status', handler);
    },
    onMessage: (fn: (msg: Record<string, unknown>) => void) => {
      const handler = (_e: unknown, msg: Record<string, unknown>) => fn(msg);
      ipcRenderer.on('ext:message', handler);
      return () => ipcRenderer.removeListener('ext:message', handler);
    },
    send: (msg: Record<string, unknown>) => ipcRenderer.send('ext:send', msg),
    /** Eklenti klasörünü aç ("Paketlenmemiş öğe yükle" için) */
    reveal: (): Promise<string | null> => ipcRenderer.invoke('ext:reveal'),
  },
  updates: {
    onReady: (fn: (version: string) => void) => {
      const handler = (_e: unknown, v: string) => fn(v);
      ipcRenderer.on('update:ready', handler);
      return () => ipcRenderer.removeListener('update:ready', handler);
    },
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
  },
});
