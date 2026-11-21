/**
 * DocsKnowledgeBase.js — WP-4 & WP-8
 * Power Pilot uygulama dokümantasyonunun yapılandırılmış yerel bilgi tabanı ve
 * çevrimdışı hibrit BM25 arama motoru (Türkçe + İngilizce diakritik katlama ve
 * eşanlamlı genişletme ile).
 *
 * Sıfır ağ, sıfır harici vektör DB bağımlılığı — tamamen yerel ve deterministiktir.
 */
'use strict';

const STOP_WORDS = new Set([
    've', 'veya', 'ile', 'icin', 'gibi', 'daha', 'cok', 'bir', 'bu', 'su', 'o',
    'da', 'de', 'mi', 'mu', 'mı', 'mü', 'ne', 'nasil', 'nerede', 'hangi', 'kadar',
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'how', 'what', 'where',
    'can', 'does', 'are', 'you', 'your', 'about', 'into', 'when', 'use', 'using'
]);

const SYNONYMS = {
    kisayol: ['shortcut', 'hotkey', 'klavye', 'tus'],
    shortcut: ['kisayol', 'hotkey', 'keyboard'],
    cokme: ['crash', 'hata', 'log', 'rapor', 'tanilama', 'diagnostics', 'zip'],
    crash: ['cokme', 'error', 'log', 'diagnostics', 'bundle', 'zip'],
    sablon: ['template', 'hazir', 'otomasyon', 'preset', 'sifirla'],
    template: ['sablon', 'preset', 'automation', 'reset'],
    guvenlik: ['security', 'pin', 'argon2', 'tls', 'mtls', 'boot', 'guard', 'korunan'],
    security: ['guvenlik', 'pin', 'argon2', 'tls', 'mtls', 'boot', 'guard', 'protected'],
    indirme: ['download', 'network', 'ag', 'steam', 'torrent', 'smartfinish'],
    download: ['indirme', 'network', 'steam', 'smartfinish'],
    ikon: ['icon', 'simge', 'gorev', 'cubugu', 'masaustu', 'cyan', 'monokrom'],
    icon: ['ikon', 'taskbar', 'desktop', 'shortcut', 'cyan', 'monochrome'],
    api: ['rest', 'http', 'https', 'curl', 'port', '18456', 'token', 'key'],
    webhook: ['n8n', 'hmac', 'bildirim', 'https', 'olay', 'event'],
    wol: ['wake', 'lan', 'mac', 'uyandir', 'magic', 'packet'],
    ups: ['nut', 'pil', 'batarya', 'kesinti', '3493', 'battery'],
    mcp: ['claude', 'cursor', 'windsurf', 'ajan', 'agent', 'ai'],
    ai: ['yapay', 'zeka', 'asistan', 'llm', 'gguf', 'whisper', 'sesli', 'rag'],
    istatistik: ['stats', 'enerji', 'kwh', 'watt', 'tasarruf', 'co2', 'fatura'],
    stats: ['istatistik', 'energy', 'kwh', 'watt', 'savings', 'co2'],
    yedek: ['backup', 'export', 'import', 'disa', 'ice', 'aktar', 'aes'],
    backup: ['yedek', 'export', 'import', 'restore', 'aes'],
    konsol: ['console', 'enterprise', 'kurumsal', 'filo', 'audit', 'denetim'],
    console: ['konsol', 'enterprise', 'fleet', 'audit', 'exemption']
};

function foldText(raw) {
    return String(raw || '')
        .replace(/İ/g, 'i')
        .replace(/I/g, 'i')
        .toLowerCase()
        .replace(/ğ/g, 'g')
        .replace(/ş/g, 's')
        .replace(/ı/g, 'i')
        .replace(/ö/g, 'o')
        .replace(/ü/g, 'u')
        .replace(/ç/g, 'c')
        .replace(/[^a-z0-9_.:/-]+/g, ' ')
        .trim();
}

