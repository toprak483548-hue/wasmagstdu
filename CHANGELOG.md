# Değişiklik günlüğü

## 3.0.0

- Grup yöneticisi rolü eklendi; grup adı değiştirme, katılımcı ekleme/çıkarma ve gruptan ayrılma akışları hazırlandı.
- Eski gruplara ilk üye üzerinden yönetici rolü atayan veritabanı geçişi eklendi.
- Durum paylaşımları yalnızca ortak sohbeti bulunan kişilere görünür hâle getirildi; medya uç noktası da aynı erişim kontrolünü uygular.
- Web Push bildiriminden ilgili sohbeti açan bağlantı eklendi.
- Arama altyapısı Render ortam değişkeni `RTC_ICE_SERVERS` üzerinden STUN/TURN sunucusu alabilir hâle getirildi.
- Sohbet arşivleme ve sessize alma işlemleri özel arayüz penceresine taşındı.
- Uçtan uca şifrelemenin etkin olmadığı hem uygulama arayüzünde hem kurulum belgelerinde açıkça belirtildi.

## 2.x

- Gerçek zamanlı birebir ve grup sohbetleri, medya/voice note, profil, durum, bildirim altyapısı, mesaj tepkileri ve WebRTC arama temel özellikleri.
