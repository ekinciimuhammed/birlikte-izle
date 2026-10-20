// Oda bağlantısı: sunucuyla kalıcı WebSocket. Karşı tarafın çevrimiçi olup olmadığını,
// hangi ekranda olduğunu taşır ve P2P kurulum sinyallerini iletir.
// Bağlantı koparsa artan aralıklarla kendiliğinden yeniden bağlanır.

import {
  CloseCode,
  ServerMessage,
  parseJson,
  type ClientMessage,
  type PeerInfo,
  type PeerStatus,
  type SignalData,
} from '@birlikte/protocol';

import { Emitter } from '../util/emitter';

export type RoomState = 'idle' | 'connecting' | 'online' | 'offline' | 'replaced';

export class RoomClient extends Emitter<{ state: RoomState; peer: PeerInfo | null; signal: SignalData }> {
  state: RoomState = 'idle';
  peer: PeerInfo | null = null;

  private ws: WebSocket | null = null;
  private status: PeerStatus = { screen: 'home', title: null };
  private retry = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly url: () => string) {
    super();
  }

  start() {
    this.stopped = false;
    window.addEventListener('online', this.reconnectNow);
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    window.removeEventListener('online', this.reconnectNow);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setPeer(null);
    this.setState('idle');
  }

  setStatus(status: PeerStatus) {
    this.status = status;
    this.send({ type: 'status', status });
  }

  signal(data: SignalData) {
    this.send({ type: 'signal', data });
  }

  private connect() {
    clearTimeout(this.retryTimer);
    this.setState('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setState('online');
      this.send({ type: 'status', status: this.status });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
    };

    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      const msg = parseJson(ServerMessage, String(e.data));
      if (!msg) return;
      switch (msg.type) {
        case 'hello':
          this.setPeer(msg.peer);
          break;
        case 'peer':
          this.setPeer(msg.peer);
          break;
        case 'peer-left':
          this.setPeer(null);
          break;
        case 'signal':
          this.emit('signal', msg.data);
          break;
      }
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.setPeer(null);
      if (e.code === CloseCode.Replaced) return this.setState('replaced');
      if (this.stopped) return;
      this.setState('offline');
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private reconnectNow = () => {
    if (!this.stopped && this.state === 'offline') this.connect();
  };

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setState(state: RoomState) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private setPeer(peer: PeerInfo | null) {
    this.peer = peer;
    this.emit('peer', peer);
  }
}
