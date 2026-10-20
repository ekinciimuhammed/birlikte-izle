// P2P bağlantı: film, kameralar ve kontrol kanalı doğrudan iki bilgisayar arasında akar.
//
// Oturumlar: Sadece "kibar olmayan" taraf (cihaz kimliği küçük olan) yeni oturum başlatır.
// Kibar taraf ilk teklifi cevaplayana kadar kanal açmaz, iz eklemez. Faz 0'da gördük:
// iki taraf aynı anda teklif gönderirse Chrome geri alınan teklifle veri kanalını düşürüyor.
// Sonraki değişiklikler (kamera açma vb.) "perfect negotiation" kalıbıyla çakışmasız yürür.

import { PeerMessage, parseJson, type SignalData } from '@birlikte/protocol';
import { Emitter } from '../util/emitter';

export type LinkState = 'connecting' | 'connected' | 'reconnecting';

export interface LinkOptions {
  polite: boolean;
  codec: string;
  iceServers: RTCIceServer[];
  policy: RTCIceTransportPolicy;
}

interface LocalTrack {
  track: MediaStreamTrack | null;
  stream: MediaStream;
  encoding: RTCRtpEncodingParameters;
}

type Events = {
  open: void;
  close: void;
  message: PeerMessage;
  track: { track: MediaStreamTrack; stream: MediaStream | null };
  state: LinkState;
  /** "dosya" kanalından gelen ikili parça */
  chunk: ArrayBuffer;
};

/** Dosya kanalında bekleyen veri bu sınırı aşınca gönderen bekler (akış denetimi). */
const FILE_HIGH_WATER = 4 << 20;
const FILE_LOW_WATER = 1 << 20;

export class Link extends Emitter<Events> {
  pc: RTCPeerConnection | null = null;

  private dc: RTCDataChannel | null = null;
  private fileDc: RTCDataChannel | null = null;
  private session = '';
  private codec: string;
  private makingOffer = false;
  private ignoreOffer = false;
  private setupPending = false;
  private stopped = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly local = new Map<string, LocalTrack>();
  private readonly senders = new Map<string, RTCRtpSender>();

  /** sendSignal: sinyali oda üzerinden karşıya iletir. Gelen sinyaller handleSignal'a verilir. */
  constructor(
    private readonly sendSignal: (data: SignalData) => void,
    private readonly opts: LinkOptions,
  ) {
    super();
    this.codec = opts.codec;
  }

  start() {
    if (!this.opts.polite) this.newSession();
  }

