// İzleme ekranı: önce içerik. Film tam ekran; kontroller fare kıpırdayınca belirir.

import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  AudioLines,
  Captions,
  ChevronLeft,
  Download,
  FastForward,
  Focus,
  FolderOpen,
  Heart,
  Link,
  Lock,
  Maximize,
  Mic,
  MicOff,
  Minimize,
  PanelTop,
  Pause,
  Play,
  Settings as SettingsIcon,
  Sparkles,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { StatsSummary, StreamStat } from '../net/stats';
import { usePresence } from '../session/session';
import { getSetting, setSetting, useSetting } from '../settings/store';
import { Button, IconButton, Spinner, cx } from '../ui/controls';
import { HeartFilled, SkipIcon } from '../ui/icons';
import { youtubeId } from '../media/youtube';
import { formatTime, useWatch, watch, type HudIcon } from '../watch/controller';
import { BrowserOffer, BrowserStage } from './watch/BrowserStage';
import { ChannelGrid, ChannelsMenu } from './watch/Channels';
import { MediaMenu } from './watch/MediaMenu';
import { PreparingOverlay } from './watch/PreparingOverlay';
import { FloatingReactions, ReactionPicker } from './watch/Reactions';
import { SubtitleOverlay } from './watch/SubtitleOverlay';
import { TransferPill } from './watch/Transfer';

/** Telefon, tablet ya da dokunmatik dizüstü: kararı her dokunuşun kendi türüne göre veririz. */
const isTouch = (e: { pointerType?: string }) => e.pointerType === 'touch' || e.pointerType === 'pen';

