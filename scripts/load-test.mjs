#!/usr/bin/env node
/**
 * load-test.mjs - WP-15.T4
 * 100 ajanlı konsol yükü + soak testi (gerçek süre; hızlandırılmış değil).
 *
 * Kullanım:
 *   node scripts/load-test.mjs --agents 100 --hours 0.01 --interval-ms 1000
 *   node scripts/load-test.mjs --agents 100 --soak-hours 24 --interval-ms 5000
 *
 * Çıktı: docs/reports/soak.json (makine) ve docs/reports/soak.md (rapor).
 * Konsol deposu SQLite (üretim yolu) kullanılır; geçici DB test sonunda silinir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const { ConsoleServer } = require('../src/console/ConsoleServer.js');

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || index + 1 >= process.argv.length) return fallback;
    return process.argv[index + 1];
}

const agents = Math.max(1, Math.min(1000, Number(arg('agents', 100)) || 100));
const intervalMs = Math.max(100, Number(arg('interval-ms', 1000)) || 1000);
const hours = Number(arg('hours', arg('soak-hours', 0.01))) || 0.01;
// Emir kaybı burst fazında, bellek ölçümü ise ardından gelen heartbeat
// soak'unda yapılır (24h üretim profili: sürekli heartbeat, seyrek emir).
const orderCycles = Math.max(1, Math.min(10, Number(arg('order-cycles', 3)) || 3));
const cycles = Math.max(orderCycles + 3, Math.ceil(hours * 3600 * 1000 / intervalMs));
const warmupCycles = Math.max(orderCycles + 1, Math.ceil(cycles * 0.1));
const outputJson = path.resolve(root, arg('output-json', 'docs/reports/soak.json'));
const outputMd = path.resolve(root, arg('output-md', 'docs/reports/soak.md'));

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[index];
}

function rssMb() {
    return Math.round(process.memoryUsage().rss / (1024 * 1024) * 100) / 100;
}

/** Ölçüm öncesi GC (varsa); RSS'in gerçekten tutulan belleği yansıtması için. */
function collectRss() {
    if (typeof global.gc === 'function') {
        global.gc();
        global.gc();
    }
    return rssMb();
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-load-'));
const server = new ConsoleServer({
    secureKey: false,
    storePath: path.join(tmpDir, 'console.db')
});
const agentIds = [];
const inventory = {
    hostname: 'load-agent',
    nics: [{ name: 'eth0', ip: '10.10.0.10', subnet: '10.10.0.0/24', mac: 'AA:BB:CC:DD:EE:FF' }],
    wolReadiness: { level: 'ready' }
};

try {
    for (let i = 0; i < agents; i += 1) {
        const id = `load-${String(i + 1).padStart(3, '0')}`;
        server.registerAgent({ agentId: id });
        agentIds.push(id);
        server.heartbeat(id, { ...inventory, hostname: id });
    }

    let queuedCount = 0;
    let ackedCount = 0;
    const receiptsByAgent = new Map(agentIds.map((id) => [id, []]));
    const latencies = [];
    const rssSamples = [];
    let cyclesRun = 0;
    let baseline = null;
    const started = Date.now();

    const drainReceipts = (res, sentReceipts) => {
        const results = res && Array.isArray(res.receipts) ? res.receipts : [];
        for (let i = 0; i < results.length; i += 1) {
            const result = results[i];
            if (result && result.ok) ackedCount += 1;
            void sentReceipts;
        }
    };

    for (let cycle = 0; cycle < cycles; cycle += 1) {
        const cycleStart = Date.now();
        for (const id of agentIds) {
            const receipts = receiptsByAgent.get(id) || [];
            const before = process.hrtime.bigint();
            const res = server.heartbeat(id, { ...inventory, hostname: id }, receipts);
            const elapsed = Number(process.hrtime.bigint() - before) / 1e6;
            latencies.push(elapsed);
            drainReceipts(res, receipts);

            // Teslim edilen emirler bir sonraki heartbeat'te makbuzlanır.
            receiptsByAgent.set(id, (res.orders || [])
                .map((signed) => signed && signed.order && signed.order.nonce)
                .filter(Boolean)
                .map((nonce) => ({ nonce, code: 'applied' })));

            if (cycle < orderCycles) {
                server.queueOrder(id, 'lock', {});
                queuedCount += 1;
            }
        }
        cyclesRun += 1;
        if (baseline === null && cyclesRun >= warmupCycles) baseline = collectRss();
        if (cyclesRun === 1 || cyclesRun === warmupCycles || cyclesRun % 10 === 0 || cyclesRun === cycles) {
            const mem = process.memoryUsage();
            rssSamples.push({
                cycle: cyclesRun,
                rssMb: rssMb(),
                heapUsedMb: Math.round(mem.heapUsed / 104857.6) / 10,
                externalMb: Math.round(mem.external / 104857.6) / 10,
                queued: queuedCount,
                acked: ackedCount
            });
        }
        const remaining = intervalMs - (Date.now() - cycleStart);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }

    // Burst fazı bitti; kalan emirleri iki heartbeat ile kapat (teslim + makbuz).
    for (const id of agentIds) {
        const first = server.heartbeat(id, { ...inventory, hostname: id }, receiptsByAgent.get(id) || []);
        drainReceipts(first, receiptsByAgent.get(id) || []);
        const finalReceipts = (first.orders || [])
            .map((signed) => signed && signed.order && signed.order.nonce)
            .filter(Boolean)
            .map((nonce) => ({ nonce, code: 'applied' }));
        if (finalReceipts.length > 0) {
            const second = server.heartbeat(id, { ...inventory, hostname: id }, finalReceipts);
            drainReceipts(second, finalReceipts);
        }
    }

    const lost = Math.max(0, queuedCount - ackedCount);
    const rssEnd = collectRss();
    const growthPct = baseline > 0 ? Math.round(((rssEnd - baseline) / baseline) * 10000) / 100 : 0;
    const report = {
        generatedAt: new Date().toISOString(),
        mode: 'sqlite',
        agents,
        hours,
        intervalMs,
        orderCycles,
        cycles: cyclesRun,
        ordersQueued: queuedCount,
        ordersAcked: ackedCount,
        ordersLost: lost,
        p50Ms: Math.round(percentile(latencies, 0.5) * 100) / 100,
        p95Ms: Math.round(percentile(latencies, 0.95) * 100) / 100,
        p99Ms: Math.round(percentile(latencies, 0.99) * 100) / 100,
        rssBaselineMb: baseline,
        rssEndMb: rssEnd,
        rssGrowthPct: growthPct,
        rssSamples,
        elapsedSec: Math.round((Date.now() - started) / 1000)
    };

    fs.mkdirSync(path.dirname(outputJson), { recursive: true });
    fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const md = `# Konsol Yük / Soak Raporu (WP-15.T4)\n\n` +
        `- Tarih: ${report.generatedAt}\n` +
        `- Ajan: **${agents}**\n` +
        `- Süre: **${hours} saat** (${cyclesRun} tur, ${intervalMs} ms aralık; ilk ${orderCycles} turda emir burst'ü)\n` +
        `- Emir: **${queuedCount}** üretildi, **${ackedCount}** makbuzlandı, **${lost}** kayıp\n` +
        `- Gecikme: p50 **${report.p50Ms} ms**, p95 **${report.p95Ms} ms**, p99 **${report.p99Ms} ms**\n` +
        `- RSS: ${baseline} MB → ${rssEnd} MB (**%${growthPct}**)\n\n` +
        `## Kabul\n\n` +
        `- Emir kaybı: ${lost === 0 ? 'PASS (0)' : `FAIL (${lost})`}\n` +
        `- p95 < 150 ms: ${report.p95Ms < 150 ? 'PASS' : 'FAIL'}\n` +
        `- RSS artışı < %5: ${growthPct < 5 ? 'PASS' : 'FAIL'}\n\n` +
        `24 saatlik üretim soak'u aynı komutla \`--soak-hours 24 --interval-ms 5000\` çalıştırılır; ` +
        `bu dosya CI/operasyon kanıtıdır.\n`;
    fs.mkdirSync(path.dirname(outputMd), { recursive: true });
    fs.writeFileSync(outputMd, md, 'utf8');

    console.log(`[load-test] ${agents} ajan, ${cyclesRun} tur, ${queuedCount} emir, kayıp=${lost}, p95=${report.p95Ms}ms, RSS=%${growthPct}`);
    if (lost > 0 || report.p95Ms >= 150 || growthPct >= 5) process.exitCode = 1;
} finally {
    try { server.close(); } catch (_) { /* yut */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* yut */ }
}
