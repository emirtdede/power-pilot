# Power Pilot - Yerel API Güvenlik Mimarisi

## Güvenlik Sınırları

- **Dinleme Adresi**: Varsayılan olarak yalnızca `127.0.0.1` (Localhost) dinlenir. Ağa veya internete açık değildir.
- **API Anahtarı**: Kriptografik rastgele üretilen API anahtarı zorunludur. `X-API-Key` veya `Authorization: Bearer` başlığında gönderilmelidir. URL parametrelerinde kabul edilmez.
- **Parola / Hash Depolama**: API anahtarı loglara veya düz metne yazılmaz. Yalnızca SHA-256 hash saklanır.
- **Komut Sınırlaması**: API üzerinden serbest shell komutu, PowerShell betiği veya executable çalıştırmak KESİNLİKLE YASAKTIR. Yalnızca önceden tanımlı Power Pilot REST işlemleri çalıştırılabilir.
- **Hız Sınırı (Rate Limit)**: IP başına dakikada en fazla **60 istek**; aşımda `429` dönülür. (CLI 5sn polling + n8n burst toleransı için.)
- **Gövde Sınırı**: İstek gövdesi en fazla 100KB; aşan bağlantı kesilir.
- **Güç Eylemleri**: `POST /api/v1/power/{lock,signout,restart,sleep,hibernate}` anında çalışır; `POST /api/v1/power/shutdown` iptal fırsatı için 5sn gecikmeli görev olarak zamanlanır.
- **IP/CIDR Allowlist (WP-01)**: `lanModeEnabled=true` iken yalnızca `lanAllowedIps` içindeki IP/CIDR kayıtları erişebilir. Hostname kabul edilmez (DNS rebinding). Loopback (`127.0.0.0/8`, `::1`) her zaman açıktır. Liste boşsa loopback dışındaki tüm istekler `403 IP_NOT_ALLOWED` alır (fail-closed). IPv4-mapped IPv6 (`::ffff:192.168.1.10`) IPv4'e normalize edilir; zone ID (`fe80::1%eth0`) güvenli ayrılır.
- **Rate-limit bellek sınırı (WP-01)**: rate-limit anahtar sayısı 1000 ile sınırlıdır; eski kayıtlar temizlenir. ACL'den geçmeyen IP map'i büyütemez.
- **Uzaktan kapatma koruması (WP-08)**: `blockRemoteShutdownWhenActive=true` (varsayılan) iken kullanıcı aktifse (idle < 60sn) `POST /api/v1/power/shutdown|restart` → `403 REMOTE_SHUTDOWN_BLOCKED`. Aynı kural `local_api`, `n8n` ve `console` kaynaklı görevlerde icra anında da uygulanır.
- **İstemci kapatma/erteleme (WP-03)**: Açık uyarı modalı iptal edildiğinde yalnızca modal kapanmaz; görev `CANCELLED` durumuna geçer. Güç komutu OS'e gönderildikten sonra gelen iptal `CANCEL_TOO_LATE` döner ve yanlış "iptal edildi" izlenimi vermez.
- **Acil kapatma anahtarı**: `lanModeEnabled=false` LAN API'yi tamamen kapatır; loopback erişimi etkilenmez. `localApiEnabled=false` ise API sunucusunu durdurur. İkisi de veri kaybı üretmez.

## Ayarlar ve Durum Uçları

| Ayar / Uç | Anlam |
| --- | --- |
| `lanModeEnabled` | LAN bind ve allowlist denetimini açar |
| `lanAllowedIps` | Yalnızca IP/CIDR listesi; hostname kabul edilmez |
| `blockRemoteShutdownWhenActive` | Aktif kullanıcıda uzaktan shutdown/restart'ı engeller |
| `localApiTlsEnabled` | HTTPS + sertifika materyali ister |
| `localApiRequireClientCert` | mTLS; TLS olmadan reddedilir |
| `localApiTlsStrict` | Sıkı TLS; TLS olmadan reddedilir |
| `GET /api/v1/status` | `transport`, `version`, güvenlik özeti |
| `getSecurityStatus()` | `aclAllowed/aclDenied/rateLimited`, `rotationDue` |

## FAZ A - Pilot güvenlik katmanı (tek-şirket)

- **TLS**: `localApiTlsEnabled=true` + sertifika materyali (`localApiCertPem`/`localApiKeyPem` veya mutlak dosya yolları) varsa `https`; materyal yoksa `http` fallback (tek-PC davranışı bozulmaz). Durum: `GET /api/v1/status` → `transport`, `getSecurityStatus()` özeti.
- **mTLS**: `localApiRequireClientCert=true` ise istemci sertifikası zorunludur; yoksa `401 MTLS_REQUIRED`. FAZ A'da uygulama katmanında 401 üretilir (debug kolaylığı); FAZ B'de TLS katmanında `rejectUnauthorized:true` ile sıkılaştırılacak.
- **Rol-bazlı anahtar**: `generateApiKey(role)` → `viewer` (salt-okunur GET) | `operator` (GET + timer/iptal + yıkıcı-olmayan güç: lock/signout/sleep/hibernate) | `admin` (tümü, shutdown/restart dahil). Kayıtsız eski anahtar `admin` sayılır (geriye uyumlu). Yetkisiz uç → `403 FORBIDDEN`.
- **Rotasyon**: anahtar yaşı 90 günü geçerse `getSecurityStatus().rotationDue=true`; UI rotasyonu hatırlatır.
- **İmzalı emirler** (`SignedOrderService`, Ed25519): konsol emri imzalar, ajan doğrular. İmzasız/bozuk/süresi-geçmiş/tekrar (replay) emir reddedilir. Güven kökü (`consolePublicKeyPem`) tanımsızsa fail-closed: tüm emirler red.
