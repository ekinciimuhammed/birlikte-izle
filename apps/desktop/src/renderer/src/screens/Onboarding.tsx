// İlk açılış: karşılama → ad → eşleşme (kod oluştur / kodu gir) → kutlama.
// Eşleşme bir kez yapılır; sonra uygulamayı açmak yeterli.

import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, Clapperboard, Hand, KeyRound, Sparkles, Video } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiErrorText } from '../net/api';
import { createPairing, enterPairingCode } from '../session/session';
import { setSetting, useSetting } from '../settings/store';
import { Button, IconButton, Spinner } from '../ui/controls';
import { HeartFilled } from '../ui/icons';

type Step = 'welcome' | 'name' | 'choose' | 'create' | 'join' | 'done';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const name = useSetting('profile.name');
  const [step, setStep] = useState<Step>(name ? 'choose' : 'welcome');
  const [partner, setPartner] = useState('');

  const paired = (partnerName: string) => {
    setPartner(partnerName);
    setStep('done');
  };

  return (
    <div className="screen onboarding">
      <div className="titlebar drag" />
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          className="onboarding-step"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        >
          {step === 'welcome' && <Welcome onNext={() => setStep('name')} />}
          {step === 'name' && <NameStep onNext={() => setStep('choose')} />}
          {step === 'choose' && <Choose onCreate={() => setStep('create')} onJoin={() => setStep('join')} onBack={() => setStep('name')} />}
          {step === 'create' && <CreateCode onPaired={paired} onBack={() => setStep('choose')} />}
          {step === 'join' && <JoinCode onPaired={paired} onBack={() => setStep('choose')} />}
          {step === 'done' && <Done partner={partner} onNext={onDone} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function AppIcon({ size = 84 }: { size?: number }) {
  return (
    <div className="app-icon" style={{ width: size, height: size, borderRadius: size * 0.26 }}>
      <HeartFilled size={size * 0.48} />
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="ob-center">
      <AppIcon />
      <h1 className="ob-title">Birlikte İzle</h1>
      <p className="ob-subtitle">Uzakta olsanız da yan yana gibi.</p>
      <ul className="ob-features">
        <Feature icon={<Clapperboard />} title="Aynı anda izleyin">
          Sen bir bölüm açarsın, o da aynı saniyede görür.
        </Feature>
        <Feature icon={<Hand />} title="İkiniz de kontrol edin">
          Durdur, sar, devam et. Kim isterse, sanki aynı koltukta.
        </Feature>
        <Feature icon={<Video />} title="Birbirinizi görün">
          Kameralar köşede, film ortada.
        </Feature>
      </ul>
      <Button size="large" onClick={onNext}>
        Başla
      </Button>
    </div>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="ob-feature">
      <span className="ob-feature-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </li>
  );
}

function NameStep({ onNext }: { onNext: () => void }) {
  const saved = useSetting('profile.name');
  const [value, setValue] = useState(saved);
  const submit = () => {
    if (!value.trim()) return;
    setSetting('profile.name', value.trim());
    onNext();
  };
  return (
    <form
      className="ob-center"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 className="ob-title">Adın ne?</h1>
      <p className="ob-subtitle">Onun ekranında bu ad görünecek.</p>
      <input
        className="ob-name-input"
        value={value}
        maxLength={32}
        autoFocus
        placeholder="Adın"
        aria-label="Adın"
        onChange={(e) => setValue(e.target.value)}
      />
      <Button size="large" type="submit" disabled={!value.trim()}>
        Devam
      </Button>
    </form>
  );
}

function Choose({ onCreate, onJoin, onBack }: { onCreate: () => void; onJoin: () => void; onBack: () => void }) {
  return (
    <div className="ob-center">
      <BackButton onClick={onBack} />
      <h1 className="ob-title">Eşleşelim</h1>
      <p className="ob-subtitle">Bu sadece bir kez yapılır. Sonra uygulamayı açmanız yeterli.</p>
      <div className="ob-choices">
        <button type="button" className="ob-choice" onClick={onCreate}>
          <Sparkles />
          <strong>Kod oluştur</strong>
          <span>Kodu ona sen söylersin</span>
        </button>
        <button type="button" className="ob-choice" onClick={onJoin}>
          <KeyRound />
          <strong>Kodum var</strong>
          <span>Onun verdiği kodu girersin</span>
        </button>
      </div>
      <ServerNote />
    </div>
  );
}

function CreateCode({ onPaired, onBack }: { onPaired: (name: string) => void; onBack: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancel: (() => void) | undefined;
    let alive = true;
    setError('');
    setCode(null);
    createPairing(onPaired)
      .then((p) => {
        if (!alive) return p.cancel();
        cancel = p.cancel;
        setCode(p.code);
      })
      .catch((err) => alive && setError(apiErrorText(err)));
    return () => {
      alive = false;
      cancel?.();
    };
    // onPaired her çizimde değişebilir; yeni kod sadece "tekrar dene" ile istenir.
  }, [attempt]);

  return (
    <div className="ob-center">
      <BackButton onClick={onBack} />
      <h1 className="ob-title">{code ? 'Kodun hazır' : error ? 'Kod alınamadı' : 'Kod hazırlanıyor'}</h1>
      <p className="ob-subtitle">Bu kodu ona söyle. O “Kodum var” deyip girecek.</p>
      <div className="code-cells" aria-label={code ? `Kod: ${code.split('').join(' ')}` : 'Kod hazırlanıyor'}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="code-cell">
            {code?.[i] ?? ''}
          </span>
        ))}
      </div>
      {error ? (
        <>
          <p className="ob-error">{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Tekrar dene
          </Button>
        </>
      ) : (
        <p className="ob-waiting">
          <Spinner /> {code ? 'Onun kodu girmesi bekleniyor… (10 dakika geçerli)' : 'Kod hazırlanıyor…'}
        </p>
      )}
      <ServerNote />
    </div>
  );
}

