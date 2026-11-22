# Erişilebilirlik Beyanı ve Mimari Sözleşmesi (WCAG 2.2 AA)

Power Pilot v1.3.1, **WCAG 2.2 Düzey AA** masaüstü uygulama erişilebilirlik kriterlerini hedefleyerek geliştirilmiş ve otomatik E2E + statik kapılarla kilitlenmiştir.

---

## 1. Kapsanan WCAG 2.2 AA Kriterleri

| Kriter | Başlık | Uygulama Özeti | Doğrulama Testi |
|---|---|---|---|
| **1.3.1** | Bilgi ve İlişkiler | Landmark etiketleri (`header`, `nav`, `main`, `footer`), `<dl>/<dt>/<dd>` istatistik kartları, `<select>` için `aria-labelledby` + `aria-describedby`. | `nav-keyboard.spec.js`, `settings-controls.spec.js` |
| **1.4.3** | Kontrast (Asgari) | Açık ve koyu temada tüm metinler ≥ 4,5:1 (`#btn-cancel` `bg-red-600` 4,83:1; `#stat-kwh` `text-green-700` / `dark:text-green-400` ≥ 5,02:1). | `contrast-a11y.test.mjs`, `settings-controls.spec.js` |
| **1.4.10** | Yeniden Akış (Reflow) | 720×520'den 3440×1440'a ve %200 ölçeklemeye kadar 11 görünümde sıfır yatay taşma. | `overlay-geometry.spec.js`, `responsive.spec.js` |
| **1.4.11** | Metin Dışı Kontrast | Saat ayırıcıları ve anlamlı chevron ikonları `.pp-sep` (`--pp-sep`) ile her iki temada ≥ 3,0:1. | `settings-controls.spec.js` |
| **1.4.13** | Üzerine Gelinen/Odaklanan İçerik | Toast bildirimleri fare üzerine geldiğinde veya odaklandığında geri sayımı duraklatır ve 24×24 kapatma düğmesi sunar. | `overlay-geometry.spec.js` |
| **2.1.1 / 2.1.2** | Klavye / Klavye Tuzağı Yok | 11 navigasyon düğmesi, 3 ayar anahtarı, tüm formlar ve mini widget klavyeyle tam erişilebilir; modal ve çekmece odak tuzakları `Escape` ile çıkar. | `nav-keyboard.spec.js`, `mini-widget.spec.js`, `modal-a11y.test.mjs` |
| **2.3.3** | Etkileşimden Kaynaklanan Animasyon | `prefers-reduced-motion: reduce` etkinleştirildiğinde tüm geçiş ve animasyon süreleri `0.001ms` / `none` değerine iner. | `app.css` |
| **2.4.1** | Blokları Atlama | İlk Tab durağı `#pp-skip` ("Ana içeriğe atla") odağı doğrudan `#main-content` bölgesine taşır. | `nav-keyboard.spec.js` |
| **2.4.2 / 2.4.3** | Sayfa Başlığı / Odak Sırası | Her görünüm geçişinde `document.title` `<Görünüm> - Power Pilot` olarak güncellenir ve odak aktif görünüme (`tabindex="-1"`) taşınır. | `nav-keyboard.spec.js` |
| **2.4.7 / 2.4.11** | Görünür Odak / Odak Örtülmez | `:focus-visible` halkası (`--pp-ring`), anahtarlarda `peer-focus-visible:ring-2`, pano sticky CTA altında `padding-bottom` + `scroll-padding-bottom` (`--pp-cta-h`). | `settings-controls.spec.js`, `overlay-geometry.spec.js` |
| **2.5.8** | Hedef Boyutu (Asgari) | Tüm onay/radyo kutusu etiketleri, mini widget kontrolleri ve düğmeler ≥ 24×24 px; istatistik çipleri ≥ 32 px. | `target-size.spec.js`, `mini-widget.spec.js`, `touch-target.test.mjs` |
| **4.1.2 / 4.1.3** | Ad, Rol, Değer / Durum Mesajları | Dekoratif Material Symbols ikonlarında `aria-hidden="true"`, filtrelerde `aria-pressed`, boş durumlarda ve bildirimlerde `role="status"` / `role="alert"`. | `a11y.spec.js`, `icon-a11y.test.mjs`, `warning-banner-a11y.test.mjs` |

---

## 2. Yüksek Karşıtlık ve Tema Desteği

- **Açık / Koyu Tema:** `<head>` içindeki `src/renderer/theme-boot.js` ilk boyamadan önce kayıtlı temayı uygular; açık tema profillerinde koyu tema parlaması (FOUC) oluşmaz.
- **Windows Yüksek Karşıtlık (`@media (forced-colors: active)`):** Odak halkaları `2px solid Highlight`, kart ve kabuk sınırları `1px solid CanvasText`, anahtarlar `ButtonText` sistem renkleriyle çizilir.

---

## 3. Bilinen Sınırlar

1. **Desteklenen en küçük pencere boyutu:** Ana pencere en az `720 × 520 px` boyutunda çalışır (`minWidth: 720`, `minHeight: 520`).
2. **PIN Korumalı Mini Widget İptali:** İptal PIN'i kuruluysa mini widget üzerindeki İptal (`×`) düğmesi güvenlik gereği PIN'i mini pencerede sormaz; ana pencereyi öne getirip erişilebilir PIN modalını açar.
3. **Store Sürümü Kısıtları:** Microsoft Store (MSIX) sürümünde Windows ile otomatik başlatma anahtarı devre dışıdır (`disabled`); yerine Windows Başlangıç Ayarları bağlantısı sunulur.
