# Faz 0 · Prototip

Mimarinin kanıtı: dosyadan film yayını, iki taraftan kontrol, karşılıklı kamera. Tarayıcıda çalışır (Chrome veya Edge).

## Çalıştır

```powershell
cd faz0-prototip
npm install
npm start
```

Sonra tarayıcıda `http://localhost:8080` adresini aç.

Otomatik test için `npm test` çalıştır. Kendi sunucusunu 8099 portunda açar; iki görünmez Chrome bağlanır, yayın ve kontrolleri dener.

## 1. Test: aynı bilgisayar

1. **İki ayrı pencere** aç (sekme değil, yan yana iki pencere). Arka planda kalan sekmede Chrome videoyu kısabiliyor.
2. İkisinde de aynı oda kodunu gir. **Birinde mikrofonu kapat**, yoksa ses geri besleme yapar.
3. Bir pencerede **Dosya Seç** ile bir MP4 aç. Öbür pencerede film görünmeli.
4. İki pencereden de oynat, durdur, ileri/geri sar ve zaman çizelgesini sürükle.

## 2. Test: gerçek ağ

Sunucunu internete açmak için Cloudflare'ın ücretsiz hızlı tünelini kullan. Sadece sayfa ve tanışma trafiği tünelden geçer; film doğrudan P2P gider.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8080
```

Çıktıdaki `https://….trycloudflare.com` adresini **başka ağdaki** bir cihazda aç (telefonun mobil verisiyle internete bağlanan bir dizüstü bilgisayar ideal). Oda bağlantısını, sağ üstteki durum hapına tıklayarak kopyalayabilirsin.

**Bağlantı kurulamazsa** (sağ üstte kırmızı "Doğrudan bağlantı kurulamadı" yazısı) ağlardan biri doğrudan bağlantıya izin vermiyordur. Bu durumda TURN kullan:

1. Cloudflare panelinde **Realtime → TURN Server** bölümünden bir anahtar oluştur (her ay ilk 1.000 GB ücretsiz).
2. Sunucuyu şu şekilde başlat:

```powershell
$env:CF_TURN_KEY_ID = "<anahtar id>"
$env:CF_TURN_API_TOKEN = "<api token>"
npm start
```

## Kontrol listesi (sonuçları PLAN.md'ye yaz)

Sağ üstteki **〰 (Bağlantı Bilgisi)** düğmesi her şeyi canlı gösterir.

- [ ] Film karşıda akıcı mı? Çözünürlük, fps ve bit hızı ne? İşlemci sınırı veya bant sınırı uyarısı var mı?
- [ ] **Yayın gecikmesi** (izleyen tarafta) kaç ms?
- [ ] Durdur'a basınca iki taraf aynı karede mi duruyor?
- [ ] Film sesi karşıda stereo mu? Kulaklıkla sol/sağ test videosuyla dene.
- [ ] **Sen sesini kısınca veya kapatınca onun duyduğu film sesi değişiyor mu?** Değişmemeli.
- [ ] Ayarlardan codec'i VP9, H.264 ve AV1 olarak tek tek dene. Hangisi daha net ve işlemciyi daha az yoruyor?
- [ ] Kameralar ve sesler karşılıklı geliyor mu? Kulaklıksız yankı oluyor mu?
- [ ] Bağlantı türü ne: "Doğrudan (P2P)" mı, "TURN aktarma" mı?

## Bilinen sınırlar (Faz 1 ve 2'de çözülecek)

- MKV ile AC3/DTS ses tarayıcıda çalmaz. MP4 (H.264 + AAC) kullan; Faz 2'de ffmpeg bunu çözecek.
- Altyazı yok (Faz 2).
- Sayfayı yenileyince dosya yeniden seçilmeli.
- Oda kodunu bilen herkes girebilir. Faz 1'de tek seferlik eşleşmeye geçilecek.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `server.js` | Sayfayı sunar, WebSocket odası (en fazla 2 kişi) ve isteğe bağlı TURN bilgisi |
| `public/rtc.js` | P2P bağlantı: perfect negotiation, kontrol kanalı, iz yönetimi, stereo |
| `public/app.js` | Roller (paylaşan/izleyen), senkron kontrol, kameralar, arayüz |
| `public/stats.js` | Bağlantı istatistikleri ve yayın gecikmesi tahmini |
| `public/settings.js` | Şemadan üretilen ayarlar (Faz 1'deki `defineSetting` provası) |
| `public/icons.js` | Simgeler |
