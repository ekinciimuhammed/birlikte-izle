// İzleme oturumu.
//
// Roller: "host" filmi kendi bilgisayarında oynatıp yayınlar ve oynatma durumunun tek
// doğruluk kaynağıdır. "guest" yayını izler; komutlarını host'a gönderir, host uygular
// ve yeni durumu yayınlar. Kim dosya açarsa host o olur.
//
// P2P bağlantı, iki taraf da izleme ekranındayken kurulur; biri çıkınca kapanır.
// React bileşenleri sadece useWatch'taki durumu okur ve watch.* komutlarını çağırır.

import { create } from 'zustand';
import type { FileRef, PeerMessage, PlayAction, Reaction, SignalData } from '@birlikte/protocol';
import { mediaUrl, type MediaInfo } from '../../../shared/media';
import { BackgroundBlur } from '../media/background';
import { BrowserPlayer, extensionLink, samePage, useExtension, type BrowserVideo } from '../media/browser';
import { sameSite, type Channel } from '../media/channels';
import { useWebPage, WebView } from '../media/webview';
import { isEmbeddable } from '../../../shared/web';
import { MoviePlayer, type Playable, type WebVideo } from '../media/player';
import { audioLabel, pickAudio, planPlayback, type Step } from '../media/playback';
import { YouTubeError, YouTubePlayer, youtubeId, youtubeStart } from '../media/youtube';
import { fetchIceServers } from '../net/api';
import { checkConnection } from '../net/health';
import { Link } from '../net/link';
import type { RoomClient } from '../net/room';
import { watchStats, type StatsSummary, type TrackRole } from '../net/stats';
import { bridge, isDesktop } from '../platform/bridge';
import { SETTINGS, type SettingKey } from '../settings/definitions';
import { getSetting, isSettingKey, onSettingChange, setSetting, settingDef } from '../settings/store';
import { SubtitleManager, type SubtitleView } from '../subtitles/manager';
import type { Cue } from '../subtitles/parse';
import { ClockSync, now } from './clock';
import { Ducker } from './ducking';
import { readHistory, recordHistory } from './history';
import { TogetherCounter } from './stats';
import { fileRefOf, Transfer, type TransferView } from './transfer';

export type Role = 'idle' | 'host' | 'guest';
export type Connection = 'alone' | 'connecting' | 'connected' | 'reconnecting';
export type HudIcon =
  | 'play'
  | 'pause'
  | 'seek'
  | 'heart'
  | 'mic-off'
  | 'video-off'
  | 'volume-off'
  | 'lock'
  | 'wifi-off'
  | 'captions'
  | 'audio'
  | 'download'
  | 'sync'
  | 'leave';

export interface WatchState {
  active: boolean;
  role: Role;
  title: string;
  pos: number;
  duration: number;
  playing: boolean;
  connection: Connection;
  /** Kontrol kanalı açık: karşı taraf gerçekten bağlı */
  peerHere: boolean;
  peerCamOn: boolean;
  peerMicOn: boolean;
  camOn: boolean;
  micOn: boolean;
  volume: number;
  muted: boolean;
  /** Dosya hazırlanıyor (ses dönüştürme vb.): kendi tarafımızda ya da karşıda */
  preparing: { title: string; ratio: number | null; byPeer: boolean } | null;
  /** Host: dosyadaki ses izleri; guest: çalan izin adı */
  audioTracks: { index: number; label: string }[];
  audioIndex: number;
  audioLabel: string | null;
  subtitles: SubtitleView;
  /** Bu taraftaki oynatıcı: dosya (<video>), YouTube ya da tarayıcı (eklenti); yayından izlerken null */
  source: 'file' | 'youtube' | 'browser' | 'web' | null;
  /** Tarayıcıda izlenen bölüm (Netflix vb.) */
  webVideo: WebVideo | null;
  /** Senkron mod: ikimiz de kendi kopyamızdan oynatıyoruz (yayın yok, kayıpsız) */
  syncMode: boolean;
  /** Karşı taraf masaüstü uygulamasında mı? (dosya alabilir, senkron moda geçebilir) */
  peerDesktop: boolean;
  /** Guest: host'un açtığı dosya (senkron mod için "bende de var mı?") */
  peerFile: FileRef | null;
  transfer: TransferView | null;
  hud: { id: number; text: string; icon: HudIcon } | null;
  /** Boş ekranda kalıcı açıklama (ör. "bu video uygulamada oynatılamıyor") */
  notice: string | null;
  /** Uzun süre bağlanılamayınca sebebi (bağlantı testinin sonucu) */
  connectionHelp: string | null;
  /** Taraflardan birinin uygulaması eski: güncellemesi gerekiyor */
  versionNotice: string | null;
  reactions: { id: number; kind: Reaction }[];
  stats: StatsSummary | null;
  /** Tarayıcıdaki ya da uygulama içindeki canlı yayın: zaman çubuğu yerine "CANLI" */
  live: boolean;
  /** Uygulama içindeki sayfada "sadece video" (oynatıcı alanı kaplar) ya da sayfanın tamamı */
  webFocus: boolean;
}

const initialState = (): WatchState => ({
  active: false,
  role: 'idle',
  title: '',
  pos: 0,
  duration: 0,
  playing: false,
  connection: 'alone',
  peerHere: false,
  peerCamOn: false,
  peerMicOn: false,
  camOn: false,
  micOn: false,
  volume: 1,
  muted: false,
  preparing: null,
  audioTracks: [],
  audioIndex: 0,
  audioLabel: null,
  subtitles: { tracks: [], selected: null, offset: 0 },
  source: null,
  webVideo: null,
  syncMode: false,
  peerDesktop: false,
  peerFile: null,
  transfer: null,
  hud: null,
  notice: null,
  connectionHelp: null,
  versionNotice: null,
  reactions: [],
  stats: null,
  live: false,
  webFocus: true,
});

export const useWatch = create<WatchState>(initialState);
const set = (patch: Partial<WatchState>) => useWatch.setState(patch);
const get = () => useWatch.getState();

type RemoteState = Extract<PeerMessage, { t: 'state' }> & { recvAt: number };

function mediaElement({ muted = false, autoplay = false } = {}) {
  const v = document.createElement('video');
  v.playsInline = true;
  v.autoplay = autoplay;
  v.muted = muted;
  return v;
}

/** "0.3.4" gibi sürümleri karşılaştırır: a eskiyse < 0 */
function compareVersions(a: string, b: string) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Ayarlar'da aktarma (TURN) kapalıysa TURN sunucuları çıkarılır. */
function usableIce(ice: RTCIceServer[]) {
  if (getSetting('connection.turn') !== 'never') return ice;
  return ice.filter((s) => ![s.urls].flat().some((u) => u.startsWith('turn')));
}

class WatchController {
  // Ekranda gösterilecek öğeler; React bunları yerleştirir, oynatma burada yönetilir.
  readonly localMovie = mediaElement();
  readonly remoteMovie = mediaElement({ autoplay: true });
  readonly localCam = mediaElement({ muted: true, autoplay: true });
  readonly remoteCam = mediaElement({ autoplay: true });
  private readonly filePlayer = new MoviePlayer(this.localMovie);
  readonly youtube = new YouTubePlayer();
  readonly browser = new BrowserPlayer(extensionLink());
  /** Uygulamanın içindeki sayfa (Kanallar, YouTube): sadece masaüstünde */
  readonly webview = isDesktop ? new WebView() : null;
  readonly web = new BrowserPlayer(this.webview?.link ?? null);
  private pendingWeb: WebVideo | null = null; // guest: eklenti bağlanınca açılacak
  private pendingChannel: { url: string; name: string; embedded: boolean; until: number } | null = null; // seçtiğim kanalda video belirince birlikte izle
  /** Şu an kullanılan oynatıcı (host'ta film, guest'te senkron moddaki kopya) */
  private player: Playable = this.filePlayer;

  private room: RoomClient | null = null;
  private roomUnsubs: (() => void)[] = [];
  private link: Link | null = null;
  private linkStarting = false;
  private linkGeneration = 0;
  private pendingSignals: SignalData[] = [];
  private stopStats: (() => void) | null = null;
  private helpTimer: ReturnType<typeof setTimeout> | undefined; // uzun süre bağlanılamazsa sebebini bul
  private iceTimer: ReturnType<typeof setInterval> | undefined; // TURN kimlik bilgilerini tazele
  private iceFetchedAt = 0;
  private appVersion = ''; // karşı tarafa bildirilir; biri eskiyse uyarılır
  private peerBye: 'leave' | 'quit' | null = null; // o "görüşürüz" dedi: kapanan bağlantı "koptu" sayılmaz
  private byeAt = 0; // son "görüşürüz" (odadan gelen ekran değişikliği aynı çıkışı ikinci kez bildirmesin)
  private dropped = false; // bağlantı koptu: geri gelince "geri geldi"
  private peerScreen: string | null = null; // odadan: onun açık ekranı (izleme → ana ekran = çıktı)
  private stats: StatsSummary | null = null;

  // Sabit akış kimlikleri: karşı taraf filmi ve kamerayı bu kimliklerle ayırt eder.
  private readonly movieStream = new MediaStream();
  private readonly camStream = new MediaStream();
  private captured: MediaStream | null = null;
  /** Yakalama akışına en son eklenen izler (gönderilecek olanlar) */
  private latest: { audio?: MediaStreamTrack; video?: MediaStreamTrack } = {};
  private camTrack: MediaStreamTrack | null = null; // kameranın kendisi
  private camOut: MediaStreamTrack | null = null; // gönderilen ve önizlemede görünen (bulanık olabilir)
  private readonly blur = new BackgroundBlur();
  private micTrack: MediaStreamTrack | null = null;

  private peerStreams = { movie: '', cam: '' };
  private readonly remoteStreams = new Map<string, MediaStream>();
  private readonly trackRoles = new Map<string, TrackRole>();

  private remoteState: RemoteState | null = null;
  private cmdSeq = 0; // guest: gönderdiğim son komut
  private lastAck = 0; // host: uyguladığım son guest komutu
  private hudId = 0;
  private deviceRetries = { cam: 0, mic: 0 };
  private timers: ReturnType<typeof setInterval>[] = [];

  private media: MediaInfo | null = null; // host: açık dosya (masaüstü)
  private loadToken = 0;
  private lastPrepareSent = 0;
  private duckFactor = 1;
  private lastHistory = 0;
  private readonly together = new TogetherCounter();
  private lastCount = 0;

