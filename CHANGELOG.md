# Changelog — Power Pilot (WBS-10.4)

## [Unreleased] — Zero-Tolerance Audit Remediation (2026-11-21)

Bu sürüm, denetimde tespit edilen **plasebo ayarları** ve **kalıcı kusurları**
kök nedenden kapatır. Hiçbir ayar "arayüzde var, davranışta yok" durumunda
bırakılmadı; hiçbir hata sessizce yutulmadı.

### Kök neden: politika varsayılanlarının ayarları gölgelemesi (P1-6)
- **Ölçülen kusur:** `AutomationTask` her göreve **tam** bir `safetyPolicy`
  nesnesi yazıyordu (varsayılan `false` değerlerle). Sonuç: kalıcı ayarlar
  (`forceCloseApps`, `remoteApprovalRequired`, `protectFullscreen`,
  `protectActiveIo`) hiçbir zaman uygulanmıyordu.
- **Çözüm:** `safetyPolicyExplicit` işareti. Kısmi nesne → verilen her alan
  bilinçli tercih; tam (maddeleştirilmiş) nesne → yalnızca varsayılandan farklı
  alanlar; kalıcı kayıt → yalnızca işaretli alanlar. Karar
  `AutomationTask.isExplicitPolicy` / `SafetyPolicyEngine.isExplicitPolicy` ile
  verilir ve `toJSON` ile kalıcılaşır.
- **Regresyon testi:** `tests/main/policy-explicitness.test.mjs`.

### Güvenlik
- **Korunan uygulamalar kullanıcı ayarı oldu (`protectedApps`).** Varsayılan
  listeden `steam.exe`, `epicgameslauncher.exe`, `discord.exe` çıkarıldı; liste
  Ayarlar → Güvenlik'ten düzenlenir. Bir görev, kendi izlediği süreçten muaftır
  (aksi halde "Steam kapanınca kapat" görevi kendini engellerdi).
- **Zorla kapatma artık gerçek (`forceCloseApps`).** `PowerService.execute()`
  `/f` bayrağını geçirir; görev düzeyi değer açıkça verilirse o kazanır.
- **Uzaktan onay gerçek bir kapı (`remoteApprovalRequired`).** `local_api`,
  `n8n`, `console` kaynaklı görevler yerel insan onayı ister; sayaç dolarsa
  eylem **iptal** edilir (fail-closed). Yerel UI görevleri etkilenmez.
- **Aktif güç isteği kapısı** yükseltme yoksa görünür biçimde atlanır
  (`loadCheck: "unavailable"` + denetim kaydı + arayüz uyarısı) — sessizce
  açık bırakılmaz.

### Davranış
- **Bekleme süresi gerçek bir OS gecikmesi (`graceSeconds`).** `shutdown` /
  `restart` / `signout` için Windows `/t n` kullanılır; bekleme penceresinde
  iptal `shutdown /a` ile zamanlanmış kapatmayı **gerçekten** durdurur. Veto
  doğrulama penceresi gecikme kadar ötelenir (meşru bekleme yanlış
  "engellendi" olarak raporlanmaz). 0–600 sn, görev düzeyi değer ezer.
- **Uyarı sayacı = iptal penceresi.** Süre dolarsa eylem çalışır; katı mod
  isteyen `warningConfig.requireConfirmation: true` ile dolduğunda iptal eder.
- **Yeniden deneme gerçek bekleme (`retry_once`).** 30 sn pencere; bu sırada
  iptal edilen görev tekrar denenmez.
- **UPS düşük-batarya gözetimi (opt-in, `UpsSupervisor`).** `LB` + `OB` →
  kısa geri sayım → seçilen güç eylemi. Normale dönüş iptal eder; cooldown
  vardır; **ulaşılamayan UPS asla eylem üretmez**.
- **Sessiz uyarı saati (`quietHours`) gerçek.** Pencere içinde pencere öne
  getirme ve balon/desktop bildirimi bastırılır; uyarı ve iptal hakkı korunur.

### Ölçüm doğruluğu
- **`disk_activity` birimi düzeltildi.** `si.fsStats()` üzerinden KB/s
  (`diskKbps`) ölçülür ve `thresholdKbps` ile karşılaştırılır; açıkça
  `thresholdIops` verilirse IOPS yolu korunur. Ölçülemezse sonuç
  **fail-closed** (`satisfied: false`).
- **Dizin taraması 1 sn'lik döngüyü bloklamaz.** `scanDirectoryAsync`
  (`fs.promises`) + `SmartFinishEngine.prefetchDirectoryScans` ile önbellekli
  okuma; senkron `scanDirectory` sözleşmesi doğrudan çağıranlar için korundu.

### Bağlantı sözleşmesi (P0-4)
- **Tek kaynak:** `src/shared/localApiConnection.js`. Kanonik ad
  `POWERPILOT_API_*`; `POWER_PILOT_API_*` geriye uyum fallback'i.
  `*_API_TLS` / `*_API_CA` ile TLS. CLI, MCP, ajan ve "MCP yapılandırmasını
  kopyala" çıktısı aynı sözleşmeyi kullanır — kopyala-yapıştır 401 üretmez.
- CLI süre alanını sayısal `durationMs` olarak gönderir.

### Arayüz ve koruma
- **UPS düşük-batarya eylemi ayarları eklendi** (etkinleştir / eylem /
  geri sayım) ve kaydetme akışına bağlandı.
- **DOM bütünlüğü kapısı:** `tests/main/dom-integrity.test.mjs` yinelenen ID ve
  eksik KPI kartlarının geri gelmesini engeller.
- **Türkçe olumsuzlama koruması** İngilizce kalıpları da kapsar
  (`NegationGuard`), dil-farkındalı.

### Dokümantasyon
- Tarihsel/yanıltıcı belgeler silindi: `architecture/POWER_PILOT_CURRENT_ARCHITECTURE.md`,
  `i18n/TRANSLATION_PLAN.md`, `release/RELEASE_HARDENING_1.0.1.md`.
- `docs/README.md` tek indeks olarak yeniden yazıldı; mimari belgeler
  (otomasyon motoru, Smart Finish, güvenlik politikaları) yürürlükteki
  davranışa göre güncellendi. Uygulama içi Dokümantasyon Merkezi de aynı
  gerçekleri anlatır.

## [1.0.0] — Official Production Release (2026-11-21)

- **v1.0.0 Resmi Yayın:** Vellium (`vellium.dev`, `support@vellium.dev`) çatısı altında sabitlenen ilk kararlı üretim sürümü (`v1.0.0`).
- **4 Seçilebilir Sistem Geneli Uygulama ve Masaüstü İkonu (`AppIconService`):** `Koyu Monokrom` (varsayılan), `Açık Monokrom`, `Saf Siyah-Beyaz` ve `Klasik Cyan` ikon setleri (`.svg`, `.png`, 7 boyutlu `.ico` + 51 parçalı Microsoft Store çoklu-DPI `build/appx` seti). Seçim değiştiğinde ana pencere, mini widget, sistem tepsisi, görev çubuğu ve Windows Masaüstü/Başlat kısayolları (`.lnk`) UTF-16LE `SHChangeNotify` (`SHCNE_UPDATEITEM` + `SHCNE_UPDATEDIR` + `SHCNE_ASSOCCHANGED`) ile eşzamanlı güncellenir.
- **22 Kategorili Otomasyon Şablonu + Tam CRUD ve Varsayılan Yönetimi (`TemplateService`):** 7 kategoride 22 yerleşik şablon, geri sayım (`duration`), belirli saat (`schedule`) ve Smart Finish (`condition`) tetikleyicileri, sıfırdan özel şablon oluşturma, mevcut şablonları düzenleme (*Düzenlendi* rozeti), çoğaltma, gizleme/silme, tekil sıfırlama, tüm varsayılanları geri getirme ve sade ikon aksiyon butonları.
- **Yapay Zekâ Asistanı 2.0 (Görev, Şablon, Bağlantı ve Yerel Doküman RAG):** `AgentOrchestrator` altında 7 uzman ajan (`planner`, `template`, `connection`, `docs_qa`, `diagnose`, `recommender`, `energy`); doğal dille görev/şablon üretimi, insan-onaylı entegrasyon yapılandırma önerisi ve `DocsKnowledgeBase` üzerinden çevrimdışı dokümantasyon soru-cevap + bölüm derin bağlantıları.
- **Zenginleştirilmiş Enerji, CO₂ ve Otomasyon İstatistikleri (`EnergyEstimateService`):** 7 Gün / 30 Gün / Tümü dönem filtresi, önlenen açık kalma süresi, kWh + aylık projeksiyon, maliyet + yıllık projeksiyon, `0.42 kg/kWh` CO₂ azaltımı, başarı oranı, aktif seri, en uzun kapanış, SVG günlük trend grafiği, eylem/kaynak dağılımları, 24 saatlik yoğunluk haritası, ölçülen oturumlar tablosu ve CSV/JSON dışa aktarma.
- **7 Alt Sayfalı Entegrasyonlar & 10 Alt Sayfalı Anlık Aramalı Dokümantasyon Merkezi:** Yerel REST API, Webhooks, MCP Sunucusu, CLI, Wake-on-LAN (kayıtlı cihazlar listesi), UPS/NUT ve Kurumsal Konsol için bağımsız alt sayfalar; Dokümantasyon Merkezi'nde `searchDocs` IPC destekli anlık arama.
- **8 Alt Sayfalı Ayarlar + Tanılama, Çökme Raporları ve Destek Paketi (`DiagnosticsService`):** Maskelenmiş (`<USER>`, `<REDACTED>`) çökme/hata, arayüz, sistem ve ana süreç günlükleri, saf Node.js Deflate ZIP destek paketi (`powerpilot-support-*.zip`), etkileşimli klavye kısayolu kaydedici, donmasız asenkron `performWipeAsync` veri silme akışı ve işlem animasyonu.
- **Kurulum Sihirbazı Otomatik Enerji Profili & %100 Responsive Arayüz:** Kurulum sihirbazı 2. adımında algılanan cihaz watt değeri ve yerel elektrik tarifesinin otomatik doldurulması; tüm ikinci kenar menülerde tek satır kilidi ve 22×12 pencere boyutunda sıfır yatay taşma.
- **Özel Windows 11 NSIS Kurulum ve Kaldırma Deneyimi:** Özel yan ve üst grafikler (sürüm numarası içermez), Görev Zamanlayıcı temizliği ve isteğe bağlı kullanıcı verisi koruma/silme adımı.

