# Birlikte İzle — Yol Haritası

Uzaktayken yan yana gibi: aynı diziyi aynı anda izlemek, ikimiz de kontrol edebilmek, birbirimizi görebilmek.

**Nasıl çalıştırılır:** [README.md](README.md)

**Temel kararlar**
- Masaüstü: Electron + React + TypeScript (iki tarafta da aynı Chromium WebRTC motoru)
- Medya: doğrudan P2P WebRTC — film `video.captureStream()` ile, kontrol DataChannel ile, kameralar ayrı akış
- Sunucu: sadece tanışma (signaling) + yedek TURN — Cloudflare Worker + Durable Object, Cloudflare TURN
- Arayüz: Apple HIG felsefesi — önce içerik, tek ana eylem, gruplu ayarlar
- Ayarlar: elle yazılmaz, tek şemadan üretilir; her yeni özellik şemaya bir satır olarak girer

Durum işaretleri: `[ ]` yapılacak · `[~]` sürüyor · `[x]` bitti

---

## Faz 0 — Prototip (kanıt) · `faz0-prototip/`

Amaç: Mimariyi gerçek ağda gözle görmek. Tarayıcıda çalışır, Electron yok.

- [x] Minik Node sunucusu: statik sayfa + WebSocket oda (en fazla 2 kişi)
- [x] P2P bağlantı ("perfect negotiation", çakışmasız)
- [x] Film yayını: dosya seç → `captureStream()` → karşı taraf
- [x] Kontrol kanalı: iki taraf da oynat / durdur / sar / ±10 sn
- [x] "Gördüğü karede dur" (yayın gecikmesi telafisi)
- [x] Kamera + mikrofon (yankı engelleme açık), film sesi işlemsiz ve stereo
- [x] Bağlantı bilgisi paneli: gecikme, bit hızı, çözünürlük, codec, bağlantı türü
- [x] Canlı kalite ayarları: bit hızı, film ses kalitesi, akıcılık/netlik
- [x] Otomatik uçtan uca test (`npm test`): iki görünmez Chrome, 22/22 geçiyor
- [ ] **Yerel test (gözle):** iki pencere, aynı bilgisayar, gerçek bir dizi dosyası
- [ ] **Gerçek ağ testi:** cloudflared tüneli + başka ağdaki bir cihaz (telefon hotspot'u)

**Bitti sayılır:** Başka bir ağdan bağlanan cihaz 1080p filmi akıcı görüyor, durdur/sar her iki taraftan çalışıyor, kameralar karşılıklı açık.

**Öğrenilenler (Faz 1'e taşınacak)**
- İki taraf aynı anda teklif gönderince Chrome, geri alınan ilk teklifle veri kanalını düşürüyor. Çözüm: kibar taraf ilk teklifi cevaplayana kadar kanal açmıyor, iz eklemiyor (`rtc.js` → `setupPending`).
- Bant tahmini 300 kbps'den başlıyor, ~5 saniyede 5–6 Mbps'ye çıkıyor. İlk saniyelerde görüntü bulanık olabilir. Faz 2'de başlangıç bit hızını yükseltmek denenecek.
- Film önceliği yüksek olsa da kamera ~1 Mbps ile akmaya devam ediyor; kamera aç kalmıyor.

**Ölçülecekler (test sonrası buraya yaz):** yayın gecikmesi ___ ms · film bit hızı ___ Mbps · bağlantı türü ___ · upload (sen) ___ Mbps · upload (o) ___ Mbps

---

## Faz 1 — İlk sürüm (MVP) · `apps/desktop`, `services/signal`, `packages/protocol`

- [x] Monorepo iskeleti (npm workspaces), electron-vite 6 + Vite 8 + React 19 + TypeScript 7, Electron 44
- [x] `packages/protocol`: zod ile bütün mesajlar; gelen her mesaj doğrulanır
- [x] Ayar altyapısı: `defineSetting()` → Ayarlar ekranı, varsayılanlar, kayıt (JSON dosyası) ve `shared` ayarların karşıya eşitlenmesi otomatik
- [x] Tasarım temeli: renk/ölçü değişkenleri, Inter, cam paneller, yaylı animasyonlar, vurgu rengi ayarı
- [x] `services/signal`: Worker + Durable Object (eşleşme kodları, iki kişilik oda, hibernation), HMAC oda anahtarı, TURN kimlik bilgisi
- [x] Eşleşme: 6 haneli tek kullanımlık kod (10 dk, yanlış denemeye sınır) → sonrası otomatik, "çevrimiçi / izliyor" durumu
- [x] Ekranlar: Karşılama → Ad → Eşleşme → Kutlama · Ana ekran · İzleme · Ayarlar (kenar çubuklu, gruplu)
- [x] Yerel oynatıcı, film yayını, iki yönlü kontrol, "kim kontrol edebilir" ayarı
- [x] Kamera baloncukları (sürükle → köşeye yaylanır, boyut ayarı), mikrofon/kamera aç-kapa, kalp
- [x] Kopma → paylaşan durur, izleyende "Yeniden bağlanıyor…", geri gelince kaldığı yerden
- [x] Kamera/mikrofon kendiliğinden kapanırsa (kablo, başka uygulama, uyku) fark edip yeniden açmayı dener
- [x] Testler: sunucu 19/19 · uygulama uçtan uca 39/39 · gerçek Electron iki pencere 15/15
- [ ] **Senin yapacakların:** sunucuyu yayına al (README → "Sunucuyu yayına alma") ve iki bilgisayarda gerçek ağda dene

**Bitti sayılır:** İki bilgisayarda kurulu uygulama, kod girmeden birbirini buluyor ve bir bölüm baştan sona sorunsuz izleniyor.

**Öğrenilenler**
- Kibar taraf kendi bağlantısını kurarken karşıdan gelen ilk teklif kaybolabiliyor. Çözüm: sinyaller tamponlanıyor; kibar olmayan taraf 10 sn içinde bağlanamazsa oturumu baştan başlatıyor.
- Kapatılan eski bağlantının "kapandı" olayı yeni bağlantıyı kilitleyebiliyordu. Artık eski bağlantıdan gelen olaylar yok sayılıyor.
- Aynı bilgisayarda iki Electron, Chromium'un *sahte* kamerasını birlikte kullanınca biri kendiliğinden düşüyor (uygulama kodu olmadan da tekrarlanıyor). Gerçek kameralarla iki bilgisayarda doğrulanmalı.
- Görünmez tarayıcı ekran görüntüleri yerel kamera önizlemesini siyah çiziyor; kareler aslında akıyor (piksel ölçümüyle doğrulandı).
- VS Code eklenti ortamı `ELECTRON_RUN_AS_NODE=1` tanımlıyor; Electron'u düz Node'a çeviriyor. Testler ve `dev:ikinci` bunu temizliyor.
- npm 11 kurulum betiklerini onaysız çalıştırmıyor (esbuild, workerd onaylandı); Electron 44 ikili dosyayı `install-electron` ile indiriyor.

---

## Faz 2 — Her şeyle uyumlu

Hedef: hangi dosya, hangi işletim sistemi, hangi cihaz olursa olsun çalışsın.

**Her dosya** (ffmpeg uygulamanın içinde gelir)
- [x] Dosya bilgisi: kapsayıcı, görüntü/ses/altyazı izleri, diller (`ffmpeg -i` çıktısından)
- [x] Üç yol, kendiliğinden seçilir ve biri olmazsa sıradakine geçilir:
  doğrudan oynat → hazırla (görüntü olduğu gibi, ses AAC'ye; önbelleğe) → canlı dönüştür (her şey H.264/AAC)
- [x] Ses dili seçimi (Türkçe dublaj / orijinal) + tercih edilen dil ayarı; aynı saniyeden devam
- [x] Altyazı: yanındaki SRT/VTT/ASS dosyaları, MKV içindeki altyazılar, elle ekleme; Windows-1254 Türkçe doğru
- [x] Altyazı iki tarafta ayrı çizilir: boyut, renk, arka plan kişiye özel; zaman kaydırma ortak ([ ve ])
- [x] Film sesi stereo (alıcıda sol 439 Hz / sağ 662 Hz ölçüldü); ses kısmak karşıyı etkilemiyor (ölçüldü)

**Her işletim sistemi**
- [x] Kurulum: Windows (NSIS, yerelde üretildi ve paket testi 5/5), macOS (dmg + zip, Intel + Apple Silicon), Linux (AppImage, deb)
- [x] Otomatik güncelleme (GitHub Releases) + "Yeni sürüm hazır" bildirimi
- [x] macOS kamera/mikrofon izinleri ve yetkileri, uygulama simgesi
- [x] GitHub Actions: her etikette üç platform için derleyip yayımlar (`.github/workflows/surum.yml`)
- [ ] **Senin yapacakların:** GitHub deposu + `SIGNAL_URL` değişkeni + ilk etiket → Mac/Linux paketleri ilk kez orada derlenecek

**Her cihaz**
- [x] Web sürümü sinyal sunucusuyla aynı adreste: kurmadan tarayıcıdan (telefondan da) katılma
- [x] Dokunmatik: filme dokunmak kontrolleri açar/kapatır; dar ekranda baloncuklar üst bantta (test: 12/12)

**Cila**
- [x] Tepkiler (❤️ 😂 😮 😢 👏 🔥)
- [x] "O konuşunca filmi kıs" (ducking) + oran ayarı
- [x] "Kaldığınız yerden" listesi (izleme geçmişi)

**Testler:** sunucu 20/20 · web 39/39 · Electron 15/15 · medya 26/26 · telefon 12/12 · paket 5/5. Hepsi sessiz; Electron pencereleri ikinci monitörde.

**Bitti sayılır:** Elindeki herhangi bir dizi dosyası açılıp ikinizde de sesli ve altyazılı oynuyor; Windows/Mac/Linux kurulum dosyaları ve tarayıcı sürümü hazır.

**Öğrenilenler**
- Chromium `captureStream()`: Her yeni kaynakta (yeni bölüm, ses dili, canlıda sarma, hatta oynatmaya başlama) daha önce alınmış *her* yakalama akışına yeni izler ekliyor. Eski izler "canlı" görünüp veri taşımıyor. Öğenin sesini tek bir musluk besliyor ve onu en son eklenen ses izi alıyor. Çözüm: öğe başına tek akış, her türden en son eklenen iz gönderilir, hiçbir iz elle durdurulmaz. (İkinci bölümü açınca film gitmemesi ve sessiz film hatası buradan çıktı.)
- Opus stereo: "stereo=1" hem kendi hem karşının açıklamasında olmalı. Karşınınki kodlayıcıyı, kendimizinki çözücüyü stereo yapıyor; biri eksikse ses mono'ya düşüyor.
- `birlikte-media://` kaynakları için üretim güvenlik politikasına (CSP) `media-src birlikte-media:` eklenmeli; yakalama için de `crossOrigin` + CORS başlığı gerekiyor.
- Dokunmatiği medya sorgusuyla değil, her dokunuşun `pointerType` değeriyle anlamak gerekiyor (test tarayıcıları ve dokunmatik dizüstüler `hover: none` bildirmiyor).
- `<video>` ses düzeyi ya da sessiz olması `captureStream` sesini etkilemiyor; ducking güvenle yapılabiliyor.

---

## Faz 3 — Senkron mod

- [ ] Dosya ikimizde de varsa: yayın yok, iki taraf kendi kopyasını oynatır (sıfır kalite kaybı)
- [ ] Dosya eşleştirme (boyut + kısmi hash)
- [ ] Saat farkı ölçümü (ping/pong) + kayma düzeltme (küçük hız ayarı / büyük farkta sarma)
- [ ] "Bölümü ona gönder": P2P dosya aktarımı, ilerleme çubuğu
- [ ] YouTube senkronu (IFrame API)

---

## Faz 4 — İsteğe bağlı

- [ ] Kendi hesaplarımızla Netflix vb. için tarayıcı eklentisi (oynatıcı senkronu, yayın yok)
- [ ] Kamera arka plan bulanıklaştırma
- [ ] "Birlikte izlediğimiz saatler" istatistiği

---

## Açık sorular

- O hangi işletim sistemini kullanıyor? (Windows → NSIS kurulum; Mac → dmg + notarization için Apple Developer hesabı)
- İkimizin gerçek upload hızları (speedtest)
