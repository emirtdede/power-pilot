/**
 * GlobalShortcutService.js - Arka planda / sistem tepsisindeyken calisan
 * istege bagli global klavye kisayollari (Electron globalShortcut).
 *
 * - Varsayilan KAPALIDIR; kullanici acmadikca OS kisayolu yakalanmaz.
 * - Her kisayol mutlaka bir degistirici tus (Ctrl/Alt/Shift/Super) + ana tus icermelidir.
 * - Uygulama kapanirken unregisterAll() ile tum kayitli kisayollar temizlenir.
 */

const DEFAULT_GLOBAL_SHORTCUTS = Object.freeze({
    toggleWindow: 'Ctrl+Alt+P',
    quickStart: 'Ctrl+Alt+S',
    cancel: 'Ctrl+Alt+X',
    voiceHud: 'Ctrl+Shift+Space'
});

const MODIFIER_MAP = Object.freeze({
    ctrl: 'Control',
    control: 'Control',
    cmdorctrl: 'CommandOrControl',
    commandorcontrol: 'CommandOrControl',
    alt: 'Alt',
    shift: 'Shift',
    super: 'Super',
    meta: 'Super',
    win: 'Super'
});

const KEY_RE = /^([A-Z0-9]|F[1-9]|F1[0-2]|Space|Tab|Enter|Return|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Plus|Minus|Backspace)$/i;

function normalizeGlobalAccelerator(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length < 3 || trimmed.length > 40) return null;
    const parts = trimmed.split('+').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 4) return null;

    const mods = [];
    const seenMods = new Set();
    for (let i = 0; i < parts.length - 1; i++) {
        const mapped = MODIFIER_MAP[parts[i].toLowerCase()];
        if (!mapped || seenMods.has(mapped)) return null;
        seenMods.add(mapped);
        mods.push(mapped);
    }
    if (mods.length === 0) return null;

    const rawKey = parts[parts.length - 1];
    if (!KEY_RE.test(rawKey)) return null;
    const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
    return [...mods, key].join('+');
}

function isValidGlobalAccelerator(raw) {
    return normalizeGlobalAccelerator(raw) !== null;
}

class GlobalShortcutService {
    constructor(options = {}) {
        this.globalShortcut = options.globalShortcut || null;
        this.logger = options.logger || null;
        this._owned = new Map(); // accelerator -> slotName
        this._lastState = { enabled: false, registered: [], failed: [] };
    }

    unregisterAll() {
        if (!this.globalShortcut) {
            this._owned.clear();
            return;
        }
        for (const acc of this._owned.keys()) {
            try {
                if (typeof this.globalShortcut.unregister === 'function') {
                    this.globalShortcut.unregister(acc);
                }
            } catch (_) { /* yut */ }
        }
        this._owned.clear();
    }

    apply(config = {}, handlers = {}) {
        this.unregisterAll();
        const enabled = config.globalShortcutsEnabled === true || config.enabled === true;
        if (!enabled || !this.globalShortcut || typeof this.globalShortcut.register !== 'function') {
            this._lastState = { enabled: false, registered: [], failed: [] };
            return { ...this._lastState };
        }

        const slots = [
            {
                slot: 'toggleWindow',
                combo: config.globalShortcutToggleWindow || config.toggleWindow || DEFAULT_GLOBAL_SHORTCUTS.toggleWindow,
                handler: handlers.toggleWindow
            },
            {
                slot: 'quickStart',
                combo: config.globalShortcutQuickStart || config.quickStart || DEFAULT_GLOBAL_SHORTCUTS.quickStart,
                handler: handlers.quickStart
            },
            {
                slot: 'cancel',
                combo: config.globalShortcutCancel || config.cancel || DEFAULT_GLOBAL_SHORTCUTS.cancel,
                handler: handlers.cancel
            }
        ];

        if (typeof handlers.voiceHud === 'function' || config.globalShortcutVoiceHud !== undefined || config.voiceHud !== undefined) {
            slots.push({
                slot: 'voiceHud',
                combo: config.globalShortcutVoiceHud || config.voiceHud || DEFAULT_GLOBAL_SHORTCUTS.voiceHud,
                handler: handlers.voiceHud
            });
        }

        const registered = [];
        const failed = [];
        const usedAcc = new Set();

        for (const item of slots) {
            const acc = normalizeGlobalAccelerator(item.combo);
            if (!acc || usedAcc.has(acc) || typeof item.handler !== 'function') {
                failed.push({ slot: item.slot, combo: String(item.combo || ''), reason: usedAcc.has(acc) ? 'DUPLICATE' : 'INVALID' });
                continue;
            }
            usedAcc.add(acc);
            try {
                const ok = this.globalShortcut.register(acc, () => {
                    try {
                        item.handler();
                    } catch (err) {
                        if (this.logger && typeof this.logger.warn === 'function') {
                            this.logger.warn(`[GlobalShortcut] ${item.slot} calistirma hatasi:`, err && err.message);
                        }
                    }
                });
                if (ok) {
                    this._owned.set(acc, item.slot);
                    registered.push({ slot: item.slot, combo: item.combo, accelerator: acc });
                } else {
                    failed.push({ slot: item.slot, combo: item.combo, accelerator: acc, reason: 'CONFLICT' });
                }
            } catch (err) {
                if (this.logger && typeof this.logger.warn === 'function') {
                    this.logger.warn(`[GlobalShortcut] ${item.slot} kayit hatasi:`, err && err.message);
                }
                failed.push({ slot: item.slot, combo: item.combo, accelerator: acc, reason: 'REGISTER_ERROR' });
            }
        }

        this._lastState = { enabled: true, registered, failed };
        return { ...this._lastState };
    }

    getStatus() {
        return {
            enabled: this._lastState.enabled,
            registered: this._lastState.registered.slice(),
            failed: this._lastState.failed.slice()
        };
    }
}

module.exports = {
    GlobalShortcutService,
    DEFAULT_GLOBAL_SHORTCUTS,
    normalizeGlobalAccelerator,
    isValidGlobalAccelerator
};
