// Dosya hazırlanırken (ör. AC3/DTS ses dönüştürülürken) ilerleme halkası.
// Karşı tarafta "Ali bölümü hazırlıyor" olarak görünür.

import { motion } from 'motion/react';

export function PreparingOverlay({
  preparing,
  partner,
}: {
  preparing: { title: string; ratio: number | null; byPeer: boolean };
  partner: string;
}) {
  const { ratio, byPeer, title } = preparing;
  const r = 34;
  const circumference = 2 * Math.PI * r;
  return (
    <div className="preparing">
      <motion.div
        className="preparing-card glass"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      >
        <svg className={ratio == null ? 'ring spinning' : 'ring'} viewBox="0 0 80 80" aria-hidden="true">
          <circle cx="40" cy="40" r={r} className="ring-track" />
          <circle
            cx="40"
            cy="40"
            r={r}
            className="ring-fill"
            strokeDasharray={circumference}
            strokeDashoffset={ratio == null ? circumference * 0.75 : circumference * (1 - ratio)}
          />
        </svg>
        <span className="preparing-percent">{ratio == null ? '' : `%${Math.round(ratio * 100)}`}</span>
        <strong>{byPeer ? `${partner} bölümü hazırlıyor` : 'Bölüm hazırlanıyor'}</strong>
        <span className="preparing-title">{title}</span>
        <span className="preparing-hint">
          {byPeer
            ? 'Hazır olunca film kendiliğinden gelecek.'
            : ratio == null
              ? 'Bu dosya anında dönüştürülerek oynatılacak.'
              : 'Sesi uyumlu hale getiriyorum. Bir kez yapılır, sonra hemen açılır.'}
        </span>
      </motion.div>
    </div>
  );
}
