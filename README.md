# Mesaj — modern sohbet uygulaması

Mesaj; mobil öncelikli arayüze sahip, Node.js + Express + Socket.IO + PostgreSQL tabanlı bir mesajlaşma uygulamasıdır. GitHub ve Render üzerinden yayımlanacak şekilde hazırlanmıştır.

## Bu sürümde bulunan özellikler

- Kullanıcı adı ve parola ile kayıt/giriş; parolalar bcrypt ile hash'lenir.
- Birebir sohbet ve grup sohbetleri; grup yöneticisi ataması, grup adını değiştirme, katılımcı ekleme/çıkarma ve gruptan ayrılma.
- Socket.IO ile anlık mesaj, yazıyor göstergesi ve çevrimiçi bilgisi.
- Gönderildi/iletildi/okundu işaretleri (çevrimiçi teslim ve sohbeti açıp okuma durumuna göre).
- Fotoğraf, MP4 video, sesli mesaj ve desteklenen belge türlerini gönderme (dosya başına 8 MB).
- Sesli mesaj kaydı (tarayıcı mikrofon izni gerekir).
- Mesajlara yanıt verme, mesajı düzenleme/silme ve emoji tepkileri.
- Sohbet içinde metin arama, sohbet arşivleme ve sessize alma.
- Profil adı, hakkında bilgisi ve fotoğrafı.
- 24 saatlik durum paylaşımı (metin/fotoğraf). Durumlar yalnızca ortak sohbeti bulunan kişilere gösterilir.
- Koyu tema, mobil uyumlu görünüm ve yüklenebilir PWA kabuğu.
- Web Push bildirim altyapısı (VAPID anahtarları tanımlandığında etkinleşir).
- Birebir sesli/görüntülü arama için WebRTC sinyalleşmesi; sunucu yöneticisi TURN/STUN sunucularını ortam değişkeniyle tanımlayabilir.
- Güvenlik başlıkları, giriş/yükleme/mesaj hız sınırları ve GitHub Actions temel kontrolleri.

## Önemli güvenlik ve kapasite sınırları

Bu proje WhatsApp'ın eşdeğeri veya üretim seviyesinde denetlenmiş bir güvenli mesajlaşma servisi değildir.

- **Gerçek uçtan uca şifreleme (E2EE) bu sürümde etkin değildir.** HTTPS aktarım sırasında bağlantıyı korur; mesaj gövdeleri sunucu/veritabanı tarafında okunabilir durumdadır. Bu nedenle özel, hassas veya gizli bilgileri paylaşmak için kullanma. E2EE, Signal Protocol gibi denetlenmiş bir protokolün istemci anahtar yönetimi, çoklu cihaz anahtar dağıtımı, cihaz doğrulama ve bağımsız güvenlik denetimiyle entegre edilmesini gerektirir. Bu projede özel/denetlenmemiş bir kripto sistemi yazılarak E2EE varmış gibi gösterilmez.
- Sesli/görüntülü arama WebRTC + varsayılan STUN sunucusu ile bağlantı kurmayı dener. Bazı mobil operatör ve kurumsal ağlarda TURN rölesi olmadan bağlantı kurulamaz. TURN tanımlandığında `/api/config` üzerinden istemcilere verilir. Şu anda aramalar birebirdir; grup araması ve çağrı geçmişi yoktur.
- Telefon numarası/OTP, adres defteri eşitleme, çoklu cihaz oturumları, konum paylaşımı ve şifreli yedekleme henüz yoktur.
- Medya dosyaları başlangıç sürümünde PostgreSQL içinde tutulur ve 8 MB ile sınırlandırılır. Yük arttığında dosyalar özel erişimli nesne depolama (ör. S3 uyumlu servis) üzerine taşınmalıdır.
- Push bildirimleri ancak HTTPS, tarayıcı desteği ve VAPID anahtarları yapılandırıldığında çalışır. Android'de tarayıcıya/ana ekrana eklenmiş PWA üzerinden test edilebilir.
- Bu sürümde kötüye kullanım raporlama, kullanıcı engelleme, e-posta/telefon doğrulaması, kapsamlı denetim kaydı ve bağımsız penetrasyon testi bulunmaz.

Projeyi herkese açık kullanıma açmadan önce KVKK ve ilgili mevzuat açısından hukuki inceleme, gizlilik metni, veri silme/erişim süreçleri, moderasyon ve güvenlik denetimi gerekir.

## Gereksinimler

- Node.js 20 veya üstü
- PostgreSQL 14 veya üstü

## Yerelde çalıştırma

1. Projeyi indir ve klasöre gir.
2. `npm install` çalıştır.
3. `.env.example` dosyasını `.env` olarak kopyala.
4. `.env` içinde `DATABASE_URL`, `DB_SSL=false` ve en az 32 karakterlik rastgele `JWT_SECRET` ayarla.
5. `npm start` çalıştır.
6. Tarayıcıda `http://localhost:3000` aç.

