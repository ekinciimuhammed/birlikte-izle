// Her saniye getStats() okuyup okunabilir bir özet çıkarır.
// roleOf(trackId) → 'movie' | 'cam' | undefined: hangi iz film, hangisi kamera.

export function watchStats(link, roleOf, onUpdate) {
  let prev = new Map();

  const timer = setInterval(async () => {
    const pc = link.pc;
    if (!pc || pc.connectionState !== 'connected') {
      prev = new Map();
      return onUpdate(null);
    }

    const report = await pc.getStats();
    const out = { rtt: null, route: null, protocol: null, movieDelay: null, streams: [] };

    let pair = null;
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

    const next = new Map();
    report.forEach((s) => {
      if (s.type !== 'outbound-rtp' && s.type !== 'inbound-rtp') return;
      const outbound = s.type === 'outbound-rtp';
      const trackId = outbound ? report.get(s.mediaSourceId)?.trackIdentifier : s.trackIdentifier;
      const role = roleOf(trackId);
      if (!role) return;

      const bytes = outbound ? s.bytesSent : s.bytesReceived;
      const before = prev.get(s.id);
      next.set(s.id, {
        bytes,
        ts: s.timestamp,
        jbDelay: s.jitterBufferDelay,
        jbCount: s.jitterBufferEmittedCount,
      });

      const codec = report.get(s.codecId);
      const item = {
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
        lost: s.packetsLost,
      };
      if (!outbound && s.kind === 'video' && before && s.jitterBufferEmittedCount > before.jbCount) {
        item.jitter = (s.jitterBufferDelay - before.jbDelay) / (s.jitterBufferEmittedCount - before.jbCount);
      }
      out.streams.push(item);
    });
    prev = next;

    // Misafirin ekranı, ev sahibinin oynatıcısından bu kadar geride:
    // ağ yolu (RTT/2) + alım tamponu + kodlama/çözme payı.
    const movieIn = out.streams.find((x) => x.role === 'movie' && x.dir === 'in' && x.kind === 'video');
    if (movieIn?.jitter != null) out.movieDelay = (out.rtt ?? 0) / 2 + movieIn.jitter + 0.05;

    onUpdate(out);
  }, 1000);

  return () => clearInterval(timer);
}