  /** grace: son mesajların ("görüşürüz") gidebilmesi için bağlantı bu kadar ms sonra kapanır */
  stop(grace = 0) {
    this.stopped = true;
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.answerTimer);
    if (grace) setTimeout(() => this.closePeerConnection(), grace);
    else this.closePeerConnection();
  }

  get isOpen() {
    return this.dc?.readyState === 'open';
  }

  get polite() {
    return this.opts.polite;
  }

  /** Oturumu baştan kur (sadece kibar olmayan taraf; kibar taraf yeni teklifle kendini yeniler). */
  renew() {
    if (!this.stopped && !this.opts.polite) this.newSession();
  }

  /** TURN kimlik bilgileri süreli: tazeleri sonraki ICE yenilemesinde ve yeni oturumlarda kullanılır. */
  setIceServers(iceServers: RTCIceServer[]) {
    this.opts.iceServers = iceServers;
    const pc = this.pc;
    if (!pc || pc.connectionState === 'closed') return;
    try {
      pc.setConfiguration({ ...pc.getConfiguration(), iceServers });
    } catch (err) {
      console.warn('ICE sunucuları güncellenemedi', err);
    }
  }

  /** Ağ değişti: 4 sn'lik kopukluğu beklemeden yeni yolları dene. */
  restartIce() {
    const pc = this.pc;
    if (pc && pc.connectionState !== 'closed' && !this.setupPending) pc.restartIce();
  }

  send(msg: PeerMessage) {
    if (this.isOpen) this.dc!.send(JSON.stringify(msg));
  }

  /** Dosya parçası gönderir; kanal doluysa önce boşalmasını bekler. */
  async sendChunk(chunk: Uint8Array) {
    const dc = this.fileDc;
    if (!dc || dc.readyState !== 'open') throw new Error('Dosya kanalı kapalı');
    if (dc.bufferedAmount > FILE_HIGH_WATER) {
      await new Promise<void>((resolve, reject) => {
        dc.onbufferedamountlow = () => resolve();
        dc.onclose = () => reject(new Error('Dosya kanalı kapandı'));
      });
    }
    dc.send(chunk as Uint8Array<ArrayBuffer>);
  }

  // --- Oturum ---------------------------------------------------------------

  private newSession(session: string = crypto.randomUUID(), waitForOffer = false) {
    this.closePeerConnection();
    this.session = session;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.setupPending = waitForOffer;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers, iceTransportPolicy: this.opts.policy });
    this.pc = pc;
    pc.onnegotiationneeded = () => this.negotiate(pc);
    pc.onicecandidate = ({ candidate }) =>
      this.signal({ candidate: candidate ? (candidate.toJSON() as SignalData['candidate']) : null });
    pc.ontrack = ({ track, streams, transceiver }) => {
      if (track.kind === 'video') applyCodecPreference(transceiver, this.codec);
      this.emit('track', { track, stream: streams[0] ?? null });
    };
    pc.onconnectionstatechange = () => this.onConnectionState(pc);

    this.emit('state', 'connecting');
    if (!waitForOffer) {
      this.setupChannelAndTracks(pc);
      // İlk teklif yolda kaybolursa (karşı taraf o an hazır değildiyse) baştan dene.
      this.recover(pc, 10_000, () => this.newSession());
    }
  }

  private setupChannelAndTracks(pc: RTCPeerConnection) {
    // İki taraf da aynı kimlikle açar; kimin oluşturduğu tartışması olmaz.
    const dc = pc.createDataChannel('kontrol', { negotiated: true, id: 0 });
    this.dc = dc;
    dc.onopen = () => this.dc === dc && this.emit('open');
    dc.onclose = () => this.dc === dc && this.emit('close');
    dc.onmessage = (e) => {
      const msg = parseJson(PeerMessage, String(e.data));
      if (msg) this.emit('message', msg);
    };

    // Dosya gönderimi ayrı kanalda: büyük veri kontrol mesajlarını bekletmesin.
    const fileDc = pc.createDataChannel('dosya', { negotiated: true, id: 1, ordered: true });
    fileDc.binaryType = 'arraybuffer';
    fileDc.bufferedAmountLowThreshold = FILE_LOW_WATER;
    fileDc.onmessage = (e) => e.data instanceof ArrayBuffer && this.emit('chunk', e.data);
    this.fileDc = fileDc;

    for (const [key, entry] of this.local) if (entry.track) this.addSender(key, entry);
  }

  private closePeerConnection() {
    const dc = this.dc;
    this.dc = null;
    if (dc?.readyState === 'open') this.emit('close');
    dc?.close();
    this.fileDc?.close();
    this.fileDc = null;
    this.pc?.close();
    this.pc = null;
    this.senders.clear();
  }

  private onConnectionState(pc: RTCPeerConnection) {
    if (this.pc !== pc) return;
    switch (pc.connectionState) {
      case 'connected':
        clearTimeout(this.recoveryTimer);
        this.emit('state', 'connected');
        break;
      case 'disconnected':
        // Kısa kesintiler kendiliğinden toparlanır; 4 sn sürerse ICE'ı yenile.
        this.emit('state', 'reconnecting');
        this.recover(pc, 4_000, () => pc.restartIce());
        break;
      case 'failed':
        // Toparlanamazsa 15 sn sonra baştan yeni oturum.
        this.emit('state', 'reconnecting');
        if (!this.opts.polite) pc.restartIce();
        this.recover(pc, 15_000, () => this.newSession());
        break;
    }
  }

  /** Kurtarmayı sadece kibar olmayan taraf yapar; kibar taraf onun teklifini bekler. */
  private recover(pc: RTCPeerConnection, delay: number, action: () => void) {
    if (this.opts.polite) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      if (!this.stopped && this.pc === pc && pc.connectionState !== 'connected') action();
    }, delay);
  }

  // --- Sinyaller --------------------------------------------------------------

  private signal(data: Omit<SignalData, 'session'>) {
    this.sendSignal({ ...data, session: this.session });
  }

  private async negotiate(pc: RTCPeerConnection) {
    if (this.pc !== pc || this.setupPending) return;
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      if (this.pc !== pc || pc.signalingState !== 'stable') return; // bu arada karşıdan teklif geldi
      await pc.setLocalDescription(withStereo(offer));
      if (pc.localDescription) this.signal({ description: describe(pc.localDescription) });
      // Teklif karşıda uygulanamazsa cevap hiç gelmez ve sonraki pazarlıklar takılır: temiz başla.
      if (!this.opts.polite) {
        clearTimeout(this.answerTimer);
        this.answerTimer = setTimeout(() => {
          if (!this.stopped && this.pc === pc && pc.signalingState === 'have-local-offer') this.newSession();
        }, 8000);
      }
    } catch (err) {
      console.error('Teklif oluşturulamadı', err);
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(data: SignalData) {
    if (this.stopped) return;
    // Yeni bir oturumun ilk teklifi: kibar taraf kendini bu oturuma göre kurar.
    if (data.description?.type === 'offer' && data.session !== this.session) {
      if (!this.opts.polite) return;
      this.newSession(data.session, true);
    }
    const pc = this.pc;
    if (!pc || data.session !== this.session) return;

    try {
      if (data.description) {
        const { description } = data;
        const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.opts.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(withStereo(description));
        if (description.type === 'answer') clearTimeout(this.answerTimer);
        if (description.type === 'offer') {
          await pc.setLocalDescription(withStereo(await pc.createAnswer()));
          if (pc.localDescription) this.signal({ description: describe(pc.localDescription) });
          if (this.setupPending && this.pc === pc) {
            this.setupPending = false;
            this.setupChannelAndTracks(pc);
          }
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      // Aynı anda iki taraftan gelen tekliflerden sonra Chromium bazen yeni teklifi kabul etmiyor
      // ("RTP extension ID reassignment"). Bağlantı yarım kalmasın: kibar olmayan taraf hemen,
      // kibar taraf için de karşı taraf (cevapsız kalan teklifinden) temiz bir oturum başlatır.
      if (data.description?.type === 'offer') {
        console.warn('Teklif uygulanamadı, oturum yenilenecek', err);
        if (!this.opts.polite && this.pc === pc) this.newSession();
        return;
      }
      console.error('Sinyal işlenemedi', err);
    }
  }

  // --- Yerel izler -------------------------------------------------------------
  // Her iz bir anahtarla tutulur ("movie-video", "cam-audio"…). İz değişince replaceTrack
  // kullanılır: yeniden pazarlık gerekmez ve karşı taraf aynı akış kimliğini görür.

  async setTrack(key: string, track: MediaStreamTrack | null, stream: MediaStream, encoding?: RTCRtpEncodingParameters) {
    const prev = this.local.get(key);
    const entry: LocalTrack = { track, stream, encoding: { ...prev?.encoding, ...encoding } };
    this.local.set(key, entry);

    const pc = this.pc;
    if (!pc || pc.connectionState === 'closed' || this.setupPending) return;
    const sender = this.senders.get(key);
    if (sender) {
      if (sender.track !== track) await sender.replaceTrack(track);
      if (encoding) await this.setEncoding(key, encoding);
    } else if (track) {
      this.addSender(key, entry);
    }
  }

  private addSender(key: string, { track, stream, encoding }: LocalTrack) {
    if (!this.pc || !track) return;
    const transceiver = this.pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [encoding],
    });
    if (track.kind === 'video') applyCodecPreference(transceiver, this.codec);
    this.senders.set(key, transceiver.sender);
  }

  async setEncoding(key: string, patch: RTCRtpEncodingParameters) {
    const entry = this.local.get(key);
    if (entry) entry.encoding = { ...entry.encoding, ...patch };
    const sender = this.senders.get(key);
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0]!, patch);
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn('Gönderim ayarı uygulanamadı', key, err);
    }
  }

  setCodec(codec: string) {
    this.codec = codec;
    const pc = this.pc;
    if (!pc) return;
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track.kind === 'video' && t.currentDirection !== 'stopped') applyCodecPreference(t, codec);
    }
    // Codec tercihi yeni bir pazarlıkta geçerli olur.
    if (pc.signalingState === 'stable' && pc.connectionState === 'connected') this.negotiate(pc);
  }
}

