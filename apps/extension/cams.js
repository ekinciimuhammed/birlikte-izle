// Kameralar sitenin üstünde: tarayıcıda izlerken (Netflix, Disney+…) uygulama iki kamerayı (onunki ve
// benimki) bu bilgisayarın içinde, doğrudan bir WebRTC bağlantısıyla sekmeye verir; burada sayfanın
// üstünde iki baloncuk olarak görünür (tam ekranda da). Görüntü bilgisayardan dışarı çıkmaz. Ses
// sayfaya gelmez: konuşma uygulamadan duyulur (yankı engelleme orada).
// Arka plan bu betiği sadece videonun olduğu çerçevede açar ({ t: 'cams' }).

(() => {
  if (window.__birlikteCams) return;
  window.__birlikteCams = true;

  let info = null; // { peer, self, peerOn, selfOn }
  let pc = null;
  let session = '';
  let ui = null;
  let prefs = { x: null, y: null, big: false, hidePeer: false, hideSelf: false };

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // eklenti güncellendi: bu sayfa artık konuşamaz
    }
  };

  chrome.storage.local.get('cams').then(({ cams }) => {
    prefs = { ...prefs, ...cams };
    render();
  });
  const save = () => chrome.storage.local.set({ cams: prefs }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.t === 'cams') {
      if (!msg.on) return stop();
      const fresh = !info;
      info = { peer: String(msg.peer || 'O'), self: String(msg.self || 'Ben'), peerOn: !!msg.peerOn, selfOn: !!msg.selfOn };
      render();
      if (fresh || !pc) connect();
    } else if (msg.t === 'cam-signal' && msg.session === session && pc) {
      onSignal(msg.data);
    }
  });

  // --- Uygulamayla görüntü bağlantısı (aynı bilgisayar) -------------------------------------------

  async function connect() {
    closePc();
    const my = (session = Math.random().toString(36).slice(2));
    const conn = new RTCPeerConnection({ iceServers: [] });
    pc = conn;
    // 0: onun kamerası, 1: benim kameram
    conn.addTransceiver('video', { direction: 'recvonly' });
    conn.addTransceiver('video', { direction: 'recvonly' });
    conn.ontrack = ({ transceiver, track }) => {
      const video = transceiver.mid === '0' ? ui?.peerVideo : ui?.selfVideo;
      if (!video) return;
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => {});
    };
    conn.onicecandidate = ({ candidate }) => send({ t: 'cam-signal', session: my, data: { candidate: candidate ? candidate.toJSON() : null } });
    conn.onconnectionstatechange = () => {
      if (pc === conn && conn.connectionState === 'failed') setTimeout(() => pc === conn && info && connect(), 2000);
    };
    await conn.setLocalDescription(await conn.createOffer());
    if (pc !== conn) return;
    send({ t: 'cam-signal', session: my, data: { description: conn.localDescription.toJSON() } });
  }

  async function onSignal(data) {
    const conn = pc;
    try {
      if (data?.description) await conn.setRemoteDescription(data.description);
      else if (data?.candidate) await conn.addIceCandidate(data.candidate);
    } catch (err) {
      console.warn('Birlikte İzle: kamera bağlantısı', err);
    }
  }

  function closePc() {
    pc?.close();
    pc = null;
    session = '';
  }

  function stop() {
    info = null;
    closePc();
    ui?.host.remove();
    ui = null;
  }

  // --- Baloncuklar ---------------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .cams { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
      font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; cursor: grab; user-select: none; touch-action: none; }
    .cams.dragging { cursor: grabbing; }
    .cam { position: relative; margin: 0; width: 220px; aspect-ratio: 4 / 3; border-radius: 18px; overflow: hidden; background: #1c1c22;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45), 0 0 0 1px rgba(255, 255, 255, .12); }
    .big .cam.peer { width: 360px; }
    .cam.self { width: 132px; }
    .big .cam.self { width: 200px; }
    .cam video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cam.self video { transform: scaleX(-1); }
    .cam .off { position: absolute; inset: 0; display: none; place-items: center; font-size: 28px; font-weight: 600;
      background: radial-gradient(circle at 50% 40%, #3a3a46, #1c1c22); }
    .cam.is-off video { visibility: hidden; }
    .cam.is-off .off { display: grid; }
    .name { position: absolute; left: 10px; bottom: 8px; padding: 2px 8px; border-radius: 99px; background: rgba(0, 0, 0, .45); }
    .hide { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border: 0; border-radius: 50%;
      background: rgba(0, 0, 0, .5); color: #fff; font-size: 15px; line-height: 24px; cursor: pointer; opacity: 0; transition: opacity .15s; }
    .cam:hover .hide { opacity: 1; }
    .cam[hidden] { display: none; }
    .show { border: 0; border-radius: 99px; padding: 7px 12px; background: rgba(20, 20, 26, .8); color: #fff; font: inherit; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .4); }
    .show[hidden] { display: none; }
  `;

  // Sitelerin güvenlik kuralları (CSP, Trusted Types) satır içi stile ve innerHTML'e izin vermeyebilir:
  // stil yapılandırılmış sayfa olarak, öğeler DOM ile kurulur.
  const el = (tag, cls, parent) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    parent?.appendChild(node);
    return node;
  };

  function build() {
    const host = document.createElement('birlikte-kameralar');
    // Kapalı gölge: sayfanın betikleri baloncuklardaki görüntüye ulaşamaz
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    const box = el('div', 'cams', root);
    const bubble = (cls, onHide) => {
      const fig = el('figure', `cam ${cls}`, box);
      const video = el('video', '', fig);
      video.autoplay = video.muted = video.playsInline = true;
      el('div', 'off', fig);
      el('span', 'name', fig);
      const hide = el('button', 'hide', fig);
      hide.title = 'Gizle';
      hide.textContent = '×';
      hide.onclick = onHide;
      return { fig, video };
    };
    const peer = bubble('peer', () => setPref({ hidePeer: true }));
    const self = bubble('self', () => setPref({ hideSelf: true }));
    const showBtn = el('button', 'show', box);
    showBtn.hidden = true;
    showBtn.onclick = () => setPref({ hidePeer: false, hideSelf: false });
    box.ondblclick = (e) => !e.target.closest('button') && setPref({ big: !prefs.big });
    dragging(box);
    // Görüntü geliyor mu (boyutu): sorun ararken ve testte görülsün; görüntünün kendisi kapalı gölgede kalır
    for (const [key, v] of [['peer', peer.video], ['self', self.video]]) {
      v.addEventListener('resize', () => (host.dataset[key] = `${v.videoWidth}x${v.videoHeight}`));
    }
    return { host, box, peer: peer.fig, self: self.fig, showBtn, peerVideo: peer.video, selfVideo: self.video };
  }

  function setPref(patch) {
    prefs = { ...prefs, ...patch };
    save();
    render();
  }

  /** Baloncukları sürükle (konum ekranın oranı olarak saklanır: pencere boyu değişse de yerinde kalır) */
  function dragging(box) {
    let start = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = box.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    });
    box.addEventListener('pointermove', (e) => {
      if (!start || !(e.buttons & 1)) return (start = null);
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      if (!start.moved) {
        start.moved = true;
        box.setPointerCapture(e.pointerId);
        box.classList.add('dragging');
      }
      const r = box.getBoundingClientRect();
      const left = Math.min(Math.max(0, start.left + dx), innerWidth - r.width);
      const top = Math.min(Math.max(0, start.top + dy), innerHeight - r.height);
      prefs.x = left / Math.max(1, innerWidth - r.width);
      prefs.y = top / Math.max(1, innerHeight - r.height);
      place();
    });
    const end = () => {
      if (start?.moved) save();
      start = null;
      box.classList.remove('dragging');
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  function place() {
    if (!ui) return;
    const { box } = ui;
    if (prefs.x == null) {
      box.style.left = box.style.top = '';
      box.style.right = '24px';
      box.style.bottom = '96px';
      return;
    }
    const r = box.getBoundingClientRect();
    box.style.right = box.style.bottom = '';
    box.style.left = `${Math.round(prefs.x * Math.max(0, innerWidth - r.width))}px`;
    box.style.top = `${Math.round(prefs.y * Math.max(0, innerHeight - r.height))}px`;
  }

  function render() {
    if (!info) return;
    if (!ui) ui = build();
    mount();
    const { box, peer, self, showBtn } = ui;
    box.classList.toggle('big', !!prefs.big);
    const bubble = (el, name, on, hidden) => {
      el.querySelector('.name').textContent = name;
      el.querySelector('.off').textContent = (name.trim()[0] || '?').toLocaleUpperCase('tr');
      el.classList.toggle('is-off', !on);
      el.hidden = hidden;
    };
    bubble(peer, info.peer, info.peerOn, prefs.hidePeer);
    bubble(self, info.self, info.selfOn, prefs.hideSelf);
    const hidden = [prefs.hidePeer && info.peer, prefs.hideSelf && 'sen'].filter(Boolean);
    showBtn.hidden = !hidden.length;
    showBtn.textContent = `${hidden.join(' ve ')} gizli · Göster`;
    place();
  }

  /** Tam ekranda sadece tam ekrana geçen öğenin içi görünür: baloncukları oraya taşı */
  function mount() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME' ? fs : document.documentElement;
    if (ui.host.parentNode === parent) return;
    parent.appendChild(ui.host);
    // Taşınan video durur: yeniden oynat
    for (const v of [ui.peerVideo, ui.selfVideo]) if (v.srcObject) v.play().catch(() => {});
  }

  document.addEventListener('fullscreenchange', () => ui && render());
  addEventListener('resize', () => ui && place());
})();
