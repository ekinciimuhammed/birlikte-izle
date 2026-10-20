import { app, BrowserWindow, ipcMain, nativeTheme, screen, session, shell, systemPreferences } from 'electron';
import { join } from 'node:path';
import { isEmbeddable, WEB_PARTITION } from '../shared/web';
import { setupExtensionBridge } from './extension';
import { registerMediaScheme, setupMedia } from './media';
import { setupMenu } from './menu';
import { SettingsFile } from './settings-file';
import { setupUpdater } from './updater';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// Ayrı profil (ör. BIRLIKTE_PROFILE=ikinci): aynı bilgisayarda ikinci bir kopya açıp
// kendinle eşleşerek deneyebilirsin. Her profilin ayarları ayrı klasörde durur.
const profile = process.env['BIRLIKTE_PROFILE'];
if (profile) app.setPath('userData', join(app.getPath('appData'), `Birlikte İzle (${profile})`));

// Profil başına tek pencere: ikinci kez açılırsa mevcut pencere öne gelir.
if (!app.requestSingleInstanceLock()) app.quit();

registerMediaScheme();

let win: BrowserWindow | null = null;
let quitting = false; // ⌘Q / Çıkış: pencere kapanışı bekletilince çıkış yeniden istenir
app.on('before-quit', () => (quitting = true));
let settings: SettingsFile;

/**
 * Otomatik testte pencereler kullanıcının ana ekranına çıkmasın: ikinci monitör varsa orada
 * yan yana (A solda, B sağda) açılır. BIRLIKTE_TEST_SLOT: 0 ya da 1.
 */
function testBounds() {
  const primary = screen.getPrimaryDisplay();
  const target = screen.getAllDisplays().find((d) => d.id !== primary.id) ?? primary;
  const { x, y, width, height } = target.workArea;
  const slot = Number(process.env['BIRLIKTE_TEST_SLOT'] ?? 0);
  const w = Math.max(900, Math.floor(width / 2));
  return { x: x + Math.min(slot * w, width - w), y, width: w, height: Math.min(800, height) };
}

function createWindow() {
  nativeTheme.themeSource = 'dark';

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(process.env['BIRLIKTE_TEST'] && testBounds()),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Birlikte İzle',
    backgroundColor: '#000000',
    titleBarStyle: 'hidden',
    ...(isWin && { titleBarOverlay: { color: '#000000', symbolColor: '#f5f5f7', height: 44 } }),
    ...(isMac && { trafficLightPosition: { x: 16, y: 16 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Film yayını pencere arkada ya da küçültülmüşken de kesilmemeli.
      backgroundThrottling: false,
      // Kanallar ve YouTube uygulamanın içinde (gömülü sayfa) açılır; aşağıda sıkı kurallarla.
      webviewTag: true,
    },
  });

  // Gömülü sayfa: sadece izin verilen siteler, kendi oynatıcı betiğimizle, Node erişimi olmadan.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const local = process.env['BIRLIKTE_EMBED_LOCAL'] === '1'; // uygulama içi izleme testi
    if (params.src !== 'about:blank' && !isEmbeddable(params.src, local)) return event.preventDefault();
    webPreferences.preload = join(__dirname, '../preload/web.js');
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false;
    params.partition = WEB_PARTITION;
  });

  // Otomatik testte pencereler odağı çalmasın (kullanıcının klavyesi teste karışmasın).
  win.once('ready-to-show', () => (process.env['BIRLIKTE_TEST'] ? win?.showInactive() : win?.show()));
  win.on('closed', () => (win = null));
  // Kapanırken karşı tarafa "görüşürüz" gidebilsin diye pencere çeyrek saniye bekler
  // (o "uygulamayı kapattı" görür, "bağlantı koptu" değil).
  let farewell = false;
  win.on('close', (event) => {
    if (farewell || !win) return;
    farewell = true;
    event.preventDefault();
    win.webContents.send('app:closing');
    setTimeout(() => (quitting ? app.quit() : win?.close()), 250);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) win.loadURL(devUrl);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  settings = new SettingsFile(join(app.getPath('userData'), 'ayarlar.json'));

  // Sadece kamera/mikrofon, tam ekran ve panoya yazma izinleri verilir.
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler(async (_wc, permission, done, details) => {
    if (!allowed.has(permission)) return done(false);
    // macOS: kamera/mikrofon için sistemin kendi izin penceresi
    if (isMac && permission === 'media' && 'mediaTypes' in details) {
      const types = details.mediaTypes ?? [];
      const ok = await Promise.all([
        types.includes('video') ? systemPreferences.askForMediaAccess('camera') : true,
        types.includes('audio') ? systemPreferences.askForMediaAccess('microphone') : true,
      ]);
      return done(ok.every(Boolean));
    }
    done(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  setupWebSession();

  ipcMain.handle('settings:load', () => settings.load());
  ipcMain.handle('settings:save', (_e, values: unknown) => settings.save(values));
  ipcMain.handle('app:version', () => app.getVersion());

  setupMenu();
  setupMedia();
  setupExtensionBridge(() => win);
  setupUpdater(() => win);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Gömülü sayfaların oturumu: sadece tam ekran izni; tarayıcı kimliği düz Chrome (bazı siteler Electron'u reddediyor) */
function setupWebSession() {
  const web = session.fromPartition(WEB_PARTITION);
  web.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen'));
  web.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');
  web.setUserAgent(
    web
      .getUserAgent()
      .replace(/\(KHTML, like Gecko\) .*?Chrome\//, '(KHTML, like Gecko) Chrome/')
      .replace(/ Electron\/\S+/, ''),
  );
}

// Gömülü sayfalar yeni pencere açamaz (reklam açılır pencereleri); bağlantılar sayfanın içinde kalır.
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:/.test(url)) event.preventDefault();
  });
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
