// Kameralar sitenin üstünde: tarayıcıda izlerken (Netflix, Disney+…) uygulama iki kamerayı (onunki ve
// benimki) bu bilgisayarın içinde, doğrudan bir WebRTC bağlantısıyla sekmeye verir; burada sayfanın
// üstünde iki baloncuk olarak görünür (tam ekranda da). Görüntü bilgisayardan dışarı çıkmaz. Ses
// sayfaya gelmez: konuşma uygulamadan duyulur (yankı engelleme orada).
// Fareyle üstüne gelince çubuk: kamera ve mikrofon aç/kapat (uygulamadakiyle aynı), baloncukları gizle.
// Baloncuk köşedeki tutamaçtan çekilerek büyütülür. Arka plan bu betiği sadece videonun olduğu
// çerçevede açar ({ t: 'cams' }).

(() => {
  if (window.__birlikteCams) return;
  // Sadece eklentinin kendi dünyasında görünür (sayfanın betikleri göremez); testler baloncuklara buradan ulaşır.
  window.__birlikteCams = { root: () => ui?.root ?? null };

  let info = null; // { peer, self, peerOn, selfOn, micOn, peerMicOn }
  let pc = null;
  let session = '';
  let ui = null;
  // size: onun baloncuğunun genişliği (benimki onun %60'ı); big: çift tıkla büyütülmüş
  let prefs = { x: null, y: null, size: 220, big: false, hidePeer: false, hideSelf: false };
  const MIN = 140;

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
      info = {
        peer: String(msg.peer || 'O'),
        self: String(msg.self || 'Ben'),
        peerOn: !!msg.peerOn,
        selfOn: !!msg.selfOn,
        micOn: !!msg.micOn,
        peerMicOn: msg.peerMicOn !== false,
      };
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
    .cams { --w: 220px; position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
      font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; cursor: grab; user-select: none; touch-action: none; }
    .cams.left { align-items: flex-start; }
    .cams.dragging { cursor: grabbing; }
    .cam { position: relative; margin: 0; width: var(--w); aspect-ratio: 4 / 3; border-radius: 18px; overflow: hidden; background: #1c1c22;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45), 0 0 0 1px rgba(255, 255, 255, .12); }
    .cam.self { width: calc(var(--w) * .6); }
    .cam video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cam.self video { transform: scaleX(-1); }
    .cam .off { position: absolute; inset: 0; display: none; place-items: center; font-size: 28px; font-weight: 600;
      background: radial-gradient(circle at 50% 40%, #3a3a46, #1c1c22); }
    .cam.is-off video { visibility: hidden; }
    .cam.is-off .off { display: grid; }
    .name { position: absolute; left: 10px; bottom: 8px; display: flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 99px;
      background: rgba(0, 0, 0, .45); }
    .name svg { display: none; width: 12px; height: 12px; color: #ff6b6b; }
    .cam.muted .name svg { display: block; }
    .hide { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border: 0; border-radius: 50%;
      background: rgba(0, 0, 0, .5); color: #fff; font-size: 15px; line-height: 24px; cursor: pointer; opacity: 0; transition: opacity .15s; }
    .grip { position: absolute; bottom: 0; right: 0; width: 22px; height: 22px; cursor: nwse-resize; opacity: 0; transition: opacity .15s;
      background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, .7) 50%, rgba(255, 255, 255, .7) 58%, transparent 58%,
        transparent 70%, rgba(255, 255, 255, .7) 70%, rgba(255, 255, 255, .7) 78%, transparent 78%); }
    .right .grip { left: 0; right: auto; cursor: nesw-resize; transform: scaleX(-1); }
    .cam:hover .hide, .cam:hover .grip, .resizing .grip { opacity: 1; }
    .cam[hidden], .bar[hidden], .show[hidden] { display: none; }
    .bar { display: flex; gap: 6px; padding: 5px; border-radius: 99px; background: rgba(20, 20, 26, .82); box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
      opacity: 0; transform: translateY(-4px); transition: opacity .15s, transform .15s; pointer-events: none; }
    .cams:hover .bar, .cams:focus-within .bar { opacity: 1; transform: none; pointer-events: auto; }
    .bar button { display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(255, 255, 255, .12);
      color: #fff; cursor: pointer; }
    .bar button:hover { background: rgba(255, 255, 255, .22); }
    .bar button.off { background: #e5484d; }
    .bar svg { width: 18px; height: 18px; }
    .show { border: 0; border-radius: 99px; padding: 7px 12px; background: rgba(20, 20, 26, .8); color: #fff; font: inherit; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .4); }
  `;

  // Simgeler (lucide). Sitelerin güvenlik kuralları (CSP, Trusted Types) innerHTML'e izin vermeyebilir:
  // öğeler DOM ile kurulur, stil yapılandırılmış stil sayfası olarak verilir.
  const ICONS = {
    cam: [['path', { d: 'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5' }], ['rect', { x: 2, y: 6, width: 14, height: 12, rx: 2 }]],
    camOff: [
      ['path', { d: 'M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196' }],
      ['path', { d: 'M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2' }],
      ['path', { d: 'm2 2 20 20' }],
    ],
    mic: [
      ['path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }],
      ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
      ['path', { d: 'M12 19v3' }],
    ],
    micOff: [
      ['path', { d: 'm2 2 20 20' }],
      ['path', { d: 'M18.89 13.23A7.12 7.12 0 0 0 19 12v-2' }],
      ['path', { d: 'M5 10v2a7 7 0 0 0 12 5' }],
      ['path', { d: 'M15 9.34V5a3 3 0 0 0-5.68-1.33' }],
      ['path', { d: 'M9 9v3a3 3 0 0 0 5.12 2.12' }],
      ['path', { d: 'M12 19v3' }],
    ],
    eyeOff: [
      ['path', { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' }],
      ['path', { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' }],
      ['path', { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' }],
      ['path', { d: 'm2 2 20 20' }],
    ],
  };

  const el = (tag, cls, parent) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    parent?.appendChild(node);
    return node;
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      svg.setAttribute(k, String(v));
    }
    for (const [tag, attrs] of ICONS[name]) {
      const part = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) part.setAttribute(k, String(v));
      svg.appendChild(part);
    }
    return svg;
  }

  function button(cls, title, onClick, parent) {
    const b = el('button', cls, parent);
    b.type = 'button';
    b.title = b.ariaLabel = title;
    b.onclick = onClick;
    return b;
  }

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
      const name = el('span', 'name', fig);
      name.appendChild(icon('micOff'));
      el('span', 'label', name);
      button('hide', 'Gizle', onHide, fig).textContent = '×';
      return { fig, video };
    };
    const peer = bubble('peer', () => setPref({ hidePeer: true }));
    const self = bubble('self', () => setPref({ hideSelf: true }));
    const grip = el('div', 'grip', peer.fig);
    grip.title = 'Boyutu değiştir';
    resizing(box, grip);

    // Çubuk: uygulamadaki C / M tuşlarıyla aynı; gizle sadece bu sayfada
    const bar = el('div', 'bar', box);
    const camBtn = button('cam', 'Kamerayı kapat', () => send({ t: 'cam-cmd', cmd: 'cam' }), bar);
    const micBtn = button('mic', 'Mikrofonu kapat', () => send({ t: 'cam-cmd', cmd: 'mic' }), bar);
    button('hide-all', 'Kameraları gizle (sadece bu sayfada)', () => setPref({ hidePeer: true, hideSelf: true }), bar).appendChild(icon('eyeOff'));

    const showBtn = button('show', 'Kameraları göster', () => setPref({ hidePeer: false, hideSelf: false }), box);
    showBtn.hidden = true;
    box.ondblclick = (e) => !e.target.closest('button, .grip') && setPref({ big: !prefs.big });
    dragging(box);
    // Görüntü geliyor mu (boyutu): sorun ararken ve testte görülsün; görüntünün kendisi kapalı gölgede kalır
    for (const [key, v] of [['peer', peer.video], ['self', self.video]]) {
      v.addEventListener('resize', () => (host.dataset[key] = `${v.videoWidth}x${v.videoHeight}`));
    }
    return { host, root, box, peer: peer.fig, self: self.fig, bar, camBtn, micBtn, showBtn, peerVideo: peer.video, selfVideo: self.video };
  }

  function setPref(patch) {
    prefs = { ...prefs, ...patch };
    save();
    render();
  }

  const width = () => Math.round(prefs.size * (prefs.big ? 1.6 : 1));
  const maxWidth = () => Math.max(MIN, Math.min(720, innerWidth * 0.6));

  /** Köşedeki tutamaçtan çekince büyür/küçülür (ekranın ortasına doğru çekmek büyütür) */
  function resizing(box, grip) {
    let start = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const r = box.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, w: width(), dir: r.left + r.width / 2 > innerWidth / 2 ? -1 : 1 };
      box.classList.add('resizing');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = (e.clientX - start.x) * start.dir;
      const dy = ((e.clientY - start.y) * 4) / 3;
      const w = Math.min(maxWidth(), Math.max(MIN, start.w + Math.max(dx, dy)));
      prefs.size = w / (prefs.big ? 1.6 : 1);
      render();
    });
    const end = () => {
      if (start) save();
      start = null;
      box.classList.remove('resizing');
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /** Baloncukları sürükle (konum ekranın oranı olarak saklanır: pencere boyu değişse de yerinde kalır) */
  function dragging(box) {
    let start = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, .grip')) return;
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
    } else {
      const r = box.getBoundingClientRect();
      box.style.right = box.style.bottom = '';
      box.style.left = `${Math.round(prefs.x * Math.max(0, innerWidth - r.width))}px`;
      box.style.top = `${Math.round(prefs.y * Math.max(0, innerHeight - r.height))}px`;
    }
    // Sol yarıdaysa baloncuklar sola hizalanır, tutamaç ortaya bakan köşede durur
    const onLeft = prefs.x != null && prefs.x < 0.5;
    box.classList.toggle('left', onLeft);
    box.classList.toggle('right', !onLeft);
  }

  function render() {
    if (!info) return;
    if (!ui) ui = build();
    mount();
    const { box, peer, self, bar, camBtn, micBtn, showBtn } = ui;
    box.style.setProperty('--w', `${Math.min(maxWidth(), width())}px`);
    const bubble = (fig, name, on, muted, hidden) => {
      fig.querySelector('.label').textContent = name;
      fig.querySelector('.off').textContent = (name.trim()[0] || '?').toLocaleUpperCase('tr');
      fig.classList.toggle('is-off', !on);
      fig.classList.toggle('muted', muted);
      fig.hidden = hidden;
    };
    bubble(peer, info.peer, info.peerOn, !info.peerMicOn, prefs.hidePeer);
    bubble(self, info.self, info.selfOn, !info.micOn, prefs.hideSelf);

    const toggle = (btn, on, onIcon, offIcon, onTitle, offTitle) => {
      btn.replaceChildren(icon(on ? onIcon : offIcon));
      btn.classList.toggle('off', !on);
      btn.title = btn.ariaLabel = on ? onTitle : offTitle;
    };
    toggle(camBtn, info.selfOn, 'cam', 'camOff', 'Kamerayı kapat', 'Kamerayı aç');
    toggle(micBtn, info.micOn, 'mic', 'micOff', 'Mikrofonu kapat', 'Mikrofonu aç');
    const allHidden = prefs.hidePeer && prefs.hideSelf;
    bar.hidden = allHidden;
    ui.host.dataset.cam = info.selfOn ? 'on' : 'off';
    ui.host.dataset.mic = info.micOn ? 'on' : 'off';

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
  addEventListener('resize', () => ui && render());
})();
