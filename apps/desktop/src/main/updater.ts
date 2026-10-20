// Otomatik güncelleme (GitHub Releases). Sadece kurulu sürümde ve yayın ayarı yapılmış
// derlemelerde çalışır; arka planda indirir, hazır olunca arayüze haber verir.
// Not: macOS'ta güncelleme için uygulamanın imzalı olması gerekir.

import { app, ipcMain, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

export function setupUpdater(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
  // Yayın ayarı olmadan derlenmiş pakette güncelleme bilgisi yoktur: hiç deneme.
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => getWindow()?.webContents.send('update:ready', info.version));
  autoUpdater.on('error', (err) => console.warn('Güncelleme denetlenemedi:', err.message));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}
