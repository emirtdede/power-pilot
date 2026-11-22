# Anahtar Rotasyon Kaydı

Bu dosya `docs/runbooks/key-rotation.md` §5 tarafından istenen denetim kaydıdır.
Her rotasyonda yeni bir satır ekleyin. Sırların **kendisini** buraya yazmayın;
yalnızca `keyId`, tarih ve dağıtım bilgisini kaydedin.

| Tarih | Kapsam | Eski `keyId` | Yeni `keyId` | Ajanlara dağıtım | Geri alma penceresi (24 saat) | Denetim kaydı |
|---|---|---|---|---|---|---|
| - | - | - | - | - | - | - |

## Sütunlar

- **Kapsam:** `console-signing`, `agent-api`, `local-api`, `backup` veya `sbom`.
- **Eski / Yeni `keyId`:** Örn. `default` → `default-2`.
- **Ajanlara dağıtım:** Yeni ortak anahtarın tüm ajanlara ulaştığı zaman
  (rotasyondan **önce** olmalıdır).
- **Geri alma penceresi:** Eski `keyId` allowlist'ten çıkarılmadan önceki 24
  saatlik süre. Pencere kapanmadan eski anahtar silinmez.
- **Denetim kaydı:** İlgili denetim zinciri kaydı (ör. `api_key_generated`).
