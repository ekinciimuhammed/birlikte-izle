// Sinyal sunucusunun HTTP uçları: eşleşme ve STUN/TURN bilgisi.

import {
  ApiError,
  IceResponse,
  PairJoinResponse,
  PairStartResponse,
  type ApiErrorCode,
} from '@birlikte/protocol';
import type { z } from 'zod';
import { getSetting } from '../settings/store';

export class ApiFailure extends Error {
  constructor(readonly code: ApiErrorCode | 'network') {
    super(code);
  }
}

export const FALLBACK_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

const base = () => getSetting('connection.server').trim().replace(/\/+$/, '');

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiFailure('network');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure(ApiError.safeParse(data).data?.error ?? 'server');
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiFailure('server');
  return parsed.data;
}

const identity = () => ({ deviceId: getSetting('device.id'), name: getSetting('profile.name') });

export function startPairing() {
  return request('/pair/start', PairStartResponse, { method: 'POST', body: JSON.stringify(identity()) });
}

export function joinPairing(code: string) {
  return request('/pair/join', PairJoinResponse, {
    method: 'POST',
    body: JSON.stringify({ ...identity(), code }),
  });
}

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const q = new URLSearchParams({ couple: getSetting('pairing.coupleId'), token: getSetting('pairing.token') });
  try {
    const { iceServers } = await request(`/ice?${q}`, IceResponse);
    return iceServers;
  } catch (err) {
    console.warn('ICE sunucuları alınamadı, sadece STUN kullanılacak', err);
    return FALLBACK_ICE;
  }
}

export function roomUrl(pairing?: { coupleId: string; token: string }) {
  const coupleId = pairing?.coupleId ?? getSetting('pairing.coupleId');
  const token = pairing?.token ?? getSetting('pairing.token');
  const q = new URLSearchParams({
    token,
    deviceId: getSetting('device.id'),
    name: getSetting('profile.name') || 'Ben',
  });
  return `${base().replace(/^http/, 'ws')}/room/${coupleId}?${q}`;
}

export function apiErrorText(err: unknown): string {
  const code = err instanceof ApiFailure ? err.code : 'server';
  switch (code) {
    case 'network':
      return 'Sunucuya ulaşılamadı. İnternet bağlantını ve Ayarlar → Bağlantı → Sunucu adresini kontrol et.';
    case 'invalid-code':
      return 'Bu kod geçersiz ya da süresi dolmuş. Ondan yeni bir kod iste.';
    case 'rate-limited':
      return 'Çok fazla deneme oldu. Birkaç dakika sonra tekrar dene.';
    default:
      return 'Bir şeyler ters gitti. Biraz sonra tekrar dene.';
  }
}
