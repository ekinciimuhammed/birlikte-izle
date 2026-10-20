// Birlikte İzle protokolü: uygulama ↔ sunucu (HTTP + WebSocket) ve
// uygulama ↔ uygulama (P2P DataChannel) mesajlarının tek tanımı.
// Gelen her mesaj bu şemalarla doğrulanır; uymayan mesaj sessizce yok sayılır.

import { z } from 'zod';

// --- Ortak parçalar ----------------------------------------------------------

export const DeviceId = z.uuid();
export const Name = z.string().trim().min(1).max(32);
export const PairCode = z.string().regex(/^\d{6}$/);
const Seconds = z.number().min(0).max(1e7);

export const Screen = z.enum(['home', 'watch']);
export type Screen = z.infer<typeof Screen>;

export const PeerStatus = z.object({
  screen: Screen,
  title: z.string().max(200).nullable(),
});
export type PeerStatus = z.infer<typeof PeerStatus>;

export const PeerInfo = z.object({
  deviceId: DeviceId,
  name: Name,
  status: PeerStatus,
});
export type PeerInfo = z.infer<typeof PeerInfo>;

// --- Eşleşme (HTTP) ----------------------------------------------------------
// A "kod oluştur" der → 6 haneli kod + oda bilgisi alır ve odaya bağlanıp bekler.
// B kodu girer → aynı oda bilgisini alır. İkisi de bilgiyi saklar; kod tek kullanımlık.