// --- Yardımcılar -----------------------------------------------------------------

function applyCodecPreference(transceiver: RTCRtpTransceiver, codec: string) {
  if (typeof transceiver.setCodecPreferences !== 'function') return;
  const all = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  try {
    if (codec === 'auto') return transceiver.setCodecPreferences([]);
    const wanted = all.filter((c) => c.mimeType.toLowerCase() === `video/${codec}`);
    if (!wanted.length) return;
    transceiver.setCodecPreferences([...wanted, ...all.filter((c) => !wanted.includes(c))]);
  } catch (err) {
    console.warn('Codec tercihi uygulanamadı', err);
  }
}

// Opus satırlarına "stereo=1" ekler. İki yönde de gerekli (ölçülerek görüldü):
// karşının açıklamasında olunca bizim kodlayıcımız stereo GÖNDERİR; kendi açıklamamızda olunca
// bizim çözücümüz stereo ÇÖZER. Yalnızca birinde olursa ses mono'ya düşer.
function withStereo({ type, sdp = '' }: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  const opus = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((m) => m[1]);
  let out = sdp;
  for (const pt of opus) {
    out = out.replace(new RegExp(`a=fmtp:${pt} (.*)`, 'g'), (line, params: string) =>
      params.includes('stereo=') ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1`,
    );
  }
  return { type, sdp: out };
}

function describe(d: RTCSessionDescription): NonNullable<SignalData['description']> {
  return { type: d.type, sdp: d.sdp };
}
