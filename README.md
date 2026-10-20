# Birlikte İzle

Uzakta olsanız da yan yana gibi: biri dizi açar, öbürü aynı anda izler. İkiniz de durdurabilir, sarabilir, birbirinizi görebilirsiniz.

- **Her dosya:** MKV, MP4, AVI…; AC3/DTS ses, çoklu ses dili, gömülü ve yanındaki altyazılar (Türkçe karakterler dahil). ffmpeg uygulamanın içinde gelir.
- **Her işletim sistemi:** Windows, macOS (Apple Silicon + Intel), Linux. Otomatik güncellenir.
- **Her cihaz:** Kurmadan, tarayıcıdan (telefondan da) katılabilir.
- **Kayıpsız izleme:** Bölüm ikinizde de varsa ikiniz de kendi kopyanızdan, tam kalitede ve senkron izlersiniz. Yoksa "Bölümü ona gönder" ile karşıya gider.
- **YouTube, Netflix ve diğerleri:** YouTube bağlantısı yapıştır; Netflix, Disney+, Prime Video, Exxen, BluTV, Gain, tabii… için tarayıcı eklentisi.
- **Kamera:** Arka planı bulanıklaştırma (bilgisayarda işlenir), "birlikte izlediğiniz saatler" kartı.

Yol haritası ve durum: [PLAN.md](PLAN.md)

## Yapı

```
apps/desktop        Electron + React uygulaması (asıl ürün; web sürümü de buradan derlenir)
apps/extension      Tarayıcı eklentisi (Chrome, Edge, Brave, Opera): Netflix vb. senkron izlemek için
services/signal     Cloudflare Worker: eşleşme, oda, TURN bilgisi + web sürümünü yayınlar
packages/protocol   İki tarafın ve sunucunun konuştuğu dil (zod şemaları)
faz0-prototip       İlk tarayıcı prototipi (referans)
```

Film, kamera ve kontrol mesajları sunucudan **geçmez**; iki cihaz arasında doğrudan (P2P) akar.

## Dosyalar nasıl açılıyor?

Uygulama her dosya için en hızlı yolu kendisi seçer, olmazsa bir sonrakine geçer:

| Yol | Ne zaman | Bekleme |
|---|---|---|
| **Doğrudan** | MP4/MKV/WebM içinde H.264, HEVC*, VP9, AV1 + AAC/MP3/Opus | yok |
| **Hazırla** | Görüntü uygun ama ses AC3/DTS/TrueHD ya da başka bir ses dili seçildi | birkaç sn–1 dk, bir kez (önbelleğe) |
| **Canlı dönüştür** | Görüntü tarayıcıda çözülemiyor (AVI/Xvid, 10-bit H.264, MPEG-2…) | yok; sarınca ~1 sn |

\* HEVC, bilgisayarın donanım çözücüsü varsa doğrudan; yoksa hazırlanır.

Altyazılar kendiliğinden bulunur: dosyanın yanındaki `Bölüm.srt`, `Bölüm.tr.srt`, `.ass`, `.vtt` ve MKV içindeki metin altyazılar. Eski Windows-1254 kodlu Türkçe altyazılar da doğru görünür. Resim tabanlı altyazılar (PGS/VobSub) desteklenmez.

## Kayıpsız izleme (senkron mod)

Normalde açan taraf filmi karşıya yayınlar (kalite internet hızına bağlıdır). Bölüm karşıda da varsa yayına gerek kalmaz:

- **Kendiliğinden:** O bir bölüm açınca uygulama aynı dosyayı senin bilgisayarında arar (İndirilenler, İndirilenler › Birlikte İzle ve daha önce dizi açtığın klasörler). Bulursa kendi kopyandan oynatır; üst çubukta **Tam kalite** yazar. Dosya parmak iziyle eşleşir (boyut + baştan/ortadan/sondan birer MB).
- **Elle:** Altyazı ve ses menüsü → **Bende de var…** → dosyayı seç. Başka yerden indirilmiş aynı bölüm de olur (süreleri tutuyorsa).
- **Bölümü ona gönder:** Aynı menüden. Dosya doğrudan (P2P) gider, ilerleme üst çubukta görünür; yarıda kalırsa bir sonraki gönderimde kaldığı yerden devam eder. Gelince ikiniz de kendi kopyanızdan izlersiniz.

