# Power Pilot — Otomasyon Motoru (`TaskManager`)

`TaskManager` eşzamanlı görevleri, zamanlamaları, Smart Finish koşullarını ve
güvenlik politikalarını yöneten çekirdek modüldür. 1 saniyelik tik döngüsü
görevleri değerlendirir; ağır işler (dizin taraması vb.) döngü dışında
hazırlanır.

---

## Görev Yaşam Döngüsü

| Durum | Anlamı |
|---|---|
| `draft` | Taslak; değerlendirilmez |
| `scheduled` | Zamanı gelmesini bekliyor |
| `monitoring` | Smart Finish koşulları izleniyor |
| `waiting` | Ek koşul/gecikme bekleniyor |
| `warning` | Geri sayım uyarısı gösteriliyor (iptal penceresi) |
| `snoozed` | Kullanıcı erteledi; süre sonunda geri döner |
| `executing` | Güç eylemi çalışıyor |
| `completed` | Başarıyla tamamlandı |
| `blocked` | Güvenlik kapısı veya çakışma engelledi |
| `failed` | OS/izin hatası |
| `cancelled` | Kullanıcı veya onay yokluğu nedeniyle iptal |
| `expired` | Uyku/çevrimdışı sırasında zamanı geçti |
| `disabled` | Kullanıcı kapattı |

Her sonuç `EXECUTION_RESULT_CODE` ile kaydedilir (`success`,
`blocked_by_policy`, `condition_invalid`, `os_execution_failed`,
`authorization_error` …) ve Geçmiş ekranında nedeniyle listelenir.

---

## İcra Hattı (tek yol)

```
tik → koşul değerlendir → uyarı/onay → güvenlik kapıları → güç eylemi → doğrulama → sonuç
```

1. **Koşul/Smart Finish** — `SmartFinishEngine` kararlılık süresiyle onaylar.
2. **Uyarı** — `WarningManager` geri sayımı gösterir. Bu süre **iptal
   penceresidir**: dolarsa eylem çalışır. `requireConfirmation: true` ise
   dolarsa iptal (katı mod).
3. **Güvenlik** — `SafetyPolicyEngine.evaluate()`; ayrıntı:
   [`SAFETY_POLICIES.md`](SAFETY_POLICIES.md).
4. **İcra** — `PowerService.execute(action, { forceClose, graceSeconds })`.
   Terminal eylemlerde `shutdown /t n` ile gerçek yerel gecikme uygulanır.
5. **Doğrulama** — `TerminalActionVerifier` eylemin gerçekten gerçekleştiğini
   doğrular; süreç hâlâ ayaktaysa "kapatma engellendi" raporu üretilir
   (sessiz başarı yok). Gecikme varsa doğrulama penceresi o kadar ötelenir.
6. **Sonuç** — Geçmiş + denetim zinciri + webhook.

---

## Ayarların gerçek karşılığı

| Ayar | Çözümleyici | Davranış |
|---|---|---|
| `forceCloseApps` | `resolveForceClose` | `/f` ile kapatma |
| `graceSeconds` | `resolveGraceSeconds` | `/t n` + `shutdown /a` iptali, 0–600 sn |
| `remoteApprovalRequired` | `resolveRemoteApproval` | Uzak kaynakta yerel onay; yoksa iptal |
| `upsAutoActionEnabled` | `UpsSupervisor` | UPS `LB`+`OB` → geri sayım → eylem |
| `prewarnSeconds` | `createTask` | Yeni görevlere varsayılan uyarı süresi |

Görev düzeyi değer, kalıcı ayarı **yalnızca açıkça verildiyse** ezer
(`AutomationTask.isExplicitPolicy`).

---

## Çakışma Önleme

Aynı anda birden çok güç eylemi tetiklenirse ilk talep eden görev kazanır;
diğerleri `blocked` olur ve nedeniyle kaydedilir. Bu, iki kapatmanın üst üste
binmesini ve doğrulama pencerelerinin karışmasını önler.

## Yeniden başlatma / uyku sonrası

Açılışta `TaskManager` kalıcı görevleri geri yükler. Uyku sırasında zamanı
geçen görevler `wakeMode` ayarına göre çalıştırılır veya atlanır; atlananlar
Geçmiş'te nedeniyle görünür (sessiz kayıp yok).

## Zincir görevler

`chain` dizisi ile icra sonrası yeni görev kurulabilir; kaynak/mode/güvenlik
politikası miras alınır, uyarı sayacı sıfırlanır.
