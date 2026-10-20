// "Bölümü ona gönder" ve senkron mod: üst çubuktaki küçük ilerleme hapı ve menüdeki satırlar.

import { Check, HardDrive, Radio, Send, X } from 'lucide-react';
import { IconButton } from '../../ui/controls';
import { useWatch, watch } from '../../watch/controller';
import type { TransferView } from '../../watch/transfer';

/** Üst çubukta: aktarım sürerken yüzde ve durdur düğmesi; senkron moddayken "Tam kalite" */
export function TransferPill() {
  const t = useWatch((s) => s.transfer);
  const syncMode = useWatch((s) => s.syncMode);
  const role = useWatch((s) => s.role);
  const source = useWatch((s) => s.source);
  if (t) {
    const ratio = t.size ? t.done / t.size : 0;
    return (
      <div className="transfer-pill" title={`${t.name}\n${transferDetail(t)}`}>
        <ProgressRing ratio={ratio} />
        <span>
          {t.direction === 'send' ? 'Gönderiliyor' : 'Bölüm geliyor'} · %{Math.floor(ratio * 100)}
        </span>
        <button type="button" className="transfer-cancel" aria-label="Aktarımı durdur" onClick={() => watch.cancelTransfer()}>
          <X />
        </button>
      </div>
    );
  }
  // Rozet sadece dosyada anlamlı (YouTube ve tarayıcıda yayın zaten yok)
  if (!syncMode || source !== 'file') return null;
  return (
    <div
      className="quality-badge"
      title={role === 'host' ? 'O kendi kopyasından izliyor: ikiniz de tam kalitede' : 'Kendi kopyandan izliyorsun: yayın yok, tam kalite'}
    >
      Tam kalite
    </div>
  );
}

/** Altyazı ve ses menüsündeki "Görüntü" bölümü */
export function QualitySection({ partner }: { partner: string }) {
  const { role, syncMode, peerHere, peerDesktop, peerFile, transfer, source } = useWatch();
  if (source === 'youtube' || source === 'browser') return null;
  const canSend = role === 'host' && peerHere && peerDesktop && watch.canSendFile;
  const canUseCopy = role === 'guest' && !!peerFile && watch.canConvert;
  if (!transfer && !syncMode && !canSend && !canUseCopy) return null;

  return (
    <div className="menu-section">
      <h4>Görüntü</h4>
      {transfer ? (
        <TransferRow t={transfer} />
      ) : syncMode ? (
        <>
          <div className="menu-item static">
            <span className="menu-check">
              <Check />
            </span>
            {role === 'host' ? `${partner} kendi kopyasından izliyor` : 'Kendi kopyandan · tam kalite'}
          </div>
          {role === 'guest' && (
            <button type="button" className="menu-item muted" onClick={() => watch.exitSync()}>
              <Radio />
              Yayından izle
            </button>
          )}
        </>
      ) : canSend ? (
        <>
          <button type="button" className="menu-item" onClick={() => watch.sendFile()}>
            <Send />
            Bölümü ona gönder
          </button>
          <p className="menu-note">Gelince ikiniz de kendi kopyanızdan, tam kalitede izlersiniz.</p>
        </>
      ) : (
        <>
          <button type="button" className="menu-item" onClick={() => watch.useLocalCopy()}>
            <HardDrive />
            Bende de var…
          </button>
          <p className="menu-note">Bu bölüm sende de varsa seç; yayın yerine kendi kopyandan izle.</p>
        </>
      )}
    </div>
  );
}

function TransferRow({ t }: { t: TransferView }) {
  const ratio = t.size ? t.done / t.size : 0;
  return (
    <div className="transfer-row">
      <div className="transfer-head">
        <span className="transfer-name">
          {t.direction === 'send' ? 'Gönderiliyor: ' : 'Geliyor: '}
          {t.name}
        </span>
        <IconButton label="Aktarımı durdur" onClick={() => watch.cancelTransfer()}>
          <X />
        </IconButton>
      </div>
      <div className="transfer-bar">
        <div style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="transfer-detail">{transferDetail(t)}</div>
    </div>
  );
}

function ProgressRing({ ratio }: { ratio: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className="progress-ring" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} />
      <circle cx="9" cy="9" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - ratio)} />
    </svg>
  );
}

function transferDetail(t: TransferView) {
  const parts = [`%${Math.floor((t.size ? t.done / t.size : 0) * 100)}`, `${formatBytes(t.done)} / ${formatBytes(t.size)}`];
  if (t.rate > 0) {
    parts.push(`${formatBytes(t.rate)}/sn`);
    const left = (t.size - t.done) / t.rate;
    parts.push(left < 60 ? `${Math.ceil(left)} sn kaldı` : `${Math.ceil(left / 60)} dk kaldı`);
  }
  return parts.join(' · ');
}

function formatBytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