export const PairStartRequest = z.object({ deviceId: DeviceId, name: Name });
export const PairStartResponse = z.object({
  code: PairCode,
  coupleId: z.string(),
  token: z.string(),
  expiresAt: z.number(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

export const PairJoinRequest = z.object({ deviceId: DeviceId, name: Name, code: PairCode });
export const PairJoinResponse = z.object({
  coupleId: z.string(),
  token: z.string(),
  partner: z.object({ deviceId: DeviceId, name: Name }),
});
export type PairJoinResponse = z.infer<typeof PairJoinResponse>;

export const ApiErrorCode = z.enum([
  'invalid-request',
  'invalid-code',
  'rate-limited',
  'unauthorized',
  'room-full',
  'server',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;
export const ApiError = z.object({ error: ApiErrorCode });

export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export const IceResponse = z.object({ iceServers: z.array(IceServer) });
export type IceResponse = z.infer<typeof IceResponse>;

// --- Oda (WebSocket) -----------------------------------------------------------
// Oda: varlık bilgisi (çevrimiçi mi, hangi ekranda), P2P kurulum sinyalleri.

export const SignalData = z.object({
  session: z.string().min(1).max(64),
  description: z
    .object({
      type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
      sdp: z.string().max(200_000),
    })
    .optional(),
  candidate: z
    .object({
      candidate: z.string().max(2000),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type SignalData = z.infer<typeof SignalData>;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: PeerStatus }),
  z.object({ type: z.literal('signal'), data: SignalData }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), peer: PeerInfo.nullable() }),
  z.object({ type: z.literal('peer'), peer: PeerInfo }),
  z.object({ type: z.literal('peer-left') }),
  z.object({ type: z.literal('signal'), data: SignalData }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Oda kapanış kodları */
export const CloseCode = {
  /** Aynı cihaz başka bir bağlantıdan girdi */
  Replaced: 4000,
  /** Odada zaten iki farklı cihaz var */
  Full: 4001,
} as const;

// --- Karşı tarafla (P2P DataChannel) ---------------------------------------------
// Film paylaşan taraf ("host") oynatma durumunun tek doğruluk kaynağıdır.
// İzleyen taraf ("guest") komut gönderir; host uygular ve yeni durumu yayınlar.

export const PlayAction = z.enum(['play', 'pause', 'seek']);
export type PlayAction = z.infer<typeof PlayAction>;

export const SettingValue = z.union([z.string().max(200), z.number(), z.boolean()]);

export const Reaction = z.enum(['heart', 'laugh', 'wow', 'sad', 'clap', 'fire']);
export type Reaction = z.infer<typeof Reaction>;

/** Dosya parmak izi: boyut + baştan, ortadan, sondan 1'er MB'ın SHA-1'i */
export const Fingerprint = z.string().regex(/^[0-9a-f]{16,40}$/);

/** YouTube video kimliği (11 karakter) */
export const YouTubeId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

export const FileRef = z.object({
  name: z.string().max(260),
  size: z.number().int().min(0),
  fingerprint: Fingerprint,
});
export type FileRef = z.infer<typeof FileRef>;

export const PeerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    name: Name,
    movieStream: z.string().max(100),
    camStream: z.string().max(100),
    camOn: z.boolean(),
    micOn: z.boolean(),
    /** Masaüstü uygulaması mı? (dosya alma ve senkron mod sadece masaüstünde) */
    desktop: z.boolean().optional(),
    /** Uygulama sürümü: taraflardan biri eskiyse uyarılır (0.3.5 öncesi göndermez) */
    version: z.string().max(20).optional(),
  }),
  z.object({
    t: z.literal('media'),
    title: z.string().max(200),
    duration: Seconds,
    /** Çalan ses izinin adı (ör. "Türkçe Dublaj · 5.1") */
    audioLabel: z.string().max(100).optional(),
    /** Çalan ses izinin dili: senkron modda karşı taraf aynı dili seçsin */
    audioLanguage: z.string().max(8).nullable().optional(),
    /** Dosyanın kimliği (senkron mod: karşıda aynı dosya var mı?) */
    file: FileRef.optional(),
    /** YouTube videosu: iki taraf da YouTube'dan oynatır, host'un saatine göre */
    youtube: YouTubeId.optional(),
    /** Tarayıcıdaki video (Netflix vb.): iki taraf da kendi tarayıcısında, eklentiyle */
    browser: z
      .object({
        site: z.string().max(40),
        url: z.string().max(2000).regex(/^https?:\/\//),
        title: z.string().max(200),
      })
      .optional(),
  }),
  /** Guest aynı dosyayı kendi bilgisayarında açtı (ready) ya da bıraktı: senkron mod */
  z.object({ t: z.literal('sync'), ready: z.boolean(), fingerprint: Fingerprint }),
  /** Senkron modda guest'in oynatıcısı takıldı / devam ediyor */
  z.object({ t: z.literal('buffering'), waiting: z.boolean() }),
  /** Saat farkı ölçümü: t0 gönderenin, t1 cevaplayanın saati (ms) */
  z.object({ t: z.literal('ping'), id: z.number().int(), t0: z.number() }),
  z.object({ t: z.literal('pong'), id: z.number().int(), t0: z.number(), t1: z.number() }),
  /** Dosya gönderimi: teklif → kabul (kaldığı yerden) → ikili parçalar "dosya" kanalından → bitti */
  z.object({ t: z.literal('file-offer'), file: FileRef }),
  z.object({ t: z.literal('file-accept'), fingerprint: Fingerprint, offset: z.number().int().min(0) }),
  z.object({ t: z.literal('file-cancel'), fingerprint: Fingerprint }),
  /** Host dosyayı hazırlıyor (ses dönüştürme vb.); ratio null ise süre belirsiz */
  z.object({ t: z.literal('preparing'), title: z.string().max(200), ratio: z.number().min(0).max(1).nullable() }),
  /**
   * Altyazı izi, parça parça (DataChannel mesaj sınırı yüzünden).
   * data: JSON olarak [başlangıç, bitiş, metin][] dizisinin bu parçası.
   */
  z.object({
    t: z.literal('subs'),
    id: z.string().max(120),
    label: z.string().max(100),
    language: z.string().max(8).nullable(),
    part: z.number().int().min(0),
    parts: z.number().int().min(1).max(200),
    data: z.string().max(64_000),
  }),
  /** Altyazı zaman kaydırması (ikinizde de aynı) */
  z.object({ t: z.literal('subs-offset'), seconds: z.number().min(-600).max(600) }),
  z.object({
    t: z.literal('state'),
    playing: z.boolean(),
    pos: Seconds,
    rate: z.number().min(0.1).max(4),
    duration: Seconds,
    /** Host'un uyguladığı son guest komutunun sırası */
    ack: z.number().int().min(0),
    action: PlayAction.optional(),
    by: z.enum(['host', 'guest']).optional(),
    /** pos'un ölçüldüğü an, host'un saatiyle (ms). Senkron modda karşı taraf buna göre hizalanır. */
    at: z.number().optional(),
  }),
  z.object({
    t: z.literal('cmd'),
    action: PlayAction,
    pos: Seconds.optional(),
    /** Guest'in ekranında o an görünen kare (yayın gecikmesi telafisi) */
    seen: Seconds.optional(),
    seq: z.number().int().min(1),
  }),
  /** Host, kontrol yetkisi ayarı yüzünden komutu reddetti */
  z.object({ t: z.literal('denied'), action: PlayAction }),
  z.object({ t: z.literal('cam'), on: z.boolean() }),
  z.object({ t: z.literal('mic'), on: z.boolean() }),
  z.object({ t: z.literal('react'), kind: Reaction }),
  /** Kanallar: karşı taraf bir kanal ya da platform seçti; aynısı benim tarayıcımda da açılsın */
  z.object({ t: z.literal('channel'), name: z.string().max(40), url: z.string().max(2000).regex(/^https:\/\//) }),
  /** İki tarafta aynı olması gereken ayarlar (ör. codec) */
  z.object({ t: z.literal('setting'), key: z.string().max(64), value: SettingValue }),
]);
export type PeerMessage = z.infer<typeof PeerMessage>;

/** JSON'u şemaya göre ayrıştırır; geçersizse null döner. */
export function parseJson<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
