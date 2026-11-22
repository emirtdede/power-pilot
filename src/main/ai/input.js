'use strict';

/**
 * input.js - WP-10.T9
 * AI IPC girdileri için tek noktadan normalize + uzunluk sınırı.
 */

const MAX_AI_INPUT = 4000;

function normalizeAiInput (value, { max = MAX_AI_INPUT, allowEmpty = true } = {}) {
    if (typeof value !== 'string') return { ok: false, code: 'INVALID_INPUT' };
    let text = value.normalize('NFKC').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
    if (!allowEmpty && text.length === 0) return { ok: false, code: 'EMPTY_INPUT' };
    if (text.length > max) return { ok: false, code: 'INPUT_TOO_LONG' };
    return { ok: true, text };
}

module.exports = { normalizeAiInput, MAX_AI_INPUT };