export function Watch({
  onBack,
  onSettings,
  keysEnabled,
}: {
  onBack: () => void;
  onSettings: () => void;
  /** Ayarlar açıkken kısayollar susar */
  keysEnabled: boolean;
}) {
  const s = useWatch();
  const keys = useRef(keysEnabled);
  keys.current = keysEnabled;
  const skip = useSetting('playback.skip');
  const name = usePartnerName();
  const [uiVisible, setUiVisible] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // --- Kontrolleri otomatik gizle -------------------------------------------------
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holdUi = useRef({ hover: false, stats: false, menu: false });
  holdUi.current.stats = statsOpen;
  const holdMenu = (open: boolean) => (holdUi.current.menu = open);
  const poke = useRef(() => {});
  poke.current = () => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(function check() {
      const { hover, stats, menu } = holdUi.current;
      const busy = !useWatch.getState().playing || hover || stats || menu;
      if (busy) hideTimer.current = setTimeout(check, 1000);
      else setUiVisible(false);
    }, 2800);
  };
  useEffect(() => {
    poke.current();
    // Fare uygulama içindeki sayfanın üstündeyken olaylar sayfaya gider; sayfa hareketi ayrıca bildirir.
    const offWebPoke = watch.webview?.onPoke(() => poke.current());
    return () => {
      clearTimeout(hideTimer.current);
      offWebPoke?.();
    };
  }, []);
  const showUi = uiVisible || !s.playing || s.role === 'idle';

  // --- Klavye -------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).matches('input:not([type=range]), select, textarea')) return;
      if (!keys.current) return;
      const step = getSetting('playback.skip');
      const actions: Record<string, () => void> = {
        Space: () => watch.command('toggle'),
        ArrowLeft: () => watch.command('skip', -step),
        ArrowRight: () => watch.command('skip', step),
        KeyF: toggleFullscreen,
        KeyM: () => watch.toggleMic(),
        KeyC: () => watch.toggleCam(),
        KeyH: () => watch.sendReaction('heart'),
        KeyS: () => watch.subtitles.toggle(),
        BracketLeft: () => watch.shiftSubtitles(-0.25),
        BracketRight: () => watch.shiftSubtitles(0.25),
        Escape: () => setStatsOpen(false),
      };
      const fn = actions[e.code];
      if (!fn) return;
      e.preventDefault();
      fn();
      poke.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘V / Ctrl+V ile YouTube bağlantısı yapıştırınca birlikte izlenir.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!keys.current || (e.target as HTMLElement).matches('input, textarea')) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!isYouTubeLink(text)) return;
      e.preventDefault();
      watch.openYouTube(text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.current?.requestFullscreen().catch(() => {});
  }

  // Fareyle: filme tek tık oynat/durdur, çift tık tam ekran.
  // Dokunarak: tek dokunuş sadece kontrolleri açar/kapatır (yanlışlıkla durdurmasın).
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touchedMovie = useRef(false);
  const onMoviePointerDown = (e: ReactPointerEvent) => {
    touchedMovie.current = isTouch(e);
  };
  const onMovieClick = () => {
    clearTimeout(clickTimer.current);
    if (touchedMovie.current) {
      if (uiVisible) setUiVisible(false);
      else poke.current();
      return;
    }
    clickTimer.current = setTimeout(() => watch.command('toggle'), 220);
  };
  const onMovieDoubleClick = () => {
    clearTimeout(clickTimer.current);
    if (!touchedMovie.current) toggleFullscreen();
  };

  // Masaüstünde sistemin dosya penceresi (her format), tarayıcıda dosya seçici
  const pickFile = () => (watch.canConvert ? watch.openDialog() : fileInput.current?.click());
  const active = s.role !== 'idle';

  return (
    <div
      ref={root}
      className={cx('screen', 'watch', !showUi && 'ui-hidden', dropping && 'dropping', s.source === 'youtube' && 'source-youtube')}
      onPointerMove={() => poke.current()}
      onPointerDown={(e) => {
        // Dokunmatikte filme dokunuş kontrolleri kendisi açıp kapatır (aşağıda); burada açarsak
        // hemen ardından gelen tıklama onları tekrar kapatırdı.
        if (isTouch(e) && (e.target as HTMLElement).classList.contains('movie-hit')) return;
        poke.current();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer.files[0];
        if (file) watch.openFile(file);
      }}
    >
      {/* Host kendi oynatıcısını görür; guest yayını, senkron moddaysa kendi kopyasını ya da YouTube'u. */}
      <MediaSlot element={watch.localMovie} className="movie" hidden={s.source !== 'file'} />
      <MediaSlot element={watch.remoteMovie} className="movie" hidden={!(s.role === 'guest' && !s.syncMode)} />
      <MediaSlot element={watch.youtube.el} className="movie youtube" hidden={s.source !== 'youtube'} />
      {/* Kanallar ve YouTube: sitenin kendisi uygulamanın içinde; sayfayla etkileşim serbest */}
      {watch.webview && <MediaSlot element={watch.webview.el} className="movie web" hidden={s.source !== 'web'} />}
      {active && s.source !== 'web' && (
        <div
          className="movie-hit"
          onPointerDown={onMoviePointerDown}
          onClick={onMovieClick}
          onDoubleClick={onMovieDoubleClick}
        />
      )}

      {active && <SubtitleOverlay raised={showUi} />}
      {s.source === 'browser' && <BrowserStage partner={name} onSettings={onSettings} />}
      {!active && !s.preparing && s.source !== 'web' && <EmptyState name={name} peerHere={s.peerHere} onPick={pickFile} />}
      {s.preparing && <PreparingOverlay preparing={s.preparing} partner={name} />}
      {s.role === 'guest' && s.connection !== 'connected' && !s.preparing && (
        <div className="watch-overlay">
          <Spinner />
          <span>Yeniden bağlanıyor…</span>
        </div>
      )}

      <header className="watch-topbar chrome drag">
        <IconButton label="Ana ekran" onClick={onBack}>
          <ChevronLeft />
        </IconButton>
        <div className="watch-title">{s.title || 'Birlikte İzle'}</div>
        <TransferPill />
        <PresencePill name={name} />
        {s.source === 'web' && active && (
          <IconButton label={s.webFocus ? 'Sayfayı göster' : 'Sadece video'} onClick={() => watch.toggleWebFocus()}>
            {s.webFocus ? <PanelTop /> : <Focus />}
          </IconButton>
        )}
        <ChannelsMenu />
        <IconButton label="Dosya aç" onClick={pickFile}>
          <FolderOpen />
        </IconButton>
        <IconButton label="Bağlantı bilgisi" onClick={() => setStatsOpen((v) => !v)}>
          <Activity />
        </IconButton>
        <IconButton label="Ayarlar" onClick={onSettings}>
          <SettingsIcon />
        </IconButton>
      </header>
      <ConnectionHelp />

      <CamBubbles name={name} />

      {active && (
        <footer
          className="controls chrome glass"
          onPointerEnter={() => (holdUi.current.hover = true)}
          onPointerLeave={() => (holdUi.current.hover = false)}
          onPointerUp={(e) => {
            // Fareyle basılan düğme odakta kalmasın; yoksa Boşluk onu da tetikler.
            const button = (e.target as HTMLElement).closest('button');
            requestAnimationFrame(() => button?.blur());
          }}
        >
          <Timeline pos={s.pos} duration={s.duration} live={s.live} />
          <div className="controls-row">
            <div className="controls-group">
              <IconButton label={s.muted ? 'Sesi aç' : 'Sesi kapat'} onClick={() => watch.toggleMute()}>
                {s.muted || s.volume === 0 ? <VolumeX /> : <Volume2 />}
              </IconButton>
              <input
                type="range"
                className="range volume"
                min={0}
                max={1}
                step={0.01}
                value={s.muted ? 0 : s.volume}
                aria-label="Ses"
                style={{ '--p': `${(s.muted ? 0 : s.volume) * 100}%` } as CSSProperties}
                onChange={(e) => watch.setVolume(Number(e.target.value))}
              />
            </div>
            <div className="controls-group center">
              <IconButton label={`${skip} sn geri (←)`} onClick={() => watch.command('skip', -skip)}>
                <SkipIcon direction="back" seconds={skip} />
              </IconButton>
              <IconButton label={s.playing ? 'Durdur (Boşluk)' : 'Oynat (Boşluk)'} large onClick={() => watch.command('toggle')}>
                {s.playing ? <Pause fill="currentColor" strokeWidth={0} /> : <Play fill="currentColor" strokeWidth={0} />}
              </IconButton>
              <IconButton label={`${skip} sn ileri (→)`} onClick={() => watch.command('skip', skip)}>
                <SkipIcon direction="forward" seconds={skip} />
              </IconButton>
            </div>
            <div className="controls-group end">
              <MediaMenu onOpenChange={holdMenu} />
              <ReactionPicker onOpenChange={holdMenu} />
              <IconButton label="Mikrofon (M)" off={!s.micOn} onClick={() => watch.toggleMic()}>
                {s.micOn ? <Mic /> : <MicOff />}
              </IconButton>
              <IconButton label="Kamera (C)" off={!s.camOn} onClick={() => watch.toggleCam()}>
                {s.camOn ? <Video /> : <VideoOff />}
              </IconButton>
              <IconButton label="Tam ekran (F)" className="fs-btn" onClick={toggleFullscreen}>
                {fullscreen ? <Minimize /> : <Maximize />}
              </IconButton>
            </div>
          </div>
        </footer>
      )}

      {!active && (
        <div className="idle-dock chrome">
          <IconButton label="Mikrofon (M)" off={!s.micOn} onClick={() => watch.toggleMic()}>
            {s.micOn ? <Mic /> : <MicOff />}
          </IconButton>
          <IconButton label="Kamera (C)" off={!s.camOn} onClick={() => watch.toggleCam()}>
            {s.camOn ? <Video /> : <VideoOff />}
          </IconButton>
          <IconButton label="Kalp gönder (H)" onClick={() => watch.sendReaction('heart')}>
            <Heart />
          </IconButton>
        </div>
      )}

      <AnimatePresence>
        {statsOpen && (
          <motion.aside
            className="stats-panel glass"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          >
            <h3>Bağlantı Bilgisi</h3>
            <StatsRows stats={s.stats} role={s.role} />
          </motion.aside>
        )}
      </AnimatePresence>

      <FloatingReactions />
      <Hud />

      <input
        ref={fileInput}
        type="file"
        accept="video/*,.mkv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) watch.openFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// --- Parçalar ---------------------------------------------------------------------------

function usePartnerName() {
  const nickname = useSetting('profile.partnerNickname').trim();
  const stored = useSetting('pairing.partnerName');
  const peer = usePresence((p) => p.peer);
  return nickname || peer?.name || stored || 'O';
}

/** Kontrolcünün sahip olduğu <video> öğesini bu bileşenin içine yerleştirir. */
function MediaSlot({ element, className, hidden }: { element: HTMLElement; className: string; hidden?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current!;
    element.className = className;
    el.appendChild(element);
    if (element instanceof HTMLVideoElement && element.autoplay && element.srcObject) element.play().catch(() => {});
    return () => {
      if (element.parentNode === el) el.removeChild(element);
    };
  }, [element, className]);
  return <div ref={host} className="media-slot" hidden={hidden} />;
}