  // Senkron mod
  private readonly clock = new ClockSync((msg) => this.send(msg));
  private peerSyncing = false; // host: guest kendi kopyasından oynatıyor
  private syncMedia: MediaInfo | null = null; // guest: kendi kopyam
  private syncFor: string | null = null; // guest: kopyamın eşlendiği host dosyasının parmak izi
  private syncAudio = 0; // guest: kopyamda çalan ses izi
  private syncToken = 0;
  private peerAudioLanguage: string | null = null;
  private followSeeking = false;
  private waitingForPeer = false; // host: guest takıldığı için durdurduk
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferTimer: ReturnType<typeof setTimeout> | undefined; // guest: takılma 1 sn'yi geçerse haber ver
  private bufferingSent = false;
  private seekLead = 0.15; // guest: kendi kopyamda sarma ne kadar sürüyor (sn)
  private playLead = 0.04; // play() ile görüntünün akmaya başlaması arası (sn); ölçülerek öğrenilir
  /** Host: geri sayımlı başlatma ("şu saatte, şu kareden"); gerçekten başlayana kadar böyle bildirilir */
  private planned: { pos: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private startTimer: ReturnType<typeof setTimeout> | undefined; // guest: planlanan anda başla
  private startDue = 0;
  private startedAt = 0; // guest: planlanan başlangıcın yapıldığı an (hemen sonra kalan fark hızlı kapatılır)
  private resyncOnce = false; // guest: sarmadan hemen sonra küçük farkı da sararak kapat
  readonly transfer = new Transfer(
    () => this.link,
    (msg) => this.send(msg),
    (view) => set({ transfer: view }),
    (info) => this.onFileReceived(info),
    (text) => this.hud(text, 'wifi-off'),
  );

  readonly subtitles = new SubtitleManager(
    (msg) => this.send(msg),
    (view) => set({ subtitles: view }),
  );
  private readonly ducker = new Ducker((factor) => {
    this.duckFactor = factor;
    this.applyVolume(get().volume, get().muted);
  });

  constructor() {
    for (const player of [this.filePlayer, this.youtube, this.browser, this.web] as Playable[]) {
      const on = (type: string, fn: () => void) =>
        player.events.addEventListener(type, () => player === this.player && fn());
      on('loadedmetadata', () => this.publishMovie());
      on('playing', () => {
        this.publishMovie();
        this.broadcast();
      });
      // Senkron modda guest'in kopyası takılırsa (ör. ağ diski, YouTube yükleniyor) host onu beklesin.
      on('waiting', () => {
        this.onLocalWaiting(true);
        this.broadcast();
      });
      for (const type of ['playing', 'canplay']) on(type, () => this.onLocalWaiting(false));
      for (const type of ['pause', 'seeked', 'ended']) {
        on(type, () => {
          this.broadcast();
          if (type !== 'seeked') this.saveHistory();
        });
      }
      on('titlechange', () => this.onTitleChange());
    }
    // Guest tarayıcıda elle durdurdu/oynattı/sardı (Netflix'te boşluk tuşu gibi): host'a komut olsun.
    const fromBrowser = (type: string, fn: (e: Event) => void) => {
      for (const player of [this.browser, this.web]) {
        player.events.addEventListener(type, (e) => this.player === player && get().role === 'guest' && get().syncMode && fn(e));
      }
    };
    fromBrowser('userpause', () => this.command('pause'));
    fromBrowser('userplay', () => this.command('play'));
    fromBrowser('userseek', (e) => this.command('seek', Number((e as CustomEvent).detail)));
    // Eklenti sonradan bağlandıysa bekleyen bölümü aç.
    useExtension.subscribe((s, prev) => {
      if (s.connected && !prev.connected && this.pendingWeb && get().role === 'guest') this.followBrowser(this.pendingWeb);
      // Kanallar: seçtiğim kanalda video belirdi → "Birlikte izle"ye basmış gibi
      const channel = this.pendingChannel;
      if (channel && s.video && s.video !== prev.video && sameSite(s.video.url, channel.url)) {
        this.pendingChannel = null;
        if (Date.now() < channel.until && get().active) this.openBrowser();
      }
    });
    useWebPage.subscribe((s, prev) => {
      const video = s.video;
      if (!video || video === prev.video) return;
      // Kanallar: uygulama içinde seçtiğim kanalda video belirdi → birlikte izle
      const channel = this.pendingChannel;
      if (channel?.embedded && sameSite(video.url, channel.url)) {
        this.pendingChannel = null;
        if (Date.now() < channel.until && get().active) return this.shareTab(this.web, video, channel.name);
      }
      // Uygulama içinde başka bir bölüme ya da kanala geçtim: o da takip etsin (kumanda gibi)
      const shared = get().webVideo;
      if (get().role === 'host' && this.player === this.web && shared && !samePage(video.url, shared.url)) this.shareTab(this.web, video);
    });
    // Uygulama içindeki sayfadan çıkılınca kapat (arkada ses kalmasın); hemen geri dönülüyorsa dokunma.
    useWatch.subscribe((s, prev) => {
      if (prev.source === 'web' && s.source !== 'web') setTimeout(() => get().source !== 'web' && this.webview?.close(), 0);
      // İzlerken "sadece video"; önizlemede (çerez onayı, oynat düğmesi) sayfanın tamamı
      this.webview?.setFocus(s.source === 'web' && s.role !== 'idle' && s.webFocus);
    });
    onSettingChange((key, value, origin) => this.onSetting(key, value, origin));
    bridge.version?.().then((v) => (this.appVersion = v), () => {});
    // Pencere kapanırken (uygulamadan çıkış): o "uygulamayı kapattı" görsün
    bridge.onClosing?.(() => this.sayBye('quit'));
    bridge.media?.onProgress((p) => {
      if (p.id === this.media?.id && get().preparing && !get().preparing?.byPeer) this.setPreparing(p.ratio);
    });
    this.applyVolume(Number(getSetting('ui.volume')), false);
  }

  /** Bu ortam film paylaşabilir mi? (Safari'de captureStream yok) */
  get canHost() {
    return typeof this.localMovie.captureStream === 'function';
  }

  /** Host: açık dosya diskte mi? (ona gönderilebilir) */
  get canSendFile() {
    return !!this.media;
  }

  /** Dosyayı ffmpeg ile her formatta açabiliyor muyuz? (sadece masaüstü) */
  get canConvert() {
    return !!bridge.media;
  }

  // --- Oda ve bağlantı yaşam döngüsü ----------------------------------------------

  attachRoom(room: RoomClient) {
    this.detachRoom();
    this.room = room;
    this.roomUnsubs = [
      room.on('peer', (peer) => {
        const before = this.peerScreen;
        this.peerScreen = peer?.status.screen ?? null;
        // "Görüşürüz" göndermeyen (eski) sürüm izleme ekranından çıktıysa da haber ver
        const saidBye = performance.now() - this.byeAt < 5000;
        if (before === 'watch' && this.peerScreen === 'home' && !saidBye && get().active) this.partnerLeft('leave');
        // Oda bağlantısı kopsa bile P2P yaşıyorsa sürdür; gerçekten koptuysa kanal kapanır.
        if (!peer && this.link?.isOpen) return;
        this.evaluateLink();
      }),
      room.on('signal', (data) => {
        if (this.link) this.link.handleSignal(data);
        else if (this.linkStarting) this.pendingSignals.push(data);
      }),
      room.on('state', (state) => state === 'online' && this.updateStatus()),
    ];
    this.updateStatus();
  }

  detachRoom() {
    this.stopLink();
    this.roomUnsubs.forEach((off) => off());
    this.roomUnsubs = [];
    this.room = null;
  }

  /** İzleme ekranına girerken */
  enter() {
    if (get().active) return;
    set({ active: true });
    this.together.begin();
    this.lastCount = performance.now();
    this.timers = [
      setInterval(() => {
        this.tick();
        if (get().syncMode && get().role === 'guest') this.followSync();
      }, 250),
      setInterval(() => {
        this.broadcast();
        this.countTogether();
      }, 1000),
      setInterval(() => get().playing && this.saveHistory(), 15_000),
    ];
    this.updateStatus();
    this.evaluateLink();
    this.openDevices(getSetting('camera.startOn'), getSetting('camera.micStartOn'));
  }

  /** İzleme ekranından çıkarken: yayın, kamera ve bağlantı kapanır */
  leave() {
    if (!get().active) return;
    const bye = this.sayBye('leave');
    this.saveHistory();
    this.countTogether();
    this.together.flush();
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.stopLink(bye);
    if (get().role === 'host') this.stopHosting();
    this.becomeIdle();
    this.blur.stop();
    this.camTrack?.stop();
    this.micTrack?.stop();
    this.camTrack = this.micTrack = this.camOut = null;
    this.localCam.srcObject = null;
    this.ducker.stop();
    const { volume, muted } = get();
    useWatch.setState({ ...initialState(), volume, muted });
    this.updateStatus();
  }

  private wantLink() {
    const peer = this.room?.peer;
    return get().active && !!peer && peer.status.screen === 'watch';
  }

  private evaluateLink() {
    const want = this.wantLink();
    if (want && !this.link && !this.linkStarting) this.startLink();
    else if (!want && (this.link || this.linkStarting)) this.stopLink();
  }

  private async startLink() {
    const room = this.room!;
    const peer = room.peer!;
    const generation = ++this.linkGeneration;
    this.linkStarting = true;
    this.pendingSignals = [];
    set({ connection: 'connecting' });
    this.armConnectionHelp();

    const ice = await fetchIceServers();
    if (generation !== this.linkGeneration) return; // bu arada durduruldu ya da yeniden başlatıldı
    if (!this.wantLink()) {
      this.linkStarting = false;
      return;
    }

    const turn = getSetting('connection.turn');
    const link = new Link((data) => room.signal(data), {
      // Cihaz kimliği büyük olan taraf "kibar"dır: oturumu karşı taraf başlatır.
      polite: getSetting('device.id') > peer.deviceId,
      codec: getSetting('video.codec'),
      iceServers: usableIce(ice),
      policy: turn === 'always' ? 'relay' : 'all',
    });
    this.link = link;
    this.linkStarting = false;
    this.iceFetchedAt = performance.now();
    // TURN kimlik bilgileri 24 saat geçerli; uzun oturumda eskimesin.
    this.iceTimer = setInterval(() => this.refreshIce(true), 6 * 60 * 60 * 1000);
    window.addEventListener('online', this.onNetworkBack);

    // Kapatılmış eski bir bağlantıdan gelen olaylar yok sayılır.
    const current = <T>(fn: (arg: T) => void) => (arg: T) => this.link === link && fn(arg);
    link.on('open', current(() => this.onChannelOpen()));
    link.on('close', current(() => this.onChannelClose()));
    link.on('message', current((msg) => this.onMessage(msg)));
    link.on('chunk', current((buf) => this.transfer.onChunk(buf)));
    link.on(
      'track',
      current(({ stream }) => {
        if (stream) this.remoteStreams.set(stream.id, stream);
        this.bindRemoteStreams();
      }),
    );
    link.on(
      'state',
      current((state) => {
        if (state === 'connected') set({ connection: link.isOpen ? 'connected' : 'connecting' });
        else set({ connection: get().peerHere || state === 'reconnecting' ? 'reconnecting' : 'connecting' });
        if (state === 'reconnecting') {
          this.armConnectionHelp();
          this.refreshIce();
        }
      }),
    );

    this.pushTracks();
    this.stopStats = watchStats(
      () => this.link?.pc ?? null,
      (id) => (id ? this.trackRoles.get(id) : undefined),
      (stats) => {
        this.stats = stats;
        set({ stats });
      },
    );
    link.start();
    for (const data of this.pendingSignals.splice(0)) link.handleSignal(data);
  }

  /** graceful: son gönderilenler ("görüşürüz") gidebilsin diye bağlantı biraz sonra kapanır */
  private stopLink(graceful = false) {
    this.linkGeneration++;
    this.linkStarting = false;
    this.pendingSignals = [];
    this.stopStats?.();
    this.stopStats = null;
    clearInterval(this.iceTimer);
    window.removeEventListener('online', this.onNetworkBack);
    this.clearConnectionHelp();
    const link = this.link;
    this.link = null;
    link?.stop(graceful ? 200 : 0);
    this.clock.stop();
    this.transfer.onCancel();
    this.resetPeerSync();
    this.remoteStreams.clear();
    this.remoteCam.srcObject = null;
    this.ducker.stop();
    if (get().role === 'guest') this.becomeIdle();
    set({ connection: 'alone', peerHere: false, peerCamOn: false, peerMicOn: false, versionNotice: null, stats: null });
  }

  /** 20 sn'de bağlanamazsak sonsuz "bağlanıyor" yerine sebebini bul ve göster. */
  private armConnectionHelp() {
    if (this.helpTimer) return;
    const timer = setTimeout(async () => {
      const report = await checkConnection();
      if (this.helpTimer !== timer) return; // bu arada bağlandık ya da çıktık
      this.helpTimer = undefined;
      set({ connectionHelp: `${this.partnerName()} ile bağlantı kurulamadı. ${report.summary} Ayrıntı: Ayarlar → Bağlantı.` });
    }, 20_000);
    this.helpTimer = timer;
  }

  private clearConnectionHelp() {
    clearTimeout(this.helpTimer);
    this.helpTimer = undefined;
    if (get().connectionHelp) set({ connectionHelp: null });
  }

  /** Taze STUN/TURN bilgisi (yeniden bağlanırken en fazla 30 sn'de bir) */
  private async refreshIce(force = false) {
    const link = this.link;
    if (!link || (!force && performance.now() - this.iceFetchedAt < 30_000)) return;
    this.iceFetchedAt = performance.now();
    const ice = await fetchIceServers();
    if (this.link === link) link.setIceServers(usableIce(ice));
  }

  /** İnternet geri geldi (ağ değişmiş olabilir): taze bilgiyle hemen yeni yolları dene. */
  private onNetworkBack = () => {
    void this.refreshIce(true).then(() => this.link?.restartIce());
  };

  /** Mevcut yerel izleri (film, kamera, mikrofon) yeni bağlantıya verir. */
  private pushTracks() {
    if (get().role === 'host') this.publishMovie();
    this.link?.setTrack('cam-video', this.camOut, this.camStream, { maxBitrate: 1_200_000 });
    this.link?.setTrack('cam-audio', this.micTrack, this.camStream, { maxBitrate: 64_000 });
  }

  private updateStatus() {
    const { active, title } = get();
    this.room?.setStatus({ screen: active ? 'watch' : 'home', title: active && title ? title : null });
  }

  partnerName() {
    return (
      getSetting('profile.partnerNickname').trim() ||
      this.room?.peer?.name ||
      getSetting('pairing.partnerName') ||
      'O'
    );
  }

  // --- Kontrol kanalı ------------------------------------------------------------------

  private send(msg: PeerMessage) {
    this.link?.send(msg);
  }

  private onChannelOpen() {
    this.clearConnectionHelp();
    set({ peerHere: true, connection: 'connected' });
    this.send({
      t: 'hello',
      name: getSetting('profile.name') || 'Ben',
      movieStream: this.movieStream.id,
      camStream: this.camStream.id,
      camOn: !!this.camTrack,
      micOn: this.micOn(),
      desktop: !!bridge.media,
      version: this.appVersion || undefined,
    });
    this.clock.start();
    if (get().role === 'host') {
      for (const [key, def] of Object.entries(SETTINGS)) {
        if ('shared' in def && def.shared) this.send({ t: 'setting', key, value: getSetting(key as SettingKey) });
      }
      if (get().preparing && !get().preparing?.byPeer) this.sendPreparing(true);
      else this.sendMedia();
      this.broadcast();
    }
    this.subtitles.resend();
    this.peerBye = null;
    this.hud(this.dropped ? `${this.partnerName()} geri geldi` : `${this.partnerName()} burada`, 'heart');
    this.dropped = false;
  }

  /** Çıkıyorum: o "izleme ekranından çıktı" / "uygulamayı kapattı" görsün. Gönderildiyse true. */
  private sayBye(reason: 'leave' | 'quit') {
    if (!this.link?.isOpen || !get().peerHere) return false;
    this.send({ t: 'bye', reason });
    return true;
  }

  /** O ayrıldı ya da bağlantı koptu: haber ver (uygulama arkadaysa bildirim), ayar açıksa filmi durdur */
  private partnerLeft(reason: 'leave' | 'quit' | 'drop') {
    const who = this.partnerName();
    const paused = this.pauseForPartner();
    const what =
      reason === 'leave' ? `${who} izleme ekranından çıktı` : reason === 'quit' ? `${who} uygulamayı kapattı` : `${who} ile bağlantı koptu`;
    const text = paused ? `${what}, durduruldu` : reason === 'drop' ? `${what}, yeniden bağlanılıyor…` : what;
    this.hud(text, reason === 'drop' ? 'wifi-off' : 'leave');
    this.notify(text);
  }

  /** Ayar açıksa ve film oynuyorsa durdur (kendi oynatıcım: host ya da kendi kopyamdan izleyen guest) */
  private pauseForPartner() {
    const mine = get().role === 'host' || (get().role === 'guest' && get().syncMode);
    if (!getSetting('playback.pauseOnDisconnect') || !mine || !this.player.playing) return false;
    this.cancelPlanned();
    this.player.pause();
    return true;
  }

  /** Uygulama arkadaysa (ör. tarayıcıda izlerken) sistem bildirimi */
  private notify(text: string) {
    if (!bridge.media || !getSetting('notify.partnerLeft') || (document.hasFocus() && !document.hidden)) return;
    try {
      const n = new Notification('Birlikte İzle', { body: text });
      n.onclick = () => window.focus();
    } catch {
      // bildirime izin yok
    }
  }

  /** Masaüstü uygulamaları farklı sürümdeyse uyar (kanallar gibi yenilikler eski sürümde çalışmaz) */
  private checkVersions(desktop: boolean | undefined, peer: string | undefined) {
    const mine = this.appVersion;
    if (!desktop || !mine) return set({ versionNotice: null });
    const who = this.partnerName();
    if (!peer || compareVersions(peer, mine) < 0) {
      set({ versionNotice: `${who} eski bir sürüm kullanıyor (${peer ?? '0.3.4 ya da öncesi'}). Kanallar gibi yenilikler onda çalışmaz; ${mine} sürümünü kurması gerekiyor.` });
    } else if (compareVersions(peer, mine) > 0) {
      set({ versionNotice: `${who} daha yeni bir sürümde (${peer}). Kanallar gibi yenilikler için sen de güncelle (Releases).` });
    } else {
      set({ versionNotice: null });
    }
  }

  private onChannelClose() {
    const wasHere = get().peerHere;
    const bye = this.peerBye;
    this.peerBye = null;
    set({ peerHere: false, peerCamOn: false, peerMicOn: false, versionNotice: null, connection: this.link ? 'reconnecting' : 'alone' });
    if (this.link) this.armConnectionHelp();
    this.ducker.stop();
    this.clock.stop();
    this.transfer.onCancel();
    if (!wasHere) return;
    // Geri gelince guest "bende de var" diye yeniden haber verir; o zamana kadar yayın açık.
    if (get().role === 'host') this.leavePeerSync();
    // "Görüşürüz" demeden kapandıysa bağlantı koptu (o çıktıysa haber zaten verildi)
    if (!bye) {
      this.dropped = true;
      this.partnerLeft('drop');
    }
    if (get().role === 'guest' && this.remoteState) {
      const pos = get().syncMode ? this.player.time : this.seenPosition();
      this.remoteState = { ...this.remoteState, playing: false, pos, recvAt: performance.now() };
      if (get().syncMode) this.player.pause();
    }
    if (get().preparing?.byPeer) set({ preparing: null });
    this.evaluateLink();
  }

  private onMessage(m: PeerMessage) {
    switch (m.t) {
      case 'hello':
        this.peerStreams = { movie: m.movieStream, cam: m.camStream };
        set({ peerCamOn: m.camOn, peerMicOn: m.micOn, peerDesktop: !!m.desktop });
        this.bindRemoteStreams();
        this.checkVersions(m.desktop, m.version);
        break;

      case 'preparing':
        if (get().role === 'host') this.stopHosting();
        if (get().role !== 'guest' || get().title !== m.title) {
          this.subtitles.clear();
          this.becomeIdle();
        }
        set({ preparing: { title: m.title, ratio: m.ratio, byPeer: true } });
        break;

      case 'media': {
        const isNew = m.title !== get().title || get().role !== 'guest';
        if (get().role === 'host') this.stopHosting();
        if (isNew) {
          this.hud(`${this.partnerName()} “${m.title}” açtı`, 'play');
          if (!get().preparing?.byPeer) this.subtitles.clear();
        }
        this.remoteState = null;
        this.cmdSeq = 0;
        // Başka bir dosyaya geçildiyse kendi kopyamı bırak.
        const key = m.youtube ? `yt:${m.youtube}` : m.browser ? `web:${m.browser.url}` : (m.file?.fingerprint ?? null);
        if (this.syncFor !== key) this.exitSync(false);
        this.peerAudioLanguage = m.audioLanguage ?? null;
        set({
          notice: null,
          role: 'guest',
          title: m.title,
          duration: m.duration,
          audioLabel: m.audioLabel ?? null,
          audioTracks: [],
          preparing: null,
          peerFile: m.file ?? null,
        });
        this.bindRemoteStreams();
        this.updateStatus();
        // Kopyam zaten açıksa (bağlantı yenilendi ya da ses dili değişti) ona göre devam et.
        if (m.youtube) this.followYouTube(m.youtube);
        else if (m.browser) this.followBrowser(m.browser);
        else if (this.syncMedia) this.startSync(this.syncMedia, this.syncFor!);
        else if (m.file) this.trySync(m.file);
        break;
      }

      case 'sync':
        // Host: guest aynı dosyayı kendi bilgisayarında açtı → yayını durdur (bant genişliği boşa gitmesin).
        if (get().role !== 'host' || m.fingerprint !== this.media?.fingerprint) return;
        if (m.ready) this.enterPeerSync();
        else this.leavePeerSync();
        break;

      case 'buffering':
        if (get().role !== 'host' || !(this.peerSyncing || this.player.kind !== 'file')) return;
        if (m.waiting && this.player.playing) this.waitForPeer();
        else if (!m.waiting) this.endPeerWait(true);
        break;

      case 'ping':
        this.clock.onPing(m);
        break;

      case 'pong':
        this.clock.onPong(m);
        break;

      case 'file-offer':
        if (getSetting('transfer.autoAccept')) {
          this.hud(`${this.partnerName()} bölümü gönderiyor`, 'download');
          this.transfer.onOffer(m.file);
        } else {
          this.send({ t: 'file-cancel', fingerprint: m.file.fingerprint });
          this.hud(`${this.partnerName()} bölüm göndermek istedi (Ayarlar → Oynatma'dan açabilirsin)`, 'download');
        }
        break;

      case 'file-accept':
        this.transfer.onAccept(m.fingerprint, m.offset);
        break;

      case 'file-cancel':
        if (this.transfer.busy) this.hud('Bölüm gönderimi durduruldu', 'download');
        this.transfer.onCancel(m.fingerprint);
        break;

      case 'state':
        // Henüz uygulanmamış komutum varsa eski durumları yok say (arayüz titremesin).
        if (get().role !== 'guest' || m.ack < this.cmdSeq) return;
        this.remoteState = { ...m, recvAt: performance.now() };
        if (m.action && m.by === 'host') this.feedback(m.action, true, m.pos);
        // Sarma zaten bir sıçrama: host'un gerçek konumu gelince kalan küçük farkı da sararak kapat.
        if (m.action === 'seek') this.resyncOnce = true;
        if (get().syncMode) this.followSync();
        break;

      case 'cmd':
        if (get().role !== 'host') return;
        if (getSetting('playback.control') === 'host') {
          this.lastAck = m.seq;
          this.send({ t: 'denied', action: m.action });
          this.broadcast();
          return;
        }
        this.hostApply(m.action, { pos: m.pos, seen: m.seen, seq: m.seq, byPeer: true });
        break;

      case 'denied':
        this.hud(`Kontrol sadece ${this.partnerName()} tarafında`, 'lock');
        break;

      case 'cam':
        set({ peerCamOn: m.on });
        break;

      case 'mic':
        set({ peerMicOn: m.on });
        break;

      case 'react':
        this.floatReaction(m.kind);
        break;

      case 'bye':
        this.peerBye = m.reason;
        this.byeAt = performance.now();
        this.partnerLeft(m.reason);
        break;

      case 'channel':
        // O bir kanal seçti: benim tarayıcımda da açılsın. Onda video belirince birlikte izleme başlar.
        this.pendingChannel = null;
        this.hud(`${this.partnerName()} kanal açtı: ${m.name}`, 'play');
        if (this.canEmbed(m.url)) this.showWebPage(m.url);
        else if (useExtension.getState().connected) bridge.extension?.send({ t: 'open', url: m.url, replace: true });
        else set({ notice: `${this.partnerName()} ${m.name} kanalını açtı. Birlikte izlemek için tarayıcı eklentisini kur (Ayarlar → Genel).` });
        break;

      case 'subs':
        this.subtitles.receive(m);
        break;

      case 'subs-offset':
        this.subtitles.setOffset(m.seconds, true);
        this.hud(`Altyazı ${formatOffset(m.seconds)}`, 'captions');
        break;

      case 'setting':
        if (isSettingKey(m.key)) {
          const def = settingDef(m.key);
          if (def.shared && typeof m.value === typeof def.default) setSetting(m.key, m.value as never, 'peer');
        }
        break;
    }
  }

  private bindRemoteStreams() {
    const movie = this.remoteStreams.get(this.peerStreams.movie);
    if (movie) {
      movie.getTracks().forEach((t) => this.trackRoles.set(t.id, 'movie'));
      if (get().role === 'guest') attach(this.remoteMovie, movie);
    }
    const cam = this.remoteStreams.get(this.peerStreams.cam);
    if (cam) {
      cam.getTracks().forEach((t) => this.trackRoles.set(t.id, 'cam'));
      attach(this.remoteCam, cam);
      this.updateDucking();
    }
  }

  private updateDucking() {
    const cam = this.remoteStreams.get(this.peerStreams.cam);
    this.ducker.watch(
      cam?.getAudioTracks()[0] ?? null,
      getSetting('audio.ducking') && get().role !== 'idle',
      getSetting('audio.duckingLevel') / 100,
    );
  }

  // --- Host: dosya açma -----------------------------------------------------------------------

  /** Masaüstü: sistemin dosya seçme penceresi */
  async openDialog() {
    if (!bridge.media) return;
    try {
      const info = await bridge.media.openDialog();
      if (info) await this.openMedia(info);
    } catch (err) {
      this.hud(errorText(err), 'video-off');
    }
  }

  /** Sürükle-bırak ya da dosya seçici: masaüstünde ffmpeg yolu, tarayıcıda doğrudan */
  async openFile(file: File) {
    const path = bridge.media?.pathForFile(file);
    if (bridge.media && path) {
      try {
        await this.openMedia(await bridge.media.openPath(path));
      } catch (err) {
        this.hud(errorText(err), 'video-off');
      }
      return;
    }
    await this.openBlob(file);
  }

  /** "Kaldığınız yerden": aynı dosyayı aynı saniyeden aç */
  async openPath(path: string, startAt = 0) {
    if (!bridge.media) return;
    try {
      await this.openMedia(await bridge.media.openPath(path), { startAt });
    } catch {
      this.hud('Dosya bulunamadı; taşınmış ya da silinmiş olabilir.', 'video-off');
    }
  }

  /** Ses dilini değiştir: aynı yerden, aynı oynatma durumuyla devam et */
  async setAudioTrack(index: number) {
    if (get().role !== 'host' || !this.media || index === get().audioIndex) return;
    const startAt = this.player.time;
    const resume = this.player.playing;
    this.player.pause();
    await this.openMedia(this.media, { audioIndex: index, startAt, resume, keepSubtitles: true });
    this.hud(get().audioTracks[index]?.label ?? 'Ses değişti', 'audio');
  }

  private async openMedia(
    info: MediaInfo,
    opts: { audioIndex?: number; startAt?: number; resume?: boolean; keepSubtitles?: boolean } = {},
  ) {
    if (!this.canHost) return this.hud('Bu cihaz film paylaşamıyor; o açınca izleyebilirsin.', 'video-off');
    const token = ++this.loadToken;
    const sameFile = get().role === 'host' && this.media?.fingerprint === info.fingerprint;
    if (this.media && this.media.id !== info.id) bridge.media?.cancel(this.media.id);
    this.media = info;
    this.becomeHost(info.name, !opts.keepSubtitles, sameFile, this.filePlayer);
    const audio = opts.audioIndex ?? pickAudio(info, getSetting('media.audioLanguage'));
    const tracks = info.audio.map((a) => ({ index: a.index, label: audioLabel(a) }));
    set({ audioTracks: tracks, audioIndex: audio, audioLabel: tracks[audio]?.label ?? null });

    const { steps, audioMode } = planPlayback(info, audio);
    let ok = false;
    for (const step of steps) {
      if (token !== this.loadToken) return;
      try {
        await this.tryStep(step, info, audio, audioMode, opts.startAt ?? 0);
        ok = true;
        break;
      } catch (err) {
        console.warn(`Oynatma yolu "${step}" olmadı`, err);
      }
    }
    if (token !== this.loadToken) return;
    set({ preparing: null });
    if (!ok) {
      this.hud('Bu dosya açılamadı.', 'video-off');
      this.stopHosting();
      this.becomeIdle();
      return;
    }
    this.sendMedia();
    this.broadcast();
    this.saveHistory(true);
    if (!opts.keepSubtitles) this.loadSubtitles(info, token);
    if (opts.resume) await this.player.play().catch(() => {});
  }

  private async tryStep(step: Step, info: MediaInfo, audio: number, mode: 'copy' | 'aac', startAt: number) {
    const base = { crossOrigin: true, duration: info.duration, startAt };
    if (step === 'direct') return this.filePlayer.load(mediaUrl.file(info.id), base);
    if (step === 'prepare') {
      this.setPreparing(info.duration ? 0 : null);
      const url = await bridge.media!.prepare(info.id, audio, mode);
      return this.filePlayer.load(url, base);
    }
    this.setPreparing(null);
    return this.filePlayer.load(mediaUrl.live(info.id, startAt, audio), { ...base, live: { id: info.id, audio } });
  }

  private async loadSubtitles(info: MediaInfo, token: number) {
    try {
      const sources = (await bridge.media?.subtitles(info.id)) ?? [];
      if (token !== this.loadToken) return;
      for (const s of sources) this.subtitles.add(s);
    } catch (err) {
      console.warn('Altyazılar okunamadı', err);
    }
  }

  /** Tarayıcı modu: dosyayı olduğu gibi oynatmayı dene (ffmpeg yok) */
  private async openBlob(file: File) {
    if (!this.canHost) return this.hud('Bu tarayıcı film paylaşamıyor; o açınca izleyebilirsin.', 'video-off');
    const token = ++this.loadToken;
    this.media = null;
    this.becomeHost(file.name.replace(/\.[^.]+$/, ''), true, false, this.filePlayer);
    set({ audioTracks: [], audioIndex: 0, audioLabel: null });
    try {
      await this.filePlayer.load(URL.createObjectURL(file), { crossOrigin: false });
    } catch {
      if (token !== this.loadToken) return;
      this.hud('Tarayıcı bu dosyayı açamıyor. Masaüstü uygulaması her formatı açar.', 'video-off');
      this.stopHosting();
      this.becomeIdle();
      return;
    }
    this.sendMedia();
    this.broadcast();
  }

  private becomeHost(title: string, clearSubtitles: boolean, sameFile: boolean, player: Playable) {
    this.exitSync(false); // guest iken kendi kopyamdan izliyordum
    if (!sameFile) this.resetPeerSync();
    if (this.localMovie.src.startsWith('blob:')) URL.revokeObjectURL(this.localMovie.src);
    this.remoteState = null;
    this.remoteMovie.srcObject = null;
    if (clearSubtitles) this.subtitles.clear();
    this.usePlayer(player);
    if (player.kind === 'file') this.ensureCapture();
    set({ role: 'host', title, pos: 0, duration: 0, playing: false, source: player === this.web ? 'web' : player.kind, notice: null });
    this.updateStatus();
    this.updateDucking();
  }

  private setPreparing(ratio: number | null) {
    set({ preparing: { title: get().title, ratio, byPeer: false } });
    this.sendPreparing();
  }

  private sendPreparing(force = false) {
    const now = performance.now();
    if (!force && now - this.lastPrepareSent < 500) return;
    this.lastPrepareSent = now;
    const p = get().preparing;
    if (p && !p.byPeer) this.send({ t: 'preparing', title: p.title, ratio: p.ratio });
  }

  /**
   * Film yakalama: öğe başına TEK captureStream, ömür boyu.
   *
   * Chromium'un davranışı (ölçülerek görüldü): her yeni kaynakta (yeni bölüm, ses dili, canlıda
   * sarma, hatta oynatmaya başlama) daha önce alınmış her yakalama akışına yeni izler ekler; eski
   * izler bir süre "canlı" görünür ama veri taşımaz. Öğenin sesini ise tek bir musluk besler ve
   * onu en son eklenen ses izi alır. Bu yüzden: tek akış + her türden EN SON eklenen iz gönderilir;
   * hiçbir iz elle durdurulmaz (durdurmak musluğu kapatıp sesi kesiyor).
   */
  private ensureCapture() {
    if (this.captured) return;
    const captured = this.localMovie.captureStream();
    this.captured = captured;
    for (const t of captured.getTracks()) this.latest[t.kind as 'audio' | 'video'] = t;
    captured.onaddtrack = (e) => {
      this.latest[e.track.kind as 'audio' | 'video'] = e.track;
      this.publishMovie();
    };
  }

  private publishMovie() {
    // O kendi kopyasından izliyorsa yayına gerek yok (bant genişliği kameraya kalsın).
    // YouTube'da yayın hiç yok: ikimiz de YouTube'dan oynatırız.
    if (get().role !== 'host' || !this.captured || !this.link || this.peerSyncing || this.player.kind !== 'file') return;
    const live = (t?: MediaStreamTrack) => (t?.readyState === 'live' ? t : undefined);
    const video = live(this.latest.video);
    const audio = live(this.latest.audio);
    if (video) {
      video.contentHint = getSetting('video.priority');
      this.trackRoles.set(video.id, 'movie');
      this.link.setTrack('movie-video', video, this.movieStream, {
        maxBitrate: getSetting('video.maxBitrate') * 1_000_000,
        priority: 'high',
        networkPriority: 'high',
      });
    }
    if (audio) {
      audio.contentHint = 'music';
      this.trackRoles.set(audio.id, 'movie');
      this.link.setTrack('movie-audio', audio, this.movieStream, {
        maxBitrate: getSetting('audio.movieQuality') * 1000,
        priority: 'high',
        networkPriority: 'high',
      });
    }
  }

  private stopHosting() {
    this.cancelPlanned();
    this.loadToken++;
    if (this.media) bridge.media?.cancel(this.media.id);
    this.media = null;
    if (this.localMovie.src.startsWith('blob:')) URL.revokeObjectURL(this.localMovie.src);
    this.player.unload();
    this.player = this.filePlayer;
    set({ source: null, webVideo: null });
    this.link?.setTrack('movie-video', null, this.movieStream);
    this.link?.setTrack('movie-audio', null, this.movieStream);
    this.resetPeerSync();
    if (!get().preparing?.byPeer) set({ preparing: null });
  }

  private becomeIdle() {
    this.exitSync(false);
    this.remoteState = null;
    this.remoteMovie.srcObject = null;
    this.pendingWeb = null;
    set({ role: 'idle', title: '', pos: 0, duration: 0, playing: false, audioTracks: [], audioLabel: null, source: null, webVideo: null });
    this.updateDucking();
  }

  private sendMedia() {
    if (get().role !== 'host' || !this.player.hasSource || get().preparing) return;
    const media = this.media;
    this.send({
      t: 'media',
      title: get().title,
      duration: this.player.duration,
      audioLabel: get().audioLabel ?? undefined,
      // Senkron mod için: o da bu dosyaya sahipse kendi kopyasından izler.
      audioLanguage: media?.audio[get().audioIndex]?.language ?? null,
      file: media ? fileRefOf(media) : undefined,
      youtube: this.player.kind === 'youtube' ? (this.youtube.videoId ?? undefined) : undefined,
      browser: this.player.kind === 'browser' ? (get().webVideo ?? undefined) : undefined,
    });
  }

  private broadcast(action?: PlayAction, by?: 'host' | 'guest') {
    if (get().role !== 'host' || !this.link?.isOpen || get().preparing) return;
    // Geri sayım sürerken oynatıcı henüz duruyor: "şu saatte, şu kareden başlıyor" diye bildir
    const plan = this.planned;
    this.send({
      t: 'state',
      playing: plan ? true : this.player.playing,
      pos: plan ? plan.pos : this.player.time,
      rate: this.player.rate,
      duration: this.player.duration,
      ack: this.lastAck,
      action,
      by,
      at: plan ? plan.at : now(),
    });
  }

  private async hostApply(
    action: PlayAction,
    { pos, seen, seq, byPeer = false }: { pos?: number; seen?: number; seq?: number; byPeer?: boolean },
  ) {
    if (!this.player.hasSource || get().preparing) return;
    if (seq) this.lastAck = seq;
    this.endPeerWait();
    if (action !== 'play') this.cancelPlanned();
    if (action === 'play') {
      if (this.planPlay()) {
        this.broadcast(action, byPeer ? 'guest' : 'host');
        this.feedback(action, byPeer, this.player.time);
        return this.tick();
      }
      await this.timedPlay();
    } else if (action === 'pause') {
      this.player.pause();
      // Onun ekranı birkaç yüz ms geride: tam onun gördüğü karede duralım.
      if (byPeer && seen != null && Math.abs(this.player.time - seen) < 3 && !this.player.isLive) {
        await this.player.seek(seen);
      }
    } else if (action === 'seek' && pos != null) {
      const seeking = this.player.seek(pos);
      this.feedback(action, byPeer, Math.max(0, pos));
      await seeking;
      // Konumu, oynatma gerçekten oradan sürerken bildir (senkron modda o buna göre hizalanır).
      await seeked(this.player, 3000);
      this.broadcast(action, byPeer ? 'guest' : 'host');
      this.tick();
      return;
    }
    this.broadcast(action, byPeer ? 'guest' : 'host');
    this.feedback(action, byPeer, this.player.time);
    this.tick();
  }

  /**
   * Geri sayımlı başlatma: o kendi kopyasından izliyorsa oynatma biraz ileriye (ağ gecikmesi kadar)
   * planlanır; ikimiz de aynı saatte, aynı kareden başlarız. Planlandıysa true.
   */
  private planPlay() {
    const peerHasCopy = !!this.link?.isOpen && get().peerHere && (this.peerSyncing || this.player.kind !== 'file');
    if (!peerHasCopy || this.player.playing || !this.player.hasSource) return false;
    this.cancelPlanned();
    const lead = clamp((this.stats?.rtt ?? 0.1) + 0.12, 0.15, 0.6);
    const timer = setTimeout(() => {
      this.planned = null;
      void this.timedPlay();
    }, Math.max(0, (lead - this.playLead) * 1000));
    this.planned = { pos: this.player.time, at: now() + lead * 1000, timer };
    return true;
  }

  private cancelPlanned() {
    if (!this.planned) return;
    clearTimeout(this.planned.timer);
    this.planned = null;
  }

  /** Oynat ve play() ile görüntünün akmaya başlaması arasındaki süreyi öğren (planlı başlangıçta düşülür) */
  private async timedPlay() {
    const player = this.player;
    const t0 = performance.now();
    await player.play().catch(() => {});
    if (player === this.player && player.playing) {
      this.playLead = clamp(this.playLead * 0.6 + ((performance.now() - t0) / 1000) * 0.4, 0.01, 0.3);
    }
  }

  /** "Birlikte izlediğimiz saatler": ikimiz de buradayken ve film oynarken geçen süre */
  private countTogether() {
    const t = performance.now();
    const dt = (t - this.lastCount) / 1000;
    this.lastCount = t;
    const { peerHere, playing, role, title } = get();
    if (peerHere && playing && role !== 'idle' && dt > 0 && dt < 5) this.together.add(dt, title);
  }

  private saveHistory(force = false) {
    if (get().role !== 'host' || !this.media) return;
    const now = Date.now();
    if (!force && now - this.lastHistory < 3000) return;
    this.lastHistory = now;
    recordHistory({ path: this.media.path, name: this.media.name, position: this.player.time, duration: this.player.duration });
  }

  // --- Guest: konum tahmini --------------------------------------------------------------

  /** Host'un oynatıcısı şu an nerede? */
  private hostPosition() {
    const s = this.remoteState;
    if (!s) return 0;
    if (!s.playing) return s.pos;
    const rtt = this.stats?.rtt ?? 0.05;
    return s.pos + ((performance.now() - s.recvAt) / 1000 + rtt / 2) * s.rate;
  }

  /** Benim ekranımda şu an hangi kare var? (yayın gecikmesi kadar geride) */
  private seenPosition() {
    const s = this.remoteState;
    if (!s) return 0;
    if (!s.playing) return s.pos;
    return clamp(this.hostPosition() - (this.stats?.movieDelay ?? 0.25), 0, s.duration || Infinity);
  }

  /** Ekrandaki karenin film zamanı (altyazılar buna göre çizilir) */
  mediaTime() {
    const { role } = get();
    if (role === 'host' || (role === 'guest' && get().syncMode)) return this.player.time;
    if (role === 'guest') return this.seenPosition();
    return 0;
  }

  cuesNow(): Cue[] {
    return get().role === 'idle' ? [] : this.subtitles.cuesAt(this.mediaTime());
  }

  // --- Komutlar (iki rol için tek giriş noktası) -----------------------------------------

  command(action: PlayAction | 'toggle' | 'skip', value?: number) {
    const { role } = get();
    if (role === 'host') {
      if (action === 'toggle') return this.hostApply(this.player.playing ? 'pause' : 'play', {});
      if (action === 'skip') return this.hostApply('seek', { pos: this.player.time + (value ?? 0) });
      return this.hostApply(action, { pos: value });
    }
    if (role !== 'guest' || !this.remoteState || !this.link?.isOpen) return;

    const s = this.remoteState;
    const sync = get().syncMode;
    const seen = sync ? this.player.time : this.seenPosition();
    const act: PlayAction = action === 'toggle' ? (s.playing ? 'pause' : 'play') : action === 'skip' ? 'seek' : action;
    let pos = value;
    if (action === 'skip') pos = clamp(seen + (value ?? 0), 0, s.duration || Infinity);
    if (act === 'seek' && pos == null) return;
    this.send({ t: 'cmd', action: act, pos, seen, seq: ++this.cmdSeq });

    // İyimser güncelleme: host onaylayana kadar arayüz geri zıplamasın.
    // Senkron modda kendi kopyam da hemen tepki verir.
    const t = { recvAt: performance.now(), at: now() + this.clock.offset };
    if (act === 'pause') this.remoteState = { ...s, ...t, playing: false, pos: seen };
    // Senkron modda oynat'ta beklenir: host "şu saatte, şu kareden" diye planlar, ikimiz aynı anda başlarız.
    else if (act === 'play' && !sync) this.remoteState = { ...s, ...t, playing: true, pos: this.hostPosition() };
    else this.remoteState = { ...s, ...t, pos: pos! };
    if (sync) this.followSync();
    this.feedback(act, false, act === 'seek' ? pos! : seen);
    this.tick();
  }

  shiftSubtitles(delta: number) {
    this.subtitles.setOffset(this.subtitles.currentOffset + delta);
    this.hud(`Altyazı ${formatOffset(this.subtitles.currentOffset)}`, 'captions');
  }

  private feedback(action: PlayAction, byPeer: boolean, pos: number) {
    const who = byPeer ? this.partnerName() : '';
    if (action === 'play') this.hud(who ? `${who} oynattı` : 'Oynatılıyor', 'play');
    else if (action === 'pause') this.hud(who ? `${who} durdurdu` : 'Durduruldu', 'pause');
    else this.hud(who ? `${who} sardı · ${formatTime(pos)}` : formatTime(pos), 'seek');
  }

  private tick() {
    const { role } = get();
    const live = this.isTab(this.player) && this.player.isLive;
    if (role === 'host') {
      set({ pos: this.player.time, duration: this.player.duration, playing: this.player.playing, live });
    } else if (role === 'guest' && this.remoteState) {
      const pos = get().syncMode ? this.player.time : this.seenPosition();
      set({ pos, duration: this.remoteState.duration, playing: this.remoteState.playing, live: get().syncMode && live });
    }
  }

  /** Tarayıcıdaki (eklenti) ya da uygulama içindeki sayfanın oynatıcısı mı? */
  private isTab(player: Playable): player is BrowserPlayer {
    return player === this.browser || player === this.web;
  }

  // --- Senkron mod: ikimiz de kendi kopyamızdan ---------------------------------------------
  //
  // Guest'te aynı dosya varsa yayın yerine onu oynatır ve host'un saatine göre takip eder:
  // 1 sn'den büyük fark → sar; küçük fark → hızı ±%5 içinde ayarla (kulak fark etmez).
  // Host bu sırada film yayınını durdurur: görüntü kayıpsız, bant genişliği kameraya kalır.

  /** Guest: host'un açtığı dosya bende de var mı? (İndirilenler, Birlikte İzle, geçmişteki klasörler) */
  private async trySync(file: FileRef) {
    if (!bridge.media || !getSetting('sync.auto')) return;
    const token = this.syncToken;
    const dirs = [...new Set(readHistory().map((h) => parentDir(h.path)))];
    const info = await bridge.media.find(file, dirs).catch(() => null);
    if (!info || token !== this.syncToken || this.syncMedia || get().peerFile?.fingerprint !== file.fingerprint) return;
    await this.startSync(info, file.fingerprint);
  }

  /** Guest: kendi kopyamı aç ve host'u takip etmeye başla. Zaten açıksa sadece haber ver. */
  private async startSync(info: MediaInfo, forFingerprint: string, manual = false) {
    if (get().role !== 'guest' || !bridge.media) return;
    const audio = this.syncAudioIndex(info);
    if (this.syncMedia?.id === info.id && this.syncAudio === audio) {
      this.send({ t: 'sync', ready: true, fingerprint: forFingerprint });
      return;
    }
    const token = ++this.syncToken;
    this.usePlayer(this.filePlayer);
    const mine = () => token === this.syncToken && get().role === 'guest';
    const still = () => mine() && get().peerFile?.fingerprint === forFingerprint;
    // Canlı dönüştürmede her sarma ffmpeg'i yeniden başlatır; takip edilemez → yayından izlemeye devam.
    const { steps, audioMode } = planPlayback(info, audio);
    let ok = false;
    for (const step of steps.filter((s) => s !== 'live')) {
      try {
        const url = step === 'direct' ? mediaUrl.file(info.id) : await bridge.media.prepare(info.id, audio, audioMode);
        if (!still()) break;
        await this.filePlayer.load(url, { crossOrigin: true, duration: info.duration, startAt: this.syncTarget() });
        ok = true;
        break;
      } catch (err) {
        console.warn(`Senkron: "${step}" olmadı`, err);
      }
    }
    if (!still()) {
      if (mine() && !this.syncMedia) this.player.unload();
      return;
    }
    if (!ok) {
      if (manual) this.hud('Bu dosya kayıpsız oynatılamıyor; yayından izlemeye devam.', 'video-off');
      if (this.syncMedia) this.exitSync(true);
      else this.player.unload();
      return;
    }
    const first = !this.syncMedia;
    this.syncMedia = info;
    this.syncFor = forFingerprint;
    this.syncAudio = audio;
    set({ syncMode: true, source: 'file' });
    this.applyVolume(get().volume, get().muted);
    this.send({ t: 'sync', ready: true, fingerprint: forFingerprint });
    this.followSync();
    if (first) this.hud('Kendi kopyandan izliyorsun · tam kalite', 'sync');
  }

  /** Kopyamda hangi ses çalsın: onun seçtiği dil varsa o, yoksa benim tercihim */
  private syncAudioIndex(info: MediaInfo) {
    const lang = this.peerAudioLanguage;
    const same = lang ? info.audio.find((a) => a.language === lang) : undefined;
    return same ? same.index : pickAudio(info, getSetting('media.audioLanguage'));
  }

  /** Guest: kendi kopyamı bırak, yayından izlemeye dön */
  exitSync(notify = true) {
    this.syncToken++; // süren arama/hazırlık varsa boşa çıksın
    this.cancelScheduledPlay();
    clearTimeout(this.bufferTimer);
    if (this.bufferingSent) {
      this.bufferingSent = false;
      this.send({ t: 'buffering', waiting: false });
    }
    const key = this.syncFor;
    this.syncMedia = null;
    this.syncFor = null;
    // Guest'in oynatıcısında kaynak varsa o, kendi kopyasıdır (host'unkine dokunma).
    if (get().role !== 'host') {
      if (this.player.hasSource) this.player.unload();
      this.player = this.filePlayer;
      this.pendingWeb = null;
      if (get().source) set({ source: null, webVideo: null });
    }
    if (!key) return;
    set({ syncMode: false });
    this.applyVolume(get().volume, get().muted);
    if (notify && !/^(yt|web):/.test(key)) this.send({ t: 'sync', ready: false, fingerprint: key });
    this.bindRemoteStreams();
  }

  /** Guest: "Bende de var" — kendi kopyamı elle seç */
  async useLocalCopy() {
    const ref = get().peerFile;
    if (!bridge.media || !ref || get().role !== 'guest') return;
    let info: MediaInfo | null;
    try {
      info = await bridge.media.openDialog();
    } catch (err) {
      return this.hud(errorText(err), 'video-off');
    }
    if (!info || get().peerFile?.fingerprint !== ref.fingerprint) return;
    // Başka yerden indirilmiş aynı bölüm de olur (parmak izi farklı); süreler tutuyorsa kabul et.
    if (info.fingerprint !== ref.fingerprint && Math.abs(info.duration - get().duration) > 2) {
      return this.hud('Bu, onun açtığı bölüm değil gibi (süreleri farklı).', 'video-off');
    }
    await this.startSync(info, ref.fingerprint, true);
  }

  /** Senkron mod: host'un oynatıcısı şu an nerede? (iki bilgisayarın saat farkı düzeltilmiş) */
  private syncTarget() {
    const s = this.remoteState;
    if (!s) return 0;
    if (!s.playing) return s.pos;
    if (s.at == null || !this.clock.ready) return this.hostPosition();
    const elapsed = Math.max(0, (now() + this.clock.offset - s.at) / 1000);
    return clamp(s.pos + elapsed * s.rate, 0, s.duration || Infinity);
  }

  /** Guest, senkron mod: kendi kopyamı host'un konumuna yaklaştır (saniyede 4 kez) */
  private followSync() {
    const s = this.remoteState;
    const p = this.player;
    if (!get().syncMode || !s || this.followSeeking || p.seeking || p.buffering || !p.hasSource) return;
    const live = this.isTab(p) && p.isLive;
    // Geri sayımlı başlatma: host "şu saatte, şu kareden" dedi → o ana kadar o karede bekle, tam o anda başla.
    const wait = s.playing && s.at != null && this.clock.ready ? s.at - (now() + this.clock.offset) : 0;
    if (wait > 15) {
      if (p.playing) p.pause();
      if (!live && Math.abs(p.time - s.pos) > this.pauseTolerance(p)) {
        this.followSeek(s.pos, false);
        return;
      }
      this.schedulePlay(wait);
      return;
    }
    // Tarayıcıdaki canlı yayında iki oynatıcının zamanı karşılaştırılamaz: sadece oynat/durdur eşitlenir.
    // (Dosya oynatıcısındaki isLive "anında dönüştürme" demek; o sarılarak eşitlenir.)
    if (live) {
      if (s.playing && !p.playing && !p.ended) p.play().catch(() => {});
      else if (!s.playing && p.playing) p.pause();
      return;
    }
    const target = this.syncTarget();
    const drift = p.time - target;
    // Hızı ince ayarlanamayan oynatıcıda kaymayı daha erken, sararak kapat.
    const fine = p.fineRate;
    if (!s.playing) {
      this.cancelScheduledPlay();
      if (p.playing) p.pause();
      if (fine) p.setRate(1);
      // Durunca aynı karede: dosyada bir kare (20 ms), diğerlerinde sarma hassasiyeti kadar
      if (Math.abs(drift) > this.pauseTolerance(p)) this.followSeek(target, false);
      return;
    }
    const limit = this.resyncOnce && p.playing ? (fine ? 0.05 : 0.15) : fine ? 1 : 0.4;
    if (Math.abs(drift) > limit || (!this.player.playing && Math.abs(drift) > 0.3)) {
      if (p.playing) this.resyncOnce = false;
      if (fine) p.setRate(s.rate);
      this.followSeek(target, true);
      return;
    }
    if (!p.playing) {
      if (!p.ended) p.play().catch(() => {});
      return;
    }
    this.resyncOnce = false;
    if (!fine) return;
    // Küçük farkları da kapat (eskiden 20–60 ms arası hiç düzeltilmiyordu): hız farkla orantılı.
    // Planlı başlangıçtan hemen sonra oynatıcının ilk kare gecikmesinden kalan farkı daha hızlı kapat.
    const fresh = performance.now() - this.startedAt < 3000;
    const cap = fresh ? 0.08 : 0.05;
    if (Math.abs(drift) < 0.01) this.player.setRate(s.rate);
    else if (Math.abs(drift) > (fresh ? 0.01 : 0.02)) this.player.setRate(s.rate * clamp(1 - drift * (fresh ? 2 : 1), 1 - cap, 1 + cap));
  }

  /** Guest: planlanan anda başla (kendi oynatıcımın başlama gecikmesi düşülerek) */
  private schedulePlay(waitMs: number) {
    const due = performance.now() + waitMs - this.playLead * 1000;
    if (this.startTimer && Math.abs(due - this.startDue) < 10) return; // zaten bu ana planlı
    clearTimeout(this.startTimer);
    this.startDue = due;
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      if (!get().syncMode || !this.remoteState?.playing) return;
      this.startedAt = performance.now();
      void this.timedPlay();
    }, Math.max(0, due - performance.now()));
  }

  private cancelScheduledPlay() {
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
  }

  /** Dururken aynı karede olmak için tolerans (sn): dosyada bir kare, diğerlerinde sarma hassasiyeti kadar */
  private pauseTolerance(p: Playable) {
    if (p.kind === 'file' && !p.isLive) return 0.02;
    return p.fineRate ? 0.1 : 0.25;
  }

  /** Sarma da zaman alır: oynarken o kadar ilerisine sar, süreyi öğren. */
  private async followSeek(target: number, playing: boolean) {
    this.followSeeking = true;
    const started = performance.now();
    try {
      await this.player.seek(target + (playing ? this.seekLead : 0));
      await seeked(this.player, 3000);
      if (playing) {
        const took = (performance.now() - started) / 1000;
        this.seekLead = clamp(this.seekLead * 0.5 + took * 0.5, 0.03, 1);
      }
    } finally {
      this.followSeeking = false;
    }
  }

  /** Guest, senkron mod: kopyam 1 sn'den uzun takılırsa host beklesin */
  private onLocalWaiting(waiting: boolean) {
    if (get().role !== 'guest' || !get().syncMode) return;
    clearTimeout(this.bufferTimer);
    if (waiting) {
      this.bufferTimer = setTimeout(() => {
        this.bufferingSent = true;
        this.send({ t: 'buffering', waiting: true });
      }, 1000);
    } else if (this.bufferingSent) {
      this.bufferingSent = false;
      this.send({ t: 'buffering', waiting: false });
    }
  }

  /** Host: guest kendi kopyasından izliyor → film yayınını durdur */
  private enterPeerSync() {
    if (!this.peerSyncing) this.hud(`${this.partnerName()} kendi kopyasından izliyor · tam kalite`, 'sync');
    this.peerSyncing = true;
    set({ syncMode: true });
    this.link?.setTrack('movie-video', null, this.movieStream);
    this.link?.setTrack('movie-audio', null, this.movieStream);
    this.broadcast();
  }

  /** Host: guest yayına döndü → yayını yeniden aç */
  private leavePeerSync() {
    if (!this.peerSyncing) return;
    this.resetPeerSync();
    this.publishMovie();
  }

  private resetPeerSync() {
    this.endPeerWait();
    this.peerSyncing = false;
    if (get().role === 'host') set({ syncMode: false });
  }

  /** Host: onun kopyası takıldı; bekle (en fazla 15 sn) */
  private waitForPeer() {
    this.waitingForPeer = true;
    this.player.pause();
    this.hud(`${this.partnerName()} için bekleniyor…`, 'pause');
    clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => this.endPeerWait(true), 15_000);
  }

  private endPeerWait(resume = false) {
    clearTimeout(this.waitTimer);
    if (!this.waitingForPeer) return;
    this.waitingForPeer = false;
    if (resume) this.player.play().then(() => this.broadcast(), () => {});
  }

  // --- YouTube -----------------------------------------------------------------------------------

  /** Host: YouTube bağlantısı aç. O da kendi YouTube'undan, benim saatime göre izler (yayın yok). */
  async openYouTube(input: string) {
    const id = youtubeId(input);
    if (!id) return this.hud('Bu bir YouTube bağlantısı değil', 'video-off');
    const token = ++this.loadToken;
    if (this.media) bridge.media?.cancel(this.media.id);
    this.media = null;
    this.becomeHost('YouTube', true, false, this.youtube);
    this.link?.setTrack('movie-video', null, this.movieStream);
    this.link?.setTrack('movie-audio', null, this.movieStream);
    try {
      await this.youtube.load(id, youtubeStart(input));
    } catch (err) {
      if (token !== this.loadToken) return;
      this.stopHosting();
      this.becomeIdle();
      if (err instanceof YouTubeError && err.embedBlocked) return this.openYouTubeInBrowser(id);
      this.hud(err instanceof Error ? err.message : 'YouTube videosu açılamadı.', 'video-off');
      return;
    }
    if (token !== this.loadToken) return;
    set({ title: this.youtube.title || 'YouTube', duration: this.youtube.duration });
    this.updateStatus();
    this.sendMedia();
    this.broadcast();
  }

  /**
   * Sahibi uygulama içinde (gömülü) oynatmayı kapatmışsa video sadece YouTube'un kendi sitesinde
   * oynar: tarayıcıda açılır, eklenti bağlıysa oradan yine birlikte izlenir.
   */
  private openYouTubeInBrowser(id: string) {
    const url = `https://www.youtube.com/watch?v=${id}`;
    // Uygulama içinde YouTube'un kendi sitesi açılır: gömme kısıtı orada yok.
    if (this.webview) return this.openChannel({ name: 'YouTube', url });
    const ext = useExtension.getState();
    const why = 'Bu videonun sahibi, YouTube dışında oynatılmasına izin vermiyor.';
    if (ext.connected) {
      bridge.extension?.send({ t: 'open', url });
      set({ notice: `${why} Tarayıcında açtım; aşağıda “Birlikte izle”ye bas.` });
    } else if (ext.available) {
      window.open(url, '_blank', 'noopener');
      set({ notice: `${why} Tarayıcında açtım; birlikte izlemek için tarayıcı eklentisini kur (Ayarlar → Genel).` });
    } else {
      set({ notice: why });
    }
  }

  /** Host'ta başlık sonradan gelirse (YouTube, tarayıcı) güncelle */
  private onTitleChange() {
    const title = this.player.kind === 'youtube' ? this.youtube.title : this.isTab(this.player) ? this.player.title : '';
    if (get().role !== 'host' || !title || title === get().title) return;
    const web = get().webVideo;
    set({ title, ...(web && { webVideo: { ...web, title } }) });
    this.updateStatus();
    this.sendMedia();
  }

  // --- Tarayıcıdaki video (Netflix, Disney+, Prime… eklentiyle) -------------------------------

  /**
   * Kanallar: seçilen kanal (canlı TV ya da platform) ikimizin tarayıcısında birden açılır; izlediğim
   * sekme oraya geçer. Bende video belirince birlikte izlemeye geçilir.
   */
  openChannel(channel: Channel) {
    if (this.canEmbed(channel.url)) {
      // Uygulamanın içinde: sayfa hemen burada açılır (çerez onayı, oynat düğmesi…); video belirince birlikte izleriz.
      this.showWebPage(channel.url);
      this.send({ t: 'channel', name: channel.name, url: channel.url });
      this.pendingChannel = { url: channel.url, name: channel.name, embedded: true, until: Date.now() + 15 * 60_000 };
      return;
    }
    const ext = useExtension.getState();
    if (!ext.connected) {
      if (!ext.available) return set({ notice: 'Kanallar masaüstü uygulamasında, tarayıcı eklentisiyle çalışır.' });
      window.open(channel.url, '_blank', 'noopener');
      return set({ notice: `${channel.name} tarayıcında açıldı. Birlikte izlemek için tarayıcı eklentisini kur (Ayarlar → Genel).` });
    }
    set({ notice: null });
    bridge.extension?.send({ t: 'open', url: channel.url, replace: true });
    this.send({ t: 'channel', name: channel.name, url: channel.url });
    this.pendingChannel = { url: channel.url, name: channel.name, embedded: false, until: Date.now() + 15 * 60_000 };
    this.hud(`${channel.name} açılıyor`, 'play');
  }

  /** Uygulama içindeki sayfada "sadece video" ile sayfanın tamamı arasında geçiş */
  toggleWebFocus() {
    set({ webFocus: !get().webFocus });
  }

  /** Bu bağlantı uygulamanın içinde açılabilir mi? (Netflix gibi şifreli platformlar tarayıcıda) */
  private canEmbed(url: string) {
    return !!this.webview && isEmbeddable(url, bridge.embedLocal);
  }

  /** Uygulama içindeki sayfayı göster ve aç; o an izlenen bırakılır (video belirince birlikte izlenir) */
  private showWebPage(url: string) {
    if (get().role === 'host') this.stopHosting();
    if (get().role !== 'idle') this.becomeIdle();
    set({ source: 'web', notice: null });
    this.webview?.open(url);
  }

  /** Host: tarayıcıda açık olan bölümü paylaş. O da kendi tarayıcısında açar, birlikte izleriz. */
  openBrowser() {
    const video = useExtension.getState().video;
    if (!video) return this.hud('Tarayıcıda açık bir bölüm yok', 'video-off');
    this.shareTab(this.browser, video);
  }

  /** Host: sekmedeki (tarayıcı ya da uygulama içi) bölümü paylaş; o da kendi tarafında açar. */
  private shareTab(player: BrowserPlayer, video: BrowserVideo, name?: string) {
    ++this.loadToken;
    if (this.media) bridge.media?.cancel(this.media.id);
    this.media = null;
    const title = name || video.title || video.site;
    this.becomeHost(title, true, false, player);
    this.link?.setTrack('movie-video', null, this.movieStream);
    this.link?.setTrack('movie-audio', null, this.movieStream);
    player.attach();
    set({ title, duration: video.duration, webVideo: { site: video.site, url: video.url, title } });
    this.updateStatus();
    this.sendMedia();
    this.broadcast();
  }

  /** Guest: aynı bölümü kendi tarafımda aç (uygulama içinde ya da tarayıcıda, eklenti) ve host'u takip et */
  private async followBrowser(web: WebVideo) {
    const key = `web:${web.url}`;
    if (this.syncFor === key) return;
    const inApp = this.canEmbed(web.url);
    const player = inApp ? this.web : this.browser;
    set({ source: inApp ? 'web' : 'browser', webVideo: web });
    if (!inApp && (!bridge.extension || !useExtension.getState().connected)) {
      this.pendingWeb = web; // eklenti kurulunca/bağlanınca
      return;
    }
    this.pendingWeb = null;
    const token = ++this.syncToken;
    this.usePlayer(player);
    try {
      await player.open(web.url);
    } catch (err) {
      if (token !== this.syncToken) return;
      this.hud(err instanceof Error ? err.message : 'Tarayıcıda açılamadı', 'video-off');
      return;
    }
    if (token !== this.syncToken || get().role !== 'guest') return;
    this.syncFor = key;
    set({ syncMode: true });
    this.applyVolume(get().volume, get().muted);
    this.followSync();
  }

  /** Guest: aynı videoyu kendi YouTube'umda aç ve host'u takip et */
  private async followYouTube(id: string) {
    if (this.syncFor === `yt:${id}`) return;
    const token = ++this.syncToken;
    this.usePlayer(this.youtube);
    set({ source: 'youtube' }); // çerçeve ekrana yerleşsin (yerleşmeden yüklenmez)
    try {
      await this.youtube.load(id, this.syncTarget());
    } catch (err) {
      if (token !== this.syncToken) return;
      this.hud(err instanceof Error ? err.message : 'YouTube videosu açılamadı.', 'video-off');
      this.exitSync(false);
      return;
    }
    if (token !== this.syncToken || get().role !== 'guest') return;
    this.syncFor = `yt:${id}`;
    set({ syncMode: true });
    this.applyVolume(get().volume, get().muted);
    this.followSync();
  }

  /** Etkin oynatıcıyı değiştir (öncekini boşalt) */
  private usePlayer(player: Playable) {
    if (this.player === player) return;
    if (this.player.hasSource) this.player.unload();
    this.player = player;
  }

  // --- Bölümü ona gönder ------------------------------------------------------------------------

  /** Host: açık bölümü ona gönder; gelince ikimiz de kendi kopyamızdan izleriz */
  sendFile() {
    if (get().role !== 'host' || !this.media || !this.link?.isOpen || !get().peerDesktop || this.peerSyncing) return;
    this.transfer.offer(this.media);
  }

  cancelTransfer() {
    this.transfer.cancel();
  }

  private onFileReceived(info: MediaInfo) {
    const ref = get().peerFile;
    if (get().role === 'guest' && ref?.fingerprint === info.fingerprint && !this.syncMedia) {
      this.startSync(info, ref.fingerprint, true);
    } else {
      this.hud(`Bölüm geldi · ${info.name}`, 'download');
    }
  }

  // --- Kamera ve mikrofon ---------------------------------------------------------------------

  private micOn() {
    return !!this.micTrack?.enabled;
  }

  private camConstraints(): MediaTrackConstraints {
    const h = getSetting('camera.resolution');
    return { width: { ideal: Math.round((h * 16) / 9) }, height: { ideal: h }, frameRate: { ideal: 30 } };
  }

  private micConstraints(): MediaTrackConstraints {
    return {
      echoCancellation: getSetting('audio.echoCancellation'),
      noiseSuppression: getSetting('audio.noiseSuppression'),
      autoGainControl: true,
    };
  }

  private async openDevices(cam: boolean, mic: boolean) {
    if (!cam && !mic) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: cam && this.camConstraints(),
        audio: mic && this.micConstraints(),
      });
      if (cam) this.useCamTrack(s.getVideoTracks()[0] ?? null);
      if (mic) this.useMicTrack(s.getAudioTracks()[0] ?? null);
    } catch {
      // Biri yoksa (ör. kamera takılı değil) diğeri yine çalışsın.
      if (cam) await this.setCam(true);
      if (mic) await this.setMic(true);
    }
  }

  private useCamTrack(track: MediaStreamTrack | null) {
    if (track && !get().active) return track.stop(); // bu arada ekrandan çıkıldı
    this.camTrack?.stop();
    this.camTrack = track;
    if (track) {
      this.trackRoles.set(track.id, 'cam');
      this.recoverWhenEnded('cam', track);
    }
    this.applyCamEffect();
    this.send({ t: 'cam', on: !!track });
    set({ camOn: !!track });
  }

  /** Arka plan ayarına göre kameranın kendisini ya da bulanık kopyasını gönder ve göster. */
  private async applyCamEffect() {
    const raw = this.camTrack;
    const mode = getSetting('camera.background');
    let out = raw;
    if (raw && (mode === 'light' || mode === 'strong')) {
      // İşlenmiş kopya hazırlanana kadar kameranın kendisi görünsün (gecikmesin).
      if (!this.camOut) this.useCamOut(raw);
      try {
        out = await this.blur.start(raw, mode);
      } catch (err) {
        console.warn('Arka plan bulanıklaştırılamadı', err);
        this.hud('Arka plan bulanıklaştırma açılamadı', 'video-off');
      }
      if (this.camTrack !== raw) return; // bu arada kamera değişti
    } else {
      this.blur.stop();
    }
    this.useCamOut(out);
  }

  private useCamOut(track: MediaStreamTrack | null) {
    if (this.camOut === track) return;
    this.camOut = track;
    if (track) this.trackRoles.set(track.id, 'cam');
    this.localCam.srcObject = track ? new MediaStream([track]) : null;
    this.link?.setTrack('cam-video', track, this.camStream, { maxBitrate: 1_200_000 });
  }

  private useMicTrack(track: MediaStreamTrack | null) {
    if (track && !get().active) return track.stop();
    this.micTrack?.stop();
    this.micTrack = track;
    if (track) {
      this.trackRoles.set(track.id, 'cam');
      this.recoverWhenEnded('mic', track);
    }
    this.link?.setTrack('cam-audio', track, this.camStream, { maxBitrate: 64_000 });
    this.send({ t: 'mic', on: this.micOn() });
    set({ micOn: this.micOn() });
  }

  /**
   * Cihaz kendiliğinden kapanırsa (kablo çıktı, başka uygulama kamerayı aldı, bilgisayar uyudu)
   * baloncuk donuk kalmasın: kapalı göster ve birkaç kez artan aralıklarla yeniden açmayı dene.
   */
  private recoverWhenEnded(kind: 'cam' | 'mic', track: MediaStreamTrack) {
    // Bir süre sorunsuz çalıştıysa deneme sayacını sıfırla.
    const healthy = setTimeout(() => track.readyState === 'live' && (this.deviceRetries[kind] = 0), 15_000);
    track.addEventListener('ended', () => {
      clearTimeout(healthy);
      const current = kind === 'cam' ? this.camTrack : this.micTrack;
      if (current !== track || !get().active) return;
      const wasOn = kind === 'cam' || track.enabled;
      if (kind === 'cam') this.useCamTrack(null);
      else this.useMicTrack(null);
      if (wasOn) this.reopenDevice(kind); // sessizdeki mikrofonu kendiliğinden açmayalım
    });
  }

  private reopenDevice(kind: 'cam' | 'mic') {
    const attempt = ++this.deviceRetries[kind];
    if (attempt > 4) {
      return this.hud(kind === 'cam' ? 'Kamera kapandı' : 'Mikrofon kapandı', kind === 'cam' ? 'video-off' : 'mic-off');
    }
    setTimeout(async () => {
      // Bu arada ekrandan çıkıldıysa ya da kullanıcı kendisi açtıysa bir şey yapma.
      if (!get().active || (kind === 'cam' ? this.camTrack : this.micTrack)) return;
      try {
        const s = await getUserMediaWithin(
          kind === 'cam' ? { video: this.camConstraints() } : { audio: this.micConstraints() },
          8000,
        );
        const track = (kind === 'cam' ? s.getVideoTracks() : s.getAudioTracks())[0];
        if (!track) throw new Error('iz yok');
        if (kind === 'cam') this.useCamTrack(track);
        else this.useMicTrack(track);
      } catch {
        this.reopenDevice(kind);
      }
    }, 1000 * attempt);
  }

  async setCam(on: boolean) {
    if (!on) return this.useCamTrack(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.camConstraints() });
      this.useCamTrack(s.getVideoTracks()[0] ?? null);
    } catch {
      this.hud('Kameraya erişilemedi', 'video-off');
    }
  }

  async setMic(on: boolean) {
    if (on && !this.micTrack) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints() });
        this.useMicTrack(s.getAudioTracks()[0] ?? null);
      } catch {
        this.hud('Mikrofona erişilemedi', 'mic-off');
      }
      return;
    }
    if (this.micTrack) this.micTrack.enabled = on;
    this.send({ t: 'mic', on: this.micOn() });
    set({ micOn: this.micOn() });
  }

  toggleCam() {
    return this.setCam(!this.camTrack);
  }

  toggleMic() {
    return this.setMic(!this.micOn());
  }

  /** Mikrofon ayarı değişti: yeni ayarlarla yeniden aç (sessizse sessiz kalsın). */
  private async reopenMic() {
    if (!this.micTrack) return;
    const wasOn = this.micOn();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints() });
      const track = s.getAudioTracks()[0] ?? null;
      if (track) track.enabled = wasOn;
      this.useMicTrack(track);
    } catch {
      this.hud('Mikrofon yeniden açılamadı', 'mic-off');
    }
  }

  // --- Ses, tepkiler, bildirim -----------------------------------------------------------------

  applyVolume(volume: number, muted: boolean) {
    // Sadece kendi duyduğumuz ses; karşıya giden film sesi bundan etkilenmez.
    for (const el of [this.localMovie, this.remoteMovie]) {
      el.volume = clamp(volume * this.duckFactor, 0, 1);
      // Senkron modda kendi kopyamı duyarım; geçişteki yarım saniyelik yayın sesi üst üste binmesin.
      el.muted = muted || (el === this.remoteMovie && get().syncMode);
    }
    this.youtube.setVolume(clamp(volume * this.duckFactor, 0, 1), muted);
    this.browser.setVolume(clamp(volume * this.duckFactor, 0, 1), muted);
    this.web.setVolume(clamp(volume * this.duckFactor, 0, 1), muted);
    set({ volume, muted });
  }

  setVolume(volume: number) {
    this.applyVolume(volume, false);
    setSetting('ui.volume', volume);
  }

  toggleMute() {
    this.applyVolume(get().volume, !get().muted);
  }

  sendReaction(kind: Reaction = 'heart') {
    this.floatReaction(kind);
    this.send({ t: 'react', kind });
  }

  private floatReaction(kind: Reaction) {
    const id = ++this.hudId;
    set({ reactions: [...get().reactions, { id, kind }] });
    setTimeout(() => set({ reactions: get().reactions.filter((r) => r.id !== id) }), 2800);
  }

  hud(text: string, icon: HudIcon) {
    set({ hud: { id: ++this.hudId, text, icon } });
  }

  // --- Ayar değişiklikleri ----------------------------------------------------------------------

  private onSetting(key: SettingKey, value: unknown, origin: 'local' | 'peer') {
    if (settingDef(key).shared && origin === 'local') {
      this.send({ t: 'setting', key, value: value as string | number | boolean });
    }
    switch (key) {
      case 'video.codec':
        this.link?.setCodec(String(value));
        break;
      case 'video.maxBitrate':
        this.link?.setEncoding('movie-video', { maxBitrate: Number(value) * 1_000_000 });
        break;
      case 'audio.movieQuality':
        this.link?.setEncoding('movie-audio', { maxBitrate: Number(value) * 1000 });
        break;
      case 'video.priority':
        this.captured?.getVideoTracks().forEach((t) => (t.contentHint = String(value)));
        break;
      case 'camera.resolution':
        this.camTrack?.applyConstraints(this.camConstraints()).catch(() => {});
        break;
      case 'camera.background':
        this.applyCamEffect();
        break;
      case 'audio.echoCancellation':
      case 'audio.noiseSuppression':
        this.reopenMic();
        break;
      case 'audio.ducking':
      case 'audio.duckingLevel':
        this.updateDucking();
        break;
      case 'connection.turn':
        // Yeni ayarla bağlantıyı baştan kur.
        if (this.link) {
          this.stopLink();
          this.evaluateLink();
        }
        break;
    }
  }
}

