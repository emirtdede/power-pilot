/**
 * agents/connectionAgent.js — WP-8
 * Doğal dil (TR + EN) ile Power Pilot bağlantı ve entegrasyon ayarlarını
 * (Yerel REST API, Webhook, Wake-on-LAN, UPS/NUT, MCP yapılandırması, Kurumsal Konsol)
 * yapılandırma önerisi olarak ayrıştırır.
 *
 * Güvenlik: Ayarları ASLA kendisi doğrudan yazmaz; doğrulanmış bir öneri kartı
 * (`connectionProposal`) döndürür ve kullanıcı onayladığında mevcut IPC + PIN
 * kapılarından uygulanır.
 */
'use strict';

const { validateSettings, validateSecuritySettings, validateWebhooks, validateWol } = require('../../ipc/validate');

const MAC_RE = /\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i;
const HTTPS_URL_RE = /\b(https:\/\/[^\s"'<>]+)\b/i;
const ANY_URL_RE = /\b(https?:\/\/[^\s"'<>]+)\b/i;
const IPV4_RE = /\b((?:\d{1,3}\.){3}\d{1,3})\b/;

function extractPort(text) {
    const m = String(text || '').match(/(?:port(?:\s*[:=uüıi]?\s*)|\b)(\d{2,5})\s*(?:port|üzerinden|üzerinde)?/i);
    if (!m) return null;
    const p = parseInt(m[1], 10);
    return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : null;
}

function wantsDisable(text) {
    return /\b(kapat|devre\s*d[ıi][şs][ıi]|durdur|disable|turn\s*off|stop)\b/i.test(String(text || ''));
}

function wantsEnable(text) {
    return /\b(a[çc]|etkinle[şs]tir|ba[şs]lat|aktif|enable|turn\s*on|start|kur|ayarla|configure|setup)\b/i.test(String(text || ''));
}

module.exports = {
    id: 'connection',
    version: '1.0.0',
    description: 'Entegrasyon ve bağlantı ayarlarını (API, Webhook, WoL, UPS, MCP, Konsol) yapılandırma taslağına çevirir.',

    async execute({ text, language = 'tr', currentSettings = {} }) {
        const raw = String(text || '').trim();
        const lower = raw.toLocaleLowerCase('tr');
        const isTr = String(language || 'tr').toLowerCase().startsWith('tr');

        // 1. MCP yapılandırma yardımcısı
        if (/\bmcp\b|claude\s*desktop|cursor\s*mcp|windsurf/i.test(lower)) {
            const port = currentSettings.localApiPort || 18456;
            const apiEnabled = currentSettings.localApiEnabled === true;
            const snippet = JSON.stringify({
                mcpServers: {
                    'power-pilot': {
                        command: 'node',
                        args: ['src/mcp/server.js'],
                        env: {
                            // P0-4: kanonik adlar — CLI/MCP bunları okur.
                            POWERPILOT_API_PORT: String(port),
                            POWERPILOT_API_KEY: '<API_KEY>'
                        }
                    }
                }
            }, null, 2);
            return {
                ok: true,
                agentId: 'connection',
                kind: 'connection_proposal',
                connectionProposal: {
                    target: 'mcp',
                    requiresPin: !apiEnabled,
                    settingsPatch: apiEnabled ? {} : { localApiEnabled: true, localApiPort: port },
                    snippet,
                    integrationSection: 'int-sec-mcp',
                    title: isTr ? 'MCP Sunucusu Yapılandırması' : 'MCP Server Setup',
                    summary: isTr
                        ? (apiEnabled
                            ? `Yerel REST API (port ${port}) etkin. Aşağıdaki MCP JSON bloğunu istemcinize yapıştırabilirsiniz.`
                            : `MCP sunucusu için Yerel REST API (port ${port}) etkinleştirilecek. Onaylayın ve API anahtarınızı kopyalayın.`)
                        : (apiEnabled
                            ? `Local REST API (port ${port}) is enabled. Copy the MCP JSON block into your AI client.`
                            : `Enable Local REST API on port ${port} for MCP, then copy your API key into the JSON config.`)
                }
            };
        }

        // 2. Webhook ekleme (HTTPS zorunlu)
        if (/webhook|n8n|zapier|make\.com/i.test(lower)) {
            const httpsMatch = raw.match(HTTPS_URL_RE);
            const anyUrl = raw.match(ANY_URL_RE);
            if (!httpsMatch) {
                return {
                    ok: true,
                    kind: 'clarify',
                    needsClarification: {
                        missingFields: ['webhookUrl'],
                        question: anyUrl && anyUrl[1].startsWith('http://')
                            ? (isTr
                                ? 'Güvenlik politikası gereği webhook adresleri yalnızca HTTPS (https://...) olabilir. Lütfen HTTPS adresi yazın.'
                                : 'Security policy requires HTTPS URLs for webhooks. Please provide an https:// URL.')
                            : (isTr
                                ? 'Webhook için hedef HTTPS adresini yazın (örn. "https://n8n.example.com/webhook/powerpilot için webhook ekle").'
                                : 'Please provide the target HTTPS webhook URL (e.g., "add webhook https://n8n.example.com/webhook/powerpilot").')
                    }
                };
            }
            const url = httpsMatch[1].replace(/[.,;)]+$/, '');
            const allEvents = ['task_created', 'task_blocked', 'task_warning_started', 'task_cancelled', 'task_snoozed', 'power_action_started'];
            const pickedEvents = allEvents.filter((ev) => lower.includes(ev));
            const events = pickedEvents.length > 0 ? pickedEvents : ['task_created', 'power_action_started', 'task_blocked'];
            const nameMatch = raw.match(/["“']([^"”']{2,50})["”']/);
            const hook = {
                name: nameMatch ? nameMatch[1].trim() : (/n8n/i.test(lower) ? 'n8n Webhook' : 'AI Webhook'),
                url,
                events,
                enabled: true
            };
            const check = validateWebhooks([hook]);
            if (!check.ok) {
                return { ok: false, code: check.code, message: check.error };
            }
            return {
                ok: true,
                agentId: 'connection',
                kind: 'connection_proposal',
                connectionProposal: {
                    target: 'webhook',
                    requiresPin: false,
                    webhook: hook,
                    integrationSection: 'int-sec-webhooks',
                    title: isTr ? 'Yeni Webhook Ekle' : 'Add New Webhook',
                    summary: isTr
                        ? `"${hook.name}" (${hook.url}) — Olaylar: ${events.join(', ')}`
                        : `"${hook.name}" (${hook.url}) — Events: ${events.join(', ')}`
                }
            };
        }

        // 3. Wake-on-LAN cihazı ekleme veya uyandırma
        if (/\bwol\b|wake[\s-]*on[\s-]*lan|uyand[ıi]r|magic\s*packet/i.test(lower) || MAC_RE.test(raw)) {
            const macMatch = raw.match(MAC_RE);
            if (!macMatch) {
                return {
                    ok: true,
                    kind: 'clarify',
                    needsClarification: {
                        missingFields: ['macAddress'],
                        question: isTr
                            ? 'Wake-on-LAN için hedef cihazın MAC adresini yazın (örn. AA:BB:CC:DD:EE:FF).'
                            : 'Please specify the target MAC address for Wake-on-LAN (e.g., AA:BB:CC:DD:EE:FF).'
                    }
                };
            }
            const macAddress = macMatch[1].toUpperCase().replace(/-/g, ':');
            const ipMatch = raw.match(IPV4_RE);
            const broadcastIp = ipMatch ? ipMatch[1] : undefined;
            const check = validateWol({ macAddress, ...(broadcastIp ? { broadcastIp } : {}), port: 9 });
            if (!check.ok) {
                return { ok: false, code: check.code, message: check.error };
            }
            const nameMatch = raw.match(/["“']([^"”']{2,40})["”']/);
            const sendNow = /\b(uyand[ıi]r|g[öo]nder|wake|send)\b/i.test(lower) && !/\b(ekle|kaydet|save|add)\b/i.test(lower);
            const device = {
                name: nameMatch ? nameMatch[1].trim() : `WoL ${macAddress.slice(-5)}`,
                macAddress,
                broadcastIp: broadcastIp || '',
                port: 9
            };
            return {
                ok: true,
                agentId: 'connection',
                kind: 'connection_proposal',
                connectionProposal: {
                    target: sendNow ? 'wol_send' : 'wol_device',
                    requiresPin: false,
                    wolDevice: device,
                    integrationSection: 'int-sec-wol',
                    title: sendNow
                        ? (isTr ? 'Wake-on-LAN Paketi Gönder' : 'Send Wake-on-LAN Packet')
                        : (isTr ? 'Wake-on-LAN Cihazı Kaydet' : 'Save Wake-on-LAN Device'),
                    summary: isTr
                        ? `${device.name} — MAC: ${macAddress}${broadcastIp ? ` (${broadcastIp})` : ''}`
                        : `${device.name} — MAC: ${macAddress}${broadcastIp ? ` (${broadcastIp})` : ''}`
                }
            };
        }

        // 4. UPS / NUT ayarları
        if (/\bups\b|\bnut\b/i.test(lower)) {
            const disable = wantsDisable(lower);
            const ipMatch = raw.match(IPV4_RE);
            const hostMatch = raw.match(/(?:host|sunucu|server)\s*[:=]?\s*([a-z0-9._-]{3,80})/i);
            const upsNameMatch = raw.match(/(?:ups\s*(?:ad[ıi]|name)|name)\s*[:=]?\s*([a-z0-9._-]{1,40})/i);
            const patch = {
                upsEnabled: !disable
            };
            if (ipMatch) patch.upsHost = ipMatch[1];
            else if (hostMatch) patch.upsHost = hostMatch[1];
            if (upsNameMatch) patch.upsName = upsNameMatch[1];
            const check = validateSettings(patch, currentSettings);
            if (!check.ok) {
                return { ok: false, code: check.code, message: check.error };
            }
            return {
                ok: true,
                agentId: 'connection',
                kind: 'connection_proposal',
                connectionProposal: {
                    target: 'settings',
                    requiresPin: false,
                    settingsPatch: patch,
                    integrationSection: 'int-sec-ups',
                    title: isTr ? 'UPS / NUT Bağlantı Ayarları' : 'UPS / NUT Monitor Settings',
                    summary: isTr
                        ? `UPS İzleme: ${patch.upsEnabled ? 'Açık' : 'Kapalı'}${patch.upsHost ? ` · Sunucu: ${patch.upsHost}` : ''}${patch.upsName ? ` · UPS: ${patch.upsName}` : ''}`
                        : `UPS Monitor: ${patch.upsEnabled ? 'Enabled' : 'Disabled'}${patch.upsHost ? ` · Host: ${patch.upsHost}` : ''}${patch.upsName ? ` · UPS: ${patch.upsName}` : ''}`
                }
            };
        }

        // 5. Kurumsal Konsol ayarları
        if (/(konsol|console|kurumsal|enterprise|filo|fleet)/i.test(lower)) {
            const httpsMatch = raw.match(HTTPS_URL_RE);
            const agentMatch = raw.match(/(?:agent\s*id|cihaz\s*id)\s*[:=]?\s*([a-z0-9._-]{2,64})/i);
            const roleServer = /\b(server|sunucu)\b/i.test(lower);
            const roleWs = /\b(workstation|[ıi][şs]\s*istasyonu)\b/i.test(lower);
            const regularPatch = {};
            const securityPatch = {};
            if (httpsMatch) securityPatch.consoleUrl = httpsMatch[1].replace(/[.,;)]+$/, '');
            if (agentMatch) regularPatch.agentId = agentMatch[1];
            if (roleServer) regularPatch.deviceRole = 'server';
            else if (roleWs) regularPatch.deviceRole = 'workstation';

            if (Object.keys(regularPatch).length === 0 && Object.keys(securityPatch).length === 0) {
                return {
                    ok: true,
                    kind: 'clarify',
                    needsClarification: {
                        missingFields: ['consoleUrl'],
                        question: isTr
                            ? 'Kurumsal Konsol için HTTPS adresini veya cihaz rolünü belirtin (örn. "konsol adresi https://console.firma.com ayarla").'
                            : 'Specify the Enterprise Console HTTPS URL or device role (e.g., "set console https://console.company.com").'
                    }
                };
            }
            if (Object.keys(regularPatch).length > 0) {
                const c1 = validateSettings(regularPatch, currentSettings);
                if (!c1.ok) return { ok: false, code: c1.code, message: c1.error };
            }
            if (Object.keys(securityPatch).length > 0) {
                const c2 = validateSecuritySettings(securityPatch, currentSettings);
                if (!c2.ok) return { ok: false, code: c2.code, message: c2.error };
            }
            const merged = { ...regularPatch, ...securityPatch };
            return {
                ok: true,
                agentId: 'connection',
                kind: 'connection_proposal',
                connectionProposal: {
                    target: 'settings',
                    requiresPin: Object.keys(securityPatch).length > 0,
                    settingsPatch: merged,
                    integrationSection: 'int-sec-enterprise',
                    title: isTr ? 'Kurumsal Konsol Ayarları' : 'Enterprise Console Settings',
                    summary: Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join(' · ')
                }
            };
        }

        // 6. Yerel REST API / LAN / TLS ayarları
        if (/(rest\s*api|local\s*api|yerel\s*api|\bapi\b|\blan\b|\btls\b|port)/i.test(lower)) {
            const disable = wantsDisable(lower);
            const enable = wantsEnable(lower);
            const port = extractPort(raw);
            const mentionsLan = /\blan\b|yerel\s*a[ğg]/i.test(lower);
            const mentionsTls = /\btls\b|\bhttps\b/i.test(lower);
            const roleMatch = lower.match(/\b(viewer|operator|admin)\b/);

            const regularPatch = {};
            const securityPatch = {};
            if (port !== null) regularPatch.localApiPort = port;
            if (disable && !mentionsLan && !mentionsTls) securityPatch.localApiEnabled = false;
            else if (enable || port !== null) securityPatch.localApiEnabled = true;

            if (mentionsLan) securityPatch.lanModeEnabled = !disable;
            if (mentionsTls) securityPatch.localApiTlsEnabled = !disable;
            if (roleMatch) securityPatch.localApiKeyRole = roleMatch[1];

            if (Object.keys(regularPatch).length === 0 && Object.keys(securityPatch).length === 0) {
                return {
                    ok: true,
                    kind: 'clarify',
                    needsClarification: {
                        missingFields: ['localApi'],
                        question: isTr
                            ? 'Yerel API için ne yapmak istersiniz? (örn. "REST API\'yi 18456 portunda aç" veya "LAN modunu kapat")'
                            : 'What would you like to change on Local API? (e.g., "enable REST API on port 18456")'
                    }
                };
            }
            if (Object.keys(regularPatch).length > 0) {
                const c1 = validateSettings(regularPatch, currentSettings);
                if (!c1.ok) return { ok: false, code: c1.code, message: c1.error };
            }
            if (Object.keys(securityPatch).length > 0) {
                const c2 = validateSecuritySettings(securityPatch, currentSettings);
                if (!c2.ok) return { ok: false, code: c2.code, message: c2.error };
            }
            const merged = { ...regularPatch, ...securityPatch };
            return {
                ok: true,
                agentId: 'connection',
                kind: 'connection_proposal',
                connectionProposal: {
                    target: 'settings',
                    requiresPin: Object.keys(securityPatch).length > 0,
                    settingsPatch: merged,
                    integrationSection: 'int-sec-api',
                    title: isTr ? 'Yerel REST API Ayarları' : 'Local REST API Settings',
                    summary: Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join(' · ')
                }
            };
        }

        return {
            ok: true,
            kind: 'clarify',
            needsClarification: {
                missingFields: ['integration'],
                question: isTr
                    ? 'Hangi entegrasyonu yapılandırmak istersiniz? (REST API, Webhook, Wake-on-LAN, UPS/NUT, MCP veya Kurumsal Konsol)'
                    : 'Which integration would you like to configure? (REST API, Webhook, Wake-on-LAN, UPS/NUT, MCP, or Enterprise Console)'
            }
        };
    }
};
