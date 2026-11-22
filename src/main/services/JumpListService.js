/**
 * JumpListService.js - Windows 11 Gorev Cubugu Jump List (app.setUserTasks)
 * ve guvenli --jump-action=<id> komut satiri yonlendiricisi.
 *
 * Yalnizca beyaz listedeki 4 hizli aksiyon kabul edilir; iptal aksiyonu
 * Cancel PIN ayarliysa PIN kapisini ASLA atlamaz.
 */

const JUMP_ACTIONS = Object.freeze({
    SLEEP_30: 'sleep-30',
    SHUTDOWN_60: 'shutdown-60',
    LOCK_15: 'lock-15',
    CANCEL_ACTIVE: 'cancel-active'
});

const ALLOWED_JUMP_IDS = new Set(Object.values(JUMP_ACTIONS));

const JUMP_SPECS = Object.freeze([
    {
        id: JUMP_ACTIONS.SLEEP_30,
        titleKey: 'jumpSleep30Title',
        descKey: 'jumpSleep30Desc',
        action: 'sleep',
        durationMs: 30 * 60 * 1000
    },
    {
        id: JUMP_ACTIONS.SHUTDOWN_60,
        titleKey: 'jumpShutdown60Title',
        descKey: 'jumpShutdown60Desc',
        action: 'shutdown',
        durationMs: 60 * 60 * 1000
    },
    {
        id: JUMP_ACTIONS.LOCK_15,
        titleKey: 'jumpLock15Title',
        descKey: 'jumpLock15Desc',
        action: 'lock',
        durationMs: 15 * 60 * 1000
    },
    {
        id: JUMP_ACTIONS.CANCEL_ACTIVE,
        titleKey: 'jumpCancelTitle',
        descKey: 'jumpCancelDesc',
        action: 'cancel',
        durationMs: 0
    }
]);

function buildUserTasks({ exePath, iconPath, translate }) {
    if (typeof exePath !== 'string' || !exePath.trim()) return [];
    const tr = typeof translate === 'function' ? translate : (k) => k;
    const icon = (typeof iconPath === 'string' && iconPath.trim()) ? iconPath : exePath;
    return JUMP_SPECS.map((spec) => ({
        program: exePath,
        arguments: `--jump-action=${spec.id}`,
        iconPath: icon,
        iconIndex: 0,
        title: String(tr(spec.titleKey) || spec.id).slice(0, 120),
        description: String(tr(spec.descKey) || spec.id).slice(0, 240)
    }));
}

function registerJumpList({ appRef, exePath, iconPath, translate, platform = process.platform, logger = null }) {
    if (platform !== 'win32') return { ok: false, skipped: true, reason: 'NON_WIN32', count: 0 };
    if (!appRef || typeof appRef.setUserTasks !== 'function') {
        return { ok: false, skipped: true, reason: 'UNSUPPORTED', count: 0 };
    }
    const tasks = buildUserTasks({ exePath, iconPath, translate });
    if (tasks.length === 0) return { ok: false, skipped: true, reason: 'NO_EXE_PATH', count: 0 };
    try {
        appRef.setUserTasks(tasks);
        return { ok: true, count: tasks.length, tasks };
    } catch (err) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn('[JumpList] setUserTasks uygulanamadi:', err && err.message);
        }
        return { ok: false, reason: (err && err.code) || 'SET_FAILED', count: 0 };
    }
}

function parseJumpActionArgv(argv) {
    if (!Array.isArray(argv)) return null;
    for (let i = 0; i < argv.length; i++) {
        const arg = String(argv[i] || '');
        if (arg.startsWith('--jump-action=')) {
            const val = arg.slice('--jump-action='.length).trim();
            return ALLOWED_JUMP_IDS.has(val) ? val : null;
        }
        if (arg === '--jump-action' && i + 1 < argv.length) {
            const val = String(argv[i + 1] || '').trim();
            return ALLOWED_JUMP_IDS.has(val) ? val : null;
        }
    }
    return null;
}

function getJumpSpec(id) {
    return JUMP_SPECS.find((s) => s.id === id) || null;
}

module.exports = {
    JUMP_ACTIONS,
    JUMP_SPECS,
    ALLOWED_JUMP_IDS,
    buildUserTasks,
    registerJumpList,
    parseJumpActionArgv,
    getJumpSpec
};
