// Birlikte İzle · Faz 0
// Roller: "host" filmi kendi bilgisayarında oynatıp yayınlar ve oynatma durumunun tek
// doğruluk kaynağıdır. "guest" yayını izler; komutlarını host'a gönderir, host uygular.

import { Link } from './rtc.js';
import { watchStats } from './stats.js';
import { loadSettings, saveSettings, renderSettings, store } from './settings.js';
import { icon, setIcon, hydrateIcons } from './icons.js';

const $ = (id) => document.getElementById(id);

// --- Durum ----------------------------------------------------------------

const settings = loadSettings();
let link = null;
let me = '';
let role = 'idle'; // 'idle' | 'host' | 'guest'
let mediaTitle = '';
let remoteState = null; // guest: host'tan gelen son durum + varış zamanı
let lastStats = null;
let seeking = false;
let muted = false;
let audioChecked = false;
let cmdSeq = 0; // guest: gönderdiği son komutun sırası
let lastAck = 0; // host: uyguladığı son guest komutunun sırası

const peer = { name: '', here: false, movieStream: null, camStream: null, camOn: false, micOn: false };
const remoteStreams = new Map(); // akış id → MediaStream
const trackRoles = new Map(); // iz id → 'movie' | 'cam' (istatistikler için)

// Sabit akış kimlikleri: karşı taraf filmi ve kamerayı bu id'lerle ayırt eder.
const movieStream = new MediaStream();
const camStream = new MediaStream();
let captured = null; // localMovie.captureStream()
let camTrack = null;
let micTrack = null;

const stage = $('stage');
const localMovie = $('localMovie');
const remoteMovie = $('remoteMovie');

const MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const camConstraints = () => ({
  width: { ideal: Math.round((settings.camRes * 16) / 9) },
  height: { ideal: settings.camRes },
  frameRate: { ideal: 30 },
});
const movieVideoEncoding = () => ({
  maxBitrate: settings.bitrate * 1_000_000,
  priority: 'high',
  networkPriority: 'high',
});
const movieAudioEncoding = () => ({
  maxBitrate: settings.audioBitrate * 1000,
  priority: 'high',
  networkPriority: 'high',
});

// --- Katılma ----------------------------------------------------------------

hydrateIcons();
renderSkipIcons();

$('nameInput').value = store.get('birlikte-izle:ad', '');
$('roomInput').value = new URLSearchParams(location.search).get('oda') ?? randomRoom();
for (const id of ['joinCam', 'joinMic']) {
  $(id).addEventListener('click', ({ currentTarget: sw }) =>
    sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')),
  );
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  me = $('nameInput').value.trim();
  const room = $('roomInput').value.trim().toLowerCase();
  if (!me || !room) return;
  store.set('birlikte-izle:ad', me);
  history.replaceState(null, '', `?oda=${encodeURIComponent(room)}`);
  $('join').hidden = true;
  stage.hidden = false;
  start(room, {
    cam: $('joinCam').getAttribute('aria-checked') === 'true',
    mic: $('joinMic').getAttribute('aria-checked') === 'true',
  });
});

function randomRoom() {
  const words = ['kalp', 'yildiz', 'ay', 'deniz', 'bulut', 'gece', 'papatya'];
  return `${words[Math.floor(Math.random() * words.length)]}-${1000 + Math.floor(Math.random() * 9000)}`;
}

async function start(room, devices) {
  link = new Link({ room, name: me });
  link.codec = settings.codec;
  wireLink();
  updateView();
  updateCams();
  applyVolume();
  poke();
  watchStats(link, (id) => trackRoles.get(id), renderStats);
  openDevices(devices);
  try {
    await link.start();
  } catch {
    setPresence('red', 'Sunucuya ulaşılamadı');
  }
}

// --- Bağlantı olayları ------------------------------------------------------

