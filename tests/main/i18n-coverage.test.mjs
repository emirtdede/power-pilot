/**
 * i18n-coverage.test.mjs - release audit regression guard.
 *
 * Every static `data-i18n` / `t('key')` reference in the renderer must exist in
 * the English dictionary (and, through the parity test, in all 17 locales).
 * Dynamic keys built from maps are listed explicitly.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const HTML_PATH = path.join(ROOT, 'src', 'index.html');
const LOCALE_DIR = path.join(ROOT, 'src', 'renderer', 'locales');

const DYNAMIC_KEYS = [
    'statusDraft', 'statusScheduled', 'statusMonitoring', 'statusWaiting',
    'statusWarning', 'statusSnoozed', 'statusExecuting', 'statusCompleted',
    'statusCancelled', 'statusBlocked', 'statusFailed', 'statusDisabled',
    'statusExpired', 'statusUnknown',
    'triggerDuration', 'triggerScheduledTime', 'triggerRecurring',
    'triggerSmartFinish', 'triggerApi',
    'energySourceUnset', 'energySourceMeasured', 'energySourceEstimated',
    'energySourceManual', 'energySourceLegacy', 'energySourceDefault',
    'sourceUserInterface', 'sourceLocalApi', 'sourceN8n', 'sourceCli',
    'sourceTemplate', 'sourceRecurring', 'sourceSystemRecovery', 'sourceConsole',
    'resultSuccess', 'resultFailed', 'resultCancelled',
    'event_task_created', 'event_task_blocked', 'event_task_warning_started',
    'event_task_cancelled', 'event_task_snoozed', 'event_power_action_started'
];

function loadTranslations() {
    const out = {};
    for (const name of fs.readdirSync(LOCALE_DIR)) {
        if (!name.endsWith('.json') || name === 'manifest.json') continue;
        out[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, name), 'utf8'));
    }
    return out;
}

function usedKeys() {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const keys = new Set(DYNAMIC_KEYS);
    for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) keys.add(m[1]);
    for (const m of html.matchAll(/\bt\('([^']+)'/g)) keys.add(m[1]);
    keys.delete('event_');
    return keys;
}

describe('i18n kapsamı', () => {
    it('HTML/JS içindeki tüm anahtarlar sözlükte var', () => {
        const en = loadTranslations().en;
        const missing = [...usedKeys()].filter((key) => typeof en[key] !== 'string' || !en[key].trim());
        expect(missing).toEqual([]);
    });

    it('yeni anahtarlar 17 dilde de dolu', () => {
        const translations = loadTranslations();
        const langs = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];
        for (const key of usedKeys()) {
            for (const lang of langs) {
                expect(typeof translations[lang][key], `${lang}.${key}`).toBe('string');
                expect(translations[lang][key].trim().length, `${lang}.${key}`).toBeGreaterThan(0);
            }
        }
    });
});
