# TLS Sertifika Yenileme Runbook'u (WP-15.T6)

Bu prosedür, yerel API ve şirket konsolu TLS/mTLS sertifikalarının kesintisiz
yenilenmesini tanımlar. Tek kaynak: `src/main/security/TlsConfig.js`.

## 1. Ön kontrol

- [ ] Yeni sertifika geçerlilik başlangıcı ≤ 24 saat içinde.
- [ ] `subjectAltName` tüm kullanılan IP/DNS adlarını içeriyor.
- [ ] Anahtar ≥ 2048-bit RSA veya Ed25519/P-256; SHA-256 imza.
- [ ] Eski sertifika en az 24 saat daha geçerli (geri alma penceresi).
- [ ] `docs/runbooks/backup.md` adımlarıyla yedek alındı.

## 2. Yeni materyal üretimi

```powershell
# Geliştirme/test CA'sı ile (üretimde HSM/TPM CA kullanın)
# 1) Kök CA (10 yıl) - parmak izini not edin
.\scripts\certs\New-PowerPilotCa.ps1 -OutDir "$env:APPDATA\powerpilot\certs"

# 2) Sunucu sertifikası (varsayılan 90 gün), SAN'a tüm IP/DNS adları verilmeli
.\scripts\certs\New-PowerPilotServerCert.ps1 `
    -CaThumbprint <CA_PARMAR_IZI> `
    -DnsName konsol.sirket.local `
    -IpAddress 10.0.0.5 `
    -OutDir "$env:APPDATA\powerpilot\certs"

# 3) İstemci (ajan) sertifikası (varsayılan 30 gün)
.\scripts\certs\New-PowerPilotClientCert.ps1 `
    -CaThumbprint <CA_PARMAR_IZI> `
    -Subject "CN=powerpilot-agent, O=Power Pilot" `
    -OutDir "$env:APPDATA\powerpilot\certs"
```

Üretimde özel anahtar HSM/TPM'den dışarı çıkmaz; yalnızca sertifika zinciri
ve ortak anahtar dosyaya yazılır.

## 3. Dağıtım sırası

1. Konsol sunucusunda yeni sertifikayı yükleyin (`consoleCertFile`, `consoleKeyFile`).
2. Konsolu yeniden başlatın; `get-security-status` çıktısında `tls: true` doğrulayın.
3. Ajanlarda CA zincirini güncelleyin; **önce bir test ajanı** bağlanmalı.
4. Parmak izi allowlist'ini kademeli açın (`consoleCaFingerprint`).
5. Eski sertifikayı 24 saat sonra kaldırın.

## 4. Doğrulama

```powershell
node -e "const https=require('https');https.get('https://KONSOL:8443/api/v1/health',{rejectUnauthorized:true},r=>{console.log(r.statusCode);r.resume()})"
```

- [ ] TLS 1.2+; zayıf cipher yok.
- [ ] Sertifikasız istemci mTLS gerektiren uçlarda 401 alıyor.
- [ ] Loglarda `CERT_*` hatası yok.

## 5. Geri alma

Eski sertifika dosyalarını geri kopyalayın, konsolu yeniden başlatın. Eski
sertifika süresi dolduysa `docs/runbooks/incident-response.md` devreye girer.
