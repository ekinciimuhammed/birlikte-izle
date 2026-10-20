// Ayar altyapısı: her ayar defineSetting() ile bir kez tanımlanır.
// Ayarlar ekranı, varsayılan değerler, kayıt ve karşı tarafla eşitleme bu tanımdan üretilir.
// Yeni bir özellik eklemek = definitions.ts dosyasına bir satır eklemek.

export type SettingValue = string | number | boolean;

export interface Option<T extends string | number = string | number> {
  value: T;
  label: string;
}

export type Control =
  | { type: 'toggle' }
  | { type: 'select'; options: readonly Option[] }
  | { type: 'segmented'; options: readonly Option[] }
  | { type: 'text'; placeholder?: string; maxLength?: number }
  | { type: 'accent'; options: readonly { value: string; label: string; color: string }[] }
  /** Arayüzde görünmeyen, uygulamanın kendi tuttuğu değerler (cihaz kimliği vb.) */
  | { type: 'hidden' };

export type GroupId =
  | 'general'
  | 'playback'
  | 'video'
  | 'audio'
  | 'camera'
  | 'subtitles'
  | 'connection'
  | 'shortcuts'
  | 'pairing'
  | 'internal';

export interface SettingDef<T extends SettingValue = SettingValue> {
  group: GroupId;
  /** Grup içindeki kutunun başlığı */
  section?: string;
  label: string;
  /** Kutunun altındaki açıklama */
  footer?: string;
  control: Control;
  default: T;
  /** "Gelişmiş" bölümünde, kapalı başlar */
  advanced?: boolean;
  /** İki tarafta da aynı olmalı: değişince karşı tarafa gönderilir */
  shared?: boolean;
  /** Sadece başka bir ayar uygunsa göster */
  visibleIf?: (values: Record<string, SettingValue>) => boolean;
}

export function defineSetting<T extends SettingValue>(def: SettingDef<T>): SettingDef<T> {
  return def;
}

/** 'motion' → string, 8 → number: değer tipini genişletir. */
export type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : never;