function tokenize(raw, { expandSynonyms = false } = {}) {
    const folded = foldText(raw);
    if (!folded) return [];
    const rawTokens = folded.split(/\s+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    if (!expandSynonyms) return rawTokens;
    const expanded = new Set(rawTokens);
    for (const tok of rawTokens) {
        if (SYNONYMS[tok]) {
            for (const syn of SYNONYMS[tok]) expanded.add(syn);
        }
        // Basit Türkçe/İngilizce ek soyma eşleşmesi (başlangıç kökü)
        for (const [root, syns] of Object.entries(SYNONYMS)) {
            if (tok.startsWith(root) && tok.length <= root.length + 5) {
                expanded.add(root);
                for (const syn of syns) expanded.add(syn);
            }
        }
    }
    return [...expanded];
}

const DOC_CHUNKS = Object.freeze([
    {
        id: 'quickstart-overview',
        sectionId: 'docs-sec-quickstart',
        category: 'quickstart',
        titleTr: 'Power Pilot Hızlı Başlangıç ve Temel Çalışma Mantığı',
        titleEn: 'Power Pilot Quick Start & Core Concepts',
        tags: ['baslangic', 'quickstart', 'zamanlayici', 'timer', 'tray', 'tepsi', 'mini', 'widget'],
        bodyTr: 'Power Pilot tamamen çevrimdışı (sıfır telemetri) çalışan bir Windows güç otomasyon aracıdır. Panel ekranından 6 güç eyleminden (Kapat, Yeniden Başlat, Uyku, Hazırda Beklet, Kilitle, Oturumu Kapat) birini seçip hızlı geri sayım veya belirli saat/tekrarlama planlayabilirsiniz. Aktif görev varken ana pencere arka plana alındığında kompakt Mini Widget otomatik belirir ve uygulama Sistem Tepsisi (Tray) üzerinden yönetilebilir.',
        bodyEn: 'Power Pilot is a 100% offline, zero-telemetry Windows power automation suite. From the Dashboard, choose one of 6 power actions (Shutdown, Restart, Sleep, Hibernate, Lock, Sign Out) and schedule a countdown, clock time, or recurring schedule. While a task is active, minimizing or unfocusing shows the compact Mini Widget and keeps controls available from the System Tray.',
        command: null
    },
    {
        id: 'autonomy-modes',
        sectionId: 'docs-sec-power-safety',
        category: 'safety',
        titleTr: 'Otonomi Modları: Klasik (Classic) ve Tam Otonom (Full)',
        titleEn: 'Autonomy Modes: Classic vs Full Autonomous',
        tags: ['otonomi', 'autonomy', 'classic', 'full', 'uyari', 'warning', 'pin'],
        bodyTr: 'Klasik (Classic) modda ön uyarı sayacı bittiğinde kullanıcı onayı olmadan yıkıcı güç işlemi durdurulur (güvenli varsayılan). Tam Otonom (Full) modda ön uyarı geri sayımı dolunca işlem otomatik yürütülür; kullanıcı bu sürede İptal veya Ertele (Snooze) yapabilir. Otonomi modu güvenlik ayarıdır ve PIN korumasıyla değiştirilir.',
        bodyEn: 'In Classic mode, the action halts when the pre-warning countdown ends unless explicitly confirmed. In Full mode, the action proceeds automatically once the pre-warning countdown completes unless cancelled or snoozed. Changing autonomy mode is PIN-protected.',
        command: null
    },
    {
        id: 'safety-guardrails',
        sectionId: 'docs-sec-power-safety',
        category: 'safety',
        titleTr: 'Güvenlik Kalkanları: Korunan Uygulamalar, Boot Guard, Bekleme Süresi ve Uzaktan Onay',
        titleEn: 'Safety Guardrails: Protected Apps, Boot Guard, Grace Period & Remote Approval',
        tags: ['guvenlik', 'safety', 'protected', 'korunan', 'boot', 'guard', 'fullscreen', 'tam ekran', 'fallback', 'pin', 'argon2', 'bekleme', 'grace', 'zorla', 'force', 'onay', 'approval'],
        bodyTr: 'SafetyPolicyEngine her güç eyleminden önce şu kalkanları doğrular: (1) Korunan Uygulamalar — liste Ayarlar → Otomasyon ekranındaki Güvenlik Politikası kartından düzenlenir; oyun istemcileri (Steam, Epic, Discord) varsayılan olarak dayatılmaz ve bir görev kendi izlediği süreçten muaftır, (2) Tam Ekran ve Aktif Güç İsteği koruması (yükseltilmiş yetki yoksa bu kapı GÖRÜNÜR biçimde atlanır, sessizce açık bırakılmaz), (3) Boot Guard — açılıştan sonraki 120 sn içinde boşta tetiklenmeyi engeller, (4) Uyku sonrası kaçırılan görev politikası (çalıştır/atla + tolerans), (5) Yedek Eylem, (6) Argon2id PIN kilidi — iptal PIN kodu asla düz metin saklanmaz: Argon2id (m=19456 KiB, t=2, p=1) ile 16 bayt rastgele tuz üzerinden 32 baytlık özet üretilir ve PHC biçiminde tutulur; doğrulama sabit zamanlı karşılaştırmayla yapılır. Ek olarak: "Açık Uygulamalar İçin Bekleme Süresi" Windows tarafında GERÇEK bir gecikme kurar (/t) ve bu pencerede iptal, zamanlanmış kapatmayı gerçekten durdurur (shutdown /a); "Zorla Kapatma" seçeneği açıkken engelleyen uygulamalar /f ile kapatılır; "Uzaktan Onay" açıkken local_api/n8n/konsol kaynaklı görevler yerel insan onayı olmadan çalışmaz ve sayaç dolarsa iptal edilir.',
        bodyEn: 'SafetyPolicyEngine validates these guardrails before every power action: (1) Protected Applications — the list is user-editable from the Safety Policy card under Settings → Automation; game launchers (Steam, Epic, Discord) are not forced defaults, and a task is exempt from the process it itself watches, (2) Fullscreen and Active Power Request guards (when elevation is unavailable this gate is skipped VISIBLY, never silently left open), (3) Boot Guard — blocks idle triggers within 120s of boot, (4) Missed-task wake policy (run/skip with tolerance), (5) Fallback action, (6) Argon2id PIN lock — the cancel PIN is never stored in plaintext: Argon2id (m=19456 KiB, t=2, p=1) derives a 32-byte hash from a random 16-byte salt and stores it as a PHC string; verification is constant-time. Additionally: the "Grace period for open apps" setting installs a REAL Windows delay (/t), and cancelling inside that window actually aborts the scheduled shutdown (shutdown /a); "Force close apps" terminates blocking apps with /f; and "Remote approval required" makes local_api/n8n/console tasks wait for a local human confirmation, cancelling when the countdown expires.',
        command: null
    },
    {
        id: 'smartfinish-conditions',
        sectionId: 'docs-sec-smartfinish',
        category: 'smartfinish',
        titleTr: 'Smart Finish Koşul Motoru (8 Koşul Türü ve AND/OR Mantığı)',
        titleEn: 'Smart Finish Condition Engine (8 Condition Types & AND/OR Logic)',
        tags: ['smartfinish', 'smart finish', 'kosul', 'condition', 'network_speed', 'cpu_usage', 'user_idle', 'process_running', 'file_stable', 'directory_idle', 'disk_activity', 'battery_level', 'and', 'or', 'stability'],
        bodyTr: 'Smart Finish, bilgisayarı zamana göre değil işin gerçekten bitmesine göre kapatır. Desteklenen 8 koşul türü: process_running (uygulama kapanınca/açıkken), network_speed (indirme hızı KB/s eşiğinin altına düşünce), cpu_usage (CPU % eşiği altı), disk_activity (disk etkinliği KB/s eşiği altı; ölçülemezse koşul sağlanmış sayılmaz), user_idle (klavye/fare boşta kalma süresi), file_stable (tek dosya değişmeyince), directory_idle (klasör içeriği sabit kalınca), battery_level (pil yüzdesi altı/üstü). Birden fazla koşulu VE (AND) veya VEYA (OR) operatörü ve kararlılık süresi (stabilitySeconds) ile birleştirebilirsiniz.',
        bodyEn: 'Smart Finish executes actions when real workloads finish instead of guessing timers. All 8 condition types are supported: process_running, network_speed, cpu_usage, disk_activity, user_idle, file_stable, directory_idle, and battery_level. Combine multiple conditions with AND/OR logic and a stability window (stabilitySeconds) to prevent false triggers.',
        command: null
    },
    {
        id: 'templates-management',
        sectionId: 'docs-sec-templates',
        category: 'templates',
        titleTr: 'Hazır Otomasyon Şablonları: Oluşturma, Düzenleme, Silme ve Sıfırlama',
        titleEn: 'Automation Templates: Create, Edit, Delete, Reset & Restore',
        tags: ['sablon', 'template', 'kategori', 'category', 'olustur', 'duzenle', 'sil', 'sifirla', 'geri', 'export', 'import'],
        bodyTr: 'Şablonlar ekranında İndirme, Render, Oyun, Üretkenlik, Zamanlı, Güç/Pil ve Güvenlik kategorilerine ayrılmış 22 varsayılan şablon bulunur. "+ Yeni Şablon Oluştur" butonuyla sıfırdan süreli, saatli/tekrarlı veya çoklu Smart Finish koşullu kendi şablonunuzu oluşturabilirsiniz. Hem özel hem yerleşik şablonları düzenleyebilir, çoğaltabilir veya silebilirsiniz. Düzenlenen yerleşik şablonlar tek tıkla varsayılana sıfırlanabilir; gizlenen/silinen yerleşik şablonlar "Varsayılanları Geri Getir" penceresinden tek tek veya toplu geri yüklenebilir. JSON olarak dışa/içe aktarma desteklenir.',
        bodyEn: 'The Templates view provides 22 categorized built-in templates across Download, Render, Gaming, Productivity, Schedule, Power/Battery, and Security. Use "+ New Template" to build custom duration, clock/recurring, or multi-condition Smart Finish templates from scratch. Both custom and built-in templates can be edited, duplicated, or deleted; modified built-ins can be reset to defaults and hidden built-ins restored individually or all at once, plus JSON export/import.',
        command: null
    },
    {
        id: 'ai-assistant-guide',
        sectionId: 'docs-sec-ai',
        category: 'ai',
        titleTr: 'AI Asistan: Doğal Dil, Şablon Oluşturma, Bağlantı Ayarlama ve Doküman RAG',
        titleEn: 'AI Assistant: Natural Language, Templates, Integrations & Docs RAG',
        tags: ['ai', 'asistan', 'assistant', 'llm', 'gguf', 'whisper', 'stt', 'sesli', 'voice', 'rag', 'dokuman', 'sablon', 'baglanti'],
        bodyTr: 'Power Pilot AI Asistanı 4 temel kabiliyet sunar ve hibrit motoru sayesinde 1.5 GB GGUF modeli indirilmeden bile çalışır: (1) Doğal dil ile görev planlama ("45 dk sonra kapat", "indirme bitince uyut"), (2) Şablon oluşturma ("Render bitince kapatan şablon oluştur"), (3) Bağlantı ve entegrasyon ayarlama ("REST API 18456 portunu aç", "n8n webhook ekle", "UPS 192.168.1.50 ayarla", "WoL cihazı ekle"), (4) Yerel Doküman RAG soru-cevap ("Kısayollar nasıl değiştirilir?", "MCP nasıl bağlanır?"). İsteğe bağlı yerel Qwen GGUF modeli ve Whisper sesli komut modeli tamamen bilgisayarınızda çalışır; minimum 4 GB RAM önerilir. Tüm değişiklikler insan onay kartından geçer.',
        bodyEn: 'Power Pilot AI Assistant delivers 4 capabilities with a hybrid engine that works immediately even without downloading the optional 1.5 GB local GGUF LLM: (1) Natural-language task scheduling, (2) Creating automation templates, (3) Configuring integrations & connections (REST API, Webhooks, WoL, UPS, MCP), and (4) Local Docs RAG Q&A grounded in official app docs. All mutating actions show a human-in-the-loop confirmation card and enforce PIN policies.',
        command: null
    },
    {
        id: 'cli-reference',
        sectionId: 'docs-sec-cli',
        category: 'cli',
        titleTr: 'CLI Komut Satırı Referansı ve PowerShell Otomasyonu',
        titleEn: 'CLI Reference & PowerShell Automation',
        tags: ['cli', 'terminal', 'powershell', 'komut', 'command', 'status', 'schedule', 'tasks', 'cancel', 'snooze', 'pause', 'resume'],
        bodyTr: 'Power Pilot CLI (src/cli/powerpilot.js) yerel REST API ile konuşur. POWERPILOT_API_KEY ortam değişkeni zorunludur; isteğe bağlı POWERPILOT_API_HOST (varsayılan 127.0.0.1), POWERPILOT_API_PORT (varsayılan 18456), TLS için POWERPILOT_API_TLS=1 ve POWERPILOT_API_CA=<sertifika yolu>. Komutlar: status, tasks [--limit N] [--offset N], timer --action <eylem> --durationMs <ms> | --minutes <dk> [--name <ad>], cancel --id <taskId>, doğrudan güç eylemleri (lock | signout | restart | sleep | hibernate | shutdown), audit [--limit N] [--beforeSeq N] [--verify], audit-verify, inventory, exemptions, maintenance-windows, orders. Genel bayraklar: --json (ham JSON) ve --help.',
        bodyEn: 'The Power Pilot CLI (src/cli/powerpilot.js) communicates with the Local REST API. POWERPILOT_API_KEY is required; POWERPILOT_API_HOST (default 127.0.0.1), POWERPILOT_API_PORT (default 18456), and for TLS POWERPILOT_API_TLS=1 with POWERPILOT_API_CA=<cert path>. Commands: status, tasks [--limit N] [--offset N], timer --action <action> --durationMs <ms> | --minutes <min> [--name <name>], cancel --id <taskId>, direct power actions (lock | signout | restart | sleep | hibernate | shutdown), audit [--limit N] [--beforeSeq N] [--verify], audit-verify, inventory, exemptions, maintenance-windows, orders. Global flags: --json and --help.',
        command: 'node src/cli/powerpilot.js timer --action shutdown --durationMs 2700000'
    },
    {
        id: 'mcp-server-guide',
        sectionId: 'docs-sec-mcp',
        category: 'mcp',
        titleTr: 'MCP Sunucusu: Claude Desktop, Cursor, Windsurf ve Antigravity Entegrasyonu',
        titleEn: 'MCP Server: Claude Desktop, Cursor, Windsurf & Antigravity Integration',
        tags: ['mcp', 'model context protocol', 'claude', 'cursor', 'windsurf', 'antigravity', 'stdio', 'json', 'tools'],
        bodyTr: 'Power Pilot yerleşik bir Model Context Protocol (MCP) stdio sunucusu (src/mcp/server.js) içerir. Önce Entegrasyonlar → Yerel REST API altından sunucuyu etkinleştirip bir API anahtarı üretin. Ardından Entegrasyonlar → MCP Sunucusu sayfasındaki hazır JSON yapılandırmasını Claude Desktop, Cursor, Windsurf veya Antigravity MCP ayarlarına yapıştırın. Sunulan 8 araç: powerpilot_status (durum ve sürüm), powerpilot_list_tasks (görev listesi), powerpilot_schedule_timer (süreli görev), powerpilot_cancel_timer (görevi iptal et), powerpilot_power_action (anında güç eylemi), powerpilot_audit_verify (denetim zinciri doğrulama), powerpilot_inventory (donanım envanteri), powerpilot_pending_orders (bekleyen konsol emirleri).',
        bodyEn: 'Power Pilot ships a native stdio MCP server (src/mcp/server.js). First enable Local REST API and generate an API key under Integrations → Local REST API. Then copy the ready-to-use JSON config from Integrations → MCP Server into Claude Desktop, Cursor, Windsurf, or Antigravity. It exposes 8 tools: powerpilot_status, powerpilot_list_tasks, powerpilot_schedule_timer, powerpilot_cancel_timer, powerpilot_power_action, powerpilot_audit_verify, powerpilot_inventory, and powerpilot_pending_orders.',
        command: 'node src/mcp/server.js'
    },
    {
        id: 'rest-api-endpoints',
        sectionId: 'docs-sec-api',
        category: 'api',
        titleTr: 'Yerel REST API Uç Noktaları, Roller ve TLS / mTLS Güvenliği',
        titleEn: 'Local REST API Endpoints, Roles & TLS / mTLS Security',
        tags: ['api', 'rest', 'endpoint', 'curl', 'port', '18456', 'tls', 'mtls', 'lan', 'role', 'viewer', 'operator', 'admin', 'x-api-key'],
        bodyTr: 'Yerel REST API varsayılan olarak yalnızca 127.0.0.1:18456 üzerinde dinler ve X-API-Key başlığıyla doğrulanır. 3 rol vardır: viewer (yalnızca okuma), operator (görev oluşturma/iptal), admin (tam erişim). LAN modu açıldığında izinli IP listesi (CIDR/IP) ve TLS/mTLS istemci sertifika parmak izi doğrulaması zorunlu kılınabilir. Uç noktalar: GET /api/v1/status, GET /api/v1/tasks (limit/offset), POST /api/v1/tasks/timer, POST /api/v1/tasks/:id/cancel, POST /api/v1/power/lock | signout | restart | sleep | hibernate | shutdown, GET /api/v1/audit (limit/beforeSeq/verify), GET /api/v1/audit/verify, GET /api/v1/inventory, GET /api/v1/exemptions, GET /api/v1/maintenance-windows, GET /api/v1/orders/pending.',
        bodyEn: 'The Local REST API binds to 127.0.0.1:18456 by default and authenticates via the X-API-Key header with 3 roles: viewer (read-only), operator (create/cancel tasks), and admin. Enabling LAN mode supports IP allowlists and TLS/mTLS client certificate fingerprint pinning. Endpoints: GET /api/v1/status, GET /api/v1/tasks (limit/offset), POST /api/v1/tasks/timer, POST /api/v1/tasks/:id/cancel, POST /api/v1/power/lock | signout | restart | sleep | hibernate | shutdown, GET /api/v1/audit (limit/beforeSeq/verify), GET /api/v1/audit/verify, GET /api/v1/inventory, GET /api/v1/exemptions, GET /api/v1/maintenance-windows, and GET /api/v1/orders/pending.',
        command: 'curl -H "X-API-Key: <API_KEY>" http://127.0.0.1:18456/api/v1/status'
    },
    {
        id: 'webhooks-n8n',
        sectionId: 'docs-sec-api',
        category: 'api',
        titleTr: 'Webhooks, n8n Entegrasyonu ve HMAC-SHA256 İmza Doğrulama',
        titleEn: 'Webhooks, n8n Integration & HMAC-SHA256 Verification',
        tags: ['webhook', 'n8n', 'zapier', 'make', 'hmac', 'bearer', 'basic', 'ssrf', 'https'],
        bodyTr: 'Webhook motoru yalnızca HTTPS adreslerine izin verir ve SSRF koruması (özel/loopback/link-local IP engeli + DNS pinning) uygular. Desteklenen olaylar: task_created, task_blocked, task_warning_started, task_cancelled, task_snoozed, power_action_started. Kimlik doğrulama: Bearer Token, Basic Auth veya X-PowerPilot-Signature (sha256 HMAC, "<timestamp>.<body>") imzası. Başarısız 5xx/429 teslimatlar üstel geri çekilmeyle 3 kez yeniden denenir.',
        bodyEn: 'Webhooks enforce HTTPS-only URLs with SSRF protection (blocking private/loopback ranges + DNS pinning). Supported events: task_created, task_blocked, task_warning_started, task_cancelled, task_snoozed, power_action_started. Supports Bearer Token, Basic Auth, and HMAC-SHA256 signing via X-PowerPilot-Signature over "<timestamp>.<body>".',
        command: null
    },
    {
        id: 'wol-ups-enterprise',
        sectionId: 'docs-sec-integrations',
        category: 'integrations',
        titleTr: 'Wake-on-LAN (WoL), UPS (NUT) İzleme ve Kurumsal Konsol / Denetim Zinciri',
        titleEn: 'Wake-on-LAN, UPS (NUT) Monitoring & Enterprise Console / Audit Chain',
        tags: ['wol', 'wake', 'mac', 'ups', 'nut', '3493', 'enterprise', 'kurumsal', 'konsol', 'console', 'audit', 'denetim', 'server', 'workstation'],
        bodyTr: 'Entegrasyonlar bölümünde Wake-on-LAN ile ağdaki cihazları MAC adresiyle uyandırabilir ve sık kullanılan cihazları profil olarak kaydedebilirsiniz. UPS / NUT İzleme, TCP 3493 üzerinden NUT uyumlu kesintisiz güç kaynaklarının pil seviyesini ve OB/LB durumunu sorgular. Kurumsal Konsol (Pro sürüm) imzalı filo emirleri, cihaz envanteri, muafiyetler, Sunucu/İş İstasyonu rol koruması ve kurcalamaya dayanıklı HMAC-SHA256 denetim zinciri sunar.',
        bodyEn: 'Under Integrations, Wake-on-LAN sends UDP Magic Packets and saves reusable device profiles. UPS / NUT Monitoring queries NUT-compatible UPS units on TCP 3493 for charge and OB/LB state. Enterprise Console (Pro builds) provides signed fleet orders, device inventory, exemptions, server-role safety locks, and a tamper-evident HMAC-SHA256 audit log.',
        command: null
    },
    {
        id: 'app-icons-themes',
        sectionId: 'docs-sec-quickstart',
        category: 'appearance',
        titleTr: 'Uygulama İkonu (4 Varyant) ve 28 Tema Kombinasyonu',
        titleEn: 'App Icon (4 Variants) & 28 Theme Combinations',
        tags: ['ikon', 'icon', 'monokrom', 'cyan', 'tema', 'theme', 'karanlik', 'dark', 'light', 'portable', 'kisayol'],
        bodyTr: 'Ayarlar → Görünüm bölümünde 2 mod (Açık/Koyu) × 14 renk paleti (28 tema) ve 4 uygulama ikonu (Koyu Monokrom, Açık Monokrom, Saf Siyah-Beyaz, Klasik Cyan) seçilebilir. Seçilen ikon uygulama içi logoya, pencere/görev çubuğu simgesine, sistem tepsisine, mini pencereye ve Windows Masaüstü/Başlat/Sabitlenmiş Görev Çubuğu (.lnk) kısayollarına eşzamanlı uygulanır. Portable (.exe) modda Windows çalışan .exe dosyasının gömülü simgesini kilitleyeceğinden, masaüstünde dinamik ikonlu kısayol oluşturmak için İkon Seçici içindeki "Dinamik İkonlu Masaüstü Kısayolu Oluştur" butonunu kullanabilirsiniz.',
        bodyEn: 'Settings → Appearance offers 2 modes × 14 color palettes (28 themes) and 4 app icons (Monochrome Dark, Monochrome Light, Pure High-Contrast, Classic Cyan). The active icon syncs across in-app logos, taskbar/window icon, system tray, mini widget, and Windows .lnk shortcuts. In Portable mode, use the one-click "Create Dynamic Desktop Shortcut" button since Windows locks the embedded PE icon of a running .exe.',
        command: null
    },
    {
        id: 'diagnostics-crash-reports',
        sectionId: 'docs-sec-shortcuts',
        category: 'troubleshooting',
        titleTr: 'Tanılama, Hata/Çökme Raporları ve Destek Paketi (ZIP)',
        titleEn: 'Diagnostics, Crash Reports & Support Bundle (ZIP)',
        tags: ['tanilama', 'diagnostics', 'cokme', 'crash', 'hata', 'error', 'log', 'zip', 'destek', 'support', 'sorun', 'bildir'],
        bodyTr: 'Ayarlar → Tanılama ve Raporlar ekranında ana süreç ve arayüz kaynaklı tüm yakalanan hata/çökme kayıtları ile sistem logları maskelenmiş biçimde görüntülenir. "Destek Paketi Oluştur (ZIP)" butonu İndirilenler klasörüne tüm logları, sistem bilgisini, maskeli ayar özetini ve denetim zinciri durumunu içeren bir ZIP arşivi kaydeder (hiçbir PIN/API anahtarı/kullanıcı adı sızmaz). Paket oluşturulduktan sonra tek tıkla klasörde açabilir, support@vellium.dev için e-posta taslağı başlatabilir veya GitHub üzerinde sorun bildirebilirsiniz.',
        bodyEn: 'Settings → Diagnostics & Crash Reports displays redacted crash/error logs and system events from both main and renderer processes. "Create Support Bundle (ZIP)" writes a sanitized ZIP archive to your Downloads folder containing logs, system info, redacted settings, and audit status, with one-click Reveal in Folder, support@vellium.dev mail draft, and GitHub Issue reporting.',
        command: null
    },
    {
        id: 'shortcuts-and-backup',
        sectionId: 'docs-sec-shortcuts',
        category: 'shortcuts',
        titleTr: 'Özelleştirilebilir Klavye Kısayolları ve Ayar Yedekleme (İçe / Dışa Aktarma)',
        titleEn: 'Customizable Keyboard Shortcuts & Settings Export / Import',
        tags: ['kisayol', 'shortcut', 'klavye', 'ctrl', 'escape', 'f1', 'yedek', 'backup', 'export', 'import', 'json'],
        bodyTr: 'Ayarlar → Klavye Kısayolları sekmesinde 5 genel kısayolu (Tema Değiştir: Ctrl+T, Hızlı Başlat: Ctrl+Enter, Aktif Görevi/Pencereyi İptal: Escape, Ayarlar: Ctrl+,, Dokümantasyon: F1) tıklayıp yeni tuş kombinasyonuna basarak özelleştirebilir veya varsayılanlara sıfırlayabilirsiniz. Ayrıca Alt+S/R/L/H/K ile hızlı eylem seçimi yapılır. Ayarlar → Sıfırlama ve Gizlilik altından tüm tercihlerinizi (sırlar hariç) gerçek JSON dosyası olarak dışa/içe aktarabilir ve otomatik AES-256 yedeklemeyi yönetebilirsiniz.',
        bodyEn: 'Under Settings → Keyboard Shortcuts, customize all 5 global shortcuts (Toggle Theme: Ctrl+T, Quick Start: Ctrl+Enter, Cancel: Escape, Settings: Ctrl+,, Docs: F1) via the interactive key recorder or reset to defaults. Under Settings → Reset & Privacy, export/import your settings as a JSON file (excluding secrets) and configure encrypted local backups.',
        command: null
    },
    {
        id: 'statistics-energy-guide',
        sectionId: 'docs-sec-quickstart',
        category: 'stats',
        titleTr: 'İstatistikler ve Dürüst Enerji Tasarrufu Ölçümü',
        titleEn: 'Statistics & Honest Energy Savings Measurement',
        tags: ['istatistik', 'stats', 'enerji', 'energy', 'kwh', 'watt', 'co2', 'fatura', 'tarife', 'boot'],
        bodyTr: 'İstatistikler ekranı uydurma sabit sayılar yerine gerçek kapanış→yeniden açılış (bootHistory) aralıklarını ölçer. Ayarlar → Enerji bölümünden cihaz Watt profilini (otomatik algılama veya manuel) ve kWh elektrik tarifesini girdiğinizde 7 Gün / 30 Gün / Tümü dönemlerine göre önlenen açık kalma süresi, kWh, tahmini maliyet, tahmini CO₂ azaltımı (0.42 kg/kWh), eylem/kaynak dağılımları ve 24 saatlik yoğunluk haritası hesaplanır; CSV veya JSON olarak dışa aktarılabilir.',
        bodyEn: 'Statistics measures actual power-down-to-boot intervals instead of fabricated constants. Once you configure device wattage and electricity tariff under Settings → Energy, you get 7-day / 30-day / All-time charts, kWh & cost savings, estimated CO₂ reduction, action/source breakdowns, hourly heatmap, and CSV/JSON export.',
        command: null
    },
    {
        id: 'troubleshooting-veto-port',
        sectionId: 'docs-sec-shortcuts',
        category: 'troubleshooting',
        titleTr: 'Sorun Giderme: Kapatma Engellendi (Veto), Port Çakışması ve Bozuk Veritabanı',
        titleEn: 'Troubleshooting: Shutdown Veto, Port Conflict & Database Recovery',
        tags: ['sorun', 'troubleshoot', 'veto', 'kapanmadi', 'engellendi', 'port', '18456', 'veritabani', 'sqlite', 'karantina'],
        bodyTr: 'Bilgisayar kapanmadıysa iki yaygın neden vardır: (1) Power Pilot güvenlik kalkanı korunan bir uygulama (VS Code, OBS vb.) tespit etti — Geçmiş sekmesinde veya AI Asistan "Teşhis" ile kesin nedeni görün; (2) Windows kapatma vetosu (kaydedilmemiş belge açık) — Power Pilot bunu algılayıp bildirim gösterir. Yerel API port 18456 meşgulse Entegrasyonlar → Yerel REST API altından farklı bir port seçin. SQLite veritabanı beklenmedik elektrik kesintisinde zarar görürse Power Pilot bozuk dosyayı silmeden quarantine/ klasörüne taşır ve temiz veritabanıyla çalışmaya devam eder.',
        bodyEn: 'If shutdown did not complete: (1) Check History or AI Diagnose to see if a Protected App blocked execution, or (2) Windows vetoed shutdown due to unsaved documents (Power Pilot detects and reports this). If port 18456 is busy, change it in Integrations → Local REST API. Corrupt SQLite databases are safely quarantined without deletion so the app recovers cleanly.',
        command: null
    }
]);

// Önceden indekslenmiş BM25 istatistikleri
const INDEX = (() => {
    const docs = DOC_CHUNKS.map((chunk) => {
        const titleTokens = tokenize(`${chunk.titleTr} ${chunk.titleEn}`);
        const tagTokens = tokenize((chunk.tags || []).join(' '));
        const bodyTokens = tokenize(`${chunk.bodyTr} ${chunk.bodyEn} ${chunk.command || ''}`);
        const tf = new Map();
        const addWeighted = (list, w) => {
            for (const tok of list) tf.set(tok, (tf.get(tok) || 0) + w);
        };
        addWeighted(titleTokens, 3.0);
        addWeighted(tagTokens, 2.5);
        addWeighted(bodyTokens, 1.0);
        const length = titleTokens.length + tagTokens.length + bodyTokens.length;
        return { chunk, tf, length };
    });

    const df = new Map();
    let totalLen = 0;
    for (const d of docs) {
        totalLen += d.length;
        for (const tok of d.tf.keys()) {
            df.set(tok, (df.get(tok) || 0) + 1);
        }
    }
    const avgLen = docs.length > 0 ? totalLen / docs.length : 1;
    return { docs, df, avgLen, N: docs.length };
})();

/**
 * Verilen sorgu için BM25 + eşanlamlı genişletme ile en alakalı doküman parçalarını döndürür.
 * @param {string} query
 * @param {{ lang?: string, topK?: number, minScore?: number }} [options]
 */
function searchDocs(query, { lang = 'tr', topK = 3, minScore = 0.45 } = {}) {
    const rawTokens = tokenize(query, { expandSynonyms: false });
    const expandedTokens = tokenize(query, { expandSynonyms: true });
    if (expandedTokens.length === 0) return [];

    const rawSet = new Set(rawTokens);
    const k1 = 1.4;
    const b = 0.65;
    const scored = [];

    for (const doc of INDEX.docs) {
        let score = 0;
        let matchedTerms = 0;
        for (const term of expandedTokens) {
            const freq = doc.tf.get(term) || 0;
            if (freq <= 0) continue;
            const docFreq = INDEX.df.get(term) || 1;
            const idf = Math.log(1 + (INDEX.N - docFreq + 0.5) / (docFreq + 0.5));
            const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.length / INDEX.avgLen)));
            const boost = rawSet.has(term) ? 1.5 : 0.7;
            score += idf * tfNorm * boost;
            matchedTerms += 1;
        }
        if (score >= minScore && matchedTerms > 0) {
            const isTr = String(lang || 'tr').toLowerCase().startsWith('tr');
            scored.push({
                id: doc.chunk.id,
                sectionId: doc.chunk.sectionId,
                category: doc.chunk.category,
                title: isTr ? doc.chunk.titleTr : doc.chunk.titleEn,
                body: isTr ? doc.chunk.bodyTr : doc.chunk.bodyEn,
                command: doc.chunk.command || null,
                score: Math.round(score * 100) / 100
            });
        }
    }

    scored.sort((a, bItem) => bItem.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(topK, 8)));
}

function listAllDocChunks(lang = 'tr') {
    const isTr = String(lang || 'tr').toLowerCase().startsWith('tr');
    return DOC_CHUNKS.map((c) => ({
        id: c.id,
        sectionId: c.sectionId,
        category: c.category,
        title: isTr ? c.titleTr : c.titleEn,
        body: isTr ? c.bodyTr : c.bodyEn,
        command: c.command || null
    }));
}

module.exports = {
    DOC_CHUNKS,
    searchDocs,
    listAllDocChunks,
    tokenize,
    foldText
};
