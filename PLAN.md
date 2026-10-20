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
- [x] Sunucu yayında: `https://birlikte-izle-signal.ekinciimuhammed.workers.dev` (yayındaki duman testi 20/20)
- [ ] **Senin yapacakların:** iki bilgisayarda gerçek ağda dene; isteğe bağlı TURN anahtarı (README → Yayına alma)

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
- [x] GitHub deposu + `SIGNAL_URL` değişkeni + `v0.3.0` etiketi: Windows exe, Mac dmg (Apple Silicon + Intel), Linux AppImage/deb Releases'te

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

- [x] Dosya ikimizde de varsa: yayın yok, iki taraf kendi kopyasını oynatır (sıfır kalite kaybı); host film yayınını kapatır
- [x] Dosya eşleştirme: boyut + baştan/ortadan/sondan 1'er MB'ın SHA-1'i; İndirilenler, Birlikte İzle klasörü ve geçmişteki klasörlerde kendiliğinden arama; "Bende de var…" ile elle (süreleri tutan farklı kopya da olur)
- [x] Saat farkı ölçümü (ping/pong, en kısa gidiş-dönüşlü ölçümler) + kayma düzeltme: küçük farkta hız %±5, 1 sn'den büyükte sarma; sarmadan sonra kalan küçük fark bir kez daha sararak kapatılır
- [x] Biri takılırsa (disk, YouTube yükleniyor) öbürü bekler (en fazla 15 sn)
- [x] "Bölümü ona gönder": P2P ayrı veri kanalı, akış denetimi, ilerleme hapı, iptal, yarıda kalırsa kaldığı yerden (.part)
- [x] YouTube senkronu: sunucudaki aracı sayfa (`yt.html`) IFrame API'yi çalıştırır; uzak betik uygulamanın sayfasına girmez
- [x] Ayarlar: "Bende de varsa kendi kopyamdan oynat", "Gönderdiği bölümleri kabul et"

**Testler:** senkron 42/42 · YouTube (gerçek YouTube) 18/18. Ölçülen fark: dosyada 0–30 ms, YouTube'da 14–76 ms.

**Öğrenilenler**
- Host, sarma bitmeden "şuradayım" derse guest sarma süresi kadar ileride kalıyor. Host artık `seeked` olayından sonra bildiriyor; guest de kendi sarma süresini öğrenip o kadar ileri sarıyor.
- YouTube `getAvailablePlaybackRates()` sadece 0,25'lik adımları sayıyor ama 1,05 / 0,95 de kabul ediliyor (ölçüldü): YouTube'da da hızla ince ayar yapılabiliyor.
- YouTube, `file://` sayfalara gömmeye izin vermiyor (yönlendiren adres yok): kurulu uygulama aracı sayfayı sinyal sunucusundan açıyor.
- Bazı kanallar (ör. dizi kanalları) IP adresinden gömülen oynatıcıyı reddediyor (hata 150) ama `localhost`'tan ve gerçek alan adından oynuyor (ölçüldü). Aracı sayfa artık 127.0.0.1 yerine her zaman `localhost`'tan açılıyor. Sahibi gömmeyi tamamen kapatmışsa video tarayıcıda açılıyor; eklentiyle yine birlikte izleniyor.

---

## Faz 4 — İsteğe bağlı

- [x] Netflix vb. için tarayıcı eklentisi (`apps/extension`, Chrome/Edge/Brave/Opera): ikimiz de kendi hesabımızla, kendi tarayıcımızda; oynat/durdur/sar uygulamadan da tarayıcıdan da iki tarafa geçer. Karşının tarayıcısında aynı bölüm kendiliğinden açılır. Netflix'te sarma sitenin kendi oynatıcısıyla. Kamerası "resim içinde resim" ile tarayıcının üstünde kalabilir.
- [x] Kamera arka plan bulanıklaştırma (MediaPipe selfie modeli, bu bilgisayarda; Hafif / Güçlü)
- [x] "Birlikte izlediğimiz saatler": ana ekranda toplam süre, bölüm sayısı, son 7 gün
- [ ] **Senin yapacakların:** iki bilgisayarda da eklentiyi yükle (README → "Netflix ve diğerleri"), gerçek Netflix'le dene

