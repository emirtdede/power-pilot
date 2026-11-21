# Power Pilot — n8n Entegrasyon ve Bağlantı Rehberi

Bu belge, Power Pilot uygulamasını kendi bilgisayarınızda çalışan **n8n** otomasyon platformuna nasıl bağlayacağınızı adım adım anlatır.

---

## 1. Güvenlik Prensipleri
- Power Pilot ile n8n arasındaki tüm iletişim **doğrudan yerel ağınızda (`127.0.0.1`)** gerçekleşir.
- Hiçbir veri Vellium veya üçüncü taraf bulut sunucularına aktarılmaz.

---

## 2. Kurulum Adımları

1. **Yerel API'yi Etkinleştirin**:
   - Power Pilot **Ayarlar → Entegrasyonlar → Yerel REST API** bölümüne gidin.
   - "Yerel API" anahtarını açın.
   - "Yeni API Anahtarı Oluştur" butonuna basın.
   - Üretilen `pp_key_...` anahtarını kopyalayın (Bu anahtar sadece bir kez gösterilir).

2. **n8n Workflow İçe Aktarın**:
   - `integrations/n8n/workflows/telegram_create_timer.json` dosyasını n8n arayüzüne sürükleyip bırakın.

3. **API Anahtarını n8n'e Ekleyin**:
   - HTTP Request düğümünü açın.
   - Header alanındaki `X-API-Key` değerine kopyaladığınız anahtarı yazın.
   - Base URL alanına `http://127.0.0.1:18456` yazın.

4. **Test Etme**:
    - Telegram'dan veya n8n Test workflow butonundan komutu çalıştırarak Power Pilot üzerinde görevin oluştuğunu doğrulayın.

---

## 3. Kullanılabilir Uç Noktalar (Özet)

- `GET /api/v1/status` — durum ve aktif görev sayısı
- `GET /api/v1/tasks` — görev listesi
- `POST /api/v1/tasks/timer` — hızlı zamanlayıcı (`action` + `durationMs`)
- `POST /api/v1/tasks/{id}/cancel` — görev iptali
- `POST /api/v1/power/{lock,signout,restart,sleep,hibernate}` — anında eylem
- `POST /api/v1/power/shutdown` — 5sn gecikmeli güvenli kapatma

Tam şema: `docs/openapi/power-pilot-local-api.yaml`. Webhook (giden) bildirimleri uygulama içinden **Entegrasyonlar > Webhook Bildirimleri** kartından yapılandırılır.
