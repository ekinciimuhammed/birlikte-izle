// Altyazı ve ses menüsü (Apple TV'deki gibi): altyazı izi, zaman kaydırma, ses dili.

import { AnimatePresence, motion } from 'motion/react';
import { Captions, Check, Minus, Plus, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, cx } from '../../ui/controls';
import { formatOffset, useWatch, watch } from '../../watch/controller';
import { QualitySection } from './Transfer';

export function MediaMenu({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const { subtitles, audioTracks, audioIndex, audioLabel, role } = useWatch();
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const toggle = (v: boolean) => {
    setOpen(v);
    onOpenChange(v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && toggle(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && toggle(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });

  return (
    <div className="menu-anchor" ref={box}>
      <IconButton label="Altyazı ve ses (S)" className={cx(subtitles.selected && 'active')} onClick={() => toggle(!open)}>
        <Captions />
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div
            className="menu glass"
            role="menu"
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          >
            <div className="menu-section">
              <h4>Altyazı</h4>
              <MenuItem checked={!subtitles.selected} onClick={() => watch.subtitles.select(null)}>
                Kapalı
              </MenuItem>
              {subtitles.tracks.map((t) => (
                <MenuItem key={t.id} checked={subtitles.selected === t.id} onClick={() => watch.subtitles.select(t.id)}>
                  {t.label}
                </MenuItem>
              ))}
              <button type="button" className="menu-item muted" onClick={() => fileInput.current?.click()}>
                <Upload />
                Dosyadan ekle…
              </button>
            </div>

            {subtitles.tracks.length > 0 && (
              <div className="menu-section">
                <h4>Zamanlama</h4>
                <div className="stepper">
                  <IconButton label="Altyazı daha erken ([)" onClick={() => watch.shiftSubtitles(-0.25)}>
                    <Minus />
                  </IconButton>
                  <span>{formatOffset(subtitles.offset)}</span>
                  <IconButton label="Altyazı daha geç (])" onClick={() => watch.shiftSubtitles(0.25)}>
                    <Plus />
                  </IconButton>
                </div>
              </div>
            )}

            {role === 'host' && audioTracks.length > 1 && (
              <div className="menu-section">
                <h4>Ses</h4>
                {audioTracks.map((a) => (
                  <MenuItem key={a.index} checked={audioIndex === a.index} onClick={() => watch.setAudioTrack(a.index)}>
                    {a.label}
                  </MenuItem>
                ))}
              </div>
            )}
            {role === 'guest' && audioLabel && (
              <div className="menu-section">
                <h4>Ses</h4>
                <div className="menu-item static">{audioLabel}</div>
              </div>
            )}
            <QualitySection partner={watch.partnerName()} />
          </motion.div>
        )}
      </AnimatePresence>
      <input
        ref={fileInput}
        type="file"
        accept=".srt,.vtt,.ass,.ssa"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (!(await watch.subtitles.addFile(file))) watch.hud('Bu dosyada altyazı bulunamadı', 'captions');
        }}
      />
    </div>
  );
}

function MenuItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="menu-item" onClick={onClick}>
      <span className="menu-check">{checked && <Check />}</span>
      {children}
    </button>
  );
}