## [1.3.1] — UI/UX & Accessibility Remediation (2026-11-20)

### Erişilebilirlik ve Klavye (WCAG 2.2 AA — WP-01, WP-02, WP-03, WP-07)
- **PPX-001 (P0) — Kenar çubuğu (sidebar) klavye navigasyonu.** 11 navigasyon öğesi `href`'siz `<a>` yerine `<button type="button">` öğelerine dönüştürüldü; tümü Tab sırasına girer, `ArrowUp`/`ArrowDown`/`Home`/`End` ile odak taşınır, `Enter`/`Space` ile etkinleştirilir.
- **PPX-002 (P1) — Ayarlar anahtarları (switch) odaklanabilirliği.** Bildirimler, Windows ile Başlat ve Sesli Geri Bildirim anahtarlarında `invisible` (`visibility: hidden`) kaldırılarak `opacity-0` + tam kaplama ve `peer-focus-visible:ring-2` odak halkası eklendi.
- **PPX-004 (P1) — Dar pencere çekmecesi (drawer) odak yönetimi.** `< 900 px` kapalı çekmece `visibility: hidden` ile erişilebilirlik ağacından ve Tab sırasından çıkarıldı; açıldığında `#main-content` `inert` olur, odak ilk nav öğesine taşınır, Tab çekmece içinde tutulur ve `Escape`/scrim kapanışında odak `#btn-nav-toggle` düğmesine döner.
- **PPX-007 / PPX-029 (P1/P3) — Mini widget klavye halkası ve erişilebilir adlar.** Mini widget kontrol düğmeleri 24×24 px hedef boyutuna yükseltildi, `:focus-visible` halkası ve ilk boyamadan itibaren statik `aria-label` eklendi.
- **PPX-008 (P2) — Ayarlar açılır listeleri (`<select>`) programatik etiketleri.** `#setting-sound-mode`, `#setting-theme` ve `#setting-language` öğeleri görünür başlık ve açıklama metinlerine `aria-labelledby` ve `aria-describedby` ile bağlandı.
- **PPX-009 / PPX-036 (P2/P4) — Dokunma ve işaretçi hedef boyutları (WCAG 2.5.8).** Entegrasyonlar/Ayarlar/Smart Finish onay ve radyo kutusu etiketleri, Hakkında `vellium.dev` bağlantısı ve `#onboarding-skip` en az 24×24 px; istatistik çipleri (`#chip-watt`, `#chip-price`) en az 32 px yüksekliğe çıkarıldı.
- **PPX-011 (P2) — Görünüm geçişi duyurusu ve odak yönetimi.** Görünüm değişiminde `document.title` `<Görünüm> — Power Pilot` olarak güncellenir ve klavye/nav aktivasyonunda odak hedef görünüme (`tabindex="-1"`) taşınır.
- **PPX-012 (P2) — Landmark adlandırması ve içeriğe atlama bağlantısı.** `<header>`, `<nav>`, `<main>`, `<footer>` bölgeleri 17 dilde `aria-label` ile adlandırıldı; ilk Tab durağı olarak `#pp-skip` ("Ana içeriğe atla") eklendi.
- **PPX-017 (P2) — Görev filtrelerinde durum semantiği.** `[data-task-filter]` düğmelerine `aria-pressed` ve renk dışı aktif durum göstergesi (alt çizgi `box-shadow`) eklendi.
- **PPX-019 / PPX-030 (P2/P3) — Boş durum canlı bölgeleri ve ortak bileşen.** Görevler, Geçmiş, Şablonlar ve AI Asistan boş durumları `role="status" aria-live="polite"` ve ortak `.pp-empty` bileşeniyle (ikon + başlık + açıklama + birincil eylem) standartlaştırıldı.
- **PPX-027 (P3) — Süre adımlayıcı (stepper) semantiği.** 6 adımlayıcı düğmesi `type="button"` yapıldı ve değer değişimleri `#pp-step-live` canlı bölgesiyle duyurulur hale getirildi.
- **PPX-028 (P3) — İstatistik kartları semantiği.** İstatistik kartları `<dl>` (`<dt>` + `<dd>`) yapısına alındı.
- **PPX-031 (P3) — Kurulum sihirbazı adım göstergesi.** `#wz-dots` grubuna erişilebilir etiket ve `#wz-step-text` (`aria-live="polite"`) adım durumu ("Adım 1/3") eklendi.
- **PPX-032 (P3) — Windows Yüksek Karşıtlık (`forced-colors: active`) desteği.** Odak halkaları, kart sınırları ve anahtarlar için sistem renkleriyle (`Highlight`, `CanvasText`, `ButtonText`) yüksek karşıtlık kuralları eklendi.

### Yerleşim, Kontrast, Tema ve Platform (WP-04, WP-05, WP-06, WP-08)
- **PPX-003 (P1) — Pano (Dashboard) sticky CTA örtüşmesi.** Sticky bar yüksekliği `ResizeObserver` ile `--pp-cta-h` olarak ölçülüp `#view-dashboard` alt boşluğuna bağlandı (`padding-bottom` + `scroll-padding-bottom`), eylem ızgarası `lg:grid-cols-6` yapıldı ve kısa pencereler (`≤ 640 px`) için dikey yoğunluk kuralları eklendi.
- **PPX-005 / PPX-010 (P1/P2) — Kontrast düzeltmeleri (WCAG 1.4.3 / 1.4.11).** `#btn-cancel` `bg-red-600 hover:bg-red-700` (4,83:1), `#stat-kwh` `text-green-700 dark:text-green-400` (5,02:1 / 7,9:1), saat ayırıcıları ve Hakkında chevron ikonları tema duyarlı `.pp-sep` (`--pp-sep`, ≥ 3:1) yapıldı; statik kontrast kapısına `text-green-500` ve `text-emerald-500` yasakları eklendi.
- **PPX-006 / PPX-018 / PPX-023 / PPX-024 (P1/P2/P3) — Bildirim ve uyarı katmanı.** `#warning-banner` ve `#toast-container` sabit overlay yerine `#main-content` içinde normal akışa alındı; başlık, filtre ve banner çakışmaları yapısal olarak ortadan kaldırıldı. Toast üst sınırı 2'ye indirildi, duyarlı genişlik (`min(20rem, calc(100vw - 8rem))`), hover/odak duraklatma ve 24×24 kapatma düğmesi eklendi.
- **PPX-013 (P2) — Desteklenen pencere alt sınırı.** 720×520 alt sınırı (`minWidth: 720, minHeight: 520`) kodda ve dokümantasyonda resmileştirildi.
- **PPX-014 (P4) — Mini widget akışkan kart ve saat.** Mini widget kartı `w-full h-full max-w-[260px]` ve saat boyutu `clamp(1.25rem, 8vw, 1.5rem)` ile dar boyutta taşmasız hale getirildi.
- **PPX-015 (P2) — Tema ve dilin anında uygulanması.** Ayarlar'da tema ve dil seçimi `change` olayında anında uygulanır ve kalıcılaştırılır; sunucu reddi durumunda son onaylı değere geri döner.
- **PPX-016 (P2) — Tek kurulum deneyimi.** İlk açılış sihirbazını atlayan kullanıcıya (`pp-wizard-skipped=1`) hemen ardından ikinci bir onboarding katmanı gösterilmez.
- **PPX-020 / PPX-033 (P2/P3) — Entegrasyonlar girdi genişlikleri.** API yapılandırma ızgarası `grid-cols-1 lg:grid-cols-2` yapıldı; IP, sertifika, anahtar ve parmak izi alanları dar pencerede tam satır genişliği alır.
- **PPX-021 (P2) — Açık temada açılış parlamasının giderilmesi.** Harici, CSP uyumlu `src/renderer/theme-boot.js` stil dosyalarından önce çalışarak ilk boyamada kayıtlı temayı uygular.
- **PPX-022 / PPX-026 (P3) — Tipografi ve içerik genişliği tokenları.** Tüm görünüm başlıkları `.page-title` (`24 px / 700`) ile hizalandı; `--pp-content-max` (`72rem`), `--pp-data-max` (`64rem`) ve `--pp-form-max` (`56rem`) kolon tokenları tanımlandı.
- **PPX-025 (P3) — Kısa pencerede kenar çubuğu kaydırma ipucu.** `#app-sidebar nav` alanına ince kaydırma çubuğu ve üst/alt `mask-image` solma efekti eklendi.
- **PPX-034 / PPX-035 (P4) — Yerelleştirme ve başlık çubuğu ipuçları.** Türkçe sözlükte `"dashboard"` etiketi `"Panel"` olarak çevrildi; pencere kontrol düğmelerine yerel `title` ipuçları eklendi.

## [Unreleased]

### Yayın öncesi QA turu (2026-11-18)
- **Kurulum paketi geliştirme artığı taşıyordu (P2).** Electron'un `dist`
  klasöründeki `debug.log` (38 KB, geliştirme sırasında oluşmuş Chromium hata
  günlüğü) hem NSIS kurulumuna hem MSIX paketine kopyalanıyordu. `afterPack`
  kancası artık bilinen artıkları (`debug.log`, `chrome_debug.log`) imzalamadan
  önce siler; uygulamanın kendi logları etkilenmez. Regresyon:
  `pack-artifacts.test.mjs` (3).
- **Mağaza (MSIX) hattı doğrulandı.** `electron-builder --win appx` imzasız
  paket üretiyor (`PowerPilot_1.1.0_x64.appx`); `makeappx unpack` paketi kabul
  etti, manifest doğru: `Vellium.PowerPilot`, `runFullTrust` + `microphone`,
  `startupTask Enabled=false`, 17 dil. Gerçek Store sertifikasıyla imzalama
  kapsam dışı (belgelendi).