function wireLink() {
  link.addEventListener('status', ({ detail }) =>
    detail === 'waiting' ? setPresence('', 'Onu bekliyorsun') : setPresence('orange', detail),
  );
  link.addEventListener('peer', ({ detail }) => {
    peer.name = detail.name;
    remoteStreams.clear();
    setPresence('orange', `${peer.name} bağlanıyor…`);
  });
  link.addEventListener('peer-left', () => {
    if (!link.isOpen) setPresence('', `${peer.name || 'O'} ayrıldı`);
  });
  link.addEventListener('full', () => setPresence('red', 'Bu oda dolu'));
  link.addEventListener('connection', ({ detail }) => {
    if (detail === 'failed') setPresence('red', 'Doğrudan bağlantı kurulamadı');
  });
  link.addEventListener('open', onChannelOpen);
  link.addEventListener('close', onChannelClose);
  link.addEventListener('message', ({ detail }) => onMessage(detail));
  link.addEventListener('track', ({ detail: { stream } }) => {
    if (stream) remoteStreams.set(stream.id, stream);
    bindRemoteStreams();
  });
}

function onChannelOpen() {
  peer.here = true;
  link.send({
    t: 'hello',
    name: me,
    movieStream: movieStream.id,
    camStream: camStream.id,
    camOn: !!camTrack,
    micOn: micOn(),
  });
  if (role === 'host') {
    link.send({ t: 'settings', codec: settings.codec });
    sendMedia();
    broadcast();
  }
  setPresence('green', `${peer.name} burada`);
  hud(`${peer.name} burada`, 'heartFilled');
  updateView();
  updateCams();
}

function onChannelClose() {
  peer.here = false;
  setPresence('', `${peer.name || 'O'} ayrıldı`);
  if (role === 'host' && !localMovie.paused) {
    localMovie.pause();
    hud(`${peer.name} koptu, durduruldu`, 'pause');
  }
  if (role === 'guest') {
    role = 'idle';
    mediaTitle = '';
    remoteState = null;
    remoteMovie.srcObject = null;
  }
  updateView();
  updateCams();
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      Object.assign(peer, {
        name: m.name,
        movieStream: m.movieStream,
        camStream: m.camStream,
        camOn: m.camOn,
        micOn: m.micOn,
      });
      bindRemoteStreams();
      updateCams();
      break;

    case 'media':
      if (role === 'host') stopHosting();
      if (m.title !== mediaTitle) hud(`${peer.name} “${m.title}” açtı`, 'play');
      role = 'guest';
      mediaTitle = m.title;
      remoteState = null;
      cmdSeq = 0;
      bindRemoteStreams();
      updateView();
      break;

    case 'state':
      // Henüz uygulanmamış komutumuz varsa eski durumları yok say (titremesin).
      if (role !== 'guest' || (m.ack ?? 0) < cmdSeq) return;
      remoteState = { ...m, recvAt: performance.now() };
      if (m.action && m.by === 'host') feedback(m.action, true, m.pos);
      break;

    case 'cmd':
      if (role === 'host') hostApply(m.action, { pos: m.pos, seen: m.seen, seq: m.seq, byPeer: true });
      break;

    case 'cam':
      peer.camOn = m.on;
      updateCams();
      break;

    case 'mic':
      peer.micOn = m.on;
      updateCams();
      break;

    case 'react':
      floatHeart();
      break;

    case 'settings':
      if (m.codec && m.codec !== settings.codec) {
        settings.codec = m.codec;
        saveSettings(settings);
        link.setCodec(m.codec);
        if (!$('settingsSheet').hidden) openSettings();
      }
      break;
  }
}

function bindRemoteStreams() {
  const movie = remoteStreams.get(peer.movieStream);
  if (movie) {
    movie.getTracks().forEach((t) => trackRoles.set(t.id, 'movie'));
    if (role === 'guest') attach(remoteMovie, movie);
  }
  const cam = remoteStreams.get(peer.camStream);
  if (cam) {
    cam.getTracks().forEach((t) => trackRoles.set(t.id, 'cam'));
    attach($('camRemote'), cam);
  }
}

// Akışa sonradan iz eklenirse (önce görüntü, sonra ses gibi) öğeyi tazeler.
function attach(el, stream) {
  const count = stream.getTracks().length;
  if (el.srcObject === stream && el.dataset.tracks === String(count)) return;
  el.srcObject = stream;
  el.dataset.tracks = String(count);
  el.play().catch(() => {});
}