**Testler:** eklenti 21/21 (iki uygulama + eklentili iki Edge + yerel video sitesi) · kamera 9/9 (keskin kenarlar ‰9,6 → 0) · paket 6/6 (eklenti klasörü pakette).

**Öğrenilenler**
- Chrome 137+ komut satırından eklenti yüklemeyi kapattı; otomatik test Edge ile. Kullanıcılar için "Paketlenmemiş öğe yükle" Chrome'da da çalışıyor.
- Eklenti kimliği manifest'teki `key`den türüyor: paketlenmemiş yüklemede de her bilgisayarda aynı. Uygulama sadece bu kimlikten gelen yerel bağlantıyı kabul ediyor.
- Tarayıcıda elle yapılanı (durdur/oynat) zaman penceresiyle değil "istediğim durum gerçekleşti mi" takibiyle ayırt etmek gerekiyor; yoksa hızlı art arda yapılan işlemler kayboluyor.
- İki taraf aynı anda iz eklediğinde Chromium bazen yeni teklifi "RTP extension ID reassignment" ile reddediyor. Artık reddedilen teklif ya da cevapsız kalan teklif temiz bir oturumla kurtarılıyor.
- MediaPipe modeli `fetch()` ile yükleniyor; kurulu uygulamada sayfa `file://` olduğu için model koda gömüldü (250 KB). WebAssembly için CSP'ye `wasm-unsafe-eval` eklendi.
- Uygulama İndirilenler'i taradığında macOS izin sorar: Info.plist'e Türkçe açıklamalar eklendi.
- GitHub Actions: Apple sertifikası yokken boş `CSC_LINK` electron-builder'ı düşürüyor (değişken hiç tanımlanmamalı); Intel macOS 15 makinesinde dmg aracı 32 bit taşmasıyla çöküyor, Intel paketi Apple Silicon makinesinde `--x64` ile derleniyor (ffmpeg'in x86_64 sürümü ayrıca indirilip doğrulanıyor). İki Mac işi de `latest-mac.yml` yüklediği için sonuncusu kazanır; Mac'te otomatik güncelleme zaten imza gerektirdiğinden şimdilik sorun değil, imza alınırsa birleştirilmeli.
- Mac paketi (v0.3.0) açılır açılmaz SIGTRAP ile çöküyordu: electron-builder yardımcı süreçlerin dosya adlarını ürün adından üretip NFD'ye çeviriyor ("İ" → I + U+0307), Electron ise yardımcıları Info.plist'teki NFC adla arıyor. Hata mesajı yok, çünkü Electron'un resmi derlemesinde CHECK mesajsız; `--single-process` ile de çöktüğü için sorun yardımcıyı başlatmak değil adların uyuşmaması. Düz Electron'da aynı adları NFC/ASCII yapınca açıldı, NFC klasör + NFD dosya yapınca çöktü. Çözüm: Mac'te ürün ve dosya adları ASCII ("Birlikte Izle.app"), görünen ad `CFBundleDisplayName` ile "Birlikte İzle".
- Bilgisayarlardan biri mobil veriye (telefondan internet paylaşımı) geçince ikisi de "bağlanıyor"da kaldı: yayındaki sunucuda TURN tanımlı değildi, mobil operatörün ortak adresi (CGNAT) doğrudan bağlantıya izin vermiyor. Uygulama artık 20 sn'de bağlanamazsa ağı test edip sebebini söylüyor; Ayarlar → Bağlantı'da elle de test edilebiliyor. İnternet geri gelince ICE beklemeden yenileniyor, sessizce ölen sunucu bağlantısı en geç 60 sn'de fark ediliyor, TURN kimlik bilgileri (24 saat geçerli) uzun oturumda tazeleniyor.
- Testleri art arda çok kez çalıştırınca Windows'un geçici port havuzu (16.384) TIME_WAIT bağlantılarıyla doluyor; Electron'un hata ayıklama portu açılamıyor ve testler "failed to launch" ile düşüyor. Uygulamadan değil; testler tek tek ya da yeniden başlatmadan sonra geçiyor.

---

## Açık sorular

- O hangi işletim sistemini kullanıyor? (Windows → NSIS kurulum; Mac → dmg + notarization için Apple Developer hesabı)
- İkimizin gerçek upload hızları (speedtest)
