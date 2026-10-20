// Kurulum dosyaları: Windows (NSIS), macOS (dmg + zip), Linux (AppImage + deb).
// Her platform kendi makinesinde derlenir (GitHub Actions: .github/workflows/surum.yml);
// ffmpeg o platformun sürümüyle uygulamanın içine konur.
//
// Otomatik güncelleme için GitHub deposu: BIRLIKTE_GH_OWNER (+ BIRLIKTE_GH_REPO) ortam
// değişkenleri verilirse yayın ayarı eklenir; verilmezse güncelleme kapalı derlenir.

const owner = process.env.BIRLIKTE_GH_OWNER;
const repo = process.env.BIRLIKTE_GH_REPO || 'birlikte-izle';
const ffmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.birlikteizle.app',
  productName: 'Birlikte İzle',
  executableName: 'birlikte-izle',
  artifactName: 'Birlikte-Izle-${version}-${os}-${arch}.${ext}',
  electronVersion: require('electron/package.json').version,
  directories: { output: 'release', buildResources: 'build' },
  files: ['out/**/*', 'package.json'],
  extraResources: [
    { from: `../../node_modules/ffmpeg-static/${ffmpeg}`, to: `bin/${ffmpeg}` },
    // Tarayıcı eklentisi: Ayarlar → Tarayıcı eklentisi → "Klasörü aç" ile yüklenir
    { from: '../extension', to: 'extension', filter: ['**/*', '!package.json'] },
  ],
  asar: true,
  npmRebuild: false,

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    shortcutName: 'Birlikte İzle',
    uninstallDisplayName: 'Birlikte İzle',
    artifactName: 'Birlikte-Izle-Kurulum-${version}.${ext}',
  },

  mac: {
    target: [{ target: 'dmg' }, { target: 'zip' }],
    category: 'public.app-category.entertainment',
    icon: 'build/icon.png',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Apple Developer sertifikası yoksa "ad-hoc" imza: Apple Silicon'da açılabilmesi için gerekli.
    identity: process.env.CSC_LINK ? undefined : '-',
    extendInfo: {
      NSCameraUsageDescription: 'Birlikte izlerken birbirinizi görebilmeniz için.',
      NSMicrophoneUsageDescription: 'Birlikte izlerken konuşabilmeniz için.',
    },
  },
  dmg: { title: 'Birlikte İzle' },

  linux: {
    target: ['AppImage', 'deb'],
    category: 'AudioVideo',
    icon: 'build/icon.png',
    synopsis: 'Uzakta olsanız da yan yana gibi.',
    maintainer: 'Birlikte İzle',
  },

  publish: owner ? [{ provider: 'github', owner, repo, releaseType: 'release' }] : null,
};