// --- Host: film yayını --------------------------------------------------------

function loadFile(file) {
  if (!file) return;
  if (typeof localMovie.captureStream !== 'function') {
    return hud('Bu tarayıcı film yayınlayamıyor. Chrome veya Edge kullan.', 'videoOff');
  }
  if (localMovie.src) URL.revokeObjectURL(localMovie.src);
  role = 'host';
  remoteState = null;
  remoteMovie.srcObject = null;
  audioChecked = false;
  mediaTitle = file.name.replace(/\.[^.]+$/, '');
  captured ??= localMovie.captureStream();
  captured.onaddtrack = publishMovie;
  localMovie.src = URL.createObjectURL(file);
  updateView();
  poke();
}

async function publishMovie() {
  if (role !== 'host' || !captured) return;
  const video = captured.getVideoTracks().find((t) => t.readyState === 'live');
  const audio = captured.getAudioTracks().find((t) => t.readyState === 'live');
  if (video) {
    video.contentHint = settings.priority;
    trackRoles.set(video.id, 'movie');
    await link.setTrack('movie-video', video, movieStream, movieVideoEncoding());
  }
  if (audio) {
    audio.contentHint = 'music';
    trackRoles.set(audio.id, 'movie');
    await link.setTrack('movie-audio', audio, movieStream, movieAudioEncoding());
  }
}

function stopHosting() {
  localMovie.pause();
  if (localMovie.src) URL.revokeObjectURL(localMovie.src);
  localMovie.removeAttribute('src');
  localMovie.load();
  link.setTrack('movie-video', null, movieStream);
  link.setTrack('movie-audio', null, movieStream);
}

function sendMedia() {
  if (role === 'host' && localMovie.src) {
    link?.send({ t: 'media', title: mediaTitle, duration: localMovie.duration || 0 });
  }
}

function broadcast(action, by) {
  if (role !== 'host' || !link?.isOpen) return;
  const v = localMovie;
  link.send({
    t: 'state',
    playing: !v.paused && !v.ended,
    pos: v.currentTime,
    rate: v.playbackRate,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    ack: lastAck,
    action,
    by,
  });
}

async function hostApply(action, { pos, seen, seq, byPeer = false } = {}) {
  const v = localMovie;
  if (!v.src) return;
  if (seq) lastAck = seq;
  if (action === 'play') {
    await v.play().catch(() => {});
  } else if (action === 'pause') {
    v.pause();
    // Onun ekranı birkaç yüz ms geride: tam onun gördüğü karede duralım.
    if (byPeer && Number.isFinite(seen) && Math.abs(v.currentTime - seen) < 3) v.currentTime = seen;
  } else if (action === 'seek') {
    v.currentTime = clamp(pos, 0, v.duration || 0);
  }
  broadcast(action, byPeer ? 'guest' : 'host');
  feedback(action, byPeer, v.currentTime);
}

localMovie.addEventListener('loadedmetadata', () => {
  publishMovie();
  sendMedia();
  broadcast();
  updateView();
});
localMovie.addEventListener('playing', () => {
  publishMovie();
  checkAudio();
});
for (const type of ['pause', 'seeked', 'ended']) localMovie.addEventListener(type, () => broadcast());
localMovie.addEventListener('error', () => {
  if (role === 'host' && localMovie.getAttribute('src')) {
    hud('Bu dosya tarayıcıda açılamıyor. MP4 (H.264 + AAC) dene.', 'videoOff');
  }
});
setInterval(() => broadcast(), 1000);

function checkAudio() {
  if (audioChecked) return;
  audioChecked = true;
  setTimeout(() => {
    if (role === 'host' && !localMovie.paused && localMovie.webkitAudioDecodedByteCount === 0) {
      hud('Bu dosyada çalınabilen ses yok (AC3/DTS olabilir). Faz 2’de ffmpeg çözecek.', 'volumeOff');
    }
  }, 2000);
}

// --- Guest: konum tahmini -------------------------------------------------------

// Host'un oynatıcısı şu an nerede?
function hostPosition() {
  const s = remoteState;
  if (!s) return 0;
  if (!s.playing) return s.pos;
  const rtt = lastStats?.rtt ?? 0.05;
  return s.pos + ((performance.now() - s.recvAt) / 1000 + rtt / 2) * (s.rate || 1);
}