- **Kapatma uyarısı pencere gizliyken görünmüyordu (P0 — veri kaybı).**
  Kullanıcı "1 saat sonra kapat" deyip pencereyi kapatınca uygulama tepside
  çalışmaya devam ediyor; süre dolunca uyarı yalnızca gizli pencerenin DOM'una
  yazılıyordu. `full` modda uyarı süresi dolunca otomatik devam edildiği için
  makine, kullanıcı hiçbir şey görmeden kapanıyordu. Uyarı başlarken pencere
  artık öne getirilir (göster + simge durumundan geri al + geçici
  always-on-top + odak), uyarı bitince üstte kalma bırakılır ve tepsi balonu
  durumu bildirir. Ölçüm: `scratch/probe-warning-hidden-window.cjs` 5/5 PASS.
  Regresyon: `warning-visibility.test.mjs` (6).
- **Windows Görev Zamanlayıcı kayıtları sahipsiz kalıyordu (P1).**
  Uygulama her zamanlanmış görevi `\PowerPilot\task_<id>` olarak Windows'a
  da yazıyor (pencere kapalıyken çalışsın diye). Bu kayıtlar userData
  dışında yaşar ve hiçbir temizlik yolu yoktu: "tüm verileri sil" sonrası
  tetikleme saatinde uygulama kendi kendine açılıyor, kaldırma sonrası
  Görev Zamanlayıcı silinmiş exe'yi çağırıyordu. `removeAllTasks` eklendi
  (yalnızca `\PowerPilot` klasörü), wipe ve bozuk-DB kurtarma öncesinde
  çalışır; NSIS kaldırıcısı da temizler (`build/installer.nsh`).
  Ölçüm: `scratch/probe-wipe-scheduler.cjs` 9/9 PASS. Regresyon:
  `scheduler.test.mjs` (35), `data-wipe.test.mjs` (15),
  `scheduler-cleanup-wiring.test.mjs` (5).
- **"Tüm verileri sil" yarım kalıyordu (P1).** Wipe sabit dosya listesine
  bağlıydı; Chromium klasörleri (`DawnGraphiteCache`, `DIPS`, `Network` …)
  sürümle değiştiği için kalıyor ve çalışırken kilitli oldukları için wipe
  `WIPE_PARTIAL` ile düşüyordu (kullanıcı "silinemedi" hatası görüyordu).
  Artık kökteki her girdi hedeflenir; temel veri ile Chromium önbelleği
  ayrılır, temel veri kilitliyse sonraki açılışta tamamlanır.
- **Pencere kapatılınca kullanıcı geri dönüş yolunu bilmiyordu (P1).**
  Aktif görev varken pencere kapatılınca uygulama gizleniyor ve görev arka
  planda çalışıyor (ölçüldü: `scratch/probe-background-run.cjs` 5/5 PASS),
  ama tepsi balonu yalnızca "arka planda çalışıyor" diyordu. Kullanıcı
  uygulamayı kapandı sanıp süreci öldürebiliyor, bu da zamanlanmış görevi
  sessizce iptal ediyordu. Balon metni 17 dilde "tepsi simgesine çift
  tıklayın" yönergesiyle genişletildi. Regresyon:
  `tests/main/background-run.test.mjs` (7).
- **Bozuk veri dosyası uygulamayı kalıcı olarak kilitliyordu (P0).**
  Bozuk `powerpilot.db` (elektrik kesintisi/antivirüs/disk hatası) durumunda
  uygulama açılıyor ama **hiçbir görev oluşturulamıyordu**; yalnızca
  "Task could not be created." görünüyor, kurtarma yolu sunulmuyordu.
  Düzeltme: `StorageRecovery.quarantineDatabase` — bozuk DB **silinmez**,
  `quarantine/` altına taşınır, temiz depoyla devam edilir; `new Db()`
  açılış hatası da kurtarma yoluna girer. `get-storage-status` `recoveredFrom`
  döndürür ve arayüz `role="status"` canlı bölgeyle çevrilmiş bildirim +
  özgün dosya yolunu gösterir (17 dil). Eski `powerpilot_data.json`
  sözleşmesi (`T-STO-03`: kaynak asla değiştirilmez) **korunur**; bakım
  şeridine "Veri klasörünü aç" çıkış düğmesi ve çevrilmiş kurtarma ipucu
  eklendi. Ölçüm: `scratch/probe-corrupt-data.cjs` 21/21 PASS. Bildirimdeki
  dosya yolu tek tıkla açılır (`btn-storage-recovered-folder`) ve bildirim
  kapatılabilir (`btn-storage-recovered-close`; dil değişiminde geri gelmez).
  Regresyon: `tests/main/storage-recovery.test.mjs` (15).
- **Zaman kritik kapatma uyarısı ekran okuyucuya hiç duyurulmuyordu (P0, WCAG 4.1.3).**
  Kapatma öncesi 30 saniyelik son çıkış uyarısı `role`/`aria-live` taşımıyordu
  (`role=null, live=null`); ekran okuyucu kullanıcısı uyarıyı **hiç duymuyordu**
  → kaydedilmemiş işiyle bilgisayar kapanıyordu. Akış gerçek görevle doğrulandı
  (12/12 PASS): 30s geri sayım, Durdur → `cancelled_by_user`, Ertele →
  `scheduled`; hiçbir adımda kapatma çalışmadı. Düzeltme: banner
  `role="alert"` + `aria-live="assertive"`, sayaç `aria-live="off"` (spam
  önleme). Regresyon: `tests/main/warning-banner-a11y.test.mjs` (8).
