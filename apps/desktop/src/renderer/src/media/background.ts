// Kamera arka planını bulanıklaştırma. Google'ın MediaPipe "selfie" modeli her karede kişiyi
// arka plandan ayırır; arka plan bulanıklaştırılır, kişi net kalır. Hepsi bu bilgisayarda çalışır,
// görüntü hiçbir sunucuya gitmez. Model ve WebAssembly dosyaları uygulamayla birlikte gelir.
//
// Akış: kamera izi → gizli <video> → küçük tuval (maske için) + tam boy tuval (birleştirme)
//       → tuval.captureStream() → karşıya giden ve önizlemede görünen iz.

// Model (250 KB) koda gömülü: kurulu uygulamada sayfa file:// üzerinden gelir ve fetch() file://
// adreslerini açamaz. WebAssembly dosyasını ise MediaPipe'ın yükleyicisi file:// için de açabiliyor.
import modelDataUrl from '../assets/selfie_segmenter.tflite?inline';
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import type { ImageSegmenter } from '@mediapipe/tasks-vision';

export type BlurStrength = 'light' | 'strong';

const BLUR_PX: Record<BlurStrength, number> = { light: 8, strong: 18 };
const MASK_W = 256; // maske çözünürlüğü (büyütünce kenarlar zaten yumuşar)

let segmenterPromise: Promise<ImageSegmenter> | null = null;

/** Model bir kez yüklenir (ilk açılışta ~1 sn), sonra hep aynısı kullanılır. */
function loadSegmenter() {
  segmenterPromise ??= (async () => {
    const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const fileset = { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl };
    const model = Uint8Array.from(atob(modelDataUrl.slice(modelDataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    const create = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    // Ekran kartı yoksa ya da WebGL kapalıysa işlemciyle çalışsın.
    return create('GPU').catch(() => create('CPU'));
  })();
  segmenterPromise.catch(() => (segmenterPromise = null));
  return segmenterPromise;
}

export class BackgroundBlur {
  private input: MediaStreamTrack | null = null;
  private output: MediaStreamTrack | null = null;
  private strength: BlurStrength = 'light';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastTs = 0;

  private readonly video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
  private readonly out = document.createElement('canvas');
  private readonly small = document.createElement('canvas');
  private readonly mask = document.createElement('canvas');
  private readonly person = document.createElement('canvas');
  private maskData: ImageData | null = null;

  /** Bu iz için bulanık bir kopya döndürür (zaten çalışıyorsa sadece gücü değişir). */
  async start(input: MediaStreamTrack, strength: BlurStrength): Promise<MediaStreamTrack> {
    this.strength = strength;
    if (this.input === input && this.output?.readyState === 'live') return this.output;
    this.stop();
    const segmenter = await loadSegmenter();
    this.input = input;
    this.video.srcObject = new MediaStream([input]);
    await this.video.play().catch(() => {});
    const { width = 640, height = 360, frameRate = 30 } = input.getSettings();
    this.resize(width, height);
    const fps = Math.min(30, frameRate || 30);
    const output = this.out.captureStream(fps).getVideoTracks()[0]!;
    output.contentHint = 'motion';
    this.output = output;

    const loop = () => {
      if (this.output !== output) return;
      const started = performance.now();
      try {
        this.frame(segmenter);
      } catch (err) {
        console.warn('Arka plan karesi işlenemedi', err);
      }
      // Kare başına süre kadar bekle (yavaş bilgisayarda kendini sınırlar).
      this.timer = setTimeout(loop, Math.max(4, 1000 / fps - (performance.now() - started)));
    };
    loop();
    return output;
  }

  stop() {
    clearTimeout(this.timer);
    this.output?.stop();
    this.output = null;
    this.input = null;
    this.video.srcObject = null;
  }

  private resize(w: number, h: number) {
    if (this.out.width === w && this.out.height === h) return;
    this.out.width = this.person.width = w;
    this.out.height = this.person.height = h;
    this.small.width = this.mask.width = MASK_W;
    this.small.height = this.mask.height = Math.max(1, Math.round((MASK_W * h) / w));
    this.maskData = null;
  }

  private frame(segmenter: ImageSegmenter) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    this.resize(v.videoWidth, v.videoHeight);
    const { width: W, height: H } = this.out;
    const { width: sw, height: sh } = this.small;

    // 1) Kişi maskesi (küçük karede)
    const sctx = this.small.getContext('2d', { willReadFrequently: false })!;
    sctx.drawImage(v, 0, 0, sw, sh);
    const ts = Math.max(this.lastTs + 1, performance.now());
    this.lastTs = ts;
    const result = segmenter.segmentForVideo(this.small, ts);
    const conf = result.confidenceMasks?.[0];
    if (!conf) return;
    const values = conf.getAsFloat32Array();
    const mctx = this.mask.getContext('2d')!;
    this.maskData ??= mctx.createImageData(sw, sh);
    const px = this.maskData.data;
    for (let i = 0, j = 3; i < values.length; i++, j += 4) px[j] = values[i]! * 255;
    result.close();
    mctx.putImageData(this.maskData, 0, 0);

    // 2) Arka plan: bütün kare bulanık (kenarlar kararmasın diye biraz taşırarak)
    const blur = BLUR_PX[this.strength] * (W / 640);
    const ctx = this.out.getContext('2d')!;
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(v, -blur * 2, -blur * 2, W + blur * 4, H + blur * 4);
    ctx.filter = 'none';

    // 3) Kişi: maskenin içinde kalan net görüntü, bulanık arka planın üstüne
    const pctx = this.person.getContext('2d')!;
    pctx.globalCompositeOperation = 'copy';
    pctx.filter = 'blur(2px)'; // kenarı yumuşat
    pctx.drawImage(this.mask, 0, 0, W, H);
    pctx.filter = 'none';
    pctx.globalCompositeOperation = 'source-in';
    pctx.drawImage(v, 0, 0, W, H);
    ctx.drawImage(this.person, 0, 0);
  }
}
