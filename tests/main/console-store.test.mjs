/**
 * console-store.test.mjs - WP-03.T1..T8
 * T-CON-01..07: bozuk JSON, teslim/makbuz durum makinesi, ajan idempotency,
 * tek-uçuş sync, 100 ajan performansı, yedek/geri yükleme ve yedek sırasında
 * heartbeat gecikmesi.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConsoleStore } from '../../src/console/ConsoleStore.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';
import { ConsoleClient } from '../../src/main/services/ConsoleClient.js';
import { SignedOrderService, generateKeyPair, sign } from '../../src/main/services/SignedOrderService.js';
import { backupDatabase, quickCheck, restoreDatabase } from '../../src/main/storage/Backup.js';
import { runBackup } from '../../src/main/storage/DbWorker.js';

const dirs = [];
const stores = [];

function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-console-store-'));
    dirs.push(dir);
    return dir;
}
function open(opts) {
    const cs = new ConsoleStore(opts);
    stores.push(cs);
    return cs;
}
function closeAll() {
    for (const cs of stores.splice(0)) {
        try { cs.close(); } catch (_) { /* yut */ }
    }
}
function signedOrder(agentId, nonce, nowMs, action = 'lock', ttlMs = 60000) {
    return {
        order: {
            version: 2,
            issuer: 'powerpilot-console',
            action,
            params: {},
            targets: [agentId],
            nonce,
            issuedAt: nowMs,
            expiresAt: nowMs + ttlMs,
            keyId: 'default'
        },
        signature: 'x',
        alg: 'ed25519',
        keyId: 'default'
    };
}
function p95(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

afterEach(() => {
    closeAll();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('ConsoleStore - WP-03', () => {
    it('T-CON-01: bozuk JSON → bakım modu, kaynak korunur, bozuk yedek alınır', () => {
        const dir = freshDir();
        const source = path.join(dir, 'console-store.json');
        const raw = '{bozuk-json';
        fs.writeFileSync(source, raw, 'utf8');
        const cs = open({ storePath: source });
        expect(cs.maintenanceMode).toBe(true);
        expect(cs.enabled).toBe(false);
        expect(fs.readFileSync(source, 'utf8')).toBe(raw);
        expect(fs.existsSync(path.join(dir, 'console.db'))).toBe(false);
        const backups = fs.readdirSync(path.join(dir, 'backups'));
        expect(backups.some((b) => b.startsWith('console-store_corrupted_'))).toBe(true);
    });

    it('T-CON-01b: eski JSON atomik migre edilir; privateKey DB’ye yazılmaz', () => {
        const dir = freshDir();
        const source = path.join(dir, 'console-store.json');
        const now = new Date().toISOString();
        const legacy = {
            agents: { a1: { inventory: { hostname: 'pc1' }, lastHeartbeatAt: now } },
            queues: {
                a1: [signedOrder('a1', 'n1', Date.now())]
            },
            policies: [{ id: 'p1', type: 'night', params: {} }],
            audit: [{ seq: 1, ts: now, actor: 'console', action: 'test', target: null, detail: '', prevHash: 'GENESIS', hash: 'h1' }],
            keypair: { publicKey: 'PUB', privateKey: 'PRIVATE-ANAHTAR' },
            disabledAgents: ['a1'],
            agentKeys: [{ hash: 'kh', role: 'agent', keyId: 'k1', agentId: 'a1' }]
        };
        fs.writeFileSync(source, JSON.stringify(legacy), 'utf8');
        const cs = open({ storePath: source });
        expect(cs.maintenanceMode).toBe(false);
        expect(cs.enabled).toBe(true);
        expect(cs.listAgents()).toHaveLength(1);
        expect(cs.listAgents()[0].disabled).toBe(true);
        expect(cs.counts().pending).toBe(1);
        expect(cs.listPolicies()).toHaveLength(1);
        expect(cs.listAudit()).toHaveLength(1);
        expect(cs.listKeys()).toHaveLength(1);
        expect(cs.legacyPrivateKey).toBe('PRIVATE-ANAHTAR');
        expect(cs.getMeta('migrated_from')).toBe('console-json-v2');
        const migrated = fs.readFileSync(`${source}.migrated`, 'utf8');
        expect(migrated).not.toContain('PRIVATE-ANAHTAR');
        expect(fs.existsSync(path.join(dir, 'console.db'))).toBe(true);
        expect(quickCheck(path.join(dir, 'console.db'))).toBe('ok');
    });

    it('T-CON-02/T-03: teslim silmez; makbuz bitirir; yeniden teslim idempotent', () => {
        const dir = freshDir();
        const cs = open({ storePath: path.join(dir, 'console-store.json') });
        const now = Date.now();
        const signed = signedOrder('a1', 'n1', now);
        expect(cs.enqueue('a1', signed)).toEqual({ duplicate: false });
        expect(cs.dueOrders('a1', now + 1)).toHaveLength(1);
        // Bağlantı koptu: aynı emir tekrar teslim edilir, kaybolmaz.
        expect(cs.dueOrders('a1', now + 2)).toHaveLength(1);
        expect(cs.counts('a1').inflight).toBe(1);
        expect(cs.ackReceipt('a1', 'n1', 'OK')).toEqual({ ok: true, duplicate: false });
        expect(cs.ackReceipt('a1', 'n1', 'OK')).toEqual({ ok: true, duplicate: true });
        expect(cs.dueOrders('a1', now + 3)).toHaveLength(0);
        expect(cs.counts('a1')).toMatchObject({ acked: 1, pending: 0, inflight: 0 });
        expect(cs.ackReceipt('a1', 'yok', 'OK')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('T-CON-03b: ajan aynı emri ikinci kez icra etmez, makbuzu tekrar gönderir', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const now = Date.now();
        const signed = sign({ action: 'lock', targets: ['a1'] }, privateKey);
        const verifier = new SignedOrderService({ publicKeyPem: publicKey, agentId: 'a1' });
        expect(verifier.verify(signed).ok).toBe(true);
        const queue = new OrderQueue();
        const enq = queue.enqueue(signed);
        expect(enq.duplicate).toBe(false);
        const pending = queue.pending();
        expect(pending).toHaveLength(1);
        queue.ack(pending[0].key, { code: 'OK', message: '' });
        expect(queue.pending()).toHaveLength(0);
        const receipts = queue.peekUnsentReceipts();
        expect(receipts).toHaveLength(1);
        // Sunucu makbuzu kaybetti ve emri yeniden teslim etti:
        expect(verifier.verify(signed).code).toBe('REPLAY');
        expect(queue.enqueue(signed).duplicate).toBe(true);
        expect(queue.pending()).toHaveLength(0);
        expect(queue.peekUnsentReceipts()).toHaveLength(1);
        expect(queue.peekUnsentReceipts()[0].nonce).toBe(signed.order.nonce);
        void now;
    });

    it('T-CON-04: 10 eşzamanlı sync() tek HTTP isteği yapar', async () => {
        let calls = 0;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const requestFn = async () => {
            calls += 1;
            await gate;
            return {
                ok: true,
                status: 204,
                headers: {},
                json: async () => ({})
            };
        };
        const storage = {
            getSettings: () => ({
                consoleUrl: 'https://console.test',
                consolePublicKeyPem: 'PEM',
                consoleAgentKey: 'agent-key',
                agentDisabled: false
            })
        };
        const inventoryService = { collect: async () => ({ agentId: 'a1', hostname: 'pc1' }) };
        const queue = {
            peekUnsentReceipts: () => [],
            markReceiptsSent: () => 0,
            markReceiptsFailed: () => 0,
            enqueue: () => ({ duplicate: false })
        };
        const client = new ConsoleClient({ storage, inventoryService, orderQueue: queue, requestFn });
        const callsPromise = Array.from({ length: 10 }, () => client.sync());
        await new Promise((r) => setImmediate(r));
        release();
        const results = await Promise.all(callsPromise);
        expect(calls).toBe(1);
        expect(new Set(results).size).toBe(1);
        // Uçuş bittikten sonra yeni sync yeni istek yapar.
        await client.sync();
        expect(calls).toBe(2);
    });

    it('T-CON-05: 100 ajan × 10 heartbeat / 10.000 emir; p95 < 150 ms, kuyruk tutarlı', () => {
        const dir = freshDir();
        const cs = open({ storePath: path.join(dir, 'console-store.json'), maxOrders: 500, nowFn: () => Date.now() });
        const now = Date.now();
        for (let a = 0; a < 100; a += 1) {
            const agentId = `a${a}`;
            for (let i = 0; i < 100; i += 1) {
                // 10.000 emir + 1.000 heartbeat yavaş Windows runner'ında 60 sn'yi
                // aşabildiği için emirler test süresinden uzun yaşamalı.
                cs.enqueue(agentId, signedOrder(agentId, `n-${a}-${i}`, now, 'lock', 30 * 60_000));
            }
        }
        expect(cs.counts().pending).toBe(10000);
        const durations = [];
        for (let round = 0; round < 10; round += 1) {
            for (let a = 0; a < 100; a += 1) {
                const started = process.hrtime.bigint();
                const out = cs.heartbeat(`a${a}`, { hostname: `pc${a}` });
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                durations.push(ms);
                expect(out.orders).toHaveLength(100);
            }
        }
        expect(durations).toHaveLength(1000);
        expect(p95(durations)).toBeLessThan(150);
        expect(cs.counts().inflight).toBe(10000);
        expect(cs.counts().acked).toBe(0);
        expect(cs.listAgents()).toHaveLength(100);
    }, 180000);

    it('T-CON-06: yedekten geri yükleme tüm ajan/kuyruk/makbuz sayılarını korur', () => {
        const dir = freshDir();
        const dbPath = path.join(dir, 'console.db');
        const cs = open({ storePath: path.join(dir, 'console-store.json'), nowFn: () => Date.now() });
        const now = Date.now();
        cs.setDisabled('a3', true);
        for (let a = 0; a < 3; a += 1) {
            const agentId = `a${a}`;
            cs.upsertAgent(agentId, { hostname: `pc${a}` });
            for (let i = 0; i < 5; i += 1) cs.enqueue(agentId, signedOrder(agentId, `n-${a}-${i}`, now));
        }
        cs.heartbeat('a0', {});
        cs.heartbeat('a1', {});
        cs.ackReceipt('a0', 'n-0-0', 'OK');
        cs.ackReceipt('a0', 'n-0-1', 'DENIED');
        cs.ackReceipt('a1', 'n-1-0', 'OK');
        const before = {
            agents: cs.listAgents().length,
            counts: cs.counts(),
            audit: cs.listAudit().length,
            disabled: cs.listDisabled().length
        };
        cs.close();
        const key = crypto.randomBytes(32);
        const backupDir = path.join(dir, 'backups');
        const backup = backupDatabase({ dbPath, backupDir, key });
        expect(backup.quickCheck).toBe('ok');
        // Mevcut DB'yi boz, sonra yedekten dön.
        fs.writeFileSync(dbPath, 'bozuk');
        const restored = restoreDatabase({ inputPath: backup.path, dbPath, key, quarantineDir: path.join(dir, 'q') });
        expect(restored.ok).toBe(true);
        const cs2 = open({ storePath: path.join(dir, 'console-store.json'), nowFn: () => Date.now() });
        expect(cs2.listAgents()).toHaveLength(before.agents);
        expect(cs2.counts()).toEqual(before.counts);
        expect(cs2.listAudit()).toHaveLength(before.audit);
        expect(cs2.listDisabled()).toHaveLength(before.disabled);
        expect(cs2.listDisabled()).toContain('a3');
    });

    it('T-CON-07: heartbeat sürerken VACUUM INTO + yedek; p95 < 150 ms, lag < 100 ms', async () => {
        const dir = freshDir();
        const cs = open({ storePath: path.join(dir, 'console-store.json'), maxOrders: 500, nowFn: () => Date.now() });
        const now = Date.now();
        // Şifreleme sınaması için uzun, benzersiz bir düz metin işareti.
        // 3 baytlık 'pc0' rastgele şifreli metinde ~%5 olasılıkla kendiliğinden
        // bulunur; bu yüzden yanlış alarm veren kısa iğne yerine 64+ bayt kullanılır.
        const plaintextMarker = `DUZMETIN-${crypto.randomBytes(24).toString('hex')}`;
        for (let a = 0; a < 100; a += 1) {
            const agentId = `a${a}`;
            for (let i = 0; i < 10; i += 1) cs.enqueue(agentId, signedOrder(agentId, `c-${a}-${i}`, now));
            cs.upsertAgent(agentId, { hostname: a === 0 ? plaintextMarker : `pc${a}` });
        }
        let maxLag = 0;
        let last = Date.now();
        const timer = setInterval(() => {
            const t = Date.now();
            maxLag = Math.max(maxLag, t - last - 10);
            last = t;
        }, 10);
        const durations = [];
        const backupPromise = runBackup({
            dbPath: path.join(dir, 'console.db'),
            backupDir: path.join(dir, 'backups'),
            key: crypto.randomBytes(32),
            prefix: 'console',
            forceCli: true,
            timeoutMs: 60000
        });
        try {
            for (let round = 0; round < 3; round += 1) {
                for (let a = 0; a < 100; a += 1) {
                    const started = process.hrtime.bigint();
                    cs.heartbeat(`a${a}`, { hostname: `pc${a}` });
                    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
                }
            }
        } finally {
            clearInterval(timer);
        }
        const backup = await backupPromise;
        expect(backup.ok).toBe(true);
        expect(backup.quickCheck).toBe('ok');
        const raw = fs.readFileSync(backup.path);
        // Şifreli yedek: PPBK1 başlığı taşır, SQLite başlığı ve düz metin içermez.
        expect(raw.subarray(0, 5).toString('utf8')).toBe('PPBK1');
        expect(raw.includes(Buffer.from('SQLite format 3\u0000', 'utf8'))).toBe(false);
        expect(raw.includes(Buffer.from(plaintextMarker, 'utf8'))).toBe(false);
        expect(p95(durations)).toBeLessThan(150);
        expect(maxLag).toBeLessThan(100);
    }, 90000);
});
