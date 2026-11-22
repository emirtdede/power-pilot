# Power Pilot - Kurumsal Pilot Kılavuzu (FAZ B, tek şirket)

## Mimari (1 sayfa)

```
[Şirket sunucusu]  node src/console/run.js  (LAN, :8443)
  ├─ Ajan kayıt defteri (heartbeat 60sn, 15dk sessiz = çevrimdışı)
  ├─ Politika dağıtımı → ajan başına imzalı emir kuyruğu (Ed25519)
  └─ Denetim günlüğü (hash zinciri)

[Her PC]  Power Pilot ajanı
  ├─ Outbound heartbeat (envanter) → emirleri ÇEKER (güvenlik duvarı dostu)
  ├─ Emri doğrula → kuyruk (idempotent) → icra (güvenlik+uyarı hattı)
  └─ Muafiyet + bakım-penceresi kapıları icra ÖNCESİ çalışır
```

Konsol ajana ASLA doğrudan bağlanmaz. WoL yalnızca konsolun bildiği MAC'lere,
dalgalı (varsayılan 20'li dalga, 5sn aralık) gönderilir.

## Kurulum (IT yöneticisi, ~15dk)

1. Sunucuda: `CONSOLE_ADMIN_KEY`, `CONSOLE_AGENT_KEY` üretin
   (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`),
   ortam değişkeni yapıp `node src/console/run.js` ile başlatın.
2. `GET /api/v1/console-key` (admin) → `publicKey`'i alın.
3. Her PC'de Power Pilot **Ayarlar → Entegrasyonlar → Kurumsal Konsol**: URL (`http://srv:8443`),
   `consolePublicKeyPem` (konsol anahtarı) + `consoleAgentKey` (ajan heartbeat
   sırrı - ham değer yalnızca ajanda durur, konsolda hash'i tutulur).
   (Denetim notu: ajan sırrı sunmak zorunda olduğundan ham tutulur;
   sızıntıda konsolda anahtar döndürülür, ajan etkilenmez.)
4. Ajan 60sn içinde heartbeat atar; `GET /api/v1/agents` ile görün.

## Politika dağıtımı (3 şablon)

| Politika | Emir | Ajan davranışı |
|---|---|---|
| `nightly-shutdown` (19:30, hafta-içi) | `apply-policy` | Yinelenen kapatma görevi; 60sn uyarı + 1 erteleme |
| `pre-patch-wake` (03:00) | `wake` (dalgalı) | Konsol WoL gönderir; MACsiz hedef raporda "atlandı" |
| `idle-lock` (10dk) | `apply-policy` | Koşul-izleme kilit görevi |

Muafiyet: `POST /api/v1/exemptions` (**yalnızca admin anahtarı**;
operator 403 alır). Muaf cihazın engellemesi denetimde
`blocked_by_policy: Muafiyet devrede (...)` olarak görünür.

## Rol matrisi

| Rol | Okuma | Politika dağıt/emir | Muafiyet ver/sil | Politika sil |
|---|---|---|---|---|
| viewer | ✅ | ❌ | ❌ | ❌ |
| operator | ✅ | ✅ | ❌ | ❌ |
| admin | ✅ | ✅ | ✅ | ✅ |

## Pilot koşusu (2-3 hafta)

1. Hafta: 10 PC, yalnızca `idle-lock` → şikâyet dinle.
2. Hafta: + `nightly-shutdown` (1 muaf PC ile) → muafiyet kanıtını logdan al.
3. Hafta: tüm filo + `pre-patch-wake` öncesi WoL-readiness raporu
   (`sleepStates.standbyS0` olanlara hazırda-beklet öner).

## Bilinen sınırlar (FAZ B)

- Konsol HTTP'dir (LAN içi); internete açılacaksa ters-vekil + TLS şart.
- Politika silme ajandaki kurulu görevi `revoke-policy` ile iptal eder;
   zaten ÇALIŞMIŞ görev geri alınamaz.

## FAZ C - Ağ gerçekleri (tamamlandı)

- Her ajan `wolReadiness` raporlar: `ready` / `degraded` / `blocked` (S0-hibernate-yok)
  / `unknown` + gerekçe + öneri. `GET /api/v1/subnets` her alt-ağı
  `ready` (röle var) / `no-relay` (röle yok) sınıflandırır.
- WoL **çevrimiçi röle** üzerinden gider (`relay-wake`, yönlendirilmiş broadcast);
  hedefe doğrudan kuyruklanmaz (hedef kapalı olabilir). Röle yoksa ve hedef
  konsolla aynı alt-ağdaysa konsol doğrudan gönderir, yoksa hedef
  `röle-yok` diye raporda kalır, yama penceresi uyanık-makinelerle planlanır.
- Dalgalandırma korunur (20'li dalga / 5sn aralık, `notBefore`).

## FAZ D - Sunucu profili + UPS + dürüst enerji (tamamlandı)
- `deviceRole: server` olan cihaza konsoldan `sleep`/`hibernate`/`shutdown`
  **yasak** (403 değil, icra-öncesi `blocked_by_policy` + denetim).
  `restart` yalnızca `requiresMaintenanceWindow` + bakım penceresi içinde.
- `rolling-restart` politikası: sunucular tek-tek; sıradaki, önceki taze
  `bootAt` ile dönmeden başlamaz. Zaman-aşımı (varsayılan 15dk) atlanır,
  kuyruk tıkanmaz.
- UPS: NUT-uyumlu `upsd`'ye salt-okunur protokol istemcisi (GPL kod yok).
  Ayar: `upsEnabled` + `upsHost` + `upsName`. `OB`/`LB` konsol rozeti olur.
- Enerji: `2.5h` sabiti KALDIRILDI. Kapanış→sonraki-açılış = gerçek süre;
  eşleşmeyen kapanış beyanlı `assumedOffHours` ile damgalı tahmin, beyan
  yoksa sayı uydurulmaz (`missing: [offhours]`, arayüz "-" gösterir).
- GPO: ajan `ScreenSaveTimeOut` + GPO-zorunluluğunu raporlar; GPO kilit
  süresi politika `idleMinutes`'ten kısaysa konsol "GPO ile çakışıyor" rozeti
  gösterir (çakışmada GPO kazanır).
- KVKK: konsola giden gerekçelerde ham `*.exe` adı taşınmaz
  (`sanitizeForConsole` → `korunan-uygulama`); tam ad yalnızca yerel logda.
  Aydınlatma metni şablonu pilot sözleşmesine eklenir.
- EDR: ajan `shutdown /s`, `rundll32 LockWorkStation` çağırır - pilot öncesi
  Defender/SentinelOne allowlist dokümanı IT'ye verilir; ikili kod-imzalı
  dağıtılır.
- Fiyat (pilot sonrası): cihaz-başı/ay + on-prem bakım; pilot tek-fiyat,
  mimariyi kilitlemez.

## Denetim turu ekleri (kusursuzluk denetimi sonrası)

- **Headless servis:** `node src/agent/headless.js [veri-dizini]` Electron'sız
  aynı yığını koşar; `scripts/install-service.ps1 -Install` NSSM ile Windows
  Servisi kurar (SYSTEM, otomatik başlatma). Serviste scheduler-yedeği yok
  (schtasks GUI bağlamı ister) - birincil 1sn döngüsü + konsol emirleri çalışır.
- **Kill-switch:** `POST /api/v1/agents/:id/disable` (yalnızca admin) ajanı
  uzaktan durdurur - ajan emir almaz, icra yapmaz, güvenlik motoru TÜM
  kaynakları engeller; heartbeat sürer, `enable` ile geri açılır.
- **Makbuz döngüsü:** icra sonuçları sonraki heartbeat ile konsola döner;
  konsol denetimine `order_receipt` işlenir. Teslim+icra+makbuz kapalı-döngüdür.
- **GPO rozeti:** `GET /api/v1/agents/gpo-conflicts?idleMinutes=10` GPO-zorunlu
  kilit süresi politikadan kısa olanları listeler (çakışmada GPO kazanır).
- **TLS sıkı kip:** `localApiTlsStrict=true` el sıkışmasında doğrular
  (`rejectUnauthorized`); pilot CA kurulumu bitmeden gevşek kip + 401 kullanılır.
- **Açık işler (müşteri-sahası gerektirir):** AD/LDAP salt-okunur bağlayıcı
  (pilot haftası, müşteri diziniyle), ajan konsol-eşleştirme ayar arayüzü
  (şu an ayar dosyası + LocalAPI; preload köprüsü hazır).
