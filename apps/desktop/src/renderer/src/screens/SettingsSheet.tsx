// Ayarlar: kenar çubuğunda gruplar, sağda o grubun kutuları.
// Kutular ve satırlar settings/definitions.ts'teki tanımlardan otomatik üretilir.

import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { SETTINGS, type SettingKey } from '../settings/definitions';
import { GROUPS, type GroupMeta } from '../settings/groups';
import type { GroupId, SettingDef } from '../settings/registry';
import { setSetting, settingDef, useSetting, useSettings } from '../settings/store';
import { useExtension } from '../media/browser';
import { checkConnection, type HealthReport } from '../net/health';
import { bridge } from '../platform/bridge';
import { unpair, usePresence } from '../session/session';
import { Button, Keycaps, ListRow, ListSection, Segmented, Select, Switch, cx } from '../ui/controls';

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [group, setGroup] = useState<GroupMeta['id']>('general');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const meta = GROUPS.find((g) => g.id === group)!;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            className="settings"
            role="dialog"
            aria-label="Ayarlar"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <aside className="settings-sidebar">
              <h2>Ayarlar</h2>
              <nav>
                {GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={cx('settings-nav', g.id === group && 'active')}
                    onClick={() => setGroup(g.id)}
                  >
                    <span className="settings-nav-icon" style={{ background: g.tint }}>
                      <g.icon />
                    </span>
                    {g.title}
                  </button>
                ))}
              </nav>
            </aside>
            <section className="settings-content">
              <header>
                <h2>{meta.title}</h2>
                <Button variant="plain" size="small" onClick={onClose}>
                  Bitti
                </Button>
              </header>
              <div className="settings-scroll" key={group}>
                <GroupContent group={group} />
              </div>
            </section>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const ENTRIES = Object.entries(SETTINGS) as [SettingKey, SettingDef][];

/** Bir grubun kutuları: önce tanımlı ayarlar (kutu kutu), sonra gruba özel ek bölümler. */
function GroupContent({ group }: { group: GroupId }) {
  const values = useSettings((s) => s.values) as Record<string, string | number | boolean>;
  const items = ENTRIES.filter(([, d]) => d.group === group && (!d.visibleIf || d.visibleIf(values)));
  const basic = items.filter(([, d]) => !d.advanced);
  const advanced = items.filter(([, d]) => d.advanced);
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <>
      {sections(basic).map(([title, keys]) => (
        <SettingsBox key={title} title={title} keys={keys} />
      ))}
      {EXTRAS[group]}
      {advanced.length > 0 && (
        <div className="advanced">
          <button type="button" className={cx('disclosure', showAdvanced && 'open')} onClick={() => setShowAdvanced((v) => !v)}>
            <ChevronRight />
            Gelişmiş
          </button>
          {showAdvanced &&
            sections(advanced).map(([title, keys]) => <SettingsBox key={title} title={title} keys={keys} />)}
        </div>
      )}
    </>
  );
}

/** Ayarları kutu başlığına göre sırayı koruyarak gruplar. */
function sections(items: [SettingKey, SettingDef][]): [string, SettingKey[]][] {
  const map = new Map<string, SettingKey[]>();
  for (const [key, def] of items) {
    const title = def.section ?? '';
    map.set(title, [...(map.get(title) ?? []), key]);
  }
  return [...map];
}

function SettingsBox({ title, keys }: { title: string; keys: SettingKey[] }) {
  const footer = keys.map((k) => settingDef(k).footer).filter(Boolean).at(-1);
  return (
    <ListSection title={title || undefined} footer={footer}>
      {keys.map((k) => (
        <SettingRow key={k} k={k} />
      ))}
    </ListSection>
  );
}

function SettingRow({ k }: { k: SettingKey }) {
  const def = settingDef(k);
  const value = useSetting(k) as string | number | boolean;
  const set = (v: string | number | boolean) => setSetting(k, v as never);
  const c = def.control;
  let control: ReactNode = null;
  switch (c.type) {
    case 'toggle':
      control = <Switch checked={!!value} onChange={set} label={def.label} />;
      break;
    case 'select':
      control = <Select value={value as string | number} options={c.options} onChange={set} label={def.label} />;
      break;
    case 'segmented':
      control = <Segmented value={value as string | number} options={c.options} onChange={set} />;
      break;
    case 'text':
      control = <TextSetting value={String(value)} placeholder={c.placeholder} maxLength={c.maxLength} label={def.label} onCommit={set} />;
      break;
    case 'accent':
      control = (
        <div className="accents" role="radiogroup" aria-label={def.label}>
          {c.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              aria-label={o.label}
              title={o.label}
              className="accent-dot"
              style={{ background: o.color, color: o.color }}
              onClick={() => set(o.value)}
            />
          ))}
        </div>
      );
      break;
    case 'hidden':
      return null;
  }
  return <ListRow label={def.label}>{control}</ListRow>;
}

