# Power Pilot — Dokümantasyon

Bu klasör Power Pilot'un **güncel** mimarisini, güvenlik sözleşmelerini ve operasyon prosedürlerini tek yerde toplar. Tarihsel planlar, denetim kayıtları ve sürüm notları burada **tutulmaz**; onların yeri [`../CHANGELOG.md`](../CHANGELOG.md)'dir.

> **Tek doğruluk kaynağı:** çalışan kod + testler. Bir belge ile kod çelişirse kod doğrudur ve belge düzeltilmelidir.

## Hızlı Erişim

| Konu | Belge |
|---|---|
| Ürün tanıtımı ve kurulum | [`../README.md`](../README.md) |
| Sürüm geçmişi | [`../CHANGELOG.md`](../CHANGELOG.md) |
| Güvenlik bildirimi | [`../.github/SECURITY.md`](../.github/SECURITY.md) |
| Katkı rehberi | [`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md) |

## Mimari (`architecture/`)

| Belge | Kapsam |
|---|---|
| [`AUTOMATION_ENGINE.md`](architecture/AUTOMATION_ENGINE.md) | Görev yaşam döngüsü, durumlar, çakışma önleme, çalıştırma hattı |
| [`SAFETY_POLICIES.md`](architecture/SAFETY_POLICIES.md) | `SafetyPolicyEngine` kapıları, korunan uygulamalar, güvenli varsayılanlar |
| [`SMART_FINISH.md`](architecture/SMART_FINISH.md) | Koşul motoru ve ölçüm birimleri |
| [`LOCAL_API_SECURITY.md`](architecture/LOCAL_API_SECURITY.md) | Yerel API kimlik doğrulama, IP ACL, TLS |
| [`ENTERPRISE_PILOT.md`](architecture/ENTERPRISE_PILOT.md) | Kurumsal konsol, politika dağıtımı, denetim zinciri |
| [`ACCESSIBILITY.md`](architecture/ACCESSIBILITY.md) | Kontrast, odak, klavye erişilebilirliği kuralları |
| [`KEYBOARD_SHORTCUTS.md`](architecture/KEYBOARD_SHORTCUTS.md) | Kısayol haritası |
| [`WINDOW_AND_VIEWPORT_MATRIX.md`](architecture/WINDOW_AND_VIEWPORT_MATRIX.md) | Pencere boyutu / kırılım matrisi |

## Entegrasyon (`integrations/`, `openapi/`)

- [`integrations/POWERSHELL_AND_CLI.md`](integrations/POWERSHELL_AND_CLI.md) — CLI ve PowerShell kullanımı
- [`integrations/N8N_SETUP.md`](integrations/N8N_SETUP.md) — n8n webhook akışı
- [`openapi/power-pilot-local-api.yaml`](openapi/power-pilot-local-api.yaml) — yerel API sözleşmesi (rota pariteleri testle doğrulanır)

## Sürüm ve imzalama (`release/`)

- [`release/RELEASE_SIGNING.md`](release/RELEASE_SIGNING.md) — imzalama ve doğrulama akışı
- [`release/ASAR-INTEGRITY.md`](release/ASAR-INTEGRITY.md) — ASAR bütünlük kontrolü
- [`release/SBOM.md`](release/SBOM.md) — yazılım malzeme listesi
- `release/release-ed25519.pub.pem` — güncelleme imza açık anahtarı

## Raporlar (`reports/`)

- [`reports/soak.md`](reports/soak.md) / [`reports/soak.json`](reports/soak.json) — konsol yük/soak sonucu
- [`reports/licenses.json`](reports/licenses.json) — bağımlılık lisans özeti

## Operasyon (`runbooks/`)

| Belge | Ne zaman |
|---|---|
| [`incident-response.md`](runbooks/incident-response.md) | Olay müdahalesi |
| [`backup.md`](runbooks/backup.md) | Yedekleme |
| [`db-restore.md`](runbooks/db-restore.md) | Geri yükleme |
| [`key-rotation.md`](runbooks/key-rotation.md) | Anahtar rotasyonu |
| [`rollback.md`](runbooks/rollback.md) | Sürüm geri alma |
| [`tls.md`](runbooks/tls.md) | TLS kurulumu |
| [`tls-renewal.md`](runbooks/tls-renewal.md) | Sertifika yenileme |
| [`console-maintenance.md`](runbooks/console-maintenance.md) | Konsol bakımı |

## Mağaza (`store/`)

- [`store/STORE_CHECKLIST.md`](store/STORE_CHECKLIST.md)
- [`store/AI_DISCLOSURE.md`](store/AI_DISCLOSURE.md)
- [`store/PRIVACY_POLICY.md`](store/PRIVACY_POLICY.md) / [`store/privacy.html`](store/privacy.html)
- [`store/store-listing.json`](store/store-listing.json)

## Dil Desteği

17 dil tam çeviriyle gelir: `tr, en, de, sv, no, da, fr, pl, it, nl, cs, es, pt, ja, zh, ko, ar`.
Çeviri dosyaları `src/renderer/locales/<kod>.json` içindedir; `src/main/locales/<kod>.server.json` bunların birebir üretilmiş kopyasıdır (`npm run build:locales`). Parite `npm run locales:check` ile zorunlu tutulur — eksik/fazla anahtar sürümü durdurur.
