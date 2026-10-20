// Eşleşme ve oda bağlantısı. Uygulama açık olduğu sürece odaya bağlı kalınır;
// böylece ana ekranda karşı tarafın çevrimiçi olup olmadığı ve ne yaptığı görünür.

import { create } from 'zustand';
import type { PeerInfo } from '@birlikte/protocol';
import { joinPairing, roomUrl, startPairing } from '../net/api';
import { RoomClient, type RoomState } from '../net/room';
import { getSetting, onSettingChange, setSetting } from '../settings/store';
import { watch } from '../watch/controller';

interface PresenceState {
  server: RoomState;
  peer: PeerInfo | null;
}

export const usePresence = create<PresenceState>(() => ({ server: 'idle', peer: null }));

let room: RoomClient | null = null;

export const isPaired = () => !!getSetting('pairing.coupleId') && !!getSetting('pairing.token');

export function connectRoom() {
  if (room || !isPaired()) return;
  const r = new RoomClient(() => roomUrl());
  room = r;
  r.on('state', (server) => usePresence.setState({ server }));
  r.on('peer', (peer) => {
    usePresence.setState({ peer });
    if (peer && peer.name !== getSetting('pairing.partnerName')) setSetting('pairing.partnerName', peer.name);
  });
  watch.attachRoom(r);
  r.start();
}

export function disconnectRoom() {
  watch.detachRoom();
  room?.stop();
  room = null;
  usePresence.setState({ server: 'idle', peer: null });
}

function savePairing(p: { coupleId: string; token: string; partnerId: string; partnerName: string }) {
  setSetting('pairing.coupleId', p.coupleId);
  setSetting('pairing.token', p.token);
  setSetting('pairing.partnerId', p.partnerId);
  setSetting('pairing.partnerName', p.partnerName);
  disconnectRoom();
  connectRoom();
}

export function unpair() {
  watch.leave();
  disconnectRoom();
  setSetting('pairing.coupleId', '');
  setSetting('pairing.token', '');
  setSetting('pairing.partnerId', '');
  setSetting('pairing.partnerName', '');
  setSetting('profile.partnerNickname', '');
}

/**
 * Kod oluşturur ve odaya bağlanıp karşı tarafın kodu girmesini bekler.
 * Dönen nesnedeki cancel() beklemeyi bırakır.
 */
export async function createPairing(onPaired: (partnerName: string) => void) {
  const res = await startPairing();
  const waiting = new RoomClient(() => roomUrl(res));
  waiting.on('peer', (peer) => {
    if (!peer) return;
    waiting.stop();
    savePairing({ coupleId: res.coupleId, token: res.token, partnerId: peer.deviceId, partnerName: peer.name });
    onPaired(peer.name);
  });
  waiting.start();
  return { code: res.code, expiresAt: res.expiresAt, cancel: () => waiting.stop() };
}

/** Karşı tarafın verdiği kodla eşleşir. */
export async function enterPairingCode(code: string) {
  const res = await joinPairing(code);
  savePairing({
    coupleId: res.coupleId,
    token: res.token,
    partnerId: res.partner.deviceId,
    partnerName: res.partner.name,
  });
  return res.partner.name;
}

// Ad veya sunucu adresi değişince odaya yeni bilgilerle bağlan (yazarken her harfte değil).
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
onSettingChange((key) => {
  if (key !== 'profile.name' && key !== 'connection.server') return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!room) return;
    disconnectRoom();
    connectRoom();
  }, 1000);
});
