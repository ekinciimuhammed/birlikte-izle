// Netflix'in kendi oynatıcısıyla oynat/durdur/sar (sayfanın kendi dünyasında çalışır).
// Netflix'te videonun zamanını doğrudan değiştirmek oynatıcıyı bozar (hata M7375); sitenin
// oynatıcısı ise milisaniye ile sarmayı kendisi yapar.

(() => {
  if (window.__birlikteNetflix) return;
  window.__birlikteNetflix = true;

  const player = () => {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((i) => i.startsWith('watch')) ?? ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch {
      return null;
    }
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || typeof m.birlikteNetflix !== 'string') return;
    const p = player();
    const video = document.querySelector('video');
    if (m.birlikteNetflix === 'seek') {
      if (p) p.seek(Math.max(0, Math.round(Number(m.ms) || 0)));
    } else if (m.birlikteNetflix === 'play') {
      if (p) p.play();
      else video?.play().catch(() => {});
    } else if (m.birlikteNetflix === 'pause') {
      if (p) p.pause();
      else video?.pause();
    }
  });
})();
