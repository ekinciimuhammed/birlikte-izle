// Tarayıcıda izlerken (Netflix, Disney+…): film tarayıcıda oynar, burada ne izlendiği, durum ve
// "kamerasını öne al" (resim içinde resim: tarayıcı tam ekrandayken de o görünür).

import { motion } from 'motion/react';
import { Globe, PictureInPicture2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { outdatedExtension, useExtension } from '../../media/browser';
import { Button, Spinner } from '../../ui/controls';
import { useWatch, watch } from '../../watch/controller';

export function BrowserStage({ partner, onSettings }: { partner: string; onSettings: () => void }) {
  const { role, syncMode, webVideo, peerCamOn } = useWatch();
  const ext = useExtension();
  if (!webVideo) return null;
  const old = outdatedExtension(ext);

  let status: string;
  let waiting = false;
  if (role === 'host') status = 'Tarayıcında oynuyor · buradan da kontrol edebilirsiniz';
  else if (syncMode) status = `Tarayıcında oynuyor · ${partner} ile aynı anda`;
  else if (!ext.available) status = `${partner} tarayıcıda ${webVideo.site} izliyor. Katılmak için masaüstü uygulaması ve eklentisi gerekir.`;
  else if (!ext.connected) status = `${partner} tarayıcıda ${webVideo.site} izliyor. Katılmak için Birlikte İzle eklentisini kur.`;
  else {
    status = `Tarayıcında açılıyor… (${webVideo.site} hesabına giriş gerekebilir)`;
    waiting = true;
  }

  return (
    <div className="browser-stage">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="browser-card">
        <span className="browser-site">
          <Globe />
          {webVideo.site}
        </span>
        <h2>{webVideo.title}</h2>
        <p>
          {waiting && <Spinner />}
          {status}
        </p>
        {old && (
          <p className="browser-warn" role="alert">
            Tarayıcıdaki eklenti eski ({old}; uygulamadaki {ext.latest}). Sitedeki kameralar ve yenilikler için güncelle.
          </p>
        )}
        <div className="browser-actions">
          {ext.available && !ext.connected && role === 'guest' && <Button onClick={onSettings}>Eklentiyi kur</Button>}
          {old && <Button onClick={onSettings}>Eklentiyi güncelle</Button>}
          {peerCamOn && <CamPip />}
        </div>
      </motion.div>
    </div>
  );
}

/** Onun kamerası her şeyin üstünde, küçük bir pencerede (tarayıcı tam ekranken de) */
function CamPip() {
  const [inPip, setInPip] = useState(false);
  useEffect(() => {
    const el = watch.remoteCam;
    const on = () => setInPip(true);
    const off = () => setInPip(false);
    el.addEventListener('enterpictureinpicture', on);
    el.addEventListener('leavepictureinpicture', off);
    return () => {
      el.removeEventListener('enterpictureinpicture', on);
      el.removeEventListener('leavepictureinpicture', off);
    };
  }, []);
  if (!document.pictureInPictureEnabled) return null;
  return (
    <Button
      variant="secondary"
      onClick={() =>
        inPip ? document.exitPictureInPicture().catch(() => {}) : watch.remoteCam.requestPictureInPicture().catch(() => {})
      }
    >
      <PictureInPicture2 />
      {inPip ? 'Küçük pencereyi kapat' : 'Kamerası hep üstte kalsın'}
    </Button>
  );
}

/** Boş ekranda: tarayıcıda açık bir bölüm varsa "bunu birlikte izle" */
export function BrowserOffer() {
  const ext = useExtension();
  const { available, connected, video } = ext;
  if (!available || !connected || !video) return null;
  const old = outdatedExtension(ext);
  return (
    <motion.div className="browser-offer glass" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div>
        <span className="browser-offer-site">
          <Globe />
          Tarayıcıda · {video.site}
        </span>
        <strong>{video.title || video.site}</strong>
        {old && <span className="browser-warn">Eklenti eski ({old}): Ayarlar → Genel'den güncelle</span>}
      </div>
      <Button onClick={() => watch.openBrowser()}>Birlikte izle</Button>
    </motion.div>
  );
}