İki bilgisayarın saat farkı ölçülür; aradaki kayma küçükse oynatma hızı fark ettirmeden (%±5) ayarlanır, büyükse sarılır (ölçülen fark: 0–30 ms). Birinin kopyası takılırsa öbürü bekler.

## YouTube

İzleme ekranında **YouTube bağlantısı yapıştır** kutusuna bağlantıyı yapıştır (ya da ekrandayken ⌘V / Ctrl+V). İkiniz de YouTube'dan, aynı anda izlersiniz; yayın yok. Video, sinyal sunucusundaki küçük bir aracı sayfada (`yt.html`) oynar; bu yüzden sunucu yayında olmalı.

## Netflix ve diğerleri (tarayıcı eklentisi)

Netflix, Disney+, Prime Video, Max, Exxen, BluTV, Gain, tabii, puhutv, MUBI, Apple TV+ ve Crunchyroll tarayıcıda oynar; ikiniz de kendi hesabınızla, kendi tarayıcınızda izlersiniz. Eklenti oradaki oynatıcıyı uygulamaya bağlar: oynat, durdur, sar iki tarafa geçer (tarayıcıda elle yapılanlar da). Kamera ve ses uygulamada kalır; **Kamerası hep üstte kalsın** düğmesi onun kamerasını tarayıcının üstünde küçük bir pencerede tutar.

İkinizde de bir kez kurulur (Chrome, Edge, Brave ya da Opera):

1. Uygulamada **Ayarlar → Genel → Netflix ve diğerleri → Klasörü aç** (geliştirirken: `apps/extension`).
2. Tarayıcıda `chrome://extensions` (Edge: `edge://extensions`) → **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** → açılan klasörü seç.

Sonra tarayıcıda bir bölüm aç; uygulamanın izleme ekranında **Tarayıcıda · Netflix … → Birlikte izle** belirir. Ona basınca karşı tarafın tarayıcısında aynı bölüm kendiliğinden açılır.

Eklenti uygulamaya sadece bu bilgisayarın içinden (`127.0.0.1`, kapı 47652) bağlanır; uygulama sadece bu eklentinin kimliğini kabul eder. Chrome Web Mağazası'na yüklenirse mağaza yeni bir kimlik verir: `BIRLIKTE_EXT_IDS=<kimlik>` ile eklenebilir.

## Kamera arka planı

**Ayarlar → Kamera → Arkamı bulanıklaştır** (Hafif / Güçlü). Google'ın MediaPipe "selfie" modeli her karede seni arka plandan ayırır; hepsi bu bilgisayarda çalışır, görüntü hiçbir sunucuya gitmez.

## İlk kurulum

Node.js 22.12 veya üstü gerekir.

```powershell
npm install
```

Electron ve ffmpeg kurulumda kendiliğinden iner.

## Geliştirme

```powershell
npm run dev:signal   # 1. terminal: yerel sinyal sunucusu (http://localhost:8787)
npm run dev          # 2. terminal: uygulama, kod değişince anında yenilenir
npm run dev:ikinci   # 3. terminal (isteğe bağlı): kendinle eşleşip denemek için ikinci kopya
```

Aynı mikrofonu iki pencere kullanırsa ses geri besleme yapar; birinde mikrofonu kapat ya da kulaklık tak.

## Mac'te

Aynı komutlar Mac'te de çalışır (Apple Silicon ve Intel). Node.js 22.12+ gerekir ([nodejs.org](https://nodejs.org)'dan ya da `brew install node`).

```bash
npm install
npm run dev:signal   # 1. terminal
npm run dev          # 2. terminal
```

İlk açılışta macOS kamera ve mikrofon izni sorar (geliştirirken uygulamanın adı "Electron" görünür). İzni yanlışlıkla reddedersen: Sistem Ayarları → Gizlilik ve Güvenlik → Kamera / Mikrofon.