// --- Yardımcılar ---------------------------------------------------------------------------------

/** getUserMedia takılırsa vazgeç; geç gelen akışı da kapat ki kamera ışığı yanık kalmasın. */
function getUserMediaWithin(constraints: MediaStreamConstraints, ms: number): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('zaman aşımı'));
    }, ms);
    navigator.mediaDevices.getUserMedia(constraints).then(
      (s) => {
        clearTimeout(timer);
        if (timedOut) s.getTracks().forEach((t) => t.stop());
        else resolve(s);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Akışa sonradan iz eklenirse (önce görüntü, sonra ses gibi) öğeyi tazeler. */
function attach(el: HTMLVideoElement, stream: MediaStream) {
  const count = String(stream.getTracks().length);
  if (el.srcObject === stream && el.dataset.tracks === count) return;
  el.srcObject = stream;
  el.dataset.tracks = count;
  el.play().catch(() => {});
}

/** Sarma bitene kadar bekle (zaten bittiyse hemen) */
function seeked(player: Playable, ms: number) {
  if (!player.seeking) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      player.events.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    player.events.addEventListener('seeked', done);
  });
}

/** C:\a\b.mkv → C:\a ; /a/b.mkv → /a */
function parentDir(path: string) {
  return path.replace(/[\\/][^\\/]*$/, '') || path;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return /Invalid data|could not find codec|moov atom/i.test(msg) ? 'Bu dosya bozuk ya da bir video değil.' : 'Dosya açılamadı.';
}

export function formatOffset(sec: number) {
  if (!sec) return 'senkron (0 sn)';
  return `${sec > 0 ? '+' : '−'}${Math.abs(sec).toFixed(2).replace('.', ',').replace(/,?0+$/, '')} sn`;
}

export function formatTime(sec: number) {
  const t = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const watch = new WatchController();
