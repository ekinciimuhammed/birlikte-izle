import { create } from 'zustand';
import { bridge } from '../platform/bridge';
import { SETTINGS, type SettingKey } from './definitions';
import type { SettingDef, SettingValue, Widen } from './registry';

export type Settings = { [K in SettingKey]: Widen<(typeof SETTINGS)[K]['default']> };
export type Origin = 'local' | 'peer';

interface SettingsState {
  values: Settings;
  loaded: boolean;
}

const DEFS = SETTINGS as Record<SettingKey, SettingDef>;

function defaults(): Settings {
  return Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.default])) as Settings;
}

export const useSettings = create<SettingsState>(() => ({ values: defaults(), loaded: false }));

/** Kayıtlı değerleri yükler; bilinmeyen anahtarları ve yanlış tipleri atar. */
export async function loadSettings() {
  const stored = await bridge.settings.load();
  const values = defaults() as Record<string, SettingValue>;
  for (const [key, def] of Object.entries(DEFS)) {
    const v = stored[key];
    if (typeof v === typeof def.default) values[key] = v as SettingValue;
  }
  if (!values['device.id']) values['device.id'] = crypto.randomUUID();
  useSettings.setState({ values: values as Settings, loaded: true });
  persist();
}

type Listener = <K extends SettingKey>(key: K, value: Settings[K], origin: Origin) => void;
const listeners = new Set<Listener>();

/** Bir ayar değişince çağrılır. Dönen işlev aboneliği kaldırır. */
export function onSettingChange(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSetting<K extends SettingKey>(key: K, value: Settings[K], origin: Origin = 'local') {
  const current = useSettings.getState().values;
  if (current[key] === value) return;
  useSettings.setState({ values: { ...current, [key]: value } });
  schedulePersist();
  for (const fn of listeners) fn(key, value, origin);
}

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettings.getState().values[key];
}

export function useSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettings((s) => s.values[key]);
}

export function settingDef(key: SettingKey): SettingDef {
  return DEFS[key];
}

export function isSettingKey(key: string): key is SettingKey {
  return key in DEFS;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 300);
}

function persist() {
  bridge.settings.save(useSettings.getState().values).catch((err) => console.error('Ayarlar kaydedilemedi', err));
}
