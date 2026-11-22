# ASAR Integrity - paket regresyonu ve düzeltmesi

## Belirti

Paketlenmiş uygulama açılmıyor, süreç `exit=1` ile kapanıyor ve stderr'de şu satır görünüyor:

```
ASAR Integrity Violation: got a hash mismatch (d53b... vs f8ae...)
```

Bu durumda imza geçerli, fuses doğru, kurulum başarılı görünür; yalnızca uygulama başlamaz.

## Kök neden

`enableEmbeddedAsarIntegrityValidation` fuse'u, `app.asar` başlığının SHA-256 özetini
`Power Pilot.exe` içine gömer. Derleme çıktıları (`dist/`, `dist-*`, test artefaktları)
`app.asar` içine dahil edildiğinde asar içeriği her derlemede değişiyor; gömülen özet
ile son asar eşleşmiyordu. Sonuç: fail-closed olarak uygulama hiç açılmıyor.

## Düzeltme

`package.json` → `build.files` ile derleme/test çıktıları paket dışında tutulur:

```json
"files": [
  "**/*",
  "!dist/**",
  "!dist-*/**",
  "!test-results/**",
  "!playwright-report/**",
  "!blob-report/**",
  "!coverage/**",
  "!scratch/**",
  "!build-sign*.log",
  "!**/*.log"
]
```

## Doğrulama

1. `npm run dist:nsis` sonrası paketlenmiş EXE doğrudan çalıştırılır:
   `dist\win-unpacked\Power Pilot.exe` → pencere açılmalı, stderr boş olmalı.
2. `powershell -File scripts/packaged-e2e.ps1 -Installer "dist\Power Pilot Setup 1.1.0.exe"`
   → temiz kurulum + yükseltme + kaldırma PASS.
3. Regresyon testi: `tests/main/release-1.1.test.mjs` → "paket hijyeni (ASAR integrity)".

## Not

`npm run pack`/`npm run dist:nsis` çıktısını **başka bir klasöre** almaya çalışmak
(`--config.directories.output=...`) tek başına yeterli değildir; `dist/**` hariç
tutulmazsa eski artefaktlar yine asar'a girer. Hariç tutma listesi bu yüzden zorunludur.
