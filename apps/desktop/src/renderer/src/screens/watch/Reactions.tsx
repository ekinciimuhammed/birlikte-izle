// Tepkiler: bir dokunuşla uçuşan kalp ve emojiler (iki tarafta da görünür).

import type { Reaction } from '@birlikte/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { Smile } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { IconButton } from '../../ui/controls';
import { HeartFilled } from '../../ui/icons';
import { useWatch, watch } from '../../watch/controller';

export const REACTIONS: { kind: Reaction; emoji: string; label: string }[] = [
  { kind: 'heart', emoji: '❤️', label: 'Kalp' },
  { kind: 'laugh', emoji: '😂', label: 'Gülme' },
  { kind: 'wow', emoji: '😮', label: 'Şaşırma' },
  { kind: 'sad', emoji: '😢', label: 'Üzülme' },
  { kind: 'clap', emoji: '👏', label: 'Alkış' },
  { kind: 'fire', emoji: '🔥', label: 'Ateş' },
];

export function ReactionPicker({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = (v: boolean) => {
    setOpen(v);
    onOpenChange(v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && toggle(false);
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });

  return (
    <div className="menu-anchor" ref={box}>
      <IconButton label="Tepki gönder (H: kalp)" onClick={() => toggle(!open)}>
        <Smile />
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div
            className="reaction-bar glass"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 600, damping: 32 }}
          >
            {REACTIONS.map((r) => (
              <button key={r.kind} type="button" aria-label={r.label} title={r.label} onClick={() => watch.sendReaction(r.kind)}>
                {r.emoji}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Ekrandan yükselen tepkiler */
export function FloatingReactions() {
  const reactions = useWatch((s) => s.reactions);
  return (
    <div className="hearts" aria-hidden="true">
      {reactions.map(({ id, kind }) => {
        // Kimlikten türetilen sabit bir rastgelelik: her çizimde aynı yol.
        const r1 = ((id * 9301 + 49297) % 233280) / 233280;
        const r2 = ((id * 4271 + 1123) % 104729) / 104729;
        return (
          <span
            key={id}
            className="heart"
            style={{ '--dx1': `${(r1 - 0.5) * 40}px`, '--dx2': `${(r2 - 0.5) * 160}px` } as CSSProperties}
          >
            {kind === 'heart' ? <HeartFilled size={34} /> : <span className="emoji">{REACTIONS.find((r) => r.kind === kind)?.emoji}</span>}
          </span>
        );
      })}
    </div>
  );
}
