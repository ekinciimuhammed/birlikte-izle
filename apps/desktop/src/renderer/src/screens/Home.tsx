// Ana ekran: tek bir kişi, tek bir eylem. O çevrimiçiyse yeşil halka, izliyorsa davet kartı.

import { motion } from 'motion/react';
import { Play, Settings as SettingsIcon, X } from 'lucide-react';
import { isDesktop } from '../platform/bridge';
import { usePresence } from '../session/session';
import { useSetting } from '../settings/store';
import { Avatar, Button, IconButton } from '../ui/controls';
import { forgetHistory, readHistory, type HistoryItem } from '../watch/history';
import { episodeCount, formatDuration, lastWeek, readStats } from '../watch/stats';

export function Home({
  onWatch,
  onSettings,
  onResume,
}: {
  onWatch: () => void;
  onSettings: () => void;
  onResume: (item: HistoryItem) => void;
}) {
  const { server, peer } = usePresence();
  const nickname = useSetting('profile.partnerNickname').trim();
  const storedName = useSetting('pairing.partnerName');
  const name = nickname || peer?.name || storedName || 'O';
  const online = !!peer;
  const watching = peer?.status.screen === 'watch';

  const status =
    server === 'replaced'
      ? 'Uygulama başka bir pencerede açık'
      : server !== 'online'
        ? 'Sunucuya bağlanılıyor…'
        : !online
          ? 'Çevrimdışı'
          : watching
            ? peer.status.title
              ? `İzliyor · ${peer.status.title}`
              : 'Seni bekliyor'
            : 'Çevrimiçi';

  return (
    <div className="screen home">
      <div className="titlebar drag">
        <div style={{ flex: 1 }} />
        <IconButton label="Ayarlar" onClick={onSettings}>
          <SettingsIcon />
        </IconButton>
      </div>

      <main className="home-center">
        <div className={`home-avatar${online ? ' online' : ''}`}>
          <Avatar name={name} size={132} muted={!online} />
        </div>
        <h1 className="home-name">{name}</h1>
        <p className="home-status">
          <span className={`dot${online ? ' green' : server === 'online' ? '' : ' orange'}`} />
          {status}
        </p>

        {watching ? (
          <motion.div
            className="home-invite glass"
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <div>
              <strong>{name} izleme ekranında</strong>
              <span>{peer?.status.title ?? 'Henüz bir şey açmadı'}</span>
            </div>
            <Button onClick={onWatch}>Katıl</Button>
          </motion.div>
        ) : (
          <Button size="large" onClick={onWatch}>
            <Play fill="currentColor" />
            Birlikte İzle
          </Button>
        )}

        <p className="home-hint">
          {online
            ? 'İkiniz de izleme ekranına girince bağlanırsınız.'
            : 'O gelince hemen bağlanırsınız. Bu arada bölümü hazırlayabilirsin.'}
        </p>
        <Together name={name} />
        {isDesktop && <History onResume={onResume} />}
      </main>
    </div>
  );
}

const WEEKDAY = new Intl.DateTimeFormat('tr-TR', { weekday: 'narrow' });
const DAY = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Birlikte izlediğiniz süre: toplam ve son 7 gün */
function Together({ name }: { name: string }) {
  const stats = readStats(useSetting('stats.together'));
  if (stats.total < 60) return null;
  const week = lastWeek(stats);
  const weekTotal = week.reduce((sum, d) => sum + d.seconds, 0);
  const max = Math.max(...week.map((d) => d.seconds), 1);
  const episodes = episodeCount(stats);
  const meta = [episodes && `${episodes} bölüm`, `${stats.sessions} kez`].filter(Boolean).join(' · ');
  return (
    <section className="together glass" aria-label={`${name} ile birlikte ${formatDuration(stats.total)} izlediniz`}>
      <div className="together-total">
        <span className="together-caption">{name} ile birlikte</span>
        <strong>{formatDuration(stats.total)}</strong>
        <span className="together-caption">{meta}</span>
      </div>
      <div className="together-week" title={`Son 7 gün: ${formatDuration(weekTotal)}`}>
        {week.map((d) => (
          <div key={d.key} className="together-day" title={`${DAY.format(d.date)}: ${d.seconds ? formatDuration(d.seconds) : '—'}`}>
            <span className="together-bar">
              <span style={{ height: `${Math.max(d.seconds ? 8 : 0, (d.seconds / max) * 100)}%` }} />
            </span>
            <span className="together-label">{WEEKDAY.format(d.date)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Kaldığınız yerden: son açılan bölümler (en fazla 4) */
function History({ onResume }: { onResume: (item: HistoryItem) => void }) {
  const raw = useSetting('history.items');
  const items = readHistory(raw).slice(0, 4);
  if (!items.length) return null;
  return (
    <section className="home-history">
      <h3>Kaldığınız yerden</h3>
      <div className="history-row">
        {items.map((item) => {
          const left = Math.max(0, item.duration - item.position);
          return (
            <div key={item.path} className="history-card glass">
              <button type="button" className="history-open" onClick={() => onResume(item)} title={item.path}>
                <span className="history-name">{item.name}</span>
                <span className="history-meta">{item.position > 0 ? `${Math.ceil(left / 60)} dk kaldı` : 'Baştan başla'}</span>
                <span className="history-bar">
                  <span style={{ width: `${item.duration ? (item.position / item.duration) * 100 : 0}%` }} />
                </span>
              </button>
              <button
                type="button"
                className="history-remove"
                aria-label="Listeden kaldır"
                onClick={() => forgetHistory(item.path)}
              >
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