// Benim ekranımda şu an hangi kare var? (yayın gecikmesi kadar geride)
function seenPosition() {
  const s = remoteState;
  if (!s) return 0;
  if (!s.playing) return s.pos;
  return clamp(hostPosition() - (lastStats?.movieDelay ?? 0.25), 0, s.duration || Infinity);
}

// --- Komutlar (iki rol için tek giriş noktası) ------------------------------

function command(action, value) {
  if (role === 'host') {
    if (action === 'toggle') action = localMovie.paused ? 'play' : 'pause';
    if (action === 'skip') return hostApply('seek', { pos: localMovie.currentTime + value });
    return hostApply(action, { pos: value });
  }
  if (role !== 'guest' || !remoteState || !link.isOpen) return;

  const s = remoteState;
  const seen = seenPosition();
  let pos = value;
  if (action === 'toggle') action = s.playing ? 'pause' : 'play';
  if (action === 'skip') {
    action = 'seek';
    pos = clamp(seen + value, 0, s.duration || Infinity);
  }
  link.send({ t: 'cmd', action, pos, seen, seq: ++cmdSeq });

  // İyimser güncelleme: host onaylayana kadar arayüz geri zıplamasın.
  const now = performance.now();
  if (action === 'pause') remoteState = { ...s, playing: false, pos: seen, recvAt: now };
  else if (action === 'play') remoteState = { ...s, playing: true, pos: hostPosition(), recvAt: now };
  else if (action === 'seek') remoteState = { ...s, pos, recvAt: now };
  feedback(action, false, action === 'seek' ? pos : seen);
}

function feedback(action, byPeer, pos) {
  const who = byPeer ? peer.name : '';
  if (action === 'play') hud(who ? `${who} oynattı` : 'Oynatılıyor', 'play');
  else if (action === 'pause') hud(who ? `${who} durdurdu` : 'Durduruldu', 'pause');
  else if (action === 'seek') hud(who ? `${who} sardı · ${fmt(pos)}` : fmt(pos), 'forward', '');
}

// --- Kamera ve mikrofon -----------------------------------------------------------

const micOn = () => !!micTrack?.enabled;

async function openDevices({ cam, mic }) {
  if (!cam && !mic) return updateCams();
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: cam && camConstraints(),
      audio: mic && MIC_CONSTRAINTS,
    });
    if (cam) await useCamTrack(s.getVideoTracks()[0]);
    if (mic) await useMicTrack(s.getAudioTracks()[0]);
  } catch {
    // Biri yoksa diğeri yine çalışsın.
    if (cam) await setCam(true);
    if (mic) await setMic(true);
  }
}

async function useCamTrack(track) {
  camTrack?.stop();
  camTrack = track ?? null;
  if (camTrack) trackRoles.set(camTrack.id, 'cam');
  $('camLocal').srcObject = camTrack ? new MediaStream([camTrack]) : null;
  await link.setTrack('cam-video', camTrack, camStream, { maxBitrate: 1_200_000 });
  link.send({ t: 'cam', on: !!camTrack });
  updateCams();
}

async function setCam(on) {
  if (!on) return useCamTrack(null);
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
    await useCamTrack(s.getVideoTracks()[0]);
  } catch {
    hud('Kameraya erişilemedi', 'videoOff');
  }
}

async function useMicTrack(track) {
  micTrack = track;
  trackRoles.set(track.id, 'cam');
  await link.setTrack('cam-audio', track, camStream, { maxBitrate: 64_000 });
  link.send({ t: 'mic', on: true });
  updateCams();
}

async function setMic(on) {
  if (on && !micTrack) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      await useMicTrack(s.getAudioTracks()[0]);
    } catch {
      hud('Mikrofona erişilemedi', 'micOff');
    }
    return;
  }
  if (micTrack) micTrack.enabled = on;
  link.send({ t: 'mic', on: micOn() });
  updateCams();
}

// --- Arayüz -------------------------------------------------------------------------

