#!/usr/bin/env node
/**
 * safety-probe.mjs - P0/BLOCKER-001 tanı aracı (SALT-OKUNUR)
 *
 * Gerçek SafetyPolicyEngine'i üretimdeki gibi çalıştırır ve varsayılan
 * `safetyPolicy` ile bir `user_interface` görevinin kararını yazdırır.
 * HİÇBİR güç eylemi yürütülmez (PowerService'e dokunulmaz).
 *
 * Kullanım:
 *   node scripts/safety-probe.mjs                 # varsayılan (tüm kapılar açık)
 *   node scripts/safety-probe.mjs --json          # makine-okur çıktı
 *   node scripts/safety-probe.mjs --no-processes  # süreç listesini atla
 *
 * Beklenen: yükseltilmemiş (asInvoker) kurulumda
 *   capability.available === false, verdict.allowed === true, loadCheck === "unavailable"
 * Yükseltilmiş oturumda:
 *   capability.available === true, verdict loadCheck "ok" | "active"
 */

'use strict';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SafetyPolicyEngine = require('../src/main/services/SafetyPolicyEngine');
const { AutomationTask } = require('../src/main/services/models/AutomationTask');
function parseArgs(argv) {
    return {
        json: argv.includes('--json'),
        skipProcesses: argv.includes('--no-processes')
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const storage = {
        getSettings: () => ({ agentDisabled: false, blockRemoteShutdownWhenActive: true, agentId: null })
    };
    const engine = new SafetyPolicyEngine(storage, null, null, {
        processProvider: opts.skipProcesses ? async () => [] : undefined
    });

    const capability = await engine.probePowerRequestCapability({ force: true });
    const task = new AutomationTask({
        name: 'safety-probe',
        action: 'lock',
        source: 'user_interface',
        safetyPolicy: {
            checkUserActivity: true,
            checkProtectedApps: !opts.skipProcesses,
            checkFullscreen: true,
            checkSystemLoad: true,
            forceCloseApps: false,
            remoteApprovalRequired: false
        },
        trigger: { type: 'duration', durationMs: 60000 }
    });
    const verdict = await engine.evaluate(task);

    const report = {
        evaluatedAt: new Date().toISOString(),
        platform: process.platform,
        elevated: capability.available === true,
        capability,
        safetyPolicy: task.safetyPolicy,
        verdict
    };

    if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        process.stdout.write('Power Pilot - güvenlik sondası (salt-okunur, eylem yürütülmez)\n');
        process.stdout.write(`  powercfg /requests yeteneği : ${capability.available === true ? 'VAR' : 'YOK'}${capability.available ? '' : ' (yükseltme gerekli)'}\n`);
        process.stdout.write(`  kod                         : ${capability.code || 'yok'}\n`);
        process.stdout.write(`  karar                       : ${verdict.allowed ? 'ALLOWED' : `BLOCKED (${verdict.reasonCode})`}\n`);
        process.stdout.write(`  loadCheck                   : ${verdict.loadCheck || 'yok'}\n`);
        if (verdict.allowed === false && verdict.reason) {
            process.stdout.write(`  gerekçe                     : ${verdict.reason}\n`);
        }
    }

    // Karar bilgilendirme amaçlıdır; exit kodu yetenek yokluğunda da 0'dır.
    process.exitCode = 0;
}

main().catch((err) => {
    process.stderr.write(`[safety-probe] hata: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
});
