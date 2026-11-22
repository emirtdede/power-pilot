/**
 * headless-agent.test.mjs - Denetim turu: Electron'sız ajan yığını açılır,
 * envanter + emir hattı çalışır, durur.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootAgent } from '../../src/agent/headless.js';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-agent-'));
}

describe('headless ajan', () => {
    it('açılır, envanter toplar, emir icra eder, durur', async () => {
        const h = await bootAgent({ userDataPath: tempDir(), appVersion: '9.9.9-test', syncIntervalMs: 3600000 });
        try {
            expect(fs.existsSync(path.join(h.dir, 'powerpilot.db'))).toBe(true);
            const inv = await h.inventory.collect();
            expect(inv.agentVersion).toBe('9.9.9-test');
            expect(typeof inv.agentId).toBe('string');
            // emir hattı: kuyruk → icra → görev kurulur
            const now = Date.now();
            h.queue.enqueue({ order: { action: 'lock', nonce: 'headless-1', issuedAt: now, expiresAt: now + 60000, issuer: 'test' }, signature: 'x' });
            const out = await h.executor.drain(h.queue);
            expect(out.executed).toBe(1);
            expect(h.tasks.tasks.length).toBeGreaterThan(0);
            // güvenlik özeti servis üzerinden alınır
            expect(h.api.getSecurityStatus().transport).toBe('disabled'); // LocalAPI varsayılan kapalı
        } finally {
            h.stop();
        }
    }, 30000);
});
