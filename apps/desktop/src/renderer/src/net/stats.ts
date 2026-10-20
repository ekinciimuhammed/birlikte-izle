// Her saniye getStats() okuyup okunabilir bir özet çıkarır.

export type TrackRole = 'movie' | 'cam';

export interface StreamStat {
  role: TrackRole;
  kind: 'audio' | 'video';
  dir: 'out' | 'in';
  kbps: number | null;
  codec: string | null;
  stereo: boolean;
  width?: number;
  height?: number;
  fps?: number;
  limit?: string;
}

export interface StatsSummary {
  rtt: number | null;
  route: 'local' | 'p2p' | 'relay' | null;
  protocol: string | null;
  /** İzleyen tarafın ekranı, paylaşanın oynatıcısından bu kadar saniye geride */
  movieDelay: number | null;
  streams: StreamStat[];
}

type AnyStat = Record<string, any> & { id: string; type: string; timestamp: number };

export function watchStats(
  getPc: () => RTCPeerConnection | null,
  roleOf: (trackId: string | undefined) => TrackRole | undefined,
  onUpdate: (s: StatsSummary | null) => void,
) {
  let prev = new Map<string, { bytes: number; ts: number; jbDelay: number; jbCount: number }>();

  const timer = setInterval(async () => {
    const pc = getPc();
    if (!pc || pc.connectionState !== 'connected') {
      prev = new Map();
      return onUpdate(null);
    }

    const report = (await pc.getStats()) as Map<string, AnyStat>;
    const out: StatsSummary = { rtt: null, route: null, protocol: null, movieDelay: null, streams: [] };

    let pair: AnyStat | undefined;
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      report.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
    }
    if (pair) {
      out.rtt = pair.currentRoundTripTime ?? null;
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      const types = [local?.candidateType, remote?.candidateType];
      out.route = types.includes('relay') ? 'relay' : types.every((t) => t === 'host') ? 'local' : 'p2p';
      out.protocol = (local?.relayProtocol ?? local?.protocol)?.toUpperCase() ?? null;
    }

    const next = new Map<string, { bytes: number; ts: number; jbDelay: number; jbCount: number }>();
    let movieJitter: number | null = null;

    for (const s of report.values()) {
      if (s.type !== 'outbound-rtp' && s.type !== 'inbound-rtp') continue;
      const outbound = s.type === 'outbound-rtp';
      const trackId: string | undefined = outbound ? report.get(s.mediaSourceId)?.trackIdentifier : s.trackIdentifier;
      const role = roleOf(trackId);
      if (!role) continue;

      const bytes: number = outbound ? s.bytesSent : s.bytesReceived;
      const before = prev.get(s.id);
      next.set(s.id, { bytes, ts: s.timestamp, jbDelay: s.jitterBufferDelay, jbCount: s.jitterBufferEmittedCount });

      const codec = report.get(s.codecId);
      out.streams.push({
        role,
        kind: s.kind,
        dir: outbound ? 'out' : 'in',
        kbps: before ? ((bytes - before.bytes) * 8) / (s.timestamp - before.ts) : null,
        codec: codec?.mimeType?.split('/')[1] ?? null,
        stereo: /stereo=1/.test(codec?.sdpFmtpLine ?? ''),
        width: s.frameWidth,
        height: s.frameHeight,
        fps: s.framesPerSecond,
        limit: s.qualityLimitationReason,
      });

      if (!outbound && s.kind === 'video' && role === 'movie' && before && s.jitterBufferEmittedCount > before.jbCount) {
        movieJitter = (s.jitterBufferDelay - before.jbDelay) / (s.jitterBufferEmittedCount - before.jbCount);
      }
    }
    prev = next;

    // Ağ yolu (RTT/2) + alım tamponu + kodlama/çözme payı
    if (movieJitter != null) out.movieDelay = (out.rtt ?? 0) / 2 + movieJitter + 0.05;
    onUpdate(out);
  }, 1000);

  return () => clearInterval(timer);
}