function updateView() {
  const active = role === 'host' || role === 'guest';
  localMovie.hidden = role !== 'host';
  remoteMovie.hidden = role !== 'guest';
  $('empty').hidden = active;
  $('controls').hidden = !active;
  $('mediaTitle').textContent = mediaTitle || 'Birlikte İzle';
  document.title = mediaTitle ? `${mediaTitle} · Birlikte İzle` : 'Birlikte İzle';
  $('emptyTitle').textContent = peer.here ? `${peer.name} burada` : 'Bir dizi seç';
  $('emptyText').textContent = peer.here
    ? 'Bir dosya seç, o da anında görsün.'
    : 'Onu beklerken bir dosya seçebilirsin. Bağlanınca o da görecek.';
  for (const id of ['playBtn', 'backBtn', 'fwdBtn', 'seek']) $(id).disabled = !active;
}

function updateCams() {
  const local = $('bubbleLocal');
  local.classList.toggle('off', !camTrack);
  local.classList.toggle('mirror', !!settings.mirror);
  local.classList.toggle('mic-off', !micOn());
  $('localInitial').textContent = initial(me);

  const remote = $('bubbleRemote');
  remote.hidden = !peer.here;
  remote.classList.toggle('off', !peer.camOn);
  remote.classList.toggle('mic-off', !peer.micOn);
  $('remoteInitial').textContent = initial(peer.name);
  $('remoteName').textContent = peer.name;

  setIcon($('micBtn'), micOn() ? 'mic' : 'micOff');
  $('micBtn').classList.toggle('off', !micOn());
  setIcon($('camBtn'), camTrack ? 'video' : 'videoOff');
  $('camBtn').classList.toggle('off', !camTrack);
}

function tick() {
  let pos = 0;
  let dur = 0;
  let playing = false;
  if (role === 'host') {
    pos = localMovie.currentTime;
    dur = localMovie.duration || 0;
    playing = !localMovie.paused && !localMovie.ended;
  } else if (role === 'guest' && remoteState) {
    pos = seenPosition();
    dur = remoteState.duration || 0;
    playing = remoteState.playing;
  }
  const seek = $('seek');
  if (!seeking) {
    seek.max = String(dur);
    seek.value = String(pos);
  }
  const shown = seeking ? Number(seek.value) : pos;
  setProgress(seek, dur ? shown / dur : 0);
  $('timeNow').textContent = fmt(shown);
  $('timeLeft').textContent = dur ? `-${fmt(dur - shown)}` : '0:00';
  setIcon($('playBtn'), playing ? 'pause' : 'play');
  stage.classList.toggle('playing', playing);
}
setInterval(tick, 250);

let hudTimer;
function hud(text, iconName, arg) {
  const el = $('hud');
  el.innerHTML = iconName ? icon(iconName, arg) : '';
  el.append(document.createTextNode(text));
  el.classList.add('show');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => el.classList.remove('show'), 1700);
}

function setPresence(color, text) {
  $('presenceDot').className = `dot ${color}`;
  $('presenceText').textContent = text;
}

function floatHeart() {
  const h = document.createElement('span');
  h.className = 'heart';
  h.innerHTML = icon('heartFilled');
  h.style.setProperty('--dx1', `${(Math.random() - 0.5) * 40}px`);
  h.style.setProperty('--dx2', `${(Math.random() - 0.5) * 160}px`);
  h.addEventListener('animationend', () => h.remove());
  $('hearts').append(h);
}

function applyVolume() {
  const v = Number($('volume').value);
  for (const el of [localMovie, remoteMovie]) {
    el.volume = v;
    el.muted = muted;
  }
  setProgress($('volume'), v);
  setIcon($('volBtn'), muted || v === 0 ? 'volumeOff' : 'volume');
}

function renderSkipIcons() {
  setIcon($('backBtn'), 'back', settings.skip);
  setIcon($('fwdBtn'), 'forward', settings.skip);
}