Mac kurulum dosyası (.dmg), Mac'in kendisinde üretilir:

```bash
VITE_SIGNAL_URL="https://birlikte-izle-signal.<hesabın>.workers.dev" npm run dist -w @birlikte/desktop
# → apps/desktop/release/Birlikte-Izle-<sürüm>-mac-arm64.dmg (Intel Mac'te: -mac-x64)
```

Kendi derlediğin uygulama doğrudan açılır. Başka bir Mac'e gönderdiğin (internetten inen) imzasız uygulamayı macOS "hasarlı" ya da "açılamıyor" diye durdurursa, uygulamayı Uygulamalar klasörüne sürükledikten sonra Terminal'de bir kez:

```bash
xattr -cr "/Applications/Birlikte Izle.app"
```

Testler Mac'te de çalışır; telefon ve uçtan uca testler Google Chrome, eklenti testi Microsoft Edge ister (`CHROME_PATH` / `EDGE_PATH` ile yol verilebilir). Pencereler ikinci ekran varsa orada açılır.

## Yayına alma

### 1. Sunucu + web sürümü (bir kez, ücretsiz)

```powershell
cd services/signal
npx wrangler login                     # tarayıcıda Cloudflare hesabına gir
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put ROOM_KEY       # üstteki komutun çıktısını yapıştır
npm run deploy                         # web sürümünü derler ve yayınlar
```

Çıkan adres (`https://birlikte-izle-signal.<hesabın>.workers.dev`) iki işe yarar:

- **Web sürümü:** Bu adresi telefonda ya da herhangi bir tarayıcıda açan kişi, hiçbir şey kurmadan katılır.
- **Masaüstü uygulamasının sunucusu:** Bir sonraki adımda derlemeye gömülür.

TURN (mobil veri ve CGNAT ağlarında doğrudan bağlantı kurulamaz, TURN olmadan "bağlanıyor"da kalınır; her ay ilk 1.000 GB ücretsiz): Cloudflare panelinde **Realtime → TURN Server** bölümünden bir anahtar oluştur, sonra `npx wrangler secret put CF_TURN_KEY_ID` ve `npx wrangler secret put CF_TURN_API_TOKEN` komutlarını çalıştır. Uygulamada **Ayarlar → Bağlantı → Bağlantıyı test et** sunucuya ulaşılıp ulaşılmadığını, o ağda doğrudan bağlantının mümkün olup olmadığını ve TURN'ün çalışıp çalışmadığını gösterir.

### 2. Kurulum dosyaları

**Sadece Windows, kendi bilgisayarında:**

```powershell
$env:VITE_SIGNAL_URL = "https://birlikte-izle-signal.<hesabın>.workers.dev"
npm run dist -w @birlikte/desktop      # → apps/desktop/release/Birlikte-Izle-Kurulum-<sürüm>.exe
```

**Üç platform birden + otomatik güncelleme (GitHub):**

1. Projeyi bir GitHub deposuna yükle.
2. Depoda **Settings → Secrets and variables → Actions → Variables** bölümüne `SIGNAL_URL` = sunucu adresi ekle.
3. Sürüm etiketi gönder:

   ```powershell
   git tag v0.2.0
   git push --tags
   ```

   [.github/workflows/surum.yml](.github/workflows/surum.yml) Windows, macOS (Apple Silicon + Intel) ve Linux paketlerini derleyip **Releases** sayfasına koyar.
4. Kurulu uygulamalar yeni sürümleri oradan kendiliğinden indirir. Ana ekranda "Yeni sürüm hazır" görünür.

Yeni sürüm çıkarmak için `apps/desktop/package.json` içindeki `version` alanını artırıp yeni bir etiket göndermen yeter.

### İmzasız uygulama uyarıları

Uygulama bir geliştirici sertifikasıyla imzalı değil. Sistemler ilk açılışta bir kez uyarır:

