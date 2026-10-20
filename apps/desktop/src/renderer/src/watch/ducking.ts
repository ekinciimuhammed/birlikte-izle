// "O konuşunca filmi kıs": karşı tarafın mikrofonunu dinler; konuşma varken film sesini
// yumuşakça kısar, susunca yavaşça geri açar. (Kendi tarafımızdaki ses düzeyi karşıya
// gönderilen film sesini etkilemez; bu ölçülerek doğrulandı.)

const THRESHOLD = 0.018; // RMS: konuşma sayılacak en düşük düzey
const HOLD_MS = 700; // susunca bu kadar bekle, sonra aç

export class Ducker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastVoice = 0;
  private factor = 1;
  private track: MediaStreamTrack | null = null;

  /** factor 0–1 arası çarpan; her değiştiğinde çağrılır */
  constructor(private readonly apply: (factor: number) => void) {}

  /** Karşının mikrofon izini izlemeye başla (null: dur). level: konuşurken kalacak oran (0–1). */
  watch(track: MediaStreamTrack | null, enabled: boolean, level: number) {
    if (!enabled || !track) return this.stop();
    this.level = level;
    if (this.track === track && this.ctx) return;
    this.stop();
    this.track = track;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.analyser);
    const buf = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(() => {
      this.analyser!.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const now = performance.now();
      if (Math.sqrt(sum / buf.length) > THRESHOLD) this.lastVoice = now;
      const target = now - this.lastVoice < HOLD_MS ? this.level : 1;
      // Kısarken hızlı, açarken yavaş: doğal hissettirir.
      const next = this.factor + (target - this.factor) * (target < this.factor ? 0.45 : 0.12);
      if (Math.abs(next - this.factor) > 0.002) {
        this.factor = next;
        this.apply(next);
      }
    }, 60);
  }

  private level = 0.35;

  stop() {
    clearInterval(this.timer);
    this.source?.disconnect();
    this.ctx?.close().catch(() => {});
    this.ctx = this.analyser = this.source = null;
    this.track = null;
    if (this.factor !== 1) {
      this.factor = 1;
      this.apply(1);
    }
  }
}
