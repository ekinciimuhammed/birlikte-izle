# Birlikte İzle

Uzakta olsanız da yan yana gibi: biri dizi açar, öbürü aynı anda izler. İkiniz de durdurabilir, sarabilir, birbirinizi görebilirsiniz.

- **Her dosya:** MKV, MP4, AVI…; AC3/DTS ses, çoklu ses dili, gömülü ve yanındaki altyazılar (Türkçe karakterler dahil). ffmpeg uygulamanın içinde gelir.
- **Her işletim sistemi:** Windows, macOS (Apple Silicon + Intel), Linux. Otomatik güncellenir.
- **Her cihaz:** Kurmadan, tarayıcıdan (telefondan da) katılabilir.

Yol haritası ve durum: [PLAN.md](PLAN.md)

## Yapı

```
apps/desktop        Electron + React uygulaması (asıl ürün; web sürümü de buradan derlenir)
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

İsteğe bağlı TURN (bazı mobil ve CGNAT ağlarında doğrudan bağlantı kurulamaz; her ay ilk 1.000 GB ücretsiz): Cloudflare panelinde **Realtime → TURN Server** bölümünden bir anahtar oluştur, sonra `npx wrangler secret put CF_TURN_KEY_ID` ve `npx wrangler secret put CF_TURN_API_TOKEN` komutlarını çalıştır.

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
npm run dist:dir -w @birlikte/desktop
npm run test:packaged -w @birlikte/desktop        # paketlenmiş uygulama + içindeki ffmpeg (5)
```

Ekran görüntüleri `apps/desktop/test/output/` klasörüne düşer.

## Ayar eklemek

Her ayar `apps/desktop/src/renderer/src/settings/definitions.ts` dosyasında bir `defineSetting({...})` satırıdır. Ayarlar ekranı, varsayılan değer, kayıt ve (gerekirse `shared: true` ile) karşı tarafla eşitleme bu tanımdan otomatik üretilir. Değişikliğe tepki vermek için `onSettingChange` kullanılır.

## Sorun giderme

- **Electron açılmıyor, `electron.app` tanımsız hatası:** Ortamda `ELECTRON_RUN_AS_NODE=1` tanımlı (bazı VS Code eklentileri tanımlar). Normal bir terminalden çalıştır ya da `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- **"Sunucuya ulaşılamadı":** `npm run dev:signal` açık mı, ya da Ayarlar → Bağlantı → Gelişmiş'teki adres doğru mu?
- **"Bu dosya açılamadı":** Dosya bozuk olabilir. Masaüstü uygulaması her formatı açar; tarayıcı sürümü sadece tarayıcının çalabildiklerini açar.
- **iPhone'da "film paylaşamıyor":** Safari film yayınlayamaz. iPhone'dan izlenir ve kontrol edilir; filmi bilgisayardaki taraf açar.