// Kontroller fare durunca kaybolur; durdurulmuşken veya üzerindeyken kalır.
let hideTimer;
function poke() {
  stage.classList.remove('ui-hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (canHideUi() ? stage.classList.add('ui-hidden') : poke()), 2800);
}

function canHideUi() {
  return (
    stage.classList.contains('playing') &&
    !seeking &&
    !$('controls').matches(':hover') &&
    $('statsPanel').hidden &&
    $('settingsSheet').hidden
  );
}

// --- Bağlantı bilgisi ve ayarlar -----------------------------------------------

const ROUTES = { local: 'Aynı ağ', p2p: 'Doğrudan (P2P)', relay: 'TURN aktarma' };
const LIMITS = { cpu: 'işlemci sınırı', bandwidth: 'bant sınırı' };

function renderStats(s) {
  lastStats = s;
  if (s && peer.here) {
    const color = s.rtt == null || s.rtt < 0.15 ? 'green' : s.rtt < 0.3 ? 'orange' : 'red';
    $('presenceDot').className = `dot ${color}`;
  }
  if ($('statsPanel').hidden) return;

  const rows = [];
  if (!s) {
    rows.push(['Durum', 'Bağlı değil']);
  } else {
    rows.push(['Bağlantı', [ROUTES[s.route] ?? '—', s.protocol].filter(Boolean).join(' · ')]);
    rows.push(['Gecikme (RTT)', ms(s.rtt)]);
    if (role === 'guest') rows.push(['Yayın gecikmesi', ms(s.movieDelay)]);
    const rank = (x) => (x.role === 'movie' ? 0 : 4) + (x.kind === 'video' ? 0 : 2) + (x.dir === 'out' ? 0 : 1);
    for (const x of s.streams.sort((a, b) => rank(a) - rank(b))) rows.push([streamLabel(x), streamValue(x)]);
  }
  $('statsBody').replaceChildren(
    ...rows.map(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'row';
      const a = document.createElement('span');
      const b = document.createElement('span');
      a.textContent = k;
      b.textContent = v;
      row.append(a, b);
      return row;
    }),
  );
}

function streamLabel(x) {
  return `${x.role === 'movie' ? 'Film' : 'Kamera'} ${x.kind === 'video' ? 'görüntü' : 'ses'} ${x.dir === 'out' ? '↑' : '↓'}`;
}

function streamValue(x) {
  const rate = x.kbps == null ? '…' : x.kbps >= 1000 ? `${(x.kbps / 1000).toFixed(1)} Mbps` : `${Math.round(x.kbps)} kbps`;
  if (x.kind === 'audio') return [rate, x.codec, x.stereo && 'stereo'].filter(Boolean).join(' · ');
  return [
    x.width && `${x.width}×${x.height}`,
    x.fps && `${Math.round(x.fps)} fps`,
    rate,
    x.codec?.toUpperCase(),
    LIMITS[x.limit],
  ]
    .filter(Boolean)
    .join(' · ');
}

function openSettings() {
  $('settingsSheet').hidden = false;
  renderSettings($('settingsBody'), settings, onSetting);
  poke();
}

function onSetting(key, value) {
  settings[key] = value;
  saveSettings(settings);
  switch (key) {
    case 'bitrate':
      link?.setEncoding('movie-video', { maxBitrate: value * 1_000_000 });
      break;
    case 'audioBitrate':
      link?.setEncoding('movie-audio', { maxBitrate: value * 1000 });
      break;
    case 'priority':
      captured?.getVideoTracks().forEach((t) => (t.contentHint = value));
      break;
    case 'codec':
      link?.setCodec(value);
      link?.send({ t: 'settings', codec: value });
      break;
    case 'camRes':
      camTrack?.applyConstraints(camConstraints()).catch(() => {});
      break;
    case 'mirror':
      updateCams();
      break;
    case 'skip':
      renderSkipIcons();
      break;
  }
}

function closePanels() {
  $('settingsSheet').hidden = true;
  $('statsPanel').hidden = true;
}

// --- Etkileşim --------------------------------------------------------------------

$('pickBtn').onclick = $('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
};