function EmptyState({ name, peerHere, onPick }: { name: string; peerHere: boolean; onPick: () => void }) {
  const peer = usePresence((p) => p.peer);
  const text = peerHere
    ? 'Bir bölüm seç, o da anında görsün.'
    : peer
      ? `${name} henüz ana ekranda. Sen hazırlanırken o da gelebilir.`
      : `${name} çevrimdışı. Bölümü açabilirsin; gelince kaldığın yerden görecek.`;
  // Bu cihaz film paylaşamıyorsa (ör. iPhone Safari) sadece izleyici olur.
  if (!watch.canHost) {
    return (
      <div className="empty">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h2>{peerHere ? `${name} burada` : `${name} bekleniyor`}</h2>
          <p>{name} bir bölüm açınca film burada başlayacak. Sen de oynatıp durdurabileceksin.</p>
          <Notice />
          <YouTubeField />
          <ChannelGrid />
        </motion.div>
      </div>
    );
  }
  return (
    <div className="empty">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      >
        <h2>{peerHere ? `${name} burada` : 'Bir bölüm seç'}</h2>
        <p>{text}</p>
        <Notice />
        <Button size="large" onClick={onPick}>
          <FolderOpen />
          Dosya Seç
        </Button>
        <p className="empty-hint">
          {watch.canConvert ? 'ya da dosyayı buraya sürükle · MKV, AVI, MP4… hepsi açılır' : 'ya da dosyayı buraya sürükle'}
        </p>
        <YouTubeField />
        <ChannelGrid />
        <BrowserOffer />
      </motion.div>
    </div>
  );
}

