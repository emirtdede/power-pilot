'use strict';

/**
 * TimerRegistry.js - WP-13.T6
 * Uygulama ömrü boyunca kurulan timeout/interval'ları izler.
 * `clearAll()` kapanışta açık handle bırakmaz.
 */

class TimerRegistry {
    constructor () {
        this.timers = new Set();
        this.closed = false;
    }

    _track (id) {
        if (id && typeof id.unref === 'function') id.unref();
        this.timers.add(id);
        return id;
    }

    setTimeout (fn, ms, ...args) {
        if (this.closed) throw new Error('TIMER_REGISTRY_CLOSED');
        const id = setTimeout(() => {
            this.timers.delete(id);
            fn(...args);
        }, ms);
        return this._track(id);
    }

    setInterval (fn, ms, ...args) {
        if (this.closed) throw new Error('TIMER_REGISTRY_CLOSED');
        const id = setInterval(fn, ms, ...args);
        return this._track(id);
    }

    clear (id) {
        if (!id) return;
        clearTimeout(id);
        clearInterval(id);
        this.timers.delete(id);
    }

    clearAll () {
        for (const id of this.timers) {
            clearTimeout(id);
            clearInterval(id);
        }
        this.timers.clear();
        this.closed = true;
    }

    get size () {
        return this.timers.size;
    }
}

module.exports = { TimerRegistry };
