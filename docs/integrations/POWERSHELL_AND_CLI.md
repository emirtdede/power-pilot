# Power Pilot — CLI ve PowerShell Kullanım Rehberi

Power Pilot, komut satırı ve PowerShell ortamlarından güvenli biçimde kontrol edilebilir.

---

## 1. Environment Variable Tanımlama

Power Pilot istemcileri (CLI, MCP, ajanlar) bağlantı bilgisini **tek bir
sözleşmeden** okur: `src/shared/localApiConnection.js`.

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `POWERPILOT_API_KEY` | — | API anahtarı (zorunlu) |
| `POWERPILOT_API_HOST` | `127.0.0.1` | Yerel API ana bilgisayarı |
| `POWERPILOT_API_PORT` | `18456` | Port |
| `POWERPILOT_API_TLS` | kapalı | `1`/`true` ise `https` |
| `POWERPILOT_API_CA` | — | Özel/self-signed sertifika için CA dosyası yolu |

> **Geriye uyum:** eski `POWER_PILOT_API_*` (alt çizgili) adlar fallback olarak
> hâlâ okunur. Kanonik ad bitişik yazımdır. Arayüz "MCP yapılandırmasını kopyala"
> çıktısı da bu kanonik adları üretir — kopyala-yapıştır yapan kullanıcı 401 almaz.

PowerShell ortamınızda API anahtarınızı tanımlayın:

```powershell
$env:POWERPILOT_API_KEY = "pp_key_sizin_anahtariz"
```

TLS kullanıyorsanız:

```powershell
$env:POWERPILOT_API_TLS = "1"
$env:POWERPILOT_API_CA  = "C:\sertifikalar\powerpilot-ca.pem"
```

---

## 2. PowerShell Örnekleri

### Durum Sorgulama:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:18456/api/v1/status" -Headers @{"X-API-Key"=$env:POWERPILOT_API_KEY}
```

### Zamanlayıcı Kurma (60 Dakika Sonra Shutdown):
```powershell
$body = @{
    name = "PowerShell Timer"
    action = "shutdown"
    durationMs = 3600000
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:18456/api/v1/tasks/timer" -Method Post -Headers @{"X-API-Key"=$env:POWERPILOT_API_KEY} -Body $body -ContentType "application/json"
```

### Ekranı Kilitleme:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:18456/api/v1/power/lock" -Method Post -Headers @{"X-API-Key"=$env:POWERPILOT_API_KEY}
```

### Diğer Anında Güç Eylemleri (signout / restart / sleep / hibernate):
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:18456/api/v1/power/sleep" -Method Post -Headers @{"X-API-Key"=$env:POWERPILOT_API_KEY}
```

### Görev İptali (id ile):
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:18456/api/v1/tasks/task_123/cancel" -Method Post -Headers @{"X-API-Key"=$env:POWERPILOT_API_KEY}
```

---

## 3. CLI Kullanımı (`src/cli/powerpilot.js`)

CLI, yerel API'nin tüm kullanıcı uçlarını kapsar ve **yalnızca** `POWERPILOT_API_KEY`
ortam değişkeni tanımlıysa çalışır (demo anahtarı yoktur).

```bash
export POWERPILOT_API_KEY="pp_key_..."
node src/cli/powerpilot.js --help
```

### Komutlar

| Komut | Ne yapar |
|---|---|
| `status` | Durum, sürüm, aktif görev sayısı |
| `tasks [--limit N] [--offset N]` | Görevleri sayfalı listeler |
| `timer --action <eylem> --durationMs <ms> [--name <ad>]` | Süreli görev kurar |
| `cancel --id <taskId>` | Görevi iptal eder |
| `lock \| signout \| restart \| sleep \| hibernate \| shutdown` | Anında güç eylemi (görev hattından geçer) |
| `audit [--limit N] [--beforeSeq N] [--verify]` | Denetim günlüğü (yalnızca Pro) |
| `audit-verify` | Denetim zinciri bütünlüğü (yalnızca Pro) |
| `inventory` | Cihaz envanteri (yalnızca Pro) |
| `exemptions` | Güvenlik muafiyetleri (yalnızca Pro) |
| `maintenance-windows` | Bakım pencereleri (yalnızca Pro) |
| `orders` | Bekleyen konsol emirleri (yalnızca Pro) |

Genel bayraklar: `--json` (ham JSON), `--help`.

```bash
node src/cli/powerpilot.js timer --action shutdown --durationMs 3600000 --name "Gece kapat"
node src/cli/powerpilot.js tasks --limit 5 --json
node src/cli/powerpilot.js cancel --id task_abc123
```

> Store sürümünde kurumsal uçlar kapalıdır; bu komutlar `503`/`404` yerine
> açıklayıcı hata döndürür. Pro (NSIS) sürümünde tümü etkindir.

---

## 4. Güvenlik Notları

- API varsayılan olarak kapalıdır; **Entegrasyonlar sekmesinden** açın ve anahtar üretin.
- Anahtar başlıkta (`X-API-Key` veya `Authorization: Bearer`) gönderilir, URL'de asla yer almaz.
- Dakikada IP başına 60 istek sınırı vardır (aşımda `429`).
- LAN erişimi yalnızca izinli IP listesinden kabul edilir; liste boşsa yalnız bu bilgisayar bağlanır.
