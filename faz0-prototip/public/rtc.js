// P2P bağlantı katmanı: signaling (WebSocket), RTCPeerConnection ("perfect negotiation"),
// kontrol kanalı (DataChannel) ve anahtar adıyla yönetilen yerel izler.
//
// Olaylar: status, peer, peer-left, full, open, close, message, track, connection

export class Link extends EventTarget {
  constructor({ room, name }) {
    super();
    this.room = room;
    this.name = name;
    this.peerName = null;
    this.pc = null;
    this.dc = null;
    this.polite = false;
    this.session = 0;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.codec = 'auto';
    this.local = new Map(); // anahtar -> { track, stream, encoding }
    this.senders = new Map(); // anahtar -> RTCRtpSender (geçerli pc için)
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async start() {
    const config = await fetch('/config').then((r) => r.json());
    this.iceServers = config.iceServers;
    this.connectSignaling();
  }

  // --- Signaling ----------------------------------------------------------

  connectSignaling() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: this.room, name: this.name }));
    ws.onmessage = (e) => this.onServer(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.emit('status', 'Sunucuya yeniden bağlanılıyor…');
      setTimeout(() => this.connectSignaling(), 2000);
    };
  }

  onServer(msg) {
    switch (msg.type) {
      case 'joined':
        if (!msg.peer) return this.emit('status', 'waiting');
        this.beginSession(msg);
        break;
      case 'peer-joined':
        this.beginSession(msg);
        break;
      case 'peer-left':
        // Bağlantıyı hemen kapatmıyoruz: sadece sunucu bağlantısı kopmuş olabilir,
        // P2P hâlâ yaşıyor olabilir. Gerçekten gittiyse kanal kendiliğinden kapanır.
        this.emit('peer-left');
        break;
      case 'full':
        this.emit('full');
        break;
      case 'signal':
        this.onSignal(msg.data);
        break;
    }
  }

  beginSession({ peer, polite, session }) {
    this.peerName = peer.name;
    this.polite = polite;
    this.session = session;
    this.emit('peer', peer);
    this.resetPeerConnection();
  }

  signal(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', data: { ...data, session: this.session } }));
    }
  }

  // --- RTCPeerConnection --------------------------------------------------

  resetPeerConnection() {
    this.pc?.close();
    this.senders.clear();

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.makingOffer = false;
    this.ignoreOffer = false;

    pc.onnegotiationneeded = () => this.negotiate(pc);
    pc.onicecandidate = ({ candidate }) => this.signal({ candidate });
    pc.ontrack = ({ track, streams, transceiver }) => {
      if (track.kind === 'video') applyCodecPreference(transceiver, this.codec);
      this.emit('track', { track, stream: streams[0] });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.emit('connection', pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    // İlk teklif çakışmasını baştan önle: kibar taraf, ilk teklifi cevaplayana kadar
    // kanal açmaz ve iz eklemez. (Chrome'da geri alınan ilk teklif, veri kanalını da
    // düşürebiliyor; bu yüzden çakışmayı sonradan çözmek yerine hiç oluşturmuyoruz.)
    this.setupPending = this.polite;
    if (!this.polite) this.setupChannelAndTracks(pc);
  }

  setupChannelAndTracks(pc) {
    // Her iki taraf da aynı kimlikle açar; kimin oluşturduğu tartışması olmaz.
    const dc = pc.createDataChannel('kontrol', { negotiated: true, id: 0 });
    this.dc = dc;
    dc.onopen = () => this.emit('open');
    dc.onclose = () => this.dc === dc && this.emit('close');
    dc.onmessage = (e) => this.emit('message', JSON.parse(e.data));

    for (const [key, entry] of this.local) if (entry.track) this.addSender(key, entry);
  }

  async negotiate(pc) {
    if (this.pc !== pc) return;
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      this.signal({ description: pc.localDescription });
    } catch (err) {
      console.error('Teklif oluşturulamadı', err);
    } finally {
      this.makingOffer = false;
    }
  }

  async onSignal({ description, candidate, session }) {
    const pc = this.pc;
    if (!pc || session !== this.session) return;
    try {
      if (description) {
        const collision =
          description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(acceptStereo(description));
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.signal({ description: pc.localDescription });
          if (this.setupPending && this.pc === pc) {
            this.setupPending = false;
            this.setupChannelAndTracks(pc);
          }
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('Sinyal işlenemedi', err);
    }
  }

  // --- Kontrol kanalı -----------------------------------------------------

  get isOpen() {
    return this.dc?.readyState === 'open';
  }

  send(msg) {
    if (this.isOpen) this.dc.send(JSON.stringify(msg));
  }

  // --- Yerel izler --------------------------------------------------------
  // Her iz bir anahtarla tutulur ("movie-video", "cam-audio"…). İz değişince
  // replaceTrack kullanılır; yeniden pazarlık gerekmez ve karşı taraf aynı akışı görür.

  async setTrack(key, track, stream, encoding) {
    const prev = this.local.get(key);
    const entry = { track, stream, encoding: { ...prev?.encoding, ...encoding } };
    this.local.set(key, entry);

    // Kibar taraf henüz kurulumda değilse iz sadece saklanır; kurulumda eklenir.
    if (!this.pc || this.pc.connectionState === 'closed' || this.setupPending) return;
    const sender = this.senders.get(key);
    if (sender) {
      if (sender.track !== track) await sender.replaceTrack(track);
      if (encoding) await this.setEncoding(key, encoding);
    } else if (track) {
      this.addSender(key, entry);
    }
  }

  addSender(key, { track, stream, encoding }) {
    const transceiver = this.pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [encoding ?? {}],
    });
    if (track.kind === 'video') applyCodecPreference(transceiver, this.codec);
    this.senders.set(key, transceiver.sender);
  }

  async setEncoding(key, patch) {
    const entry = this.local.get(key);
    if (entry) entry.encoding = { ...entry.encoding, ...patch };
    const sender = this.senders.get(key);
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0], patch);
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn('Gönderim ayarı uygulanamadı', key, err);
    }
  }

  setCodec(codec) {
    this.codec = codec;
    const pc = this.pc;
    if (!pc) return;
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track.kind === 'video' && t.currentDirection !== 'stopped') {
        applyCodecPreference(t, codec);
      }
    }
    // Codec tercihi sadece yeni bir pazarlıkta geçerli olur.
    if (pc.signalingState === 'stable' && pc.connectionState === 'connected') this.negotiate(pc);
  }
}

// --- Yardımcılar ----------------------------------------------------------

function applyCodecPreference(transceiver, codec) {
  if (typeof transceiver.setCodecPreferences !== 'function') return;
  const all = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  if (codec === 'auto') return transceiver.setCodecPreferences([]);
  const wanted = all.filter((c) => c.mimeType.toLowerCase() === `video/${codec}`);
  if (!wanted.length) return;
  try {
    transceiver.setCodecPreferences([...wanted, ...all.filter((c) => !wanted.includes(c))]);
  } catch (err) {
    console.warn('Codec tercihi uygulanamadı', err);
  }
}

// Karşı tarafın açıklamasına "stereo=1" ekler: bu, karşının stereo almak istediğini söyler,
// böylece bizim Opus kodlayıcımız filmi stereo gönderir. (İki uç da bizim uygulamamız.)
function acceptStereo({ type, sdp }) {
  const opus = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((m) => m[1]);
  let out = sdp;
  for (const pt of opus) {
    out = out.replace(new RegExp(`a=fmtp:${pt} (.*)`, 'g'), (line, params) =>
      params.includes('stereo=') ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1`,
    );
  }
  return { type, sdp: out };
}
