import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { bridge } from './platform/bridge';
import { Button } from './ui/controls';
import type { HistoryItem } from './watch/history';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { SettingsSheet } from './screens/SettingsSheet';
import { Watch } from './screens/Watch';
import { connectRoom, isPaired } from './session/session';
import { getSetting, useSetting, useSettings } from './settings/store';
import { watch } from './watch/controller';

export function App() {
  const accent = useSetting('appearance.accent');
  const paired = useSettings((s) => !!s.values['pairing.coupleId'] && !!s.values['pairing.token']);
  const [onboarding, setOnboarding] = useState(() => !isPaired() || !getSetting('profile.name'));
  const [screen, setScreen] = useState<'home' | 'watch'>('home');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [update, setUpdate] = useState<string | null>(null);

  // Güncelleme indirildiyse ana ekranda nazikçe haber ver.
  useEffect(() => bridge.updates?.onReady(setUpdate), []);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  useEffect(() => {
    if (paired) return connectRoom();
    // Eşleşme kaldırıldı: baştan.
    setOnboarding(true);
    setScreen('home');
    setSettingsOpen(false);
  }, [paired]);

  const goWatch = () => {
    watch.enter();
    setScreen('watch');
  };
  const goHome = () => {
    watch.leave();
    setScreen('home');
  };
  const openSettings = () => setSettingsOpen(true);
  const resume = (item: HistoryItem) => {
    goWatch();
    watch.openPath(item.path, item.position);
  };

  const view = onboarding ? 'onboarding' : screen;

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          className="screen"
          initial={{ opacity: 0, scale: 1.015 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
        >
          {view === 'onboarding' && <Onboarding onDone={() => setOnboarding(false)} />}
          {view === 'home' && <Home onWatch={goWatch} onSettings={openSettings} onResume={resume} />}
          {view === 'watch' && <Watch onBack={goHome} onSettings={openSettings} keysEnabled={!settingsOpen} />}
        </motion.div>
      </AnimatePresence>
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AnimatePresence>
        {update && view === 'home' && (
          <motion.div
            className="update-banner glass"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            <span>Yeni sürüm hazır · {update}</span>
            <Button size="small" onClick={() => bridge.updates?.install()}>
              Yeniden başlat
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
