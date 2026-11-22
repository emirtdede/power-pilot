/**
 * tests/setup/renderer-setup.mjs - WBS-4.1
 * window.electronAPI köprüsünün varsayılan mock'u.
 */
process.env.NODE_ENV = 'test';

import { vi } from 'vitest';

globalThis.electronAPI = {
    scheduleAction: vi.fn(async () => ({ success: true, taskId: 'task_test' })),
    cancelAction: vi.fn(async () => ({ success: true })),
    createTask: vi.fn(async () => ({ success: true, task: { id: 'task_test' } })),
    getTasks: vi.fn(async () => []),
    getHistory: vi.fn(async () => []),
    saveSettings: vi.fn(async () => ({ success: true })),
    getTemplates: vi.fn(async () => []),
    saveTemplate: vi.fn(async () => ({ success: true })),
    deleteTemplate: vi.fn(async () => ({ success: true })),
    getWebhooks: vi.fn(async () => []),
    saveWebhooks: vi.fn(async () => ({ success: true })),
    testWebhook: vi.fn(async () => ({ success: true })),
    generateApiKey: vi.fn(async () => 'pp_key_test'),
    sendWakeOnLan: vi.fn(async () => ({ success: true })),
    aiStatus: vi.fn(async () => ({ loaded: false, code: 'MODEL_MISSING' })),
    aiParse: vi.fn(async () => ({ ok: true, needsClarification: { question: 'Süre?', missingFields: [] } })),
    aiModelDownload: vi.fn(async () => ({ started: true })),
    aiModelLoad: vi.fn(async () => ({ loaded: false, code: 'MODEL_MISSING' })),
    sttStatus: vi.fn(async () => ({ ready: false, modelPresent: false })),
    sttTranscribe: vi.fn(async () => ({ ok: false, code: 'STT_MODEL_MISSING' })),
    aiDiagnose: vi.fn(async () => ({ ok: true, explanation: 'X', whatToDo: 'Y' })),
    aiEnergy: vi.fn(async () => ({ ok: true, summary: 'S', suggestion: null })),
    aiSuggest: vi.fn(async () => ({ ok: true, suggestion: null })),
    aiDismissSuggestion: vi.fn(async () => ({ success: true })),
    warningCancel: vi.fn(async () => ({ success: true })),
    warningSnooze: vi.fn(async () => ({ success: true })),
    warningConfirm: vi.fn(async () => ({ success: true })),
    setCancelPin: vi.fn(async () => ({ success: true })),
    clearCancelPin: vi.fn(async () => ({ success: true })),
    getCancelPinState: vi.fn(async () => ({ set: false })),
    deviceEstimate: vi.fn(async () => ({ ok: true, profile: { deviceClass: 'laptop', wattW: 45, wattSource: 'estimated' } }))
};
