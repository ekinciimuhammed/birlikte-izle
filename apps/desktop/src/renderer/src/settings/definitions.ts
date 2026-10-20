// Uygulamanın bütün ayarları. Ayarlar ekranı bu listeden otomatik çizilir:
// grup → kutu (section) → satır. Sıra burada nasılsa ekranda da öyledir.

import { defineSetting } from './registry';

// Web sürümü sinyal sunucusuyla aynı adresten sunulur: orada varsayılan, sayfanın kendi adresidir.
export const DEFAULT_SERVER: string =
  import.meta.env.VITE_SIGNAL_URL ??
  (!window.birlikte && import.meta.env.PROD ? location.origin : 'http://localhost:8787');

export const ACCENTS = [
  { value: 'pink', label: 'Pembe', color: '#ff375f' },
  { value: 'blue', label: 'Mavi', color: '#0a84ff' },
  { value: 'purple', label: 'Mor', color: '#bf5af2' },
  { value: 'orange', label: 'Turuncu', color: '#ff9f0a' },
  { value: 'green', label: 'Yeşil', color: '#30d158' },
] as const;

export const SETTINGS = {
  // --- Genel ---------------------------------------------------------------
  'profile.name': defineSetting({
    group: 'general',
    section: 'Profil',
    label: 'Adın',
    control: { type: 'text', placeholder: 'Adın', maxLength: 32 },
    default: '',
  }),
  'profile.partnerNickname': defineSetting({
    group: 'general',
    section: 'Profil',
    label: 'Onun lakabı',
    footer: 'Boş bırakırsan kendi adı görünür. Lakap sadece sende görünür.',
    control: { type: 'text', placeholder: 'Ör. Aşkım', maxLength: 32 },
    default: '',
  }),
  'appearance.accent': defineSetting({
    group: 'general',
    section: 'Görünüm',
    label: 'Vurgu rengi',
    control: { type: 'accent', options: ACCENTS },
    default: 'pink',
  }),

  // --- Oynatma -------------------------------------------------------------
  'playback.control': defineSetting({
    group: 'playback',
    section: 'Kontrol',
    label: 'Kim kontrol edebilir',
    footer: 'Filmi paylaşan tarafın ayarı geçerlidir.',
    control: {
      type: 'segmented',
      options: [
        { value: 'both', label: 'İkimiz de' },
        { value: 'host', label: 'Sadece paylaşan' },
      ],
    },
    default: 'both',
  }),
  'playback.skip': defineSetting({
    group: 'playback',
    section: 'Kontrol',
    label: 'İleri / geri atlama',
    control: {
      type: 'select',
      options: [
        { value: 5, label: '5 sn' },
        { value: 10, label: '10 sn' },
        { value: 15, label: '15 sn' },
        { value: 30, label: '30 sn' },
      ],
    },
    default: 10,
  }),
  'media.audioLanguage': defineSetting({
    group: 'playback',
    section: 'Dil',
    label: 'Tercih edilen ses',
    footer: 'Dosyada birden çok ses varsa (ör. Türkçe dublaj ve orijinal) hangisiyle başlansın.',
    control: {
      type: 'select',
      options: [
        { value: 'auto', label: 'Dosyanın varsayılanı' },
        { value: 'tur', label: 'Türkçe' },
        { value: 'eng', label: 'İngilizce' },
        { value: 'original', label: 'Orijinal (ilk ses)' },
      ],
    },
    default: 'auto',
  }),
  'playback.pauseOnDisconnect': defineSetting({
    group: 'playback',
    section: 'Bağlantı koparsa',
    label: 'Filmi durdur',
    footer: 'Bağlantı geri gelince kaldığınız yerden devam edersiniz.',
    control: { type: 'toggle' },
    default: true,
  }),
  'sync.auto': defineSetting({
    group: 'playback',
    section: 'Kayıpsız izleme',
    label: 'Bende de varsa kendi kopyamdan oynat',
    control: { type: 'toggle' },
    default: true,
    visibleIf: () => !!window.birlikte,
  }),
  'transfer.autoAccept': defineSetting({
    group: 'playback',
    section: 'Kayıpsız izleme',
    label: 'Gönderdiği bölümleri kabul et',
    footer:
      'Aynı dosya bu bilgisayarda da varsa (İndirilenler ya da daha önce açtığın klasörler) yayın yerine kendi kopyandan, tam kalitede ve senkron izlersin. Gönderdiği bölümler İndirilenler › Birlikte İzle klasörüne kaydedilir.',
    control: { type: 'toggle' },
    default: true,
    visibleIf: () => !!window.birlikte,
  }),

  // --- Görüntü (yayın) -----------------------------------------------------
  'video.maxBitrate': defineSetting({
    group: 'video',
    section: 'Yayın',
    label: 'En yüksek bit hızı',
    control: {
      type: 'select',
      options: [
        { value: 2, label: '2 Mbps' },
        { value: 4, label: '4 Mbps' },
        { value: 6, label: '6 Mbps' },
        { value: 8, label: '8 Mbps' },
        { value: 12, label: '12 Mbps' },
        { value: 16, label: '16 Mbps' },
      ],
    },
    default: 8,
  }),
  'video.priority': defineSetting({
    group: 'video',
    section: 'Yayın',
    label: 'Öncelik',
    footer: 'Akıcılık: hareketli sahnelerde kare atlamaz. Netlik: bağlantı daralınca çözünürlüğü korur.',
    control: {
      type: 'segmented',
      options: [
        { value: 'motion', label: 'Akıcılık' },
        { value: 'detail', label: 'Netlik' },
      ],
    },
    default: 'motion',
  }),
  'video.codec': defineSetting({
    group: 'video',
    section: 'Kodlama',
    label: 'Codec',
    footer: 'İkinizde de aynı olur. Otomatik çoğu durumda en iyisidir.',
    advanced: true,
    shared: true,
    control: {
      type: 'select',
      options: [
        { value: 'auto', label: 'Otomatik' },
        { value: 'vp9', label: 'VP9' },
        { value: 'h264', label: 'H.264' },
        { value: 'av1', label: 'AV1' },
      ],
    },
    default: 'auto',
  }),

  // --- Ses -----------------------------------------------------------------
  'audio.movieQuality': defineSetting({
    group: 'audio',
    section: 'Film sesi',
    label: 'Kalite',
    footer: 'Film sesi işlenmeden, stereo gönderilir.',
    control: {
      type: 'select',
      options: [
        { value: 96, label: 'Standart' },
        { value: 192, label: 'Yüksek' },
        { value: 256, label: 'En yüksek' },
      ],
    },
    default: 192,
  }),
  'audio.ducking': defineSetting({
    group: 'audio',
    section: 'O konuşunca',
    label: 'Filmin sesini kıs',
    control: { type: 'toggle' },
    default: true,
  }),
  'audio.duckingLevel': defineSetting({
    group: 'audio',
    section: 'O konuşunca',
    label: 'Ne kadar kısılsın',
    footer: 'Sadece senin duyduğun ses kısılır; onun duyduğu film sesi değişmez.',
    control: {
      type: 'segmented',
      options: [
        { value: 55, label: 'Az' },
        { value: 35, label: 'Orta' },
        { value: 20, label: 'Çok' },
      ],
    },
    default: 35,
    visibleIf: (v) => v['audio.ducking'] === true,
  }),
  'audio.echoCancellation': defineSetting({
    group: 'audio',
    section: 'Mikrofon',
    label: 'Yankı engelleme',
    control: { type: 'toggle' },
    default: true,
  }),
  'audio.noiseSuppression': defineSetting({
    group: 'audio',
    section: 'Mikrofon',
    label: 'Gürültü bastırma',
    footer: 'İkiniz de kulaklık takıyorsanız yankı engellemeyi kapatmak sesinizi daha doğal yapar.',
    control: { type: 'toggle' },
    default: true,
  }),

  // --- Kamera --------------------------------------------------------------
  'camera.startOn': defineSetting({
    group: 'camera',
    section: 'İzlemeye başlarken',
    label: 'Kamera açık olsun',
    control: { type: 'toggle' },
    default: true,
  }),
  'camera.micStartOn': defineSetting({
    group: 'camera',
    section: 'İzlemeye başlarken',
    label: 'Mikrofon açık olsun',
    control: { type: 'toggle' },
    default: true,
  }),
  'camera.resolution': defineSetting({
    group: 'camera',
    section: 'Görüntü',
    label: 'Çözünürlük',
    control: {
      type: 'select',
      options: [
        { value: 360, label: '360p' },
        { value: 540, label: '540p' },
        { value: 720, label: '720p' },
      ],
    },
    default: 540,
  }),
  'camera.mirror': defineSetting({
    group: 'camera',
    section: 'Görüntü',
    label: 'Kendimi ayna gibi göster',
    control: { type: 'toggle' },
    default: true,
  }),
  'camera.bubbleSize': defineSetting({
    group: 'camera',
    section: 'Görüntü',
    label: 'Baloncuk boyutu',
    control: {
      type: 'segmented',
      options: [
        { value: 'small', label: 'Küçük' },
        { value: 'medium', label: 'Orta' },
        { value: 'large', label: 'Büyük' },
      ],
    },
    default: 'medium',
  }),
  'camera.background': defineSetting({
    group: 'camera',
    section: 'Arka plan',
    label: 'Arkamı bulanıklaştır',
    footer: 'Arkandaki oda bulanık görünür, sen net kalırsın. Bu bilgisayarda işlenir; görüntü hiçbir yere gönderilmez.',
    control: {
      type: 'segmented',
      options: [
        { value: 'none', label: 'Kapalı' },
        { value: 'light', label: 'Hafif' },
        { value: 'strong', label: 'Güçlü' },
      ],
    },
    default: 'none',
  }),

  // --- Altyazı --------------------------------------------------------------
  'subtitles.language': defineSetting({
    group: 'subtitles',
    section: 'Başlangıç',
    label: 'Varsayılan altyazı',
    footer: 'Altyazılar dosyanın yanındaki .srt/.ass/.vtt dosyalarından ve MKV içinden kendiliğinden bulunur.',
    control: {
      type: 'select',
      options: [
        { value: 'auto', label: 'Türkçe varsa Türkçe' },
        { value: 'tur', label: 'Sadece Türkçe' },
        { value: 'eng', label: 'Sadece İngilizce' },
        { value: 'off', label: 'Kapalı başlasın' },
      ],
    },
    default: 'auto',
  }),
  'subtitles.size': defineSetting({
    group: 'subtitles',
    section: 'Görünüm',
    label: 'Boyut',
    control: {
      type: 'segmented',
      options: [
        { value: 's', label: 'Küçük' },
        { value: 'm', label: 'Orta' },
        { value: 'l', label: 'Büyük' },
        { value: 'xl', label: 'Çok büyük' },
      ],
    },
    default: 'm',
  }),
  'subtitles.color': defineSetting({
    group: 'subtitles',
    section: 'Görünüm',
    label: 'Renk',
    control: {
      type: 'segmented',
      options: [
        { value: 'white', label: 'Beyaz' },
        { value: 'yellow', label: 'Sarı' },
      ],
    },
    default: 'white',
  }),
  'subtitles.style': defineSetting({
    group: 'subtitles',
    section: 'Görünüm',
    label: 'Arka plan',
    footer: 'Görünüm sadece sende değişir; o kendi ayarını yapar. Zaman kaydırma ikinizde ortaktır ([ ve ] tuşları).',
    control: {
      type: 'segmented',
      options: [
        { value: 'shadow', label: 'Gölge' },
        { value: 'box', label: 'Kutu' },
      ],
    },
    default: 'shadow',
  }),

  // --- Bağlantı ------------------------------------------------------------
  'connection.turn': defineSetting({
    group: 'connection',
    section: 'Aktarma sunucusu (TURN)',
    label: 'Kullanım',
    footer: 'Otomatik: doğrudan bağlantı kurulamazsa devreye girer. Sunucuda TURN anahtarı tanımlı olmalı.',
    control: {
      type: 'segmented',
      options: [
        { value: 'auto', label: 'Otomatik' },
        { value: 'always', label: 'Her zaman' },
        { value: 'never', label: 'Kapalı' },
      ],
    },
    default: 'auto',
  }),
  'connection.server': defineSetting({
    group: 'connection',
    section: 'Sunucu',
    label: 'Adres',
    footer: 'Eşleşme ve tanışma sunucusu. Film bu sunucudan geçmez.',
    advanced: true,
    control: { type: 'text', placeholder: 'https://…', maxLength: 200 },
    default: DEFAULT_SERVER,
  }),

  // --- Uygulamanın kendi tuttukları (ekranda görünmez) ----------------------
  'device.id': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '' }),
  'pairing.coupleId': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '' }),
  'pairing.token': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '' }),
  'pairing.partnerId': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '' }),
  'pairing.partnerName': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '' }),
  'ui.camCorner': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: 'br' }),
  'ui.volume': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: 1 }),
  'history.items': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '[]' }),
  'stats.together': defineSetting({ group: 'internal', label: '', control: { type: 'hidden' }, default: '{}' }),
};

export type SettingKey = keyof typeof SETTINGS;