$('playBtn').onclick = () => command('toggle');
$('backBtn').onclick = () => command('skip', -settings.skip);
$('fwdBtn').onclick = () => command('skip', settings.skip);
$('micBtn').onclick = () => setMic(!micOn());
$('camBtn').onclick = () => setCam(!camTrack);
$('fsBtn').onclick = toggleFullscreen;
$('heartBtn').onclick = () => {
  floatHeart();
  link?.send({ t: 'react' });
};
$('volBtn').onclick = () => {
  muted = !muted;
  applyVolume();
};
$('volume').addEventListener('input', () => {
  muted = false;
  applyVolume();
});

$('seek').addEventListener('input', () => {
  seeking = true;
  tick();
});
$('seek').addEventListener('change', () => {
  seeking = false;
  command('seek', Number($('seek').value));
});

$('statsBtn').onclick = () => {
  $('statsPanel').hidden = !$('statsPanel').hidden;
  renderStats(lastStats);
};
$('settingsBtn').onclick = openSettings;
$('settingsDone').onclick = () => ($('settingsSheet').hidden = true);
$('settingsSheet').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});

$('presence').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    hud('Davet bağlantısı kopyalandı', 'link');
  } catch {
    hud(location.href, 'link');
  }
};

// Filme tıkla: oynat/durdur · çift tıkla: tam ekran
let clickTimer;
for (const v of [localMovie, remoteMovie]) {
  v.addEventListener('click', () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => command('toggle'), 220);
  });
  v.addEventListener('dblclick', () => {
    clearTimeout(clickTimer);
    toggleFullscreen();
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () =>
  setIcon($('fsBtn'), document.fullscreenElement ? 'minimize' : 'maximize'),
);

for (const type of ['pointermove', 'pointerdown']) stage.addEventListener(type, poke);

// Fareyle basılan düğme odakta kalmasın; yoksa Boşluk tuşu onu da tetikler.
stage.addEventListener('pointerup', (e) => {
  if (e.target.closest('.controls button, .topbar button')) requestAnimationFrame(() => e.target.closest('button').blur());
});

document.addEventListener('keydown', (e) => {
  if (stage.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches('input:not([type=range]), select, textarea')) return;
  if (e.key === 'Escape') return closePanels();
  const actions = {
    Space: () => command('toggle'),
    ArrowLeft: () => command('skip', -settings.skip),
    ArrowRight: () => command('skip', settings.skip),
    KeyF: toggleFullscreen,
    KeyM: () => setMic(!micOn()),
    KeyC: () => setCam(!camTrack),
  };
  const fn = actions[e.code];
  if (!fn) return;
  e.preventDefault();
  fn();
  poke();
});

// Dosyayı sürükle-bırak
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('drop');
});
stage.addEventListener('dragleave', (e) => {
  if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop');
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('drop');
  loadFile(e.dataTransfer.files[0]);
});

// Kamera baloncuklarını sürükle → en yakın köşeye yaylanarak otursun
const cams = $('cams');
cams.dataset.corner = store.get('birlikte-izle:kose', 'br');
let drag = null;
cams.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  cams.setPointerCapture(e.pointerId);
});
cams.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  cams.classList.add('dragging');
  cams.style.transform = `translate(${dx}px, ${dy}px)`;
});
const endDrag = () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  cams.classList.remove('dragging');
  if (!moved) return;
  const before = cams.getBoundingClientRect();
  const cx = before.left + before.width / 2;
  const cy = before.top + before.height / 2;
  const corner = (cy < innerHeight / 2 ? 't' : 'b') + (cx < innerWidth / 2 ? 'l' : 'r');
  cams.style.transform = '';
  cams.dataset.corner = corner;
  store.set('birlikte-izle:kose', corner);
  const after = cams.getBoundingClientRect();
  cams.animate(
    [{ transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` }, { transform: 'none' }],
    { duration: 420, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1.12)' },
  );
};
cams.addEventListener('pointerup', endDrag);
cams.addEventListener('pointercancel', endDrag);

// --- Yardımcılar ------------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function fmt(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function setProgress(range, ratio) {
  range.style.setProperty('--p', `${clamp(ratio, 0, 1) * 100}%`);
}

function initial(name) {
  return (name || '?').trim().charAt(0).toLocaleUpperCase('tr-TR');
}

const ms = (sec) => (sec == null ? '—' : `${Math.round(sec * 1000)} ms`);