Tablolar ilk açılışta oluşturulur. Önceki Mesaj sürümünün tabloları varsa yeni sütunlar `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` ile eklenir; mevcut kullanıcı ve sohbet kayıtları silinmez.

## GitHub'a yükleme

1. GitHub'da yeni ve boş bir repository oluştur.
2. ZIP'i cihazında çıkart.
3. Çıkartılan klasörün **içindeki tüm dosyaları ve klasörleri** GitHub'a yükle. ZIP dosyasını tek başına yükleme; `public` klasörünün yapısını koru.
4. `.env`, `node_modules` veya gerçek anahtar/parola içeren dosyaları yükleme.
5. `.github/workflows/ci.yml` otomatik kontrol için repoda kalabilir.

## Render'da yayımlama

1. Render hesabına gir ve **New → Blueprint** seç.
2. GitHub repository'ni bağla.
3. Render `render.yaml` dosyasından Node web servisi ve PostgreSQL veritabanını algılar.
4. Oluşturmayı onayla ve deploy tamamlanınca verilen `onrender.com` adresini aç.
5. `https://SENIN-ADRESIN.onrender.com/api/health` adresi `{"ok":true,"service":"mesaj-app"}` döndürmeli.

`render.yaml`, `DATABASE_URL`, `DB_SSL` ve rastgele `JWT_SECRET` ayarlarını tanımlar. İsteğe bağlı VAPID ve TURN ayarlarını yalnızca kullanacaksan Render → Web Service → Environment ekranından ekle. `.env` dosyasını Render'a veya GitHub'a yükleme. Render'ın ücretsiz planlarında uyku, kapasite ve veritabanı saklama kısıtları olabilir; yayımdan önce güncel plan koşullarını kontrol et.

## WebRTC aramalarına TURN ekleme (önerilir)

Varsayılan STUN sunucusu her ağda yeterli olmaz. Üretime yakın kullanım için güvenilir bir TURN hizmeti edin. Render → Web Service → Environment bölümünde `RTC_ICE_SERVERS` anahtarını JSON dizi olarak ayarla. Örnek biçim:

```json
[
  { "urls": "stun:stun.example.net:3478" },
  { "urls": "turn:turn.example.net:3478", "username": "TURN_KULLANICI", "credential": "TURN_PAROLA" }
]
```

Örnekteki alan adları ve kimlik bilgileri yer tutucudur; kendi TURN sağlayıcının verdiği değerleri kullan. Mümkünse kısa ömürlü TURN kimlik bilgileri kullan. TURN parolasını GitHub'a veya `.env.example` dosyasına gerçek değer olarak koyma. Değişken tanımlandıktan sonra servisi yeniden yayımla.

## Web Push bildirimlerini açma (isteğe bağlı)

1. Güvenilir bir Node.js terminalinde `npx web-push generate-vapid-keys` çalıştır.
2. Üretilen `publicKey` ve `privateKey` değerlerini Render → servis → Environment bölümüne sırasıyla `VAPID_PUBLIC_KEY` ve `VAPID_PRIVATE_KEY` olarak ekle.
3. `VAPID_SUBJECT` değerini uygulama sahibine ait destek e-postasıyla ayarla.
4. Servisi yeniden yayımla. Uygulamada Profil ve ayarlar → Bildirimler → Etkinleştir adımını tamamla.

Özel anahtarı hiçbir zaman GitHub'a koyma veya başka biriyle paylaşma.

## Dosya yapısı

```text
server.js
render.yaml
package.json
.env.example
README.md
public/
  index.html
  style.css
  app.js
  sw.js
  manifest.webmanifest
  icon.svg
.github/workflows/ci.yml
```

## Sorun giderme

- `JWT_SECRET` hatası: Render Environment içinde otomatik oluşturulmuş `JWT_SECRET` bulunduğunu kontrol et.
- Veritabanı bağlantı hatası: Render PostgreSQL kaynağının web servise bağlandığını ve `DATABASE_URL` değişkenini kontrol et.
- Fotoğraf/dosya yüklenmiyor: Dosya 8 MB'tan küçük ve desteklenen türde olmalı.
- Mikrofon/kamera izni çıkmıyor: Render HTTPS adresini kullan ve tarayıcıdan izin ver.
- Arama bağlanmıyor: Ağın STUN bağlantısını engellemesi veya TURN sunucusu gerektirmesi mümkün; bu MVP'nin bilinen sınırıdır.
- Push etkinleşmiyor: VAPID anahtarlarının her ikisinin de Render Environment'ta bulunduğunu, `VAPID_SUBJECT` değerinin geçerli bir iletişim adresi olduğunu ve uygulamanın HTTPS üzerinden açıldığını kontrol et.
- Görüntülü/sesli arama bağlanmıyor: `RTC_ICE_SERVERS` içine TURN servisi ve doğru kimlik bilgileri eklenmiş olmalı; STUN tek başına her ağda çalışmaz.
- Grup ayarları görünmüyor: Grup menüsündeki ⋮ simgesini aç. Grup adı/üye yönetimi yalnızca yönetici hesabına açıktır.
