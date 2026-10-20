// Tarayıcıda izlerken (Netflix, Disney+…) kameralar sitenin üstünde: eklenti sekmede iki baloncuk
// gösterir (apps/extension/cams.js). Görüntü bu bilgisayarın içinde, doğrudan bir WebRTC bağlantısıyla
// gider; dışarı çıkmaz. Ses uygulamada kalır (yankı engelleme burada). Teklifi sekme yapar (o hazır
// olunca), cevabı biz; sinyaller eklenti köprüsünden geçer.

import { bridge } from '../platform/bridge';

export interface BrowserCamsInfo {
  peer: string;
  self: string;
  /** Onun kamerası (kapalıysa null) */
  peerTrack: MediaStreamTrack | null;
  /** Benim kameram (arka plan bulanıksa işlenmiş hali) */
  selfTrack: MediaStreamTrack | null;
  micOn: boolean;
  peerMicOn: boolean;
}

/** Baloncuklardaki çubuktan: kamerayı / mikrofonu aç-kapat (uygulamadaki C / M) */
export type BrowserCamsCommand = 'cam' | 'mic';

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

export class BrowserCams {
  private info: BrowserCamsInfo | null = null;
  private pc: RTCPeerConnection | null = null;
  private session = '';
  private sent = '';

  constructor(onCommand: (cmd: BrowserCamsCommand) => void) {
    const ext = bridge.extension;
    if (!ext) return;
    ext.onMessage((m) => {
      if (m.t === 'cam-signal') void this.onSignal(String(m.session ?? ''), m.data as Signal | undefined);
      else if (m.t === 'cam-cmd' && this.info && (m.cmd === 'cam' || m.cmd === 'mic')) onCommand(m.cmd);
    });
    // Eklenti yeniden bağlandı: baloncukları yeniden iste
    ext.onStatus((s) => {
      this.sent = '';
      if (s.connected) this.announce();
      else this.closePc();
    });
  }

  /** null: baloncuklar kalksın (tarayıcıda izlemiyoruz) */
  update(info: BrowserCamsInfo | null) {
    this.info = info;
    this.announce();
    if (info) this.applyTracks();
    else this.closePc();
  }

  private announce() {
    const i = this.info;
    const msg = i
      ? { t: 'cams', on: true, peer: i.peer, self: i.self, peerOn: !!i.peerTrack, selfOn: !!i.selfTrack, micOn: i.micOn, peerMicOn: i.peerMicOn }
      : { t: 'cams', on: false };
    const key = JSON.stringify(msg);
    if (key === this.sent) return;
    this.sent = key;
    bridge.extension?.send(msg);
  }

  private async onSignal(session: string, data: Signal | undefined) {
    if (!this.info || !data) return;
    try {
      if (data.description?.type === 'offer') {
        // Sekme yeniden yüklendi ya da baloncuklar başka çerçeveye geçti: yeni bağlantı
        this.closePc();
        this.session = session;
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.pc = pc;
        pc.onicecandidate = ({ candidate }) => this.signal(pc, { candidate: candidate ? candidate.toJSON() : null });
        await pc.setRemoteDescription(data.description);
        if (this.pc !== pc) return;
        this.applyTracks();
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.pc === pc && pc.localDescription) this.signal(pc, { description: pc.localDescription.toJSON() });
      } else if (data.candidate && session === this.session) {
        await this.pc?.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.warn('Sitedeki kameralara bağlanılamadı', err);
    }
  }

  private signal(pc: RTCPeerConnection, data: Signal) {
    if (this.pc === pc) bridge.extension?.send({ t: 'cam-signal', session: this.session, data });
  }

  /** İz değişince (kamera açıldı, bağlantı yenilendi) yeniden pazarlık gerekmez: replaceTrack */
  private applyTracks() {
    const pc = this.pc;
    const info = this.info;
    if (!pc || !info) return;
    for (const [mid, track] of [['0', info.peerTrack], ['1', info.selfTrack]] as const) {
      const t = pc.getTransceivers().find((x) => x.mid === mid);
      if (!t) continue;
      // Sadece ilk cevaptan önce (sonra yön değişirse yeniden pazarlık gerekir)
      if (!pc.currentLocalDescription && t.direction !== 'sendonly') t.direction = 'sendonly';
      if (t.sender.track !== track) t.sender.replaceTrack(track).catch(() => {});
    }
  }

  private closePc() {
    this.pc?.close();
    this.pc = null;
    this.session = '';
  }
}
