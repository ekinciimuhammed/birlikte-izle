// Açılır pencere: uygulamaya bağlı mı, bu sekmede izlenebilir bir video var mı?
const $ = (id) => document.getElementById(id);

async function refresh() {
  const status = await chrome.runtime.sendMessage({ t: 'status' }).catch(() => null);
  const connected = !!status?.connected;
  $('dot').className = `dot ${connected ? 'on' : 'wait'}`;
  $('app').textContent = connected ? 'Uygulamaya bağlı' : 'Uygulama açık değil';
  $('app-hint').textContent = connected
    ? 'İzleme ekranında bu videoyu paylaşabilirsin.'
    : 'Birlikte İzle uygulamasını aç; eklenti kendiliğinden bağlanır.';
  const video = status?.video;
  $('vdot').className = `dot ${video ? 'on' : ''}`;
  $('video').textContent = video ? `${video.site} · ${video.title}` : 'Bu sekmede video yok';
  $('video-hint').textContent = video ? 'Uygulamada “Birlikte izle”ye bas.' : 'Netflix, Disney+, Prime Video, YouTube… bir bölüm aç.';
}

refresh();
setInterval(refresh, 1000);