- **Windows:** "Windows bilgisayarınızı korudu" → **Ek bilgi** → **Yine de çalıştır**.
- **macOS:** Uygulamaya sağ tık → **Aç**. Olmazsa Sistem Ayarları → Gizlilik ve Güvenlik → **Yine de Aç**. Mac'te otomatik güncelleme için uygulamanın imzalı olması gerekir; Apple Developer hesabı (yılda 99 $) alınırsa iş akışı sertifikayı (`MAC_CSC_LINK`) kendiliğinden kullanır.

## Testler

Testler **sessizdir** (`--mute-audio`). Electron pencereleri ikinci monitörde, yan yana açılır.

```powershell
npm run typecheck                                 # bütün paketlerde tip denetimi
npm test -w @birlikte/signal                      # sunucu (20 kontrol)
npm test -w @birlikte/desktop                     # uçtan uca, iki tarayıcı (39)
npm run test:electron -w @birlikte/desktop        # gerçek Electron, iki pencere (15)
npm run test:media -w @birlikte/desktop           # zor dosyalar, altyazı, stereo, ducking (26)
npm run test:phone -w @birlikte/desktop           # masaüstü ↔ telefon tarayıcısı (12)
npm run test:sync -w @birlikte/desktop            # senkron mod, bölüm gönderme, kayma, istatistik (42)
npm run test:youtube -w @birlikte/desktop         # YouTube senkronu, gerçek YouTube; internet yoksa atlanır (18)
npm run test:camera -w @birlikte/desktop          # kamera arka planı bulanıklaştırma (9)
npm run test:extension -w @birlikte/desktop       # tarayıcı eklentisi, iki Edge + iki uygulama (21)
npm run dist:dir -w @birlikte/desktop
npm run test:packaged -w @birlikte/desktop        # paketlenmiş uygulama + içindeki ffmpeg ve eklenti (6)
```

Ekran görüntüleri `apps/desktop/test/output/` klasörüne düşer.

## Ayar eklemek

Her ayar `apps/desktop/src/renderer/src/settings/definitions.ts` dosyasında bir `defineSetting({...})` satırıdır. Ayarlar ekranı, varsayılan değer, kayıt ve (gerekirse `shared: true` ile) karşı tarafla eşitleme bu tanımdan otomatik üretilir. Değişikliğe tepki vermek için `onSettingChange` kullanılır.

## Sorun giderme

- **Electron açılmıyor, `electron.app` tanımsız hatası:** Ortamda `ELECTRON_RUN_AS_NODE=1` tanımlı (bazı VS Code eklentileri tanımlar). Normal bir terminalden çalıştır ya da `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- **"Sunucuya ulaşılamadı":** `npm run dev:signal` açık mı, ya da Ayarlar → Bağlantı → Gelişmiş'teki adres doğru mu?
- **"Bu dosya açılamadı":** Dosya bozuk olabilir. Masaüstü uygulaması her formatı açar; tarayıcı sürümü sadece tarayıcının çalabildiklerini açar.
- **iPhone'da "film paylaşamıyor":** Safari film yayınlayamaz. iPhone'dan izlenir ve kontrol edilir; filmi bilgisayardaki taraf açar. YouTube bağlantısı iPhone'dan da açılabilir.
- **"Tarayıcı eklentisi bağlı değil":** Uygulama açık mı? Tarayıcıda eklenti etkin mi (`chrome://extensions`)? Eklenti uygulamayı yarım dakikada bir arar; tarayıcıda bir video sitesi açmak da hemen bağlanmasını sağlar.
- **YouTube videosu açılmıyor:** Sahibi başka sitelerde oynatılmasını kapatmışsa uygulama bunu söyler ve videoyu tarayıcıda açar; eklenti kuruluysa oradan "Birlikte izle" ile devam edilir. Sinyal sunucusu yayında mı (`yt.html` oradan gelir)? Sunucu adresi IP ise (ör. `http://192.168.1.5:8787`) bazı kanallar oynatmaz; alan adı ya da `localhost` kullan.
- **Testler "Process failed to launch" ile düşüyor (Windows):** Çok sayıda test art arda çalışınca geçici portlar tükenebiliyor (`netstat -ano | find /c "TIME_WAIT"`). Birkaç dakika bekle ya da bilgisayarı yeniden başlat.
