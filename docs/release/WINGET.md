# Windows Package Manager (`winget`) Yayın Rehberi

Power Pilot, Microsoft `winget-pkgs` 1.6.0 çok dosyalı manifest şemasıyla ücretsiz olarak Windows Package Manager üzerinden dağıtılmaya hazırdır.

## 1. Manifest Üretme (SHA-256 Dahil)

Önce NSIS kurulum paketini derleyin, ardından manifest üreticisini çalıştırın:

```powershell
npm run dist:nsis
npm run winget:manifest
```

Bu komut `packaging/winget/manifests/v/Vellium/PowerPilot/<sürüm>/` altında 4 adet geçerli YAML manifest dosyası üretir ve `dist/Power Pilot Setup <sürüm>.exe` dosyasının gerçek `SHA256` özetini `InstallerSha256` alanına yazar.

## 2. Yerel Doğrulama

```powershell
winget validate --manifest packaging\winget\manifests\v\Vellium\PowerPilot\1.0.0
```

## 3. Microsoft `winget-pkgs` Deposuna Gönderim

1. `Power.Pilot.Setup.<sürüm>.exe` dosyasını GitHub Release (`v<sürüm>`) ekine yükleyin.
2. `microsoft/winget-pkgs` reposuna PR açın veya `wingetcreate submit packaging\winget\manifests\v\Vellium\PowerPilot\1.0.0` komutunu çalıştırın.
3. Onay sonrası kullanıcılar tek komutla kurup güncelleyebilir:

```powershell
winget install Vellium.PowerPilot
winget upgrade Vellium.PowerPilot
```
