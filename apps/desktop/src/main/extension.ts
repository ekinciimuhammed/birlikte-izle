// Tarayıcı eklentisi köprüsü: Netflix, Disney+, Prime… tarayıcıda oynar; eklenti oradaki oynatıcıyı
// bu uygulamaya bağlar. Bağlantı sadece bu bilgisayardan (127.0.0.1) ve sadece Birlikte İzle
// eklentisinden kabul edilir (tarayıcı, eklentinin kimliğini Origin başlığında gönderir; web
// sayfaları bunu taklit edemez).

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

/** manifest.json'daki "key"den türeyen sabit kimlik (paketlenmemiş yüklemede de aynı kalır) */
export const EXTENSION_ID = 'gpomfkpiinekndjakgfebfpfaigoijfp';
const PORTS = [47652, 47653, 47654];

export interface ExtensionStatus {
  connected: boolean;
  browser: string | null;
  /** Bağlanan eklentinin sürümü (eski kopya mı?) */
  version: string | null;
  /** Uygulamanın içindeki eklentinin sürümü */
  latest: string | null;
}

export function setupExtensionBridge(getWin: () => BrowserWindow | null) {
  // Mağazadan kurulan sürümün kimliği farklı olur: BIRLIKTE_EXT_IDS ile eklenebilir.
  const allowed = new Set(
    [EXTENSION_ID, ...(process.env['BIRLIKTE_EXT_IDS'] ?? '').split(',')].filter(Boolean).map((id) => `chrome-extension://${id.trim()}`),
  );
  let client: WebSocket | null = null;
  const latest = bundledVersion();
  let status: ExtensionStatus = { connected: false, browser: null, version: null, latest };
  let port = 0;

  const toRenderer = (channel: string, payload: unknown) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const setStatus = (next: ExtensionStatus) => {
    status = next;
    toRenderer('ext:status', status);
  };

  const listen = (ports: number[]) => {
    const [first, ...rest] = ports;
    if (first == null) return console.warn('Eklenti köprüsü açılamadı: kapılar dolu');
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: first,
      maxPayload: 64 * 1024,
      verifyClient: ({ origin }: { origin: string }) => allowed.has(origin),
    });
    wss.on('error', (err: NodeJS.ErrnoException) => {
      // Aynı bilgisayarda ikinci bir kopya (deneme profili) varsa bir sonraki kapı
      if (err.code === 'EADDRINUSE') listen(rest);
      else console.warn('Eklenti köprüsü', err);
    });
    wss.on('listening', () => (port = first));
    wss.on('connection', (sock) => {
      client?.close(4000, 'yenisi geldi');
      client = sock;
      setStatus({ connected: true, browser: null, version: null, latest });
      const ping = setInterval(() => sock.send(JSON.stringify({ t: 'ping' })), 20_000);
      sock.on('message', (data) => {
        let msg: { t?: unknown; browser?: unknown; version?: unknown };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof msg?.t !== 'string' || msg.t === 'pong') return;
        if (msg.t === 'hello') {
          setStatus({
            connected: true,
            browser: typeof msg.browser === 'string' ? msg.browser.slice(0, 30) : null,
            version: typeof msg.version === 'string' ? msg.version.slice(0, 20) : null,
            latest,
          });
        }
        toRenderer('ext:message', msg);
      });
      sock.on('close', () => {
        clearInterval(ping);
        if (client !== sock) return;
        client = null;
        setStatus({ connected: false, browser: null, version: null, latest });
      });
    });
  };
  // Test ve ikinci profil için kapı seçilebilir.
  const fixed = Number(process.env['BIRLIKTE_EXT_PORT']);
  listen(fixed ? [fixed] : PORTS);

  ipcMain.on('ext:send', (_e, msg: unknown) => {
    if (client && msg && typeof msg === 'object') client.send(JSON.stringify(msg));
  });
  ipcMain.handle('ext:status', () => status);
  ipcMain.handle('ext:port', () => port);
  ipcMain.handle('ext:reveal', () => {
    const dir = extensionDir();
    if (dir) shell.openPath(dir);
    return dir;
  });
}

function bundledVersion(): string | null {
  const dir = extensionDir();
  try {
    const version = dir && JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Eklenti klasörü: kurulu uygulamada resources/extension, geliştirirken apps/extension */
function extensionDir() {
  const dirs = [join(process.resourcesPath, 'extension'), join(app.getAppPath(), '..', 'extension')];
  return dirs.find((d) => existsSync(join(d, 'manifest.json'))) ?? null;
}
