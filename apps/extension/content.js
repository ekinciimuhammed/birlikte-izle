// Sayfadaki oynatıcı: en büyük <video>'yu bulur, durumunu arka plana bildirir ve uygulamadan gelen
// komutları (oynat, durdur, sar, hız, ses) uygular. Netflix'te sarma sitenin kendi oynatıcısıyla
// yapılır (videoya doğrudan dokunmak Netflix'i bozar): bu iş netflix.js'e (sayfanın kendi dünyası).
/* global birlikteSite, birlikteCleanUrl */

(() => {
  if (window.__birlikteContent) return;
  window.__birlikteContent = true;

  const site = birlikteSite(location.href);
  const isNetflix = location.hostname.endsWith('netflix.com');
  let video = null;
  let announced = '';
  let lastReport = 0;

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Eklenti güncellendi ya da kaldırıldı: bu sayfa artık konuşamaz.
      clearInterval(timer);
    }
  };

  /** Sayfadaki (gölge DOM'lar dahil) videolar */
  function videos() {
    const found = [...document.querySelectorAll('video')];
    if (found.length) return found;
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          out.push(...el.shadowRoot.querySelectorAll('video'));
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return out;
  }

  /** İzlenen video: görünen en büyük, 45 saniyeden uzun olan (reklam/önizleme değil) */
  function pick() {
    let best = null;
    let bestArea = 0;
    for (const v of videos()) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      const long = !Number.isFinite(v.duration) || v.duration > 45;
      if (v.readyState >= 1 && long && area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function title() {
    const meta = navigator.mediaSession && navigator.mediaSession.metadata;
    if (meta && meta.title) return meta.title;
    if (isNetflix) {
      const el = document.querySelector('[data-uia="video-title"]');
      if (el && el.innerText.trim()) return el.innerText.trim().replace(/\s*\n+\s*/g, ' · ');
    }
    const name = site ? site.name : '';
    const t = document.title.replace(new RegExp(`\\s*[|\\-–—]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
    return t || name;
  }

  function state() {
    return {
      t: 'state',
      playing: !video.paused && !video.ended,
      time: video.currentTime || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      rate: video.playbackRate || 1,
      seeking: video.seeking,
      buffering: !video.paused && video.readyState < 3,
      ended: video.ended,
      at: Date.now(),
    };
  }

  function report() {
    if (!video) return;
    lastReport = Date.now();
    send(state());
  }

  function info() {
    return {
      t: 'video',
      site: site ? site.name : location.hostname,
      title: title(),
      url: birlikteCleanUrl(location.href),
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    };
  }

  function announce() {
    const current = info();
    const key = JSON.stringify(current);
    if (key === announced) return;
    announced = key;
    send(current);
    report();
  }

  const EVENTS = ['play', 'playing', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'canplay', 'ended', 'durationchange'];
  function watch(v) {
    if (video === v) return;
    if (video) EVENTS.forEach((e) => video.removeEventListener(e, report));
    video = v;
    announced = '';
    if (!v) return send({ t: 'gone' });
    EVENTS.forEach((e) => v.addEventListener(e, report));
    announce();
  }

  const timer = setInterval(() => {
    watch(pick());
    if (!video) return;
    announce(); // başlık ya da süre sonradan gelebilir
    // Oynarken saniyede iki kez, dururken arada bir
    if (Date.now() - lastReport > (video.paused ? 3000 : 500)) report();
  }, 500);

  const netflix = (cmd, extra) => window.postMessage({ birlikteNetflix: cmd, ...extra }, location.origin);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.t === 'probe') {
      reply(video ? { video: info(), state: state() } : null);
      return;
    }
    if (msg.t !== 'cmd' || !video) return;
    switch (msg.cmd) {
      case 'play':
        if (isNetflix) netflix('play');
        else video.play().catch(() => {});
        break;
      case 'pause':
        if (isNetflix) netflix('pause');
        else video.pause();
        break;
      case 'seek':
        if (isNetflix) netflix('seek', { ms: Math.round(msg.value * 1000) });
        else video.currentTime = msg.value;
        break;
      case 'rate':
        video.playbackRate = Math.min(4, Math.max(0.25, Number(msg.value) || 1));
        break;
      case 'volume':
        video.volume = Math.min(1, Math.max(0, Number(msg.value) || 0));
        video.muted = !!msg.muted;
        break;
    }
    report();
  });

  watch(pick());
})();
