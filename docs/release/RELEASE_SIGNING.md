# Power Pilot - Windows İmzalama ve Dağıtım Prosedürü (1.1.0)

## 1. Hedef

- Varsayılan dağıtım: NSIS kurulum paketi (`Power Pilot Setup 1.1.0.exe`).
- APPX yalnızca publisher sertifikası `APPX_PUBLISHER` ile birebir eşleşiyorsa üretilir.
- İmzalı sürüm zorunludur; imzasız build yalnızca iç test içindir.

## 2. Sertifika ve Anahtar Saklama

| Girdi | Açıklama | Zorunlu |
| --- | --- | --- |
| `WIN_CERT_SUBJECT` | Windows sertifika deposundaki sertifikanın Subject DN'i (HSM/TPM destekli) | İmzalı build |
| `WIN_CERT_SHA1` | (Opsiyonel) sertifika parmak izi; çoklu sertifikada seçim | Hayır |
| `PP_SBOM_SIGNING_KEY` | Çevrimdışı Ed25519 release anahtarı dosyası | Release manifesti |

**PFX/`.p12` ve `CSC_LINK`/`CSC_KEY_PASSWORD` CI secret'ı olarak kabul edilmez.**
Özel anahtar HSM/TPM'den dışarı çıkmaz. `package.json` sabit alanları taşır;
`electron-builder.config.cjs` yalnızca `WIN_CERT_SUBJECT` ortam değişkenini
`certificateSubjectName` alanına çözer. Ortam değişkeni yoksa yerel `pack`
imzasız üretilir; release CI'da değişken zorunludur. SHA-256 +
`https://timestamp.digicert.com` kullanılır.

> **Neden `.cjs`?** Dosya adı `electron-builder.js` iken Windows `cmd`, `PATH`
> aramasından önce çalışma dizinindeki bu dosyayı `.js` uzantısıyla çalıştırıyordu;
> `npm run pack` gerçek CLI yerine yapılandırma dosyasını çalıştırıp **0 koduyla
> hiç derleme yapmıyordu**. `.cjs` uzantısı bu gölgelemeyi kaldırır.

### 2.1 Yerel (bütçesiz) imzalama - kendinden imzalı sertifika

Üretimde HSM/TPM zorunludur. Bütçe yoksa yerel/şirket içi dağıtım için
kendinden imzalı sertifika ile imzalanabilir:

```powershell
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object Subject -eq 'CN=Vellium'
$env:WIN_CERT_SHA1 = $cert.Thumbprint
# electron-builder'in getirdigi signtool HTTPS /tr desteklemez
$env:WIN_TIMESTAMP_URL = "http://timestamp.digicert.com"
npm run dist:nsis
npm run verify:signature
```

- `WIN_CERT_SUBJECT` yerine `WIN_CERT_SHA1` kullanın: aynı Subject'e sahip birden
  fazla sertifika varsa seçim belirsizleşir (signtool "No certificates were found" verir).
- Uyarının kullanıcıda kaybolması için sertifika, Güvenilen Kök Sertifikalar
  deposuna eklenmelidir (GPO/Intune). Halka açık dağıtımda bunun yerine
  Microsoft Store yolu kullanılır (bkz. `docs/planning/YAPILACAKLAR.md`).
- `WIN_TIMESTAMP_URL` yalnızca eski signtool içindir; CI'da yeni signtool ile
  varsayılan HTTPS adresi kullanılır.

## 3. Adımlar

| Adım | Komut | Beklenen |
| --- | --- | --- |
| 1 | `npm ci` | Kilitli bağımlılıklar (Electron 43.4.0, Node 24.18.1) |
| 2 | `npm test && npm run coverage` | Tüm testler + kapsam eşikleri |
| 3 | `npm run locales:check && npm run models:verify` | 17 dil paritesi ve model pinleri |
| 4 | `npm run test:security` | Statik güvenlik taraması temiz |
| 5 | `npm run release:check` | Hijyen kapısı (fuses, timestamp, sürüm) |
| 6 | `npm run pack && npm run verify:pack && npm run spike:pslist` | ASAR + fuses + paketli `ps-list` |
| 7 | `npm run test:e2e` | Electron smoke + i18n/görev akışı |
| 8 | `npm run test:load` | 100 ajan yük/soak raporu |
| 9 | `npm run dist:nsis` | `dist/Power Pilot Setup 1.1.0.exe` |
| 10 | `npm run verify:signature` | `signtool verify /pa /all` + RFC 3161 timestamp |
| 11 | `npm run sbom -- --require-signature` | CycloneDX SBOM + imzalı release manifesti |
| 12 | `powershell -File scripts/packaged-e2e.ps1 -Installer ...` | Temiz kurulum/yükseltme/kaldırma |
| 13 | `npm run release:check -- --strict-git` | Temiz ağaç |
| 14 | `git tag -s v1.1.0` | İmzalı etiket |

NSIS assisted installer kullanır (`oneClick=false`) ve kurulum dizini
değiştirilebilir. Varsayılan dağıtım yalnızca NSIS'tir; APPX koşulludur.

## 4. İmzasız İç Build

```powershell
$env:WIN_CERT_SUBJECT = $null
npm run pack
```

Bu çıktı yalnızca iç kullanım içindir; dağıtılmaz. İç artefakt için bile
SHA-256 kaydı tutulur; ancak `NotSigned` durumu "yayınlandı" sayılmaz.

## 5. Doğrulama ve Kanıt

```powershell
powershell -NoProfile -File scripts/verify-signature.ps1 "dist\Power Pilot Setup 1.1.0.exe"
```

Kabul:

- `signtool verify /pa /all` başarılı.
- `Get-AuthenticodeSignature`: `Status=Valid` ve `TimeStamperCertificate` mevcut.
- SHA-256, `dist/release-manifest.json` içindeki artefakt hash'iyle aynı.
- SBOM ve manifest imzası çevrimdışı release anahtarıyla doğrulanabilir.

## 6. Geri Alma

- Bozuk kurulum: önceki imzalı NSIS paketini yeniden çalıştırın.
- Kullanıcı verisi `%APPDATA%\powerpilot` altındadır; DB geri dönüşü için
  `docs/runbooks/db-restore.md`.
- Sertifika/imza hatasında tag atılmaz; imzasız build yalnızca iç artefakt kalır.