function JoinCode({ onPaired, onBack }: { onPaired: (name: string) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const submit = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    try {
      onPaired(await enterPairingCode(value));
    } catch (err) {
      setError(apiErrorText(err));
      setCode('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ob-center">
      <BackButton onClick={onBack} />
      <h1 className="ob-title">Kodu gir</h1>
      <p className="ob-subtitle">Onun ekranındaki 6 haneli kod.</p>
      <label className="code-cells input" onClick={() => input.current?.focus()}>
        <input
          ref={input}
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          value={code}
          aria-label="Eşleşme kodu"
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            setCode(v);
            if (v.length === 6) submit(v);
          }}
        />
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`code-cell${i === code.length ? ' caret' : ''}`}>
            {code[i] ?? ''}
          </span>
        ))}
      </label>
      {error && <p className="ob-error">{error}</p>}
      <Button size="large" disabled={code.length !== 6 || busy} onClick={() => submit(code)}>
        {busy ? <Spinner /> : 'Eşleş'}
      </Button>
      <ServerNote />
    </div>
  );
}

function Done({ partner, onNext }: { partner: string; onNext: () => void }) {
  return (
    <div className="ob-center">
      <motion.div
        className="ob-heart"
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: [0.4, 1.15, 1], opacity: 1 }}
        transition={{ duration: 0.7, times: [0, 0.6, 1], ease: 'easeOut' }}
      >
        <HeartFilled size={64} />
      </motion.div>
      <h1 className="ob-title">Eşleştiniz</h1>
      <p className="ob-subtitle">Artık {partner} ile birlikte izleyebilirsin.</p>
      <Button size="large" onClick={onNext}>
        Başlayalım
      </Button>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton label="Geri" className="ob-back no-drag" onClick={onClick}>
      <ChevronLeft />
    </IconButton>
  );
}

/** Sunucu adresi: kurulumda gerekirse buradan değiştirilir. */
function ServerNote() {
  const server = useSetting('connection.server');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(server);
  if (editing) {
    return (
      <form
        className="ob-server"
        onSubmit={(e) => {
          e.preventDefault();
          setSetting('connection.server', value.trim());
          setEditing(false);
        }}
      >
        <input className="ob-server-input" value={value} autoFocus aria-label="Sunucu adresi" onChange={(e) => setValue(e.target.value)} />
        <Button size="small" type="submit">
          Kaydet
        </Button>
      </form>
    );
  }
  return (
    <p className="ob-server">
      Sunucu: {server.replace(/^https?:\/\//, '')} ·{' '}
      <button type="button" className="link" onClick={() => setEditing(true)}>
        Değiştir
      </button>
    </p>
  );
}
