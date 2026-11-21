# Power Pilot — Güvenlik Politikası Motoru (`SafetyPolicyEngine`)

Power Pilot hiçbir güç işlemini güvenlik kapılarından geçirmeden çalıştırmaz.
Motorun tek giriş noktası `SafetyPolicyEngine.evaluate(task)`'tır ve
`TaskManager` icra hattı her terminal eylemden **önce** buradan geçer.

---

## Kapılar

| # | Kapı | Ayar | Not |
|---|---|---|---|
| 0 | Kill-switch | Konsol ajanı devre-dışı | Açıksa **tüm** eylemler engellenir |
| 1 | Korunan uygulamalar | `protectedApps` (liste) | Kullanıcı düzenler; görevin kendi izlediği süreç muaf |
| 2 | Tam ekran | `protectFullscreen` | Tam ekran uygulama açıkken engellenir |
| 3 | Aktif güç isteği | `protectActiveIo` | `powercfg /requests` — aşağıya bakın |
| 4 | Aktif kullanıcı | `remoteUserActiveCheck` | Uzaktan görevde kullanıcı bilgisayardaysa reddedilir |
| 5 | Bakım penceresi | Konsol politikası | `requiresMaintenanceWindow` görevleri pencere dışında çalışmaz |
| 6 | Muafiyet | `ExemptionService` | Konsol muafiyeti icra **öncesi** değerlendirilir |
| 7 | Sunucu profili | Sunucu profili | Profilde yasak eylem engellenir |
| 8 | Boot Guard | — | Açılıştan sonraki 120 sn içinde boşta tetiklenme engellenir |

### Korunan uygulamalar

- Liste `settings.protectedApps` içinde tutulur, Ayarlar → Güvenlik ekranından
  düzenlenir. Boş/bozuk değerde güvenli varsayılana döner.
- Girdiler `.exe` biçimine ve kanonik ada normalize edilir; yol veya komut
  içeren girdiler sessizce atılır (enjeksiyon yüzeyi yok).
- **Görev muafiyeti:** bir görev `process_running` koşuluyla `steam.exe`'yi
  izliyorsa, `steam.exe` o görev için korunan-listede sayılmaz. Aksi halde
  "Steam kapanınca kapat" görevi kendi kendini engellerdi.
- Varsayılan listede oyun istemcileri (`steam.exe`, `epicgameslauncher.exe`,
  `discord.exe`) **yoktur**; bunlar kullanıcı tercihidir, dayatma değil.

### Aktif güç isteği (yetenek-farkındalıklı)

`powercfg.exe /requests` **yükseltilmiş yetki** gerektirir; paketlenmiş uygulama
`asInvoker` çalışır. Bu yüzden motor açılışta bir **yetenek sondası** yapar:

| Ortam | `powercfg /requests` | Davranış | Sonuç |
|---|---|---|---|
| Yükseltilmiş oturum | Aktif istek var | `POWER_REQUEST_ACTIVE` | Fail-closed |
| Yükseltilmiş oturum | Ölçüm hatası | `POWER_REQUESTS_UNAVAILABLE` | Fail-closed |
| `asInvoker` paket | Yetki hatası | `loadCheck: "unavailable"` ile atlanır | Diğer kapılar etkin |

Atlanan kapı **görünür** biçimde işaretlenir: sonuçta `loadCheck: "unavailable"`,
denetim günlüğünde `power_request_check_unavailable` kaydı ve Ayarlar →
Entegrasyonlar ekranında uyarı. Sessizce "açık" bırakmak yasaktır.
Tanı: `node scripts/safety-probe.mjs` (salt-okunur, hiçbir güç eylemi yürütmez).

---

## Görev-düzeyi politika ile kalıcı ayarın ilişkisi

`AutomationTask` her zaman **tam** bir `safetyPolicy` nesnesi taşır (kayıt
sözleşmesi). Bu yüzden "alan tanımlı mı?" kontrolü kalıcı ayarları gölgelerdi.
Doğru kural `safetyPolicyExplicit` işaretiyle uygulanır:

| Girdi | Explicit kabul edilen alanlar |
|---|---|
| `safetyPolicy` hiç verilmedi | Hiçbiri → kalıcı ayarlar geçerli |
| Kısmi nesne (örn. `{ forceCloseApps: true }`) | Verilen her alan bilinçli tercih |
| Tam nesne (6/6 alan, maddeleştirilmiş varsayılan) | Yalnızca varsayılandan **farklı** alanlar |
| Kalıcı kayıt (`safetyPolicyExplicit` var) | Yalnızca işaretli alanlar |

Karar `AutomationTask.isExplicitPolicy(task, key)` /
`SafetyPolicyEngine.isExplicitPolicy(task, key)` ile verilir.

---

## Davranışsal ayarlar (plasebo değil)

| Ayar | Gerçek davranış |
|---|---|
| `forceCloseApps` | Kapatmayı engelleyen uygulamalar `taskkill /f` ile kapatılır (`PowerService.execute(action, { forceClose })`). Görev düzeyi değer açıkça verilirse o kazanır. |
| `graceSeconds` | Yalnızca `shutdown`/`restart`/`signout` için. Windows `/t n` ile **gerçek** yerel gecikme; bekleme penceresinde iptal `shutdown /a` ile gerçekten durdurulur. Veto doğrulaması gecikme kadar ötelenir. 0–600 sn. |
| `remoteApprovalRequired` | `local_api` / `n8n` / `console` kaynaklı görevler yerel insan onayı ister. Sayaç dolarsa eylem **iptal** edilir (fail-closed). Yerel UI görevleri etkilenmez. |
| `retry_once` yedeği | Gerçek 30 sn bekleme penceresi; bu sırada iptal edilirse tekrar denenmez. |
| `upsAutoActionEnabled` | UPS `LB` + `OB` bildirdiğinde geri sayım sonrası seçilen güç eylemi (`UpsSupervisor`). Normale dönüş iptal eder; `reachable:false` asla eylem üretmez. Varsayılan kapalı. |

---

## Uyarı sayacı = iptal penceresi

Uyarı geri sayımı **iptal penceresidir**: süre dolarsa eylem çalışır (kullanıcı
süre boyunca iptal edebilir). Katı mod isteyen kullanıcı
`warningConfig.requireConfirmation: true` ile süre dolduğunda **iptal**
davranışını seçer. İki mod da testlidir.

---

## Testler

- `tests/main/policy-explicitness.test.mjs` — explicit işaret ve kalıcı ayar önceliği
- `tests/main/safety.test.mjs`, `safety-policy-extra`, `safety-enterprise`, `audit-fixes`
- `tests/main/taskmanager-grace-approval.test.mjs` — grace + uzaktan onay
- `tests/main/ups-supervisor.test.mjs` — UPS durum makinesi
