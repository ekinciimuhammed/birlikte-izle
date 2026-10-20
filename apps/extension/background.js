// Birlikte İzle eklentisi, arka plan: bu bilgisayarda açık olan Birlikte İzle uygulamasına yerel bir
// WebSocket ile bağlanır (127.0.0.1, dışarıya kapalı). Sekmedeki oynatıcı ile uygulama arasında
// aracıdır: durum uygulamaya gider, uygulamanın komutları (oynat, durdur, sar, aç) sekmeye.
/* global birlikteAllowedUrl, birlikteSite */
importScripts('sites.js');

const PORTS = [47652, 47653, 47654];
const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let connecting = false;
let activeTab = null; // kontrol edilen sekme
let lastVideo = null; // { tab, ...video }
let lastState = null;

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
    chrome.tabs.sendMessage(activeTab, msg).catch(() => {});
    return;
  }
  if (msg.t === 'open' && typeof msg.url === 'string' && birlikteAllowedUrl(msg.url)) {
    await openUrl(msg.url);
  }
}

/** Karşının açtığı bölümü bu tarayıcıda aç: zaten açık bir sekme varsa ona geç. */
async function openUrl(url) {
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
  } else {
    const tab = await chrome.tabs.create({ url, active: true });
    activeTab = tab.id;
  }
}

/** Bu sekmeyi kontrol et ve oynatıcısının bilgisini uygulamaya bildir */
function activate(tab) {
  activeTab = tab;
  chrome.tabs.sendMessage(tab, { t: 'probe' }).then(
    (r) => {
      if (!r || activeTab !== tab) return;
      lastVideo = { ...r.video, tab };
      lastState = r.state;
      toApp(lastVideo);
      toApp(lastState);
    },
    () => {},
  );
}

// --- Sekmelerden gelenler ----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.t === 'status') {
    reply({ connected: !!ws && ws.readyState === WebSocket.OPEN, video: lastVideo });
    return;
  }
  const tab = sender.tab?.id;
  if (tab == null || !birlikteSite(sender.tab.url ?? sender.url ?? '')) return;
  if (msg.t === 'video') {
    // İlk bulunan ya da oynamaya başlayan sekme kontrol edilir.
    if (activeTab == null) activeTab = tab;
    if (tab !== activeTab) return;
    lastVideo = { ...msg, tab };
    toApp(lastVideo);
  } else if (msg.t === 'state') {
    if (tab !== activeTab && msg.playing) activate(tab); // başka sekmede oynatıldı: artık o
    if (tab !== activeTab) return;
    lastState = msg;
    toApp(msg);
  } else if (msg.t === 'gone' && tab === activeTab) {
    lastVideo = lastState = null;
    toApp({ t: 'gone' });
  }
  connect();
});

chrome.tabs.onRemoved.addListener((tab) => {
  if (tab !== activeTab) return;
  activeTab = null;
  lastVideo = lastState = null;
  toApp({ t: 'gone' });
});

// Hizmet çalışanı uyutulursa bağlantı kopar: yarım dakikada bir uyanıp yeniden bağlan.
chrome.alarms.create('birlikte-baglan', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
connect();