- **7 düğme 24px dokunma hedefinin altındaydı (P2, WCAG 2.5.8).** Zamanlayıcı
  +/- düğmeleri **24×21px**, "Veri klasörünü aç" düğmesi **99×16px** idi; 16px
  yükseklik touchpad/titrek elle/yüksek DPI ekranda ıskalanır. Ölçüm (öncesi):
  7 ihlal. Düzeltme: adım düğmelerine `min-h-[24px]`, kırpan `py-1` kaldırıldı;
  veri klasörü düğmesi `inline-flex items-center min-h-[24px]`. Ölçüm (sonrası):
  **0 ihlal**. Aynı probe metin ölçeklemeyi de doğruladı: 1440/1024/800 genişlik
  ve zoom 1.0/1.5/**2.0**'da 6 görünümde **yatay taşma 0, kırpılan metin 0**
  (10/10 PASS). Regresyon: `tests/main/touch-target.test.mjs` (5).
- **Modal pencereler klavye/ekran okuyucu için kapalıydı (P1, WCAG 2.4.3 / 4.1.2).**
  Altı modalın hiçbirinde `role="dialog"`, `aria-modal`, erişilebilir ad, odak
  tuzağı, Escape ve odak geri dönüşü yoktu. Ölçüm: PIN modalinde **ilk Tab
  basışı** odağı `btn-minimize`'a kaçırdı, **Escape modalı kapatmadı**, ekran
  okuyucu başlığı duyurmadı (ad `null`). Düzeltme: tek merkezi katman
  (`openModal`/`closeModal`) `role="dialog"` + `aria-modal="true"` + başlığa
  `aria-labelledby` uygular, odağı modala taşır, Tab'ı içeride tutar
  (Shift+Tab döngüsü dahil), Escape'i uygulamanın **kendi iptal yoluna**
  bağlar (bekleyen PIN işlemi asılı kalmaz) ve kapanışta odağı tetikleyiciye
  döndürür. Ölçüm (sonrası): **8/8 PASS** — 12 Tab içeride, Escape kapattı,
  odak `btn-pin-clear`'a döndü. Regresyon: `tests/main/modal-a11y.test.mjs` (7).
- **Bildirimler kapalıyken hata mesajları da kayboluyordu (P1).** Ayarlar >
  "Bildirimleri Göster" kapatıldığında `showToast` **her türde** erken dönüyordu,
  yani hata mesajları da sessizce yutuluyordu ("PIN kurulamadı", "görev
  oluşturulamadı", "klasör açılamadı"...). Uygulamada bu yoldan geçen **79 hata
  çağrısı** var; kullanıcı işlemin başarısız olduğunu **hiç öğrenmiyordu** —
  sessiz başarısızlık. Ölçüm (öncesi): bildirim kapalı + geçersiz PIN →
  toast adedi **0**. Düzeltme: ayar yalnızca bilgilendirme amaçlı geri bildirimi
  kapatır, hata her zaman görünür (`if (!showNotifs && type !== 'error') return;`).
  Ölçüm (sonrası): hata toast'ı görünür (`role="alert"`), başarı toast'ı
  gizli (ayar amacına uygun). Regresyon:
  `tests/main/toast-error-visibility.test.mjs` (4).
- **Dekoratif ikonlar ekran okuyucuya anlamsız kelimeler okuyordu (P1, WCAG 4.1.2).**
  Material Symbols ikon fontu ligatürle çalışır: `<span>power_settings_new</span>`
  ekranda ikon çizer, ama **DOM metni anlamsız bir kelimedir**. Hiçbir ikonda
  `aria-hidden` yoktu (ölçüm: **28/28 açık**). Ekran okuyucu kullanıcısı düğme
  adını **"power_settings_new Bilgisayarı Kapat Gücü tamamen kapatır"**, toast'ı
  **"error Klasör açılamadı."** diye duyuyordu — **29 düğme** etkileniyordu.
  Düzeltme: 57 dekoratif ikon `aria-hidden="true"` aldı (index.html 52,
  mini.html 3, app.js 2); yalnızca ikon taşıyan düğmelerin mevcut `aria-label`
  etiketi korundu. Ayrıca toast'ın **canlı bölge** semantiği yoktu — ekran
  okuyucu yeni bildirimi kendiliğinden duyurmuyordu; `role`/`aria-live`/
  `aria-atomic` eklendi (hata → `alert`/`assertive`, diğer → `status`/`polite`).
  Ölçüm (sonrası): **0/28 açık**, **0 düğme** etkileniyor, okunan toast metni
  "Klasör açılamadı.". Not: mevcut `audit-a11y.mjs` bunu yakalamıyordu çünkü
  yalnızca "adı olmayan düğme" sayıyordu (ad *vardı*, sadece yanlış addı).
  Regresyon: `tests/main/icon-a11y.test.mjs` (7).
- **PIN'i unutan kullanıcıya hiçbir kurtarma yolu gösterilmiyordu (P1).**
  Kullanıcı İptal PIN'i kurduktan sonra PIN'i unutursa arayüzde ne yapacağını
  anlatan **tek bir cümle bile yoktu** (ölçüm: `mentionsForgot: false`,
  `mentionsReset: false`); kullanıcı kendi kurduğu ayarla kendini korumasız
  bırakıyordu. Kurtarma anahtarı/arka kapı tasarım gereği **yasak**
  (`REMEDIATION_PLAN_WBS_V3.md` §2.2 — PIN'in varlık nedeni fiziksel erişimi
  olan kişiyi engellemektir), bu yüzden güvenlik kapısı zayıflatılmadı; onun
  yerine gerçek yol gösterildi. Ayarlar > İptal PIN'i kartına uyarı metni ve
  **"Veri klasörünü aç"** düğmesi eklendi. Yol sabit metin olarak gömülmedi
  (MSIX'te paket verisi sanallaştırılır, sabit `%APPDATA%` yanıltıcı olurdu);
  yeni `open-data-folder` IPC'si klasörü platformdan sorar ve **istemciden
  gelen yolu yok sayar**. Ölçüm (sonrası, 16/16 PASS): metin görünür, düğme
  çalışıyor (`success: true` + gerçek `userData` yolu), `C:\Windows\System32`
  enjeksiyonu yok sayıldı, kontrast 12.21:1 ve 6.93:1 (WCAG AA), 3 yeni anahtar
  17 dilde (724 anahtar). Uygulama PIN unutulduğunda kilitlenmiyor: tüm
  görünümler erişilebilir, yeni görev oluşturulabiliyor. Regresyon:
  `tests/main/pin-recovery.test.mjs` (10).
- **Mini pencere (küçük sayaç widget'ı) normal görevlerde boş görünüyordu (P1).**
  Widget, görev çubuğunda **her aktif görevde** açılıyordu, ama sayaç verisini
  yalnızca Hızlı Zamanlayıcı renderer'ı gönderiyordu. Smart Finish, şablon,
  zamanlanmış görev ve zincir görevlerinde pencere açılıyor fakat içi
  **`--` / `00:00`** kalıyordu — kullanıcı sayaç sanıp bakıyor, hiçbir bilgi
  göremiyordu. Ölçüm (öncesi): `createTask({duration:1h})` → pencereyi gizle →
  `{"action":"--","countdown":"00:00"}`. Düzeltme: sayaç artık ana süreçte
  `TaskManager`'dan hesaplanır (`src/main/services/MiniWidgetState.js`, saf ve
  test edilebilir) ve 1 sn'de bir widget'a itilir. Koşullu görevlerde sahte geri
  sayım yerine **"İzleniyor"** + son ilerleme mesajı gösterilir. Mini penceredeki
  **"X"** düğmesi artık gösterilen görevi gerçekten iptal eder (önceden yalnızca
  ana pencereyi açıyordu). Pencere kapanınca interval temizlenir. Ölçüm
  (sonrası): `{"action":"Bilgisayarı Kapat","countdown":"59:57"}`. Regresyon:
  `tests/main/mini-widget-state.test.mjs` (15).
- **Enerji kısayolu giriş alanına odaklanmıyordu (P3, kullanılabilirlik).**
  İstatistik görünümündeki "kWh için watt girin →" düğmesi Ayarlar > Enerji
  kartına götürüp doğru yere kaydırıyordu, ancak giriş alanına **odaklanmıyordu**
  (`document.activeElement` → `BODY`). Düğme "girin" dediği halde kullanıcının
  tıklayıp ayrıca alana tıklaması gerekiyordu. Düzeltme: kaydırmanın ardından
  `#nrg-watt` alanı `focus({ preventScroll: true })` ile odaklanır. Ölçüm
  (sonrası): `activeElement.id === 'nrg-watt'`. Regresyon:
  `tests/main/energy-chip-focus.test.mjs` (4).
- **Biten görevler listeden kaldırılamıyordu (P1).** İptal edilen/tamamlanan/
  süresi geçen görevler diskte kalıcı olarak kalıyor ve "Tüm" filtresinde
  **eylem düğmesi olmayan** satırlar olarak sonsuza kadar birikiyordu; kullanıcı
  bunları temizlemenin hiçbir yolunu bulamıyordu. Ölçüm (öncesi): 15 görev
  oluştur → 15'i iptal → "Tüm" → **15 satır, her satırda 0 eylem**; yeniden
  başlatmada 15 satır hâlâ orada. Düzeltme: `TaskManager.removeTask`
  (yalnızca **terminal** durumdakiler; çalışan görev `TASK_NOT_TERMINAL` ile
  reddedilir) + `removeTerminalTasks`, `remove-task` / `remove-terminal-tasks`
  IPC, preload yüzeyi, terminal satırda **"Kaldır"** düğmesi ve tablo başlığında
  **"Bitenleri temizle"**. Ölçüm (sonrası): 15 → kaldır → **0**, toplu temizleme
  **8 → 0**, yeniden başlatmada silinen **dönmüyor**. 6 yeni anahtar 17 dilde.
  Regresyon: `tests/main/task-remove.test.mjs` (8).
- **"Şablonu Kaydet" düğmesi hiç çalışmıyordu (P1).** Smart Finish görünümünde
  kullanıcı şablon kaydettiğinde **hiçbir zaman** kaydolmuyordu; her seferinde
  "Şablon koşulu veya zamanlaması geçersiz." hatası görünüyordu. Kök neden sıra
  hatasıydı: renderer `{ name, action, defaultCondition }` gönderiyor (`id` YOK),
  `main.js` ham payload'ı doğruluyordu, `TemplateService.isValidTemplate` ise
  `typeof tpl.id !== 'string'` kontrolüyle **id'yi zorunlu** tutuyordu; id ise
  doğrulamadan **sonra** üretiliyordu. Ölçüm (gerçek UI): 10 şablon → kaydet →
  **10 şablon** (artış yok). Düzeltme: kayıt önce normalleştirilir (id sunucuda
  üretilir), doğrulama normalleştirilmiş kayıt üzerinde yapılır. Ölçüm (sonra):
  10 → **11**, ad korunuyor, yeniden açılışta **kalıcı**. Regresyon:
  `tests/main/template-save.test.mjs` (5).
- **Görev adı olarak yalnızca boşluk kabul ediliyordu (P2).** Doğrulayıcı ad
  uzunluğunu (≤120) ve `<`/`>` karakterlerini kontrol ediyor ama `trim()`
  sonrası boşluğu kontrol etmiyordu; `"   "` adıyla görev oluşturulabiliyor ve
  görev listesinde **adsız bir satır** olarak görünüyordu. Düzeltme: `name`
  `trim()` sonrası boşsa `INVALID_NAME`. Regresyon:
  `validate-schema.test.mjs` → "boşluktan ibaret ad reddedilir".
- **Metin kontrastı WCAG AA'yı geçmiyordu (P0, erişilebilirlik).** 10 görünümün
  tamamı gerçek uygulamada taranarak ölçüldü (etkin arka plan, atasal zincirden
  birleştirilerek). Açık temada **52 kusur**: `text-slate-400` beyaz üstünde
  **2,56:1**, `text-slate-500` slate-100 üstünde **4,34:1**, uyarı metni
  `text-amber-500` **2,10:1**, hata metni `text-red-500` **3,23:1**. Koyu temada
  **22 kusur**: `text-primary` (#0067c2) koyu zeminlerde **2,40–3,16:1**
  (menü/buton vurgusu, "Kullan" düğmeleri, sesli komut düğmesi okunmuyordu).
  Düzeltme: `text-slate-500 dark:text-slate-400`,
  `text-slate-600 dark:text-slate-400`, `text-amber-700 dark:text-amber-400`,
  `text-red-700 dark:text-red-400`, `bg-primary/10`, ve koyu tema için yeni
  `primary-light: #60a5fa` token'ı (`text-primary dark:text-primary-light`).
  Ölçüm (sonra): açık **0**, koyu **0** kusur. Regresyon:
  `tests/main/contrast-a11y.test.mjs` (10).
- **`classList`'e boşluklu token verilmesi seçili durumu bozuyordu (P0).**
  Kontrast düzeltmesi sırasında `classList.remove('text-primary dark:text-primary-light')`
  gibi **tek string içinde iki sınıf** yazıldı. `DOMTokenList` boşluk kabul
  etmez ve geçersiz token'ı **sessizce** yok sayar — hata fırlatmaz. Sonuç:
  görev filtresinde "Tümü/Aktif" seçimi görsel olarak taşınmıyor, aktif menü
  vurgusu kayboluyordu. Ek olarak `toggle('text-slate-600', 'dark:text-slate-400', !on)`
  çağrısında ikinci string `force` argümanı sayılıyordu (truthy) → toggle hiç
  çalışmıyordu. 9 çağrı tek tek token'a ayrıldı. Ölçüm (gerçek uygulama,
  `scratch/probe-task-filter.cjs`): seçim `active → all` taşınıyor, eski düğme
  primary'yi bırakıp okunur renge dönüyor (**8/8 PASS**, kontrast 5,71:1).
  Regresyon: `tests/main/dom-token-safety.test.mjs` (2).
- **Ana sayfada birincil eylem dar ekranda kesiliyordu (P1).** `#view-dashboard`
  diğer tüm görünümlerin aksine `overflow-y-auto` içermiyordu; ata `#main-content`
  ise `overflow-hidden`. Ölçüm (önce): 1366×768'de CTA alt kenarı **735 / 728**
  (7 px taşma), 1024×768'de **163 px** kesik, kaydırma çubuğu yok. Düzeltme:
  görünüme `overflow-y-auto`, CTA kapsayıcısına `sticky bottom-0` + yarı saydam
  zemin. Ölçüm (sonra): 1366/1280/1024/1536/1920 boyutlarında **TAM GÖRÜNÜR**.
  Regresyon: `tests/e2e/dashboard-layout.spec.js`.
- **Yabancı kullanıcı uygulamayı Türkçe açıyordu (P0).** Üç katmanda birden
  `'tr'` varsayılanı vardı: `StorageService.getDefaultData()` `language: 'tr'`,
  `normalizeLanguage()` bilinmeyen dili `tr`ye çeviriyordu, renderer fallback'i
  de `tr` idi. Sunucu ayarları sistem dili algısından önce geldiği için
  **Rusça/Hintçe/Vietnamca bir Windows'ta ilk açılış Türkçe** oluyordu.
  Ölçüm (önce): `navigator.language="ru"` → `htmlLang="tr"`, `ppLocale="tr"`,
  menü "Ayarlar". Düzeltme: nötr varsayılan **İngilizce** (`FALLBACK_LANGUAGE`),
  depolama varsayılanı `language: null` ("kullanıcı seçmedi"), doğrulayıcıda
  `language` nullable enum, STT bilinmeyen dilde `en`. Ölçüm (sonra):
  `navigator.language="ru"` → `htmlLang="en"`, menü "Settings". Regresyon:
  `main-i18n.test.mjs` (+5), `lang-fallback.spec.js` (ru/hi/vi + tr korunur).
- **Mağaza URL'leri ölüydü (P0).** `store-listing.json` içindeki
  `privacyPolicyUrl` ve `supportUrl`, vellium.dev SPA'sında **yayınlanmayan**
  `/power-pilot/privacy` ve `/power-pilot/support` yollarına gidiyordu; canlı
  tarayıcıda başlık "Bu sayfa burada değil." (404) dönüyordu — Store başvurusu
  bu haliyle reddedilirdi. Canlı doğrulanmış sayfalara bağlandı:
  gizlilik → `/en/legal/privacy` (200, 4 617 krkt), destek →
  `/en/legal/support` (200, 2 180 krkt), EULA → `/en/legal/products/power-pilot`
  (Power Pilot'a özel), iletişim → `/en/contact`. Regresyon:
  `store-listing.test.mjs` → "URL'ler allowlist'teki gerçek sayfalara işaret
  eder (404 dead-link yok)".
- **Ana süreç çökme koruması eklendi.** `uncaughtException` /
  `unhandledRejection` için kanca yoktu; yakalanmamış bir hata uygulamayı
  sessizce kapatıyor ve log bırakmıyordu. Yeni saf `src/main/util/CrashGuard.js`
  hatayı redakte edilmiş biçimde loglar (yığın ilk 5 satır) ve süreci ayakta
  tutar. Regresyon: `tests/main/crash-guard.test.mjs` (7).
- **Kullanıcıya ham hata metni sızması giderildi.** `schedule-action` ve
  `create-task` IPC yanıtları `err.message` döndürüyordu; TaskManager bu
  mesajları Türkçe ürettiği için İngilizce/Japonca arayüzde Türkçe teknik metin
  görünüyordu. Artık teknik ayrıntı yalnızca loga yazılır, kullanıcıya
  `t('errorTaskCreationFailed')` gider. Regresyon:
  `tests/main/ipc-error-leak.test.mjs` (3).
- **"Uygunsuz içeriği bildir" çıkmazı giderildi.** Düğme ana sayfayı açıyordu
  (bildirim kanalı yok); artık Vellium iletişim sayfasına
  (`/en/contact` → Teknik Destek) gider.
- **Ölü i18n anahtarları temizlendi.** 10 anahtar (`aboutTitle`, `aboutSub`,
  `okText`, `socialHeader`, `timerText`, `willBe*` ×5) tüm repoda 0 referans
  doğrulandıktan sonra 17 dilden kaldırıldı: 723 → **713 anahtar**.
  `event_*` anahtarları korundu (dinamik: `t('event_' + ev)`).
- **Ölü değişkenler.** Hızlı zamanlayıcı başlatma yolundaki kullanılmayan
  `currentLang` ve `lang` kaldırıldı; `parseInt(minVal)` → `parseInt(minVal, 10)`.
- **Her açılışta basılan CSP konsol hatası giderildi.** `<meta>` içindeki
  `frame-ancestors 'none'` tarayıcı tarafından yok sayılıyor ve
  "directive is ignored when delivered via a <meta> element" hatası
  basılıyordu. Direktif meta'dan kaldırıldı; **yürürlükte kalmaya devam
  ediyor** çünkü aynı politika `onHeadersReceived` ile HTTP başlığı olarak
  gönderiliyor (`APP_CSP`). Ölçüm: `scratch/runtime-health.cjs` →
  önce 1 console.error, sonra **0**; `security.spec.js` 7/7 PASS.
- **Hakkında görünümüne destek girişi eklendi.** EULA, gizlilik, OSS ve
  "uygunsuz içerik bildir" vardı ama **destek/sorun bildirme girişi yoktu** —
  sorun yaşayan kullanıcının gideceği bir yol bulunmuyordu. `btn-support`
  eklendi → `/en/legal/support` (https allowlist içinde, 17 dilde çevrildi).
  Regresyon: `tests/e2e/about-links.spec.js` (düğmelerin gerçekten
  `shell.openExternal` çağırdığını ve çıplak ana sayfaya gitmediğini doğrular).
- **i18n "kullanılmayan anahtar" dedektörü düzeltildi.** Araç 86 anahtarı ölü
  bildiriyordu; gerçek ölü sayısı **0**. Kaçırdığı beş kullanım biçimi:
  harita değeri (`BUSY: 'aiBusy'`), nesne özelliği (`dict.timeFormatDays`),
  `this.translate('key')`, üçlü seçim (`t(x ? 'a' : 'b')`) ve dinamik önek
  (`t('event_' + ev)`). Dedektör bu biçimleri tanıyor; test dosyalarındaki
  anmalar artık "kullanım" sayılmıyor. Regresyon: `i18n-check.test.mjs` (+4) —
  hem yanlış pozitif hem yanlış negatif yönü kilitli.
- **Yayın artefaktından geliştirici dosyaları çıkarıldı.** `app.asar` içinde
  `playwright.config.js`, `vitest.config.js`, `tailwind.config.js`,
  `electron-builder*.cjs` ve `.nvmrc` son kullanıcıya gidiyordu; hiçbiri
  çalışma zamanında `require` edilmiyor (kanıt: 0 referans). Regresyon:
  `tests/main/packaged-hygiene.test.mjs` (4). Chromium dil paketleri zaten
  doğru kırpılmış durumda: **18 .pak / 11,93 MB**.
- **TLS yenileme runbook'u çalışmayan komut veriyordu.** `docs/runbooks/
  tls-renewal.md`, var olmayan `scripts/certs/generate.mjs` dosyasını
  çalıştırıyordu (`0` sonuç: dosya yok). Gerçek `.ps1` scriptleri ve gerçek
  parametreleriyle değiştirildi (CA → sunucu → istemci, varsayılan 10 yıl /
  90 gün / 30 gün).
- **DRY: `stableStringify` tek kaynağa taşındı.** Fonksiyon
  `src/console/ConsoleStore.js` ve `src/main/storage/MigrateV2.js` içinde
  birebir kopyaydı; imza (HMAC) ve migrasyon checksum'ı bu fonksiyona bağlı
  olduğu için kopyaların ayrışması sessiz imza uyuşmazlığı üretirdi. Yeni
  `src/main/util/stableStringify.js`. Regresyon:
  `tests/main/stable-stringify.test.mjs` (6).

### Performans ölçümü (gerçek uygulama)
`scratch/runtime-health.cjs` — 7 görünümün tamamı, 0 yakalanmamış hata:
`dashboard 9.2 ms / tasks 28.3 / templates 28.1 / history 28.2 / stats 27.8 /
settings 42.1 / about 14.6`; DOM 922–1026 düğüm (görünüm başına sabit,
sızıntı yok).

### Dokümantasyon ve Altyapı
- GitHub topluluk dosyaları eklendi: güvenlik politikası, katkı rehberi,
  davranış kuralları, destek rehberi, CODEOWNERS, issue/PR şablonları ve
  sürüm notu kategorileri.
- CI; salt-okunur izinler, eşzamanlılık, zaman aşımı, coverage/Playwright
  artefaktları ve sürümden bağımsız installer yollarıyla güncellendi.
  Haftalık bağımlılık denetimi ve Dependabot yapılandırması eklendi.
- README sürüm rozeti 1.1.0'a güncellendi; dokümantasyon indeksi ve GitHub
  politikaları bağlandı.

### Microsoft Store (MSIX) ve ilk kullanım
- **Store sürümü ayrıldı.** MSIX paketinde servis modu, konsol ajanı, LAN
  sunucusu ve Task Scheduler yedeği kapalı; autostart Windows Başlangıç
  ayarlarına devredildi (`StartupTask` manifest uzantısı). Uygulama içi
  "Başlangıç ayarlarını aç" düğmesi `ms-settings:startupapps` sayfasına gider.
  Store dışı Pro (NSIS/MSI) sürümü tüm kurumsal özellikleri korur.
- **Paket küçültüldü ve temizlendi.** Test/doküman/CI artıkları ile CUDA ve
  arm64 AI ikilileri paket dışına alındı: kurulu boyut ~1,3 GB → **~599 MB**,
  app.asar 106 MB → 68 MB. Store hedefi `appx` + `runFullTrust` + StartupTask
  olarak tanımlandı (`npm run pack:store`, `npm run dist:store`).
- **İlk açılış rehberi.** 3 adımlı rehberle normal kullanıcı tek tıkla
  "süre sonunda kapat", "işim bitince kapat" (ağ trafiği durunca) veya
  "gece uyut" görevi kurar; mevcut görevi olan kullanıcıya gösterilmez.
- **PIN çıkmazı giderildi.** PIN kurulmadan güvenlik ayarı (ör. otonomi)
  kaydedilmek istendiğinde sonsuz PIN modalı yerine "önce PIN oluşturun"
  mesajı verilir ve PIN kartına odaklanılır.

### Entegrasyon, erişilebilirlik ve mağaza hazırlığı
- **B2 — CLI artık API'nin tamamını kapsıyor ve tek kaynaktan üretiliyor.**
  `src/cli/powerpilot.js` yalnızca HTTP taşıması yapıyor; argüman ayrıştırma,
  istek gövdesi kurma ve doğrulama saf `src/cli/commands.js` kataloğunda
  (15 rotanın tamamı). Demo anahtar fallback'i kaldırıldı: CLI artık
  `POWERPILOT_API_KEY` olmadan çalışmıyor, `--help` ve `--json` destekliyor,
  kullanım hatasında çıkış kodu 2. Regresyon: `tests/main/cli-commands.test.mjs`
  (21). Doküman: `docs/integrations/POWERSHELL_AND_CLI.md`.
- **B3 — OpenAPI sözleşmesi koddan ayrışmıyor.** `/audit/verify` ucu ve
  `/audit` sorgu parametreleri (`limit`, `beforeSeq`, `verify`) belgelendi;
  rota listesini kodla karşılaştıran `tests/main/openapi-parity.test.mjs` (3)
  artık yeni uçlarda da kırılıyor.
- **C3 — 17 dilli mağaza metni tek kaynakta.** `docs/store/store-listing.json`
  tüm diller için ad, kısa/uzun açıklama ve özellik listesi taşıyor; Partner
  Center'ın sessiz ret nedenleri (alan sınırı, eksik dil, boş alan, yer tutucu
  sızıntısı) `tests/main/store-listing.test.mjs` (9) ile CI'da yakalanıyor.
  Metinlerin ürünle çelişmediği de doğrulanıyor: telemetri yok, veri silme,
  engellenme raporu, yerel AI ve kurumsal özelliklerin ayrı sürümde olduğu.
- **C4 — İkon-only düğmelerin erişilebilir adı var.** Süre adımlayıcılarının
  6 düğmesi ekran okuyucuda adsızdı; `data-i18n-aria-context` desteğiyle
  ("Gün: değeri artır") 17 dilde adlandırıldı. `scratch/audit-a11y.mjs`
  93 düğmenin tamamını adlı raporluyor; `tests/e2e/a11y.spec.js` PASS.
  i18n denetleyicisi artık `data-i18n-aria-label`/`-aria-context`
  kullanımlarını da tarıyor (kaçan anahtar kör noktası kapandı).
- **C5 — Cihazda kalan sağlık özeti.** Hakkında görünümünde çökmesiz oturum,
  görev başarı oranı ve son hataların **kategori** dağılımı gösteriliyor;
  hesaplama saf `src/main/services/HealthMetrics.js` içinde ve **hiçbir veri
  dışarı gitmiyor** (telemetri yok sözü korunuyor). Ham sonuç kodları
  arayüze sızmıyor. Regresyon: `tests/main/health-metrics.test.mjs` (10),
  `tests/e2e/health-summary.spec.js`.

### Düzeltmeler
- **Güvenlik kapısı sürekli kırmızıydı (yanlış pozitif).** `scripts/security-check.mjs`
  düz HTTP istemci URL'sini yasaklarken `http://schemas.microsoft.com/...`
  gibi XML **ad alanı** tanımlayıcılarını da yakalıyordu; bunlar ağ isteği
  değil, Task Scheduler XML'inde zorunlu ad alanlarıdır. Kural `schemas.`
  önekini istisna tutuyor. Kapı artık **153 dosyada temiz**; kapının kendisi
  `tests/main/security-gate.test.mjs` ile gerçekten çalıştırılıyor.
- **Sesli komut hiç çalışmıyordu (mikrofon izni).** Uygulama sesli komut için
  `navigator.mediaDevices.getUserMedia({ audio })` çağırıyordu ama Electron izin
  tutucusu yalnızca `notifications`'a izin veriyordu; mikrofon her seferinde
  reddediliyor ve kullanıcı "mikrofon izni yok" hatası alıyordu. İzin mantığı
  saf `src/main/security/Permissions.js` modülüne taşındı: bildirim ve
  **yalnızca ses** (video/kamera reddedilir), yalnızca `app://powerpilot`
  origin'inden. MSIX tarafında da `microphone` DeviceCapability bildirildi
  (`electron-builder.store.cjs`); üretilen manifestte
  `<DeviceCapability Name="microphone"/>` doğrulandı. Regresyon:
  `tests/main/permissions.test.mjs` (7).
- **Gizlilik politikası eklendi (mağaza zorunluluğu).** Microsoft Store, veri
  toplamayan uygulamalar için de gizlilik politikası URL'si ister; belge yoktu.
  `docs/store/PRIVACY_POLICY.md` iki dilli (TR/EN) yazıldı ve ürünün gerçek
  davranışıyla eşlendi: telemetri yok, "Verilerimi sil", mikrofon beyanı,
  cihazda saklanan veriler tablosu, ağ erişiminin yalnızca açık özelliklerde
  kullanıldığı. `store-listing.json`'a `privacyPolicyUrl` / `supportUrl` /
  `supportEmail` / `websiteUrl` eklendi; `store-listing.test.mjs` (11) bunları
  ve belgenin varlığını denetler. Ayrıca yayına hazır, **JavaScript'siz tek
  dosya** `docs/store/privacy.html` eklendi: vellium.dev bir SPA olduğu için
  `/power-pilot/privacy` adresi HTTP 200 dönse de JS çalışmadan yalnızca
  "Vellium" kabuğu görünüyordu; mağaza incelemesinde politika metninin
  görünmesi gerektiğinden statik sayfa şart. Test iki dili, gömülü metni ve
  `<script>` yokluğunu doğrular.
- **A2 — Açılışta beyaz parlama giderildi, açılış süresi ölçüldü.** Ana pencere
  varsayılan `show:true` ile açılıyordu; kullanıcı ilk kare gelmeden beyaz bir
  pencere görüyordu ("yarım açılmış" izlenimi). Pencere artık `show:false` +
  `backgroundColor` ile açılıp `ready-to-show` anında gösteriliyor. İlk boya
  (FCP) p95 **300 ms** / p50 268 ms (8 çalıştırma, ilk çalıştırma dahil;
  `scratch/boot-measure.js`), hedef p95 ≤ 2500 ms. Regresyon: E2E 26/26.
- **C1 — Store (MSIX) paketi gerçekten üretilebiliyor.** Mağaza yolu kod
  incelemesinde "hazır" görünüyordu ama uçtan uca hiç çalıştırılmamıştı;
  ilk gerçek denemede dört ayrı engel çıktı ve hepsi giderildi:
  1. `build-appx` electron-builder'ı `npx.cmd` ile çağırıyordu; Node 20+
     (CVE-2024-27980) `.cmd` spawn'ını `EINVAL` ile reddettiği için paket
     **hiç** üretilemiyordu. Artık CLI doğrudan mevcut Node ile çağrılıyor.
  2. Betik `WINDOWS_CERT_SUBJECT` doğruluyor, build ise `package.json`'daki
     ham `${env.WIN_CERT_SUBJECT}` üzerinden gidiyordu → doğru sertifikayla
     bile "Cannot find certificate". Artık doğrulanmış Subject açıkça veriliyor
     ve her zaman imza alanını çözen `electron-builder.config.cjs` geçiliyor.
  3. `appx.publisher` manifeste `${env.APPX_PUBLISHER}` olarak **ham** yazılıyor,
     MakeAppx "Publisher ayrıştırılamadı" ile reddediyordu; değer artık
     `electron-builder.config.cjs` içinde ortamdan çözülüyor.
  4. `build/appx-extensions.xml` iki hata taşıyordu: dosya AppxManifest içine
     gömüldüğü için `<?xml?>` bildirimi belge ortasında ikinci bir bildirim
     üretiyor (geçersiz XML) ve StartupTask `Executable` yolu paket içindeki
     gerçek konumla (`app\Power Pilot.exe`) uyuşmuyordu.
     Kanıt: `node scripts/build-appx.js --store` → `dist/PowerPilot_1.1.0_x64.appx`
     (159,8 MB, 113 girdi); manifestte `runFullTrust` + `windows.startupTask`
     (`Enabled="false"`, `TaskId="PowerPilotStartup"`, doğru EXE yolu).
     Regresyon: `tests/main/build-appx-gate.test.mjs` (8),
     `store-packaging.test.mjs` güncellendi. Yalnızca **gerçek mağaza
     sertifikasıyla imzalama** (bu makinedeki eski `signtool` HTTPS zaman
     damgasını desteklemiyor) ve WACK elle yapılır.
- **B5 — Mini zamanlayıcı çoklu monitörde yanlış ekrana düşüyordu.** Mini
  pencere her zaman `screen.getPrimaryDisplay()` köşesine sabitleniyordu;
  ana pencereyi ikincil ekranda kullanan kişi widget'ı başka ekranda görüyor,
  monitör söküldüğünde görünmez bir koordinatta kalabiliyordu. Yeni saf
  `src/main/services/MiniWindowPlacement.js` ana pencerenin (yoksa imlecin)
  bulunduğu ekranı seçiyor, çalışma alanına kırpıyor ve ekran yapılandırması
  değiştiğinde yeniden konumlandırıyor. Regresyon:
  `tests/main/mini-window-placement.test.mjs` (9).
- **A6 — Kapatma engellendiğinde artık sessiz kalmıyor.** Windows'ta
  `shutdown /s` komutu başarı dönse bile kaydedilmemiş işi olan uygulamalar
  oturum sonlandırmayı veto edebilir; Windows kendi onay penceresini gösterir
  ve Power Pilot görevi "başarılı" sayıp hiçbir şey söylemezdi. Yeni
  `TerminalActionVerifier` terminal eylemden (kapatma/yeniden başlatma/oturum
  kapatma) sonra kısa bir doğrulama penceresi açar; süreç hâlâ ayaktaysa
  kullanıcıya toast + kalıcı uyarı şeridi + tepsi balonu ile "Kapatma
  engellendi" raporu verilir. Gerçekten kapanırsa timer hiç çalışmaz (yanlış
  alarm yok); kullanıcı iptal ederse bekleyen rapor düşer.
  Regresyon: `tests/main/terminal-action-verifier.test.mjs` (10),
  `tests/main/taskmanager-shutdown-veto.test.mjs` (5),
  `tests/e2e/shutdown-veto.spec.js` (1).
- **P0 — Yeniden başlatmada tüm görevler ve ayarlar kayboluyordu (ACL).**
  Klasör sıkılaştırması `icacls <dizin> … /T` ile yapılıyordu; `(OI)(CI)F`
  maskesi `/T` ile dosyaların kendisine hiç ACE yazmadığı için `powerpilot.db`,
  `secrets.v1.json` ve yedekler **sahibi tarafından bile** açılamıyordu
  (`EPERM`). İkinci açılışta `DB_OPEN_FAILED` → bakım modu → veri kaybı.
  Düzeltme: dizin izinleri `/T` **olmadan** veriliyor (dosyalar kalıtımla
  alıyor), mevcut dosyalara ayrıca açık tam erişim yazılıyor ve açılışta
  **onarım kapısı** (`repairInheritedAccess`) eski sürümlerin bozduğu
  kurulumları sessizce iyileştiriyor (idempotent, sağlıklıda no-op).
  Erişim tespiti `fs.accessSync` yerine gerçek `open()` ile yapılıyor
  (accessSync bozuk dosyada yanlışlıkla OK dönüyordu).
  Regresyon: `tests/main/acl-secure.test.mjs` (P0 regresyon bloğu).
- **P0 — Türkçe Windows'ta uygulama kapalıyken yedek zamanlayıcı hiç
  kurulmuyordu.** `schtasks /sd MM/DD/YYYY` tarihi **sistem yereline** göre
  ayrıştırır; tr-TR gibi gün.ay.yıl kullanan sistemlerde
  `ERROR: Incorrect Start Date` veriyordu, yani "uygulama kapalıyken görev
  yine çalışsın" yedeği sessizce devre dışıydı. Görev artık yerel ayardan
  bağımsız **XML tanımıyla** (ISO 8601 `StartBoundary`) oluşturuluyor; bu
  arada iki sessiz hata da kapandı: yedek görev artık **pilde** de tetikleniyor
  (`DisallowStartIfOnBatteries=false`) ve makine uykuda/kapalıysa açılınca
  çalışıyor (`StartWhenAvailable=true`). Geçici XML dosyası iş bitince
  siliniyor. Gerçek `schtasks` ile tr-TR doğrulandı.
- **Kurulum boyutu 507 MB → 107 MB.** NSIS (Pro) paketi, hiçbir kullanıcının
  ihtiyaç duymadığı CUDA/cuDNN, Vulkan ve arm64 AI ikililerini taşıyordu
  (~370 MB). Ayrıca Chromium'un 55 yerel paketi (~47 MB) ve AI kitaplıklarının
  yalnız derleme/CI için gereken parçaları paket içindeydi:
  `node-llama-cpp/llama/gitRelease.bundle` (34 MB llama.cpp git geçmişi),
  `whisper.node/src` (9 MB C++ kaynağı), yalnız tarayıcıda yüklenen whisper
  WASM paketi (8 MB), `better-sqlite3` kaynak/derleme artıkları ve diğer
  platform prebuild'leri, ve tüm `.map` dosyaları.
  Sonuç: kurulum **107 MB**, kurulu boyut **377 MB**, Electron yerel paketi
  55 → 18 (17 arayüz dili + en-US). AI çalışma zamanı CPU ile çalışmaya devam
  ediyor; doğrulandı: `scratch/verify-llama-cpu-only.js` (CUDA+Vulkan gizliyken
  `getLlama()` PASS), whisper `loadWhisperModule()` PASS, paketlenmiş kurulum
  + SQLite açılışı (`packaged-e2e.ps1`) PASS. Regresyon:
  `store-packaging.test.mjs` (boyut dışlamaları + dil listesi).
- **Bakım modu artık görünür.** Depo açılamadığında (bozuk veritabanı,
  yarım migrasyon, kurcalanmış denetim zinciri) her kayıt sessizce
  reddediliyor ama arayüz normal görünüyordu; kullanıcı görevinin
  kaydedildiğini sanıyordu. Artık `get-storage-status` IPC'si üzerinden
  durum okunuyor ve üstte kırmızı, `role="alert"` uyarı şeridi çıkıyor
  ("Veri deposu bakım modunda; işlem yapılamıyor." / denetim kurcalandı
  metni). Metinler mevcut 17 dildeki anahtarlardan gelir. Regresyon:
  `tests/main/storage-status.test.mjs`.
- **"Verilerimi sil" akışı eklendi (Store 10.2.7).** Ayarlar > Gizlilik
  bölümünde onaylı, kalıcı silme akışı: görevler, ayarlar, geçmiş, PIN/API
  anahtarları, denetim kayıtları, yedekler, indirilen modeller ve loglar
  silinir; uygulama kapanır. PIN kuruluysa silme PIN ister. Silme mantığı
  saf `src/main/services/DataWipe.js` modülünde (enjekte edilebilir fs,
  yol-kökü dışına çıkmaz, kilitli dosyada yeniden dener ve **sessizce
  yutmak yerine** raporlar). 9 birim testi + gerçek dosya sistemiyle
  doğrulama (`scratch/verify-data-wipe.js`).
- **Dil sızıntıları giderildi.** Pencere denetimlerinin ve diyalog kapatma
  düğmelerinin erişilebilir adları (`aria-label`) sabit Türkçe/İngilizce
  yerine sözlükten geliyor; sesli komut "dinleniyor" durumu, açılış hata
  penceresi, AI netleştirme soruları/mesajları ve AI durum satırı aktif dile
  çevrildi. AI modeli indirme/yükleme hataları servis içindeki Türkçe metin
  yerine kod → sözlük anahtarı eşlemesiyle gösteriliyor (disk alanı, bağlantı,
  HTTP durumu, bütünlük doğrulaması); teknik ayrıntı log'da kalıyor.
  Statik Türkçe iskelet, sözlük uygulanana kadar `i18n-pending`
  kapısıyla gizlendiği için başka dilde açan kullanıcı yanlış dil görmez.
  Oturum içi dil değişiminde Smart Finish gibi çalışma zamanında üretilen
  etiketler de anahtardan yeniden çevriliyor (eski dilde kalmıyor).
  Yeni regresyon testi (`tests/renderer/i18n-keys.test.mjs`) tüm i18n
  başvurularının sözlükte bulunmasını, 17 dilin anahtar eşitliğini ve
  ikon-only düğmelerin i18n'li erişilebilir adını doğrular. E2E tarafında
  `i18n-all` pencere denetimlerinin 17 dildeki erişilebilir adını, yeni
  `i18n-switch` ise yeniden yükleme olmadan dil değişimini doğrular.
- **Ayarları kaydetmek gereksiz PIN istiyordu.** Dil/tema gibi güvenlik dışı
  ayarlar kaydedilirken değişmemiş `autonomyMode` alanı da patch'e girdiği
  için PIN'siz kurulumda tüm kayıt `PIN_REQUIRED` ile engelleniyordu.
  Güvenlik alanı artık yalnızca gerçekten değiştiğinde gönderiliyor; otorite
  değişimi PIN kapısından geçmeye devam ediyor.
- **P0 — Zamanlanmış güç eylemleri yükseltilmemiş kurulumda hiç çalışmıyordu.**
  Güvenlik motoru, aktif güç isteği kontrolü için `powercfg.exe /requests`
  çalıştırıyor; bu komut yönetici yetkisi ister ve paketlenmiş uygulama
  `asInvoker` çalışır. Sonuç: her görev `POWER_REQUESTS_UNAVAILABLE` ile
  engelleniyordu (fail-closed yanlış yere uygulanıyordu). Motor artık bir
  **yetenek sondası** yapar: yetenek varsa eski fail-closed davranışı aynen
  korunur; yetenek yoksa yalnız bu kapı atlanır ve durum **görünür** olur
  (`loadCheck: "unavailable"`, `audit` kaydı `power_request_check_unavailable`,
  Ayarlar uyarısı). `node scripts/safety-probe.mjs` ile tanı alınabilir.
- Uyarı bannerındaki Durdur/Ertele işlemleri PIN kapısını beklemiyordu; eylemler
  async hale getirildi, TOCTOU koruması eklendi ve banner yalnızca başarılı
  sonuçta kapanıyor.
- Material Symbols ikon fontu yüklenene kadar ligatür adları görünüyordu;
  `fonts-pending` açılış kapısı ile ikonlar font hazır olana kadar gizleniyor.
- Renderer `app://powerpilot` üzerinden yüklendiği için yalnızca `src` dizini
  sunuluyor; `../powerpilot_icon.png` ve `../public/Vellium-logo.svg` yolları
  404 dönüyordu ve arayüzde kırık görsel olarak görünüyordu. Logolar
  `src/assets/` altına alındı ve yollar güncellendi; `src` dışına işaret eden
  varlıkları yakalayan regresyon testi eklendi.
- Yerel REST API kartında not metinleri düğmelere yapışıyordu: 12 px yazı,
  notlar arası ve düğme öncesi düzenli boşluk, dar pencerede sarma eklendi.
  İkincil düğme kontrastı artırıldı.
- Koyu temada yerel form denetimleri (onay kutuları) beyaz çiziliyordu;
  `color-scheme: dark` ile tema uyumlu hale getirildi.
- Türkçe metinler düzeltildi: `Telefon QR'si` → `Telefon QR Kodu`,
  QR notundaki `tuş` → `anahtar`.

## [1.1.0] — Security & Reliability Hardening (2026-10-23)

### Güvenlik
- Emir imzası v2: RFC 8785 kanonik tam nesne imzası, nonce tek kullanım,
  `keyId`/`issuer` doğrulaması, makbuz uçları ve denetim kaydı.
- TLS/mTLS tek kaynak (`TlsConfig`); sessiz HTTP fallback yok. LAN ve konsol
  HTTPS zorunlu; konsol yalnızca loopback + açık `PP_ALLOW_INSECURE_CONSOLE=1`
  ile HTTP'ye izin verir.
- Sırlar Electron `safeStorage`/DPAPI ile `secrets.v1.json`'da; Argon2id PIN,
  deneme kilidi, ACL/EFS, log redaksiyonu ve dışa aktarımda maskeleme.
- `app://powerpilot` protokolü, katı CSP + güvenlik başlıkları, `sandbox:true`,
  IPC gönderen allowlist'i, dış bağlantı host allowlist'i, CSP ihlal logu.
- Güvenlik ayarları PIN'li ayrı IPC'de; API anahtarı üretimi denetlenir.
- Webhook HTTPS-only + SSRF DNS pinning + HMAC; WOL broadcast netmask'tan.
- Yıkıcı eylemler denetim zinciri bozulduğunda (`auditTampered`) durur.

### Veri ve dayanıklılık
- SQLite (`powerpilot.db`) tek gerçek kaynak; v2 JSON atomik migrasyonu,
  `quick_check`, WAL/secure_delete, değişen satır diff-flush.
- Denetim zinciri HMAC-SHA256 + günlük checkpoint + Windows Event Log özeti.
- Şifreli günlük yedekler, geri yükleme ve bakım modu runbook'ları.
- Konsol deposu SQLite/bellek ayrımı, kalıcı kuyruk ve makbuz yaşam döngüsü.

### Güvenilirlik ve performans
- Görev sonuç dinleyicileri, `task-executed`/`task-failed`, sistem uyanma
  yeniden senkronu, monotonik sayaç ve aktif görev geri yükleme.
- Fail-closed güvenlik politikası, güç isteği timeout/cache, gerçek fullscreen
  ve süreç listesi hataları.
- AI oturum serileştirmesi, metrik örnekleme kilidi, tray debounce ve merkezi
  timer kaydı; görev tablosunda delta render.
- Başsız ajan timer/temizlik kapatması.

### i18n ve paketleme
- 17 dil JSON kaynağı; ana süreçte `vm` yok, renderer yalnızca aktif dili yükler.
- Tailwind build-time; inline script/stil yok.
- Electron fuses, SHA-256 + RFC 3161 imza, CycloneDX SBOM + imzalı release
  manifesti, paketli E2E ve 100 ajan yük/soak testi.

## [1.0.1] — Release Hardening (2026-10-22)

### Güvenlik
- LAN API için IP/CIDR allowlist eklendi; hostname reddedilir, IPv4-mapped IPv6
  normalize edilir, zone ID güvenli ayrılır. Allowlist boşsa loopback dışı tüm
  istekler fail-closed reddedilir.
- ACL, rate-limit'ten önce uygulanır; rate-limit anahtar sayısı 1000 ile
  sınırlandırıldı. Yetkisiz IP'ler belleği büyütemez.
- `blockRemoteShutdownWhenActive` (varsayılan `true`) ile kullanıcı aktifken
  uzaktan shutdown/restart engellenir; kural icra anında da uygulanır.
- TLS/mTLS/sıkı TLS kombinasyonları doğrulanır; eksik sertifika materyali
  reddedilir. API çift yığın bind + IPv4 fallback ve güvenlik durum özeti.
- Şema v2: güvenli varsayılanlar, v1→v2 migrasyon, hostname filtreleme,
  migrasyon öncesi yedek ve prototip kirlenmesi koruması.

### Görev yürütme
- Atomik `executionClaims` claim/token durum makinesi: aynı görevin çift
  icrası ve `await` sonrası bayat token kullanımı engellendi.
- `evaluateTasks()` senkron kaldı; `handleTaskExecution` fire-and-forget
  çalışır. Uyarı iptali/ertelemesi aktif uyarıyı ve görevi birlikte çözer.
- Görev erteleme artık hedef zamanı ileri taşır; 1 saatlik bir görev 10 dakika
  ertelendiğinde yanlışlıkla 10 dakika sonraya çekilmez.
- Güç komutu başladıktan sonra iptal `CANCEL_TOO_LATE` döner; IPC bunu
  başarı gibi sunmaz.
- Boş `processName` fail-closed; `chrome` ve `chrome.exe` kanonik eşleşir.
  Bayat/boş süreç listesi tetikleme üretmez.

### Arayüz, görev yönetimi ve i18n
- Yeni **Görevler** ekranı: aktif/tüm filtreleri, otomatik yenileme, tetikleyici,
  sonraki çalışma, durum ve kalan süre; listeden iptal/erteleme ve PIN koruması.
- 17 dilde 595 anahtar: statik `data-i18n`, dinamik `t()` metinleri, placeholder
  ve başlık çevirileri; tray menüsü, balon bildirimleri ve IPC hata mesajları da
  ana süreçte yerelleştirildi.
- Hakkında ekranındaki sürüm artık `package.json`/`app.getVersion()` kaynağından
  okunur.
- Mini widget ve ana pencere için `backgroundThrottling: false`; arka planda
  kalan sayaç/animasyon donması giderildi.
- Gizlilik politikası internet/ağ ifadeleri ve açık kaynak lisans listesi gerçek
  çalışma zamanı bağımlılıklarıyla güncellendi.
- `#setting-language` üzerindeki yinelenen `class` özniteliği düzeltildi.

### Performans ve bütünlük
- 2 saniyelik PowerShell/tasklist yoklaması kaldırıldı; `ps-list@9` dinamik
  import + 5 saniyelik örnekleme + ihtiyaç kapısı kullanılır. ASAR dışı
  fastlist paket spike'ı eklendi.
- Idle ölçümü `powerMonitor.getSystemIdleTime()` üzerinden yapılır.
- Qwen/Whisper model URL'leri 40 karakterli immutable commit'e, tam bayt
  sayısına ve SHA-256'ya pinlendi. HTTP 200/206/416, Content-Range ve yarım
  `.part` finalizasyonu doğrulanır.
- Konsol makbuzları `peek/markSent/markFailed` ile idempotent hale getirildi;
  204/boş gövde 2xx yanıtı tek kez işaretlenir.

### Paketleme ve sürüm
- Sürüm `1.0.1`; Electron `43.4.0`, Node `24.18.1`, Vitest `3.2.4`,
  electron-builder `26.15.3`, Playwright `1.64.1` tam pinlendi.
- Varsayılan dağıtım yalnızca NSIS. `allowToChangeInstallationDirectory`
  için assisted installer (`oneClick=false`) kullanılır.
- APPX yalnızca `APPX_PUBLISHER` ve eşleşen sertifikayla üretilir.
- `release-check`, `verify-pack`, `spike:pslist`, `dist:appx` ve CI kapıları
  eklendi. İmzalama SHA-256 + RFC 3161 zaman damgasına ayarlandı.
- 17 dil / 595 anahtar paritesi, `en` fallback, Arapça RTL, aktif
  görev/uyarı geri yüklemesi ve tüm statik/dinamik UI anahtarlarının kapsamı
  doğrulandı. Çeviriler makine çevirisi temellidir; profesyonel dil incelemesi
  yayın öncesi dış adımdır.

### Test
- 51 test dosyası / 483 test; Playwright Electron açılış smoke testi ve
  i18n/görev görünümü E2E testi (dil değişimi, sürüm, görev oluşturma,
  erteleme, iptal) eklendi.
- `tests/main/i18n-coverage.test.mjs` statik anahtar kapsamını ve 17 dilde
  doluluk/pariteyi korur; `taskmanager.test.mjs` ertelemenin hedefi geri
  çekmediğini doğrular.

### Bilinen dış blocker'lar
- İmzalı RC için OV sertifikası, APPX için eşleşen publisher sertifikası.
- Profesyonel çeviri incelemesi.
- `v1.0.1` tag ve kademeli dağıtım, temiz ağaç ve release onayı bekliyor.

## [2.0.0] — Yayınlanmadı (geliştirme dalı)

### Eklenenler (WBS-E: opsiyonel enerji + otomatik tanıma)
- Watt/fiyat kurulumda ve ayarlarda **opsiyonel** (boş = `null`, uydurma sayı yok)
- Otomatik cihaz tanıma: kasa sınıfı (ChassisTypes), pilde gerçek deşarj ölçümü,
  donanım katman tahmini; ilk pilde-kullanımda sessiz arka-plan kalibrasyonu
- Eksik-veri boş-durumları: "—" kartlar + uyarı çipleri + Ayarlar derin-bağı
- Akıllı fiyat varsayılanı **3,24 TL** (EPDK Nisan 2026 mesken, `EFFECTIVE_FROM`
  damgalı; sürüm öncesi gözden geçirme STORE_CHECKLIST'te)
- Eski `(150, 2.5)` profilleri korunur + `legacy` rozetiyle doğrulamaya davet

### Eklenenler
- Smart Finish: 7 koşul türü, çoklu koşul kurucu (AND/OR, en fazla 3), kararlılık süresi, belirli-saat görevleri, zincir halkaları (F6, F11.1)
- Şablonlar: 10 hazır şablon, sınırsız kullanıcı şablonu (kaydet/kullan/sil, karantina) (F6)
- Entegrasyonlar: API açma/port/LAN arayüzü, webhook yönetim ekranı + secret maskeleme + test-gönderimi, telefon QR eşleşmesi, OpenAPI parite kilidi (F5, F11.4)
- AI Asistan (yerel, çevrimdışı): AiBackend durum makinesi, ModelManager (indir/resume/SHA-manifest), JSON-şemalı komut ayrıştırıcı, Asistan sekmesi, kurulum sihirbazı (F7)
- Sesli komut: whisper.cpp STT (Türkçe sabit dil, enerji kapısı, 15sn tavan), mikrofon akışı, sesli geri bildirim anahtarı (F8)
- Ajan sistemi: deterministik Orkestratör + 4 ajan (komut/teşhis/enerji/önerici), Ajan Kayıtları, susturma kuralları (F9)
- Çift mod: Klasik (varsayılan) / Tam Yetki, kuruluş-anı damgası, uyarı bandı (Durdur/Ertele/Şimdi), tray mod göstergesi (F9)
- Güvenlik: iptal PIN'i (SHA256+salt, 5 yanlışta 60sn kilit), açılış koruması (120sn), güç-istekli tam-ekran koruması (F11.2, F11.5)
- Klavye kısayolları (Alt+S/R/L/H, Esc, Ctrl+T) + kademeli uyarı (5dk/1dk/30sn, gece sessizliği) (F11.3)
- Kalıcılık: Windows Görev Zamanlayıcı yedeği + second-instance iletimi + kalıcı duraklatma (WBS-2.2, P0-2)

### Değişen Davranışlar (dikkat)
- Uyarı zaman-aşımı Klasik modda DURDURUR (eskiden her zaman devam ederdi); scheduler-ateşlemeli görevler etkilenmez.
- `create-task`/`save-settings`/`save-webhooks` IPC dönüş şekilleri `{success, ...}` sarmalayıcısına geçti.
- `powerpilot_data.json` şemasına eklendi: `autonomyMode`, `automationPaused`, `cancelPinHash/Salt`, `bootGuardSeconds`, `templates`, görevlerde `mode` + `chain`.

### Altyapı
- 244 otomatik test, kapsam kapıları (satır %80/fonksiyon %70/dal %65); GitHub Actions CI.
- Electron 40.8 → 43.4.0; `node-llama-cpp@3.20.0`, `@fugood/whisper.node@1.2.0-rc.1`, `qrcode-generator`, `@electron/rebuild`, `systeminformation@5.31.0`, `electron-log`.
- Renderer i18n verisi `src/renderer/i18n.js` dosyasına taşındı (parite testli).

### Bilerek Ertelenenler
- Otomatik güncelleme akışı (feed URL kararı bekleniyor).
- Tam renderer modülerizasyonu (i18n ayrıldı; mantık bölünmesi ayrı faz).