/** Boş ekranda kalıcı açıklama (kapatılabilir) */
function Notice() {
  const notice = useWatch((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="empty-notice" role="status">
      <span>{notice}</span>
      <button type="button" aria-label="Kapat" onClick={() => useWatch.setState({ notice: null })}>
        <X />
      </button>
    </div>
  );
}

/** Uzun süre bağlanılamayınca sebebi ya da sürüm uyarısı (kapatılabilir; durum düzelince kendiliğinden kalkar) */
function ConnectionHelp() {
  const help = useWatch((s) => s.connectionHelp);
  const version = useWatch((s) => s.versionNotice);
  const text = help ?? version;
  if (!text) return null;
  return (
    <div className="empty-notice connection-help" role="alert">
      <span>{text}</span>
      <button type="button" aria-label="Kapat" onClick={() => useWatch.setState(help ? { connectionHelp: null } : { versionNotice: null })}>
        <X />
      </button>
    </div>
  );
}

const isYouTubeLink = (text: string) => /youtu\.?be/i.test(text) && !!youtubeId(text);

/** "ya da YouTube bağlantısı yapıştır": ikiniz de YouTube'dan, aynı anda izlersiniz */
function YouTubeField() {
  const [value, setValue] = useState('');
  const ok = isYouTubeLink(value);
  return (
    <form
      className="yt-field"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) watch.openYouTube(value);
      }}
    >
      <Link />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="YouTube bağlantısı yapıştır"
        aria-label="YouTube bağlantısı"
        spellCheck={false}
      />
      {ok && (
        <button type="submit" className="yt-open">
          Aç
        </button>
      )}
    </form>
  );
}

