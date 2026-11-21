# Yedekleme ve Geri Yükleme (WP-04.T7)

Power Pilot sırları **asla** `powerpilot_data.json` içinde tutmaz. Sırlar
`secrets.v1.json` dosyasında, Electron `safeStorage` (Windows'ta DPAPI) ile
şifrelenmiş olarak durur. Bu nedenle yedekler iki sınıfa ayrılır:

| Yedek türü | İçerik | Taşınabilir mi? |
|---|---|---|
| Veri dışa aktarımı | görevler, geçmiş, ayarlar (sırlar hariç), şablonlar, denetim | Evet |
| `secrets.v1.json` | şifreli sırlar | **Hayır** — yalnızca aynı Windows kullanıcısı/makinesi çözebilir |

## Dışa aktarma (önerilen)

```powershell
node scripts/export-data.mjs --data-dir "$env:APPDATA\powerpilot" --out "D:\yedek\powerpilot-export.json"
```

Komut şunları çıkarır:

- `consoleAgentKey`, `localApiKeyPem`, `localApiPfxPassphrase`,
  `consoleClientKeyPem`, `consoleClientPfxPassphrase`
- webhook `bearerToken`, `basicAuthPass`, `hmacSecret`
- `cancelPinHash`, `cancelPinSalt`, `localApiKeyHash`, `localApiKeyMasked`,
  `localApiKeyCreatedAt`

Dışa aktarım sırasında kalan sır varsa komut **hata verir ve dosya yazmaz**.

## Geri yükleme

1. Veriyi hedef makinenin userData dizinine kopyalayın (`powerpilot_data.json`).
2. Uygulamayı açın. Sır alanları boş gelir; bu beklenen durumdur.
3. Yeniden provisioning yapın:
   - Konsol ajan anahtarı (`consoleAgentKey`) ve konsol URL'si,
   - TLS sertifika/anahtar dosyaları veya PFX + parola,
   - webhook kimlik bilgileri,
   - iptal PIN'i (Ayarlar → Sıfırlama ve Gizlilik).
4. `node scripts/secure-dir.ps1` ile veri dizini ACL'ini sıkılaştırın.

## Eski (düz metin) yedekler

`backups/` altında sır içeren eski dosyalar açılışta otomatik taranır ve
silinir. Elle denetim:

```powershell
Select-String -Path "$env:APPDATA\powerpilot\backups\*.json" `
  -Pattern 'consoleAgentKey|localApiKeyPem|bearerToken|privateKey'
```

Eşleşme varsa dosyayı silin. Migrasyonu elle tetiklemek için:

```powershell
npx electron scripts/migrate-secrets.mjs --user-data-dir="$env:APPDATA\powerpilot"
```

## Headless ajan

Servis `LocalSystem` olarak çalışıyorsa DPAPI anahtarı makine hesabına bağlıdır.
`secrets.v1.json` yalnızca aynı hesapla çözülebilir. Servis hesabını değiştirmek
sırların yeniden girilmesini gerektirir.
