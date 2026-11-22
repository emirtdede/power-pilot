/**
 * distribution.test.mjs - Store (MSIX) / Pro özellik kapsamı.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadFresh({ env = {}, windowsStore = false } = {}) {
    vi.resetModules();
    delete process.env.PP_STORE_BUILD;
    Object.assign(process.env, env);
    const previous = process.windowsStore;
    if (windowsStore) process.windowsStore = true;
    else delete process.windowsStore;
    const mod = await import('../../src/main/config/distribution.js');
    if (previous === undefined) delete process.windowsStore;
    else process.windowsStore = previous;
    return mod;
}

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.windowsStore;
});

describe('dağıtım kapsamı', () => {
    it('Pro (varsayılan): tüm gelişmiş özellikler açık', async () => {
        const d = await loadFresh();
        expect(d.IS_STORE).toBe(false);
        expect(d.isFeatureEnabled('lanApi')).toBe(true);
        expect(d.isFeatureEnabled('consoleAgent')).toBe(true);
        expect(d.isFeatureEnabled('headless')).toBe(true);
        expect(d.isFeatureEnabled('taskScheduler')).toBe(true);
        expect(d.isFeatureEnabled('startupViaWindowsSettings')).toBe(false);
    });

    it('PP_STORE_BUILD=1: Store kapsamı', async () => {
        const d = await loadFresh({ env: { PP_STORE_BUILD: '1' } });
        expect(d.IS_STORE).toBe(true);
        expect(d.isFeatureEnabled('lanApi')).toBe(false);
        expect(d.isFeatureEnabled('consoleAgent')).toBe(false);
        expect(d.isFeatureEnabled('headless')).toBe(false);
        expect(d.isFeatureEnabled('taskScheduler')).toBe(false);
        expect(d.isFeatureEnabled('startupViaWindowsSettings')).toBe(true);
        expect(d.isFeatureEnabled('storeUpdatesOnly')).toBe(true);
    });

    it('process.windowsStore=true: Store kapsamı', async () => {
        const d = await loadFresh({ windowsStore: true });
        expect(d.IS_STORE).toBe(true);
        expect(d.isFeatureEnabled('lanApi')).toBe(false);
    });

    it('publicInfo yalnızca renderer için güvenli alanları döner', async () => {
        const d = await loadFresh({ env: { PP_STORE_BUILD: '1' } });
        const info = d.publicInfo();
        expect(info.store).toBe(true);
        expect(info.features).toEqual({
            headless: false,
            consoleAgent: false,
            lanApi: false,
            startupViaWindowsSettings: true
        });
    });
});
