// Ayarları kullanıcı klasöründe tek bir JSON dosyasında tutar.
// Yazma işlemi önce geçici dosyaya yapılıp sonra yer değiştirilir: elektrik kesilse bile
// yarım yazılmış bir dosya kalmaz.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class SettingsFile {
  constructor(private readonly path: string) {}

  load(): Record<string, unknown> {
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return isPlainObject(data) ? data : {};
    } catch {
      return {};
    }
  }

  save(values: unknown) {
    if (!isPlainObject(values)) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(values, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
