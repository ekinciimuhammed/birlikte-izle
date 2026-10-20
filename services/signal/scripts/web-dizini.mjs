// wrangler, "assets" klasörü yoksa açılmıyor: web sürümü derlenmemişse boş klasör oluştur.
import { mkdirSync } from 'node:fs';
mkdirSync(new URL('../web', import.meta.url), { recursive: true });
