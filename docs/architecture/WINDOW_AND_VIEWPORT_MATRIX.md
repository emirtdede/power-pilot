# Desteklenen Pencere ve Görünüm Matrisi (PPX-013 / WP-08 / WP-09)

Power Pilot, Windows 10 (1809+) ve Windows 11 masaüstü ortamları için tasarlanmış çerçevesiz (`frame: false`) bir Electron uygulamasıdır. Bu belge, ana pencere ve mini widget için desteklenen pencere boyutlarını, kırılma noktalarını (breakpoints) ve ölçekleme sözleşmesini tanımlar.

---

## 1. Ana Pencere Sınırları

| Özellik | Değer | Kaynak |
|---|---|---|
| Varsayılan boyut | **1400 × 840 px** | `main.js` (`createWindow`) |
| Desteklenen en küçük boyut | **720 × 520 px** | `minWidth: 720`, `minHeight: 520` |
| Doğrulanan en büyük boyut | **3440 × 1440 px** (Ultra-Wide QHD) | `tests/e2e/overlay-geometry.spec.js` |
| Özel başlık çubuğu yüksekliği | **32 px** (`--pp-titlebar-h: 2rem`) | `src/renderer/app.css` |

> **Not (PPX-013):** `720 × 520` altındaki boyut istekleri (ör. `640 × 480`) işletim sistemi ve Electron pencere yöneticisi tarafından güvenli biçimde **720 × 520** alt sınırına kenetlenir.

---

## 2. Duyarlı İskelet Kırılma Noktaları (Breakpoints)

| Genişlik Aralığı | Kenar Çubuğu (Sidebar) Kipi | Genişlik | Davranış |
|---|---|---|---|
| **≥ 1120 px** | Geniş (`wide`) | `248 px` (`15.5rem`) | İkon + tam metin etiketleri + alt bilgi kartı görünür. |
| **900 px - 1119 px** | İkon Rayı (`rail`) | `72 px` (`4.5rem`) | Yalnız ikonlar görünür; her düğmede aktif dilde `aria-label`, `title` ve `data-tip` bulunur. |
| **720 px - 899 px** | Çekmece (`drawer`) | `272 px` (`17rem`) | Kenar çubuğu ekran dışındadır (`visibility: hidden`); başlık çubuğundaki `#btn-nav-toggle` düğmesiyle açılır, arka plan `inert` olur ve odak çekmece içinde tutulur. |

### Kısa Pencere Yüksekliği (`≤ 640 px`)
- Pano (`#view-dashboard`) görünümünde dikey boşluklar otomatik sıkılaştırılır; böylece `720 × 520` ve `1024 × 600` pencerelerde ilk boyamada (`scrollTop = 0`) süre girişleri ve adımlayıcı düğmeler alttaki yapışkan (sticky) başlatma çubuğu tarafından örtülmez.
- Kenar çubuğu navigasyon listesi (`#app-sidebar nav`) kısa yüksekliklerde `scrollbar-width: thin` ve üst/alt 12 px `mask-image` solma efektiyle kaydırılabilir kalır.

---

## 3. İçerik Kolonu Genişlik Tokenları

Geniş ve ultra-geniş ekranlarda satır uzunluğunu okunabilir tutmak ve görünümler arası sol/sağ hizalamayı korumak için üç standart kolon genişliği kullanılır:

| Token | Sınıf | Değer | Kullanıldığı Görünümler |
|---|---|---|---|
| `--pp-content-max` | `.content-col` | `72rem` (1152 px) | Pano (Dashboard) |
| `--pp-data-max` | `.pp-data-col` | `64rem` (1024 px) | Görevler, Şablonlar, Geçmiş, İstatistikler |
| `--pp-form-max` | `.pp-form-col` | `56rem` (896 px) | Smart Finish, AI Asistan, Entegrasyonlar, Ayarlar, Hakkında |

---

## 4. Doğrulanan 22 Boyut × 11 Görünüm Matrisi

`tests/e2e/overlay-geometry.spec.js` içinde her sürümde otomatik olarak koşulan 22 pencere boyutu:

- **Alt sınır ve kenetlenme:** `640×480` (→ `720×520`), `720×520`
- **Dar / Çekmece kipi:** `768×1024`, `800×600`, `899×600`
- **Ray (Rail) kipi:** `900×600`, `1000×1000`, `1024×600`, `1024×768`, `1024×1366`, `1119×700`
- **Geniş (Wide) kip:** `1120×700`, `1150×720`, `1200×500` (→ `1200×520`), `1280×720`, `1280×800`, `1366×768`, `1440×900`, `1600×900`, `1920×1080`, `2560×1440`, `3440×1440`

**Kabul kriteri:** 11 görünümün tamamında (`dashboard`, `active`, `tasks`, `smartfinish`, `assistant`, `templates`, `history`, `stats`, `integrations`, `settings`, `about`) `documentElement`, `body`, `#main-content` ve aktif `.view-section` için yatay taşma (`scrollWidth - clientWidth`) **0 px**'tir.

---

## 5. Mini Widget Pencere Sözleşmesi

| Özellik | Değer |
|---|---|
| Varsayılan pencere boyutu | **280 × 76 px** (`resizable: false`, `alwaysOnTop: true`) |
| Savunma amaçlı alt sınır | **160 × 48 px** (`minWidth: 160`, `minHeight: 48`) |
| Kart genişliği ve saat | `w-full h-full max-w-[260px]`, saat yazı boyutu `clamp(1.25rem, 8vw, 1.5rem)` |
| Kontrol düğmeleri | 3 adet (`#btn-hide`, `#btn-restore`, `#btn-cancel`), her biri **24 × 24 px** |

---

## 6. DPI, Yakınlaştırma ve RTL

- **Yakınlaştırma / Ölçekleme:** %125, %150 ve %200 ölçek düzeylerinde WCAG 1.4.10 (Reflow) uyarınca yatay kaydırma oluşmaz.
- **Sağdan Sola (RTL):** Arapça (`ar`) seçildiğinde `<html lang="ar" dir="rtl">` uygulanır; kenar çubuğu sağa yerleşir ve çekmece sağ kenardan açılır.
