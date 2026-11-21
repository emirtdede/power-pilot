# Power Pilot — Privacy Policy / Gizlilik Politikası

**Last updated / Son güncelleme:** 2026-11-17
**Applies to / Geçerli olduğu sürüm:** Power Pilot 1.0.0 (Microsoft Store / MSIX) and
Power Pilot Pro (NSIS)
**Contact / İletişim:** privacy@vellium.dev

---

## English

### Summary

Power Pilot is **local-first**. It does not collect telemetry, usage statistics,
crash reports, or analytics. Your tasks, settings, history, and voice commands
stay on your computer unless **you** explicitly export them.

### What we collect

**Nothing.** Power Pilot does not operate a backend service and does not send
usage data, diagnostics, or crash reports. There is no account, no sign-in, and
no advertising or tracking SDK bundled in the app.

### Data stored on your device

All of the following is stored locally, in `%LOCALAPPDATA%\Power Pilot`:

| Data | Purpose | Retention |
|---|---|---|
| Tasks and schedules | Execute your power actions | Until you delete them |
| Settings and preferences | Remember your choices | Until you change or delete them |
| Execution history | Show "why didn't it run?" and health summary | Last 500 records, then rotated |
| Audit log (HMAC-chained) | Security integrity of destructive actions | Until you delete it |
| PIN (Argon2id hash) | Protect security settings | Until you remove it |
| API keys / secrets (DPAPI-encrypted) | Local API and webhooks, if you enable them | Until you revoke them |
| Optional AI models (Qwen / Whisper) | On-device voice and text understanding | Until you delete them |

You can erase all of it at any time with **Settings → Privacy → Delete my data**.
Uninstalling the app does not automatically remove this folder, so use that
button first if you want a clean removal.

### Microphone

Voice commands are **optional**. When you press the microphone button, the app
records audio locally, transcribes it with the on-device Whisper model, and
discards the audio. **Audio is never uploaded.** The microphone is only used
while the button is active, and Windows shows its own microphone indicator.

### On-device AI

The optional AI assistant (text and voice) runs entirely on your computer using
models you download explicitly. Commands and audio are processed locally and are
not sent to any server. Models are verified by SHA-256 after download.

### Network access

Power Pilot works fully offline. Network is used only when **you** enable a
feature that requires it:

- **Local REST API** (Enterprise edition): listens on `127.0.0.1` by default;
  LAN exposure requires explicit opt-in. Requests stay on your network.
- **Webhooks**: only to URLs you configure (HTTPS required).
- **Model downloads**: only when you ask the app to download an AI model.
- **Wake-on-LAN**: sends a magic packet on your own network.

### Third parties

We do not share data with third parties because we do not receive any.
The Microsoft Store processes the download/install transaction; Microsoft's own
privacy statement applies to that transaction.

### Children

Power Pilot is a system utility and is not directed at children.

### Changes

If this policy changes, the updated version is published with the app release.

### Contact

Questions: **privacy@vellium.dev**

---

## Türkçe

### Özet

Power Pilot **yerel önceliklidir**. Telemetri, kullanım istatistiği, çökme
raporu veya analitik toplamaz. Görevleriniz, ayarlarınız, geçmişiniz ve sesli
komutlarınız, **siz** açıkça dışa aktarmadıkça bilgisayarınızda kalır.

### Ne topluyoruz

**Hiçbir şey.** Power Pilot bir arka uç servisi işletmez; kullanım verisi,
tanılama veya çökme raporu göndermez. Hesap, oturum açma, reklam veya izleme
SDK'sı yoktur.

### Cihazınızda saklanan veriler

Aşağıdakilerin tamamı `%LOCALAPPDATA%\Power Pilot` altında **yerel** olarak
saklanır:

| Veri | Amaç | Saklama |
|---|---|---|
| Görevler ve programlar | Güç eylemlerinizi yürütmek | Siz silene kadar |
| Ayarlar ve tercihler | Seçimlerinizi hatırlamak | Değiştirene/silene kadar |
| Yürütme geçmişi | "Neden çalışmadı?" ve sağlık özeti | Son 500 kayıt, sonra döner |
| Denetim günlüğü (HMAC zincirli) | Yıkıcı eylemlerin güvenlik bütünlüğü | Siz silene kadar |
| PIN (Argon2id özeti) | Güvenlik ayarlarını korumak | Kaldırana kadar |
| API anahtarları / sırlar (DPAPI şifreli) | Yerel API ve webhook'lar (açarsanız) | İptal edene kadar |
| Opsiyonel AI modelleri (Qwen / Whisper) | Cihazda ses/metin anlama | Silene kadar |

Tamamını istediğiniz an **Ayarlar → Sıfırlama ve Gizlilik → Verilerimi sil** ile
silebilirsiniz. Uygulamayı kaldırmak bu klasörü otomatik silmez; temiz kaldırma
için önce bu düğmeyi kullanın.

### Mikrofon

Sesli komutlar **opsiyoneldir**. Mikrofon düğmesine bastığınızda uygulama sesi
yerelde kaydeder, cihazdaki Whisper modeliyle yazıya çevirir ve sesi siler.
**Ses hiçbir zaman yüklenmez.** Mikrofon yalnızca düğme etkinken kullanılır ve
Windows kendi mikrofon göstergesini gösterir.

### Cihazdaki yapay zekâ

Opsiyonel AI asistanı (metin ve ses) tamamen bilgisayarınızda, açıkça
indirdiğiniz modellerle çalışır. Komutlar ve ses yerelde işlenir, hiçbir sunucuya
gönderilmez. Modeller indirme sonrası SHA-256 ile doğrulanır.

### Ağ erişimi

Power Pilot tamamen çevrimdışı çalışır. Ağ yalnızca **siz** gerektiren bir
özelliği açtığınızda kullanılır:

- **Yerel REST API** (Enterprise): varsayılan olarak `127.0.0.1` dinler; LAN'a
  açılması açık onay gerektirir. İstekler ağınızda kalır.
- **Webhook'lar**: yalnızca sizin yapılandırdığınız adreslere (HTTPS zorunlu).
- **Model indirme**: yalnızca bir AI modeli indirmek istediğinizde.
- **Wake-on-LAN**: kendi ağınızda sihirli paket gönderir.

### Üçüncü taraflar

Veri paylaşmıyoruz çünkü hiç veri almıyoruz. İndirme/kurulum işlemini Microsoft
Store yürütür; o işlem için Microsoft'un gizlilik bildirimi geçerlidir.

### Çocuklar

Power Pilot bir sistem aracıdır ve çocuklara yönelik değildir.

### Değişiklikler

Politika değişirse güncel sürüm uygulama sürümüyle birlikte yayımlanır.

### İletişim

Sorular: **privacy@vellium.dev**
