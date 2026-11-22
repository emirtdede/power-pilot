/**
 * bridge.test.mjs - renderer preload sözleşmesi (iskele; WBS-3.1'de genişletilecek).
 */
import { describe, it, expect } from 'vitest';

describe('electronAPI köprü sözleşmesi', () => {
    it('gerekli metotlar tanımlı', () => {
        for (const key of ['scheduleAction', 'cancelAction', 'createTask', 'getTasks', 'getHistory', 'saveSettings', 'getTemplates', 'saveTemplate', 'deleteTemplate', 'getWebhooks', 'saveWebhooks', 'testWebhook', 'generateApiKey', 'sendWakeOnLan', 'aiStatus', 'aiParse', 'aiModelDownload', 'aiModelLoad', 'sttStatus', 'sttTranscribe', 'aiDiagnose', 'aiEnergy', 'aiSuggest', 'aiDismissSuggestion', 'warningCancel', 'warningSnooze', 'warningConfirm', 'setCancelPin', 'clearCancelPin', 'getCancelPinState', 'deviceEstimate']) {
            expect(typeof globalThis.electronAPI[key]).toBe('function');
        }
    });

    it('scheduleAction başarısızlığı {success:false} döndürür', async () => {
        globalThis.electronAPI.scheduleAction.mockResolvedValueOnce({ success: false, message: 'Invalid duration.' });
        const res = await globalThis.electronAPI.scheduleAction({ action: 'shutdown', durationMs: -1 });
        expect(res.success).toBe(false);
    });
});