function PresencePill({ name }: { name: string }) {
  const connection = useWatch((s) => s.connection);
  const rtt = useWatch((s) => s.stats?.rtt ?? null);
  const peer = usePresence((p) => p.peer);
  let color = '';
  let text: string;
  if (connection === 'connected') {
    color = rtt == null || rtt < 0.15 ? 'green' : rtt < 0.3 ? 'orange' : 'red';
    text = `${name} burada`;
  } else if (connection === 'reconnecting') {
    color = 'orange';
    text = 'Yeniden bağlanıyor…';
  } else if (connection === 'connecting') {
    color = 'orange';
    text = 'Bağlanıyor…';
  } else {
    text = peer ? `${name} ana ekranda` : `${name} çevrimdışı`;
  }
  return (
    <span className="pill glass" role="status">
      <span className={cx('dot', color)} />
      {text}
    </span>
  );
}

function Timeline({ pos, duration, live }: { pos: number; duration: number; live: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  // Canlı yayında zaman çizelgesi anlamsız (iki oynatıcının zamanı farklı, sarma yok)
  if (live) {
    return (
      <div className="timeline live">
        <span className="live-badge">CANLI</span>
      </div>
    );
  }
  const shown = drag ?? pos;
  const commit = () => {
    if (drag == null) return;
    watch.command('seek', drag);
    setDrag(null);
  };
  return (
    <div className="timeline">
      <span className="time">{formatTime(shown)}</span>
      <input
        type="range"
        className="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={shown}
        aria-label="Zaman çizelgesi"
        style={{ '--p': `${duration ? (shown / duration) * 100 : 0}%` } as CSSProperties}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="time end">{duration ? `-${formatTime(duration - shown)}` : '0:00'}</span>
    </div>
  );
}

const SIZES = { small: [150, 96], medium: [208, 132], large: [300, 180] } as const;
/** Telefon: baloncuklar küçük ve videonun üstündeki boş bantta yan yana */
const COMPACT_SIZES = { small: [96, 64], medium: [124, 84], large: [156, 104] } as const;

function useNarrow() {
  const query = '(max-width: 700px)';
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

type CamWho = 'peer' | 'self';
const CAM_WIDTH_KEY = { peer: 'ui.camPeerWidth', self: 'ui.camSelfWidth' } as const;
/** Köşedeki tutamacın sürükleme yönü (baloncuklar hangi köşedeyse tutamaç ekranın ortasına bakar) */
const RESIZE_DIR: Record<string, [number, number]> = { tl: [1, 1], tr: [-1, 1], bl: [1, -1], br: [-1, -1] };
const camMaxWidth = () => Math.round(Math.min(960, innerWidth * 0.6));
const clampCam = (w: number) => Math.round(Math.max(100, Math.min(camMaxWidth(), w)));
/** Sürüklerken uygulama içindeki sayfa fareyi kapmasın */
const camsBusy = (on: boolean) => document.body.classList.toggle('cams-busy', on);

/**
 * Kamera baloncukları: sürükle, bırakınca en yakın köşeye yaylanarak otursun. Köşedeki tutamaçla
 * her biri ayrı ayrı boyutlandırılır (hatırlanır); onunkine çift tıklayınca büyür / eski boyuna döner.
 */
function CamBubbles({ name }: { name: string }) {
  const { peerHere, peerCamOn, peerMicOn, camOn, micOn } = useWatch();
  const me = useSetting('profile.name');
  const mirror = useSetting('camera.mirror');
  const size = useSetting('camera.bubbleSize') as keyof typeof SIZES;
  const corner = useSetting('ui.camCorner');
  const peerCustom = Number(useSetting('ui.camPeerWidth')) || 0;
  const selfCustom = Number(useSetting('ui.camSelfWidth')) || 0;
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const resize = useRef<{ who: CamWho; x: number; y: number; from: number } | null>(null);
  const [resizing, setResizing] = useState<{ who: CamWho; width: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const narrow = useNarrow();
  const table = narrow ? COMPACT_SIZES : SIZES;
  const [big, small] = table[size] ?? table.medium;

  // Ayarlar → Kamera'dan hazır boy seçilince köşeden verilen boyutlar sıfırlanır.
  const lastSize = useRef(size);
  useEffect(() => {
    if (lastSize.current === size) return;
    lastSize.current = size;
    setSetting('ui.camPeerWidth', 0);
    setSetting('ui.camSelfWidth', 0);
    setZoomed(false);
  }, [size]);

  const widthOf = (who: CamWho) => {
    if (narrow) return who === 'peer' ? big : small;
    if (resizing?.who === who) return resizing.width;
    if (who === 'peer' && zoomed) return camMaxWidth();
    const custom = who === 'peer' ? peerCustom : selfCustom;
    return custom ? clampCam(custom) : who === 'peer' ? big : small;
  };

  const startResize = (who: CamWho) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation(); // baloncukları taşıma başlamasın
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { who, x: e.clientX, y: e.clientY, from: widthOf(who) };
    setResizing({ who, width: widthOf(who) });
    camsBusy(true);
  };
  const moveResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const r = resize.current;
    if (!r) return;
    const [sx, sy] = RESIZE_DIR[corner as string] ?? RESIZE_DIR.br!;
    const dx = (e.clientX - r.x) * sx;
    const dy = (e.clientY - r.y) * sy * (16 / 9); // yükseklik değişimini genişliğe çevir
    setResizing({ who: r.who, width: clampCam(r.from + (Math.abs(dx) >= Math.abs(dy) ? dx : dy)) });
  };
  const endResize = () => {
    const r = resize.current;
    resize.current = null;
    camsBusy(false);
    if (!r || !resizing) return setResizing(null);
    setSetting(CAM_WIDTH_KEY[r.who], resizing.width);
    if (r.who === 'peer') setZoomed(false);
    setResizing(null);
  };
  const handle = (who: CamWho) =>
    narrow ? undefined : (
      <span
        className="bubble-resize"
        role="separator"
        aria-label="Boyutlandır"
        onPointerDown={startResize(who)}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );

  const end = () => {
    const el = box.current;
    const d = drag.current;
    drag.current = null;
    camsBusy(false);
    if (!el || !d?.moved) return;
    el.classList.remove('dragging');
    const before = el.getBoundingClientRect();
    const midX = before.left + before.width / 2;
    const midY = before.top + before.height / 2;
    const next = (midY < innerHeight / 2 ? 't' : 'b') + (midX < innerWidth / 2 ? 'l' : 'r');
    el.style.transform = '';
    el.dataset.corner = next;
    const after = el.getBoundingClientRect();
    el.animate(
      [{ transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` }, { transform: 'none' }],
      { duration: 420, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1.12)' },
    );
    setSetting('ui.camCorner', next);
  };

  return (
    <div
      ref={box}
      className={cx('cams', resizing && 'resizing')}
      data-corner={corner}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // Düğme baloncuğun dışında bırakıldıysa (fare yakalanmadan önce) sürükleme yok
        if (!e.buttons) return void (drag.current = null);
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) {
          // Fare ancak sürükleme başlayınca yakalanır; yoksa tıklamalar (çift tıkla büyüt) baloncuğa ulaşmaz.
          e.currentTarget.setPointerCapture(e.pointerId);
          camsBusy(true);
        }
        d.moved = true;
        e.currentTarget.classList.add('dragging');
        e.currentTarget.style.transform = `translate(${dx}px, ${dy}px)`;
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {peerHere && (
        <Bubble
          width={widthOf('peer')}
          off={!peerCamOn}
          micOff={!peerMicOn}
          name={name}
          label={name}
          resize={handle('peer')}
          onDoubleClick={narrow ? undefined : () => setZoomed((z) => !z)}
        >
          <MediaSlot element={watch.remoteCam} className="cam-video" />
        </Bubble>
      )}
      <Bubble width={widthOf('self')} off={!camOn} micOff={!micOn} name={me} mirror={mirror} resize={handle('self')}>
        <MediaSlot element={watch.localCam} className="cam-video" />
      </Bubble>
    </div>
  );
}

function Bubble({
  width,
  off,
  micOff,
  name,
  label,
  mirror,
  resize,
  onDoubleClick,
  children,
}: {
  width: number;
  off: boolean;
  micOff: boolean;
  name: string;
  label?: string;
  mirror?: boolean;
  /** Köşedeki boyutlandırma tutamacı */
  resize?: ReactNode;
  onDoubleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cx('bubble', off && 'off', mirror && 'mirror')} style={{ width }} onDoubleClick={onDoubleClick}>
      {children}
      {resize}
      <span className="bubble-initial" style={{ fontSize: width * 0.16 }}>
        {(name || '?').charAt(0).toLocaleUpperCase('tr-TR')}
      </span>
      {label && <span className="bubble-name">{label}</span>}
      {micOff && (
        <span className="bubble-muted" aria-label="Mikrofon kapalı">
          <MicOff />
        </span>
      )}
    </div>
  );
}

const HUD_ICONS: Record<HudIcon, ReactNode> = {
  play: <Play fill="currentColor" strokeWidth={0} />,
  pause: <Pause fill="currentColor" strokeWidth={0} />,
  seek: <FastForward />,
  heart: <HeartFilled size={20} />,
  'mic-off': <MicOff />,
  'video-off': <VideoOff />,
  'volume-off': <VolumeX />,
  lock: <Lock />,
  'wifi-off': <WifiOff />,
  captions: <Captions />,
  audio: <AudioLines />,
  download: <Download />,
  sync: <Sparkles />,
};

function Hud() {
  const hud = useWatch((s) => s.hud);
  const [shown, setShown] = useState(hud);
  useEffect(() => {
    if (!hud) return;
    setShown(hud);
    const t = setTimeout(() => setShown(null), 1700);
    return () => clearTimeout(t);
  }, [hud]);
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key={shown.id}
          className="hud glass"
          role="status"
          initial={{ opacity: 0, scale: 0.94, x: '-50%', y: '-50%' }}
          animate={{ opacity: 1, scale: 1, x: '-50%', y: '-50%' }}
          exit={{ opacity: 0, scale: 0.97, x: '-50%', y: '-50%' }}
          transition={{ type: 'spring', stiffness: 520, damping: 34 }}
        >
          {HUD_ICONS[shown.icon]}
          {shown.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const ROUTES = { local: 'Aynı ağ', p2p: 'Doğrudan (P2P)', relay: 'TURN aktarma' } as const;
const LIMITS: Record<string, string> = { cpu: 'işlemci sınırı', bandwidth: 'bant sınırı' };

function StatsRows({ stats, role }: { stats: StatsSummary | null; role: string }) {
  if (!stats) {
    return (
      <div className="list">
        <div className="row">
          <span>Durum</span>
          <span className="row-value">Bağlı değil</span>
        </div>
      </div>
    );
  }
  const rank = (x: StreamStat) => (x.role === 'movie' ? 0 : 4) + (x.kind === 'video' ? 0 : 2) + (x.dir === 'out' ? 0 : 1);
  const rows: [string, string][] = [
    ['Bağlantı', [stats.route ? ROUTES[stats.route] : '—', stats.protocol].filter(Boolean).join(' · ')],
    ['Gecikme (RTT)', ms(stats.rtt)],
    ...(role === 'guest' ? ([['Yayın gecikmesi', ms(stats.movieDelay)]] as [string, string][]) : []),
    ...[...stats.streams].sort((a, b) => rank(a) - rank(b)).map((x): [string, string] => [streamLabel(x), streamValue(x)]),
  ];
  return (
    <div className="list">
      {rows.map(([k, v]) => (
        <div className="row" key={k}>
          <span>{k}</span>
          <span className="row-value">{v}</span>
        </div>
      ))}
    </div>
  );
}

const ms = (sec: number | null) => (sec == null ? '—' : `${Math.round(sec * 1000)} ms`);

function streamLabel(x: StreamStat) {
  return `${x.role === 'movie' ? 'Film' : 'Kamera'} ${x.kind === 'video' ? 'görüntü' : 'ses'} ${x.dir === 'out' ? '↑' : '↓'}`;
}

function streamValue(x: StreamStat) {
  const rate = x.kbps == null ? '…' : x.kbps >= 1000 ? `${(x.kbps / 1000).toFixed(1)} Mbps` : `${Math.round(x.kbps)} kbps`;
  if (x.kind === 'audio') return [rate, x.codec, x.stereo && 'stereo'].filter(Boolean).join(' · ');
  return [
    x.width && `${x.width}×${x.height}`,
    x.fps && `${Math.round(x.fps)} fps`,
    rate,
    x.codec?.toUpperCase(),
    x.limit && LIMITS[x.limit],
  ]
    .filter(Boolean)
    .join(' · ');
}
