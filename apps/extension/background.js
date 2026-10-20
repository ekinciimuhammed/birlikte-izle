// Birlikte İzle eklentisi, arka plan: bu bilgisayarda açık olan Birlikte İzle uygulamasına yerel bir
// WebSocket ile bağlanır (127.0.0.1, dışarıya kapalı). Sekmedeki oynatıcı ile uygulama arasında
// aracıdır: durum uygulamaya gider, uygulamanın komutları (oynat, durdur, sar, aç) sekmeye.
/* global birlikteAllowedUrl, birlikteSite, birlikteCleanUrl, birlikteCleanTitle */
importScripts('sites.js');

const PORTS = [47652, 47653, 47654];
const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let connecting = false;
let activeTab = null; // kontrol edilen sekme
let activeFrame = null; // o sekmede videonun olduğu çerçeve (oynatıcı iframe'de olabilir); null: henüz bilinmiyor
let heardAt = 0; // kontrol edilen çerçeveden son haber
let lastVideo = null; // { tab, ...video }
let lastState = null;
let camsInfo = null; // uygulamadan: kameralar sitenin üstünde gösterilsin mi, isimler (cams.js)
let camsTarget = null; // baloncukların gösterildiği { tab, frame }

// --- Uygulamaya bağlantı -----------------------------------------------------------------------

