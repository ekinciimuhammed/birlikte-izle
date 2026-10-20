// Kanallar: canlı TV ve platformlar. Seçilen kanal iki tarafın tarayıcısında birden açılır (eklenti);
// izlenen sekme kanal değiştirir. Üst çubukta menü, boş ekranda düğmeler.

import { AnimatePresence, motion } from 'motion/react';
import { Tv } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useExtension } from '../../media/browser';
import { LIVE_CHANNELS, PLATFORMS, type Channel } from '../../media/channels';
import { IconButton } from '../../ui/controls';
import { watch } from '../../watch/controller';

const GROUPS: [string, Channel[]][] = [
  ['Canlı TV', LIVE_CHANNELS],
  ['Platformlar', PLATFORMS],
];

/** Üst çubuk: izlerken de kanal değiştirmek için */
export function ChannelsMenu() {
  const available = useExtension((s) => s.available);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!available) return null;
  return (
    <div className="menu-anchor" ref={box}>
      <IconButton label="Kanallar" onClick={() => setOpen((v) => !v)}>
        <Tv />
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div
            className="menu menu-down glass no-drag"
            role="menu"
            aria-label="Kanallar"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          >
            {GROUPS.map(([title, channels]) => (
              <div className="menu-section" key={title}>
                <h4>{title}</h4>
                {channels.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setOpen(false);
                      watch.openChannel(c);
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Boş ekran: kanallar doğrudan düğme olarak */
export function ChannelGrid() {
  const available = useExtension((s) => s.available);
  if (!available) return null;
  return (
    <div className="channels" aria-label="Kanallar">
      {GROUPS.map(([title, channels]) => (
        <div className="channel-group" key={title}>
          <span className="channel-group-title">{title}</span>
          <div className="channel-chips">
            {channels.map((c) => (
              <button key={c.name} type="button" className="channel-chip" onClick={() => watch.openChannel(c)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
