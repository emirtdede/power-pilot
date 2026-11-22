# Power Pilot - Smart Finish (Koşul Motoru)

Smart Finish, güç eylemini yalnızca süreye bağlı çalıştırmaz; bilgisayardaki
gerçek işin bittiğini ölçer. `SmartFinishEngine` koşulları **AND/OR** mantığıyla
değerlendirir ve yanlış erken kapatmayı önlemek için **kararlılık süresi**
uygular.

---

## Kararlılık Süresi

Koşul ilk kez sağlandığında görev hemen çalışmaz: `stabilitySeconds`
(varsayılan 15 sn) boyunca koşulun **doğru kalması** gerekir. Anlık düşüşler
(CPU'nun 1 saniyeliğine %5'e inmesi) erken kapatmaya yol açmaz. Koşul bozulursa
sayaç sıfırlanır.

---

## Desteklenen koşullar

| Tip | Parametre | Anlamı |
|---|---|---|
| `process_running` | `processName` | Süreç kapandığında sağlanır |
| `cpu_usage` | `thresholdPercent` (vars. 10) | CPU eşiğin altına indiğinde |
| `user_idle` | `idleSeconds` | Klavye/fare hareketsizken |
| `network_speed` | `thresholdKbps` (vars. 50) | Ağ trafiği eşiğin altına indiğinde |
| `disk_activity` | `thresholdKbps` (vars. 100) veya `thresholdIops` | Disk etkinliği eşiğin altına indiğinde |
| `file_stable` | `filePath`, `stableSeconds` | Dosya boyutu/mtime sabitlendiğinde |
| `directory_idle` | `dirPath`, `stableSeconds` | Klasördeki değişiklik durduğunda |
| `battery_level` | `belowPercent` / `abovePercent` | Pil eşiğe ulaştığında |

Desteklenmeyen bir koşul tipi `createTask`'ta **reddedilir**
(`UNSUPPORTED_CONDITION`); sessiz "bilinmeyen koşul" akışı yoktur. Eski
`file_stable` klasör görevleri otomatik olarak `directory_idle`'a çevrilir
(klasör mtime'ı indirme sırasında sabit kalabildiği için yanlış erken kapanma
üretiyordu).

---

## Birim doğruluğu: `disk_activity`

Ölçülen değer `si.fsStats()` üzerinden **KB/s**'dir (`diskKbps`).

- Şablonlar `thresholdKbps` gönderir → KB/sn karşılaştırılır.
- Smart Finish formunda **Ölçü Birimi** seçicisi vardır: `Kbps (verim)` veya
  `IOPS (işlem/sn)`. IOPS seçilirse koşul `thresholdIops` olarak yazılır ve
  motor IOPS yoluyla değerlendirir. Böylece motorun iki birimi de arayüzden
  üretilebilir (belgelenmiş ama ulaşılamaz bir yetenek bırakılmaz).
- `thresholdKbps`, `thresholdIops`, `stableSeconds`, `maxDepth` ve
  `maxEntries` `validate.js`'te aralık denetiminden geçer.
- Ölçüm yapılamıyorsa sonuç **fail-closed**: `satisfied: false`. "Ölçemedim,
  öyleyse bitti" varsayımı yapılmaz.

Aynı kural `network_speed` ve `cpu_usage` için de geçerlidir.

---

## Dizin taraması döngüyü bloklamaz

`scanDirectory` senkron sözleşmesini doğrudan çağıranlar için korur; motor
`scanDirectoryAsync` (`fs.promises`) kullanır. `TaskManager` her tikte
`SmartFinishEngine.prefetchDirectoryScans(tasks)` çağırır; sonuç önbelleğe
alınır ve değerlendirme aşamasında anında okunur. Böylece 1 saniyelik tik
döngüsü büyük klasörlerde bile bloklanmaz.

---

## Testler

- `tests/main/smartfinish.test.mjs`
- `tests/main/smartfinish-engine-core.test.mjs`
- `tests/main/release-hardening.test.mjs`