function openSocket(port) {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}/birlikte`);
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      sock.close();
      resolve(null);
    }, 1500);
    sock.onopen = () => {
      clearTimeout(timer);
      resolve(sock);
    };
    sock.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
  });
}

async function connect() {
  if (ws || connecting) return;
  connecting = true;
  try {
    // Aynı bilgisayarda iki uygulama varsa (deneme/test) hangi kapıya bağlanacağı seçilebilir.
    const { port } = await chrome.storage.local.get('port');
    for (const p of port ? [port] : PORTS) {
      const sock = await openSocket(p);
      if (!sock) continue;
      ws = sock;
      sock.onmessage = (e) => {
        try {
          onApp(JSON.parse(e.data));
        } catch {
          // bozuk mesajı yok say
        }
      };
      sock.onclose = () => {
        if (ws === sock) ws = null;
        camsInfo = null; // uygulama kapandı: baloncuklar da kalksın
        pushCams();
        setTimeout(connect, 3000);
      };
      toApp({ t: 'hello', browser: browserName(), version: VERSION });
      if (lastVideo) toApp(lastVideo);
      if (lastState) toApp(lastState);
      return;
    }
    setTimeout(connect, 5000);
  } finally {
    connecting = false;
  }
}

function toApp(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (brands.includes('Microsoft Edge')) return 'Edge';
  if (brands.includes('Opera')) return 'Opera';
  if (brands.includes('Brave')) return 'Brave';
  return 'Chrome';
}

// --- Uygulamadan gelenler ----------------------------------------------------------------------

async function onApp(msg) {
  if (msg.t === 'ping') return toApp({ t: 'pong' });
  if (msg.t === 'cmd' && activeTab != null) {
    chrome.tabs.sendMessage(activeTab, msg, activeFrame == null ? undefined : { frameId: activeFrame }).catch(() => {});
    return;
  }
  if (msg.t === 'open' && typeof msg.url === 'string' && birlikteAllowedUrl(msg.url)) {
    await openUrl(msg.url, msg.replace === true);
  }
  if (msg.t === 'cams') {
    camsInfo = msg.on ? msg : null;
    pushCams();
  }
  if (msg.t === 'cam-signal' && camsTarget) toFrame(camsTarget, msg);
}

// --- Kameralar sitenin üstünde -----------------------------------------------------------------

function toFrame({ tab, frame }, msg) {
  chrome.tabs.sendMessage(tab, msg, { frameId: frame }).catch(() => {});
}

/** Baloncuklar videonun olduğu çerçevede görünür; video başka sekmeye/çerçeveye geçince onlar da geçer. */
function pushCams() {
  const target = camsInfo && activeTab != null ? { tab: activeTab, frame: activeFrame ?? 0 } : null;
  const same = target && camsTarget && target.tab === camsTarget.tab && target.frame === camsTarget.frame;
  if (camsTarget && !same) toFrame(camsTarget, { t: 'cams', on: false });
  camsTarget = target;
  if (target) toFrame(target, camsInfo);
}

/**
 * Karşının açtığı bölümü bu tarayıcıda aç: zaten açık bir sekme varsa ona geç. replace: yoksa yeni
 * sekme açmak yerine kontrol edilen sekmeyi oraya götür (kanal değiştirme, kumanda gibi).
 */
async function openUrl(url, replace = false) {
  const target = new URL(url);
  const tabs = await chrome.tabs.query({});
  const same = tabs.find((t) => {
    try {
      const u = new URL(t.url);
      return u.origin === target.origin && u.pathname === target.pathname && u.searchParams.get('v') === target.searchParams.get('v');
    } catch {
      return false;
    }
  });
  if (same) {
    await chrome.tabs.update(same.id, { active: true });
    await chrome.windows.update(same.windowId, { focused: true }).catch(() => {});
    activate(same.id);
    return;
  }
  const moved = replace && activeTab != null ? await chrome.tabs.update(activeTab, { url, active: true }).catch(() => null) : null;
  if (moved) {
    await chrome.windows.update(moved.windowId, { focused: true }).catch(() => {});
    // Eski sayfanın videosu gitti; yenisi bulununca bildirilir.
    activeFrame = null;
    lastVideo = lastState = null;
    toApp({ t: 'gone' });
    return;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  activeTab = tab.id;
  activeFrame = null;
  pushCams();
}

/** Bu sekmeyi (ya da sekmedeki bir çerçeveyi) kontrol et ve oynatıcısının bilgisini uygulamaya bildir */
function activate(tab, frame = null) {
  activeTab = tab;
  activeFrame = frame;
  pushCams();
  chrome.tabs.sendMessage(tab, { t: 'probe' }, frame == null ? undefined : { frameId: frame }).then(
    async (r) => {
      if (!r || activeTab !== tab) return;
      const page = r.video.top ? null : await chrome.tabs.get(tab).catch(() => null);
      lastVideo = { ...pageInfo(r.video, page), tab };
      lastState = r.state;
      toApp(lastVideo);
      toApp(lastState);
    },
    () => {},
  );
}

/** Oynatıcı iframe'deyse paylaşılacak bağlantı ve başlık sekmenin kendisinden (izleme sayfası) gelir. */
function pageInfo({ top, ...video }, tab) {
  if (top || !tab?.url) return video;
  const site = birlikteSite(tab.url);
  return { ...video, url: birlikteCleanUrl(tab.url), title: birlikteCleanTitle(tab.title ?? '', site?.name ?? '') || video.title };
}

/**
 * Bu çerçeve kontrol edilen mi? Aynı sekmede başka bir çerçeve: oynamaya başladıysa ya da kontrol
 * edilenden 4 sn'dir haber yoksa (sayfa değişti, eski çerçeve gitti) artık o.
 */
function claim(tab, frame, playing) {
  if (tab !== activeTab) return false;
  if (activeFrame === frame || activeFrame === null) {
    if (activeFrame !== frame) {
      activeFrame = frame;
      pushCams();
    }
    heardAt = Date.now();
    return true;
  }
  if (!playing && Date.now() - heardAt < 4000) return false;
  activate(tab, frame); // yeni çerçevenin video bilgisini de al
  heardAt = Date.now();
  return true;
}

// --- Sekmelerden gelenler ----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.t === 'status') {
    reply({ connected: !!ws && ws.readyState === WebSocket.OPEN, video: lastVideo });
    return;
  }
  const tab = sender.tab?.id;
  if (tab == null || !birlikteSite(sender.tab.url ?? sender.url ?? '')) return;
  const frame = sender.frameId ?? 0;
  if (msg.t === 'video') {
    // İlk bulunan ya da oynamaya başlayan sekme kontrol edilir.
    if (activeTab == null) activeTab = tab;
    if (!claim(tab, frame, false)) return;
    lastVideo = { ...pageInfo(msg, sender.tab), tab };
    toApp(lastVideo);
    // Sayfa yenilendiyse yeni sayfanın betiği baloncukları bilmiyor
    if (camsTarget) toFrame(camsTarget, camsInfo);
  } else if (msg.t === 'state') {
    if (tab !== activeTab && msg.playing) activate(tab, frame); // başka sekmede oynatıldı: artık o
    if (!claim(tab, frame, msg.playing)) return;
    lastState = msg;
    toApp(msg);
  } else if (msg.t === 'cam-signal' || msg.t === 'cam-cmd') {
    // Baloncuklardan: görüntü bağlantısı ya da kamera/mikrofon aç-kapat (sadece baloncukların olduğu çerçeveden)
    if (camsTarget && tab === camsTarget.tab && frame === camsTarget.frame) toApp(msg);
    return;
  } else if (msg.t === 'gone' && tab === activeTab && frame === activeFrame) {
    lastVideo = lastState = null;
    heardAt = 0; // sayfadaki başka bir çerçeve hemen devralabilir
    toApp({ t: 'gone' });
  }
  connect();
});

chrome.tabs.onRemoved.addListener((tab) => {
  if (tab !== activeTab) return;
  activeTab = null;
  activeFrame = null;
  lastVideo = lastState = null;
  toApp({ t: 'gone' });
  pushCams();
});

// Hizmet çalışanı uyutulursa bağlantı kopar: yarım dakikada bir uyanıp yeniden bağlan.
chrome.alarms.create('birlikte-baglan', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
connect();