/** Metin ayarı: yazarken yerelde tutulur, Enter'da veya odaktan çıkınca kaydedilir. */
function TextSetting(props: {
  value: string;
  placeholder?: string;
  maxLength?: number;
  label: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft.trim() !== props.value && props.onCommit(draft.trim());
  return (
    <input
      className="text-input"
      value={draft}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      aria-label={props.label}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

// --- Gruplara özel ek bölümler -----------------------------------------------------------

const VERDICT_DOT = { ok: 'green', warn: 'orange', fail: 'red' } as const;

function ConnectionStatus() {
  const server = usePresence((p) => p.server);
  const text = { idle: 'Bağlı değil', connecting: 'Bağlanıyor…', online: 'Bağlı', offline: 'Bağlantı yok, yeniden deneniyor', replaced: 'Başka pencerede açık' }[server];
  const [report, setReport] = useState<HealthReport | null>(null);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      setReport(await checkConnection());
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <ListSection title="Durum">
        <ListRow label="Sunucu">
          <span className="row-value">
            <span className={cx('dot', server === 'online' ? 'green' : server === 'offline' ? 'red' : 'orange')} /> {text}
          </span>
        </ListRow>
      </ListSection>
      <ListSection
        title="Bağlantı testi"
        footer={
          report?.summary ??
          'Sunucuya ulaşılıyor mu, bu ağda doğrudan bağlantı kurulabiliyor mu, aktarma (TURN) çalışıyor mu? Sadece bu bilgisayarın ağını ölçer; karşı tarafta da çalıştırın.'
        }
      >
        {report?.items.map((item) => (
          <ListRow key={item.label} label={item.label}>
            <span className="row-value">
              <span className={cx('dot', VERDICT_DOT[item.verdict])} /> {item.text}
            </span>
          </ListRow>
        ))}
        <ListRow label="Bu bilgisayarın ağı">
          <Button variant="secondary" size="small" disabled={testing} onClick={test}>
            {testing ? 'Test ediliyor…' : report ? 'Yeniden test et' : 'Bağlantıyı test et'}
          </Button>
        </ListRow>
      </ListSection>
    </>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ['Oynat / Durdur', ['Boşluk']],
  ['Geri / İleri sar', ['←', '→']],
  ['Tam ekran', ['F']],
  ['Mikrofon', ['M']],
  ['Kamera', ['C']],
  ['Kalp gönder', ['H']],
  ['Altyazıyı aç / kapat', ['S']],
  ['Altyazı erken / geç', ['[', ']']],
];

function Shortcuts() {
  return (
    <ListSection title="İzlerken" footer="Filme bir kez tıklamak oynatır/durdurur, iki kez tıklamak tam ekran yapar.">
      {SHORTCUTS.map(([label, keys]) => (
        <ListRow key={label} label={label}>
          <Keycaps keys={keys} />
        </ListRow>
      ))}
    </ListSection>
  );
}

function Pairing() {
  const partner = useSetting('pairing.partnerName');
  const online = usePresence((p) => !!p.peer);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ListSection title="Eşleştiğin kişi">
        <ListRow label="Ad">
          <span className="row-value">{partner || '—'}</span>
        </ListRow>
        <ListRow label="Durum">
          <span className="row-value">
            <span className={cx('dot', online && 'green')} /> {online ? 'Çevrimiçi' : 'Çevrimdışı'}
          </span>
        </ListRow>
      </ListSection>
      <ListSection footer={confirming ? 'Tekrar birlikte izlemek için yeni bir kodla eşleşmeniz gerekecek.' : undefined}>
        {confirming ? (
          <ListRow label="Emin misin?">
            <span className="row-actions">
              <Button variant="secondary" size="small" onClick={() => setConfirming(false)}>
                Vazgeç
              </Button>
              <Button variant="destructive" size="small" onClick={unpair}>
                Eşleşmeyi kaldır
              </Button>
            </span>
          </ListRow>
        ) : (
          <ListRow label={<span className="danger">Eşleşmeyi kaldır</span>} onClick={() => setConfirming(true)} />
        )}
      </ListSection>
    </>
  );
}

function About() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    bridge.version?.().then(setVersion);
  }, []);
  return (
    <ListSection title="Hakkında">
      <ListRow label="Sürüm">
        <span className="row-value">{version ?? 'Web'}</span>
      </ListRow>
    </ListSection>
  );
}

/** Netflix ve diğerleri: tarayıcı eklentisinin durumu ve kurulumu (sadece masaüstü) */
function BrowserExtension() {
  const { available, connected, browser } = useExtension();
  if (!available) return null;
  return (
    <ListSection
      title="Netflix ve diğerleri"
      footer="Netflix, Disney+, Prime Video, Max, Exxen, BluTV, Gain, tabii, MUBI ve YouTube tarayıcıda oynar; eklenti oradaki oynatıcıyı bu uygulamaya bağlar. İkiniz de kendi hesabınızla, kendi tarayıcınızda izlersiniz; kamera ve ses burada kalır. İkinizde de eklenti kurulu olmalı."
    >
      <ListRow label="Tarayıcı eklentisi">
        <span className="row-value">
          <span className={cx('dot', connected ? 'green' : 'orange')} /> {connected ? `Bağlı · ${browser ?? 'tarayıcı'}` : 'Bağlı değil'}
        </span>
      </ListRow>
      {!connected && (
        <ListRow
          label={
            <ol className="steps">
              <li>
                Chrome'da <code>chrome://extensions</code> adresini aç (Edge: <code>edge://extensions</code>)
              </li>
              <li>
                <b>Geliştirici modu</b>nu aç
              </li>
              <li>
                <b>Paketlenmemiş öğe yükle</b>'ye bas ve eklenti klasörünü seç
              </li>
            </ol>
          }
        />
      )}
      <ListRow label="Eklenti klasörü">
        <Button variant="secondary" size="small" onClick={() => bridge.extension?.reveal()}>
          Klasörü aç
        </Button>
      </ListRow>
    </ListSection>
  );
}

const EXTRAS: Partial<Record<GroupId, ReactNode>> = {
  general: (
    <>
      <BrowserExtension />
      <About />
    </>
  ),
  connection: <ConnectionStatus />,
  shortcuts: <Shortcuts />,
  pairing: <Pairing />,
};
