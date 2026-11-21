# Power Pilot — Mağaza Yayın Kontrol Listesi (WBS-10.2/10.3)

## Otomatik (CI/kod ile doğrulananlar)

- [x] `npm run coverage` kapıları yeşil (satır %80, fonksiyon %70, dal %65)
- [x] `npm run dist:store` gerçek `.appx` üretir (imza hariç); manifest
      `runFullTrust` + `DeviceCapability microphone` + `windows.startupTask`
      içerir (`tests/main/build-appx-gate.test.mjs`).
- [x] OpenAPI parite testi yeşil (`openapi-parity.test.mjs`)
- [x] `asarUnpack: **/*.node` kayıtlı (`build-config.test.mjs`)
- [x] AI kapalıyken beyan metni gizli (uygulama-içi mantık; TS-10.1)
- [x] 17 dilde mağaza metni + gizlilik/support URL'leri
      (`store-listing.test.mjs`)
- [x] Gizlilik politikası belgesi mevcut ve iki dilli
      (`docs/store/PRIVACY_POLICY.md`)
- [x] Mikrofon izni uygulama içinde veriliyor; yalnızca ses, yalnızca kendi
      origin (`tests/main/permissions.test.mjs`)

## Manuel (bu makinede/Partner Center'da yapılır)

- [ ] **WACK:** Windows App Certification Kit ile MSIX test edilir, 0 hata.
  Komut: WACK GUI → paket seç → tüm testler. (CI'da koşmaz: Store
  ilişkilendirmesi + SDK gerektirir.)
- [x] **Mikrofon yetkisi:** `electron-builder.store.cjs` içinde
  `capabilities: ['runFullTrust', 'microphone']`; üretilen manifestte
  `<DeviceCapability Name="microphone"/>` doğrulandı (TS-10.2).
- [ ] **11.16 beyanları:** `AI_DISCLOSURE.md` metinleri açıklamaya + Partner
  Center notuna yapıştırıldı; uygulama-içi Bildir düğmesi test edildi.
- [ ] **İmza:** NSIS için Azure Trusted Signing; Store içi Microsoft imzası
  (MSIX Store'a imzasız verilebilir, Microsoft yeniden imzalar).
  Not: MSIX imzası bu makinede denenemedi — gömülü eski `signtool.exe`
  HTTPS zaman damgasını desteklemiyor ("A required function is not present").
  Paket üretimi ve manifest doğrulaması başarılı; yalnızca imzalama adımı
  gerçek mağaza sertifikası + güncel signtool ile yapılır.
- [ ] **Sürüm:** `1.0.0`, CHANGELOG, 17 dilde Store açıklaması,
  PIN'siz demo modu notu (sertifikasyon 10.3.1).
- [x] **Partner Center URL'leri:** `store-listing.json` içindeki
  `privacyPolicyUrl` / `supportUrl` / `eulaUrl` / `contactUrl` canlı
  doğrulanmış sayfalara bağlandı. Eski `/power-pilot/privacy` ve
  `/power-pilot/support` yolları vellium.dev SPA'sında **yayınlanmadığı**
  için 404 sayfası render ediyordu (başlık: "Bu sayfa burada değil.");
  canlı ölçümle değiştirildi:
  - Gizlilik → `https://vellium.dev/en/legal/privacy` (HTTP 200, 4617 krkt)
  - Destek → `https://vellium.dev/en/legal/support` (HTTP 200, 2180 krkt)
  - EULA → `https://vellium.dev/en/legal/products/power-pilot` (Power Pilot'a özel)
  - İletişim → `https://vellium.dev/en/contact` (Teknik Destek + Gizlilik kanalı)
  Regresyon: `store-listing.test.mjs` → "URL'ler allowlist'teki gerçek
  sayfalara işaret eder (404 dead-link yok)".

## Bilerek Ertelenenler (gerekçeli)

- **Otomatik güncelleme (electron-updater):** Yayın akışı (feed URL)
  kararı olmadan bağlanmadı — feedsiz bağlamak ölü kod olurdu.
  Karar verilince tek adım: `repository.url` + `publish` yapılandırması
  ve `autoUpdater.checkForUpdatesAndNotify()` bağlantısı.
- **Renderer bölme + Electron 43:** Bkz. F11.6 (aşağıda, ayrı faz).
