// macOS'ta üst menü çubuğu her zaman görünür ve kısayollar (⌘C, ⌘V, ⌘Q, ⌃⌘F) ondan çalışır:
// sade, Türkçe bir menü. Windows ve Linux'ta pencere çerçevesiz; kurulu sürümde menü hiç yok
// (geliştirirken Electron'un kendi menüsü kalır: yenile, geliştirici araçları).

import { app, Menu } from 'electron';

const NAME = 'Birlikte İzle';

export function setupMenu() {
  if (process.platform !== 'darwin') {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: NAME,
        submenu: [
          { role: 'about', label: `${NAME} Hakkında` },
          { type: 'separator' },
          { role: 'hide', label: `${NAME}'yi Gizle` },
          { role: 'hideOthers', label: 'Diğerlerini Gizle' },
          { role: 'unhide', label: 'Tümünü Göster' },
          { type: 'separator' },
          { role: 'quit', label: `${NAME}'den Çık` },
        ],
      },
      {
        label: 'Düzen',
        submenu: [
          { role: 'undo', label: 'Geri Al' },
          { role: 'redo', label: 'Yinele' },
          { type: 'separator' },
          { role: 'cut', label: 'Kes' },
          { role: 'copy', label: 'Kopyala' },
          { role: 'paste', label: 'Yapıştır' },
          { role: 'selectAll', label: 'Tümünü Seç' },
        ],
      },
      {
        label: 'Görünüm',
        submenu: [{ role: 'togglefullscreen', label: 'Tam Ekran' }],
      },
      {
        label: 'Pencere',
        submenu: [
          { role: 'minimize', label: 'Küçült' },
          { role: 'zoom', label: 'Büyüt' },
          { type: 'separator' },
          { role: 'close', label: 'Kapat' },
        ],
      },
    ]),
  );
  app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: app.getVersion() });
}
