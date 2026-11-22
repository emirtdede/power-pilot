'use strict';

/**
 * VoiceCommandRouter.js - WP-4.1
 * Sıfır-Arayüz (Zero-UI) Görev Çubuğu Üstü Sesli Dikte HUD Yönlendiricisi.
 *
 * Ana uygulama penceresini açmadan sesli komutları (STT çıktısını) işler:
 *  1. İptal / Durdurma Niyeti ("zamanlayıcıyı durdur", "görevi iptal et", "cancel timer")
 *     -> İptal PIN'i etkinse güvenliği delmez (PIN_REQUIRED döner ve ana pencereyi açar).
 *     -> PIN yoksa aktif görevi/uyarıyı anında iptal eder.
 *  2. Durum / Kalan Süre Niyeti ("kalan süre ne kadar", "aktif görev var mı", "time left")
 *     -> Aktif görev varsa eylemi ve kalan süreyi, yoksa boşta bilgisini döner.
 *  3. Görev Başlatma Niyeti ("45 dakika sonra bilgisayarı kapat", "gece 01:00'de uyut")
 *     -> AgentOrchestrator.runCommand (DeterministicParser + NegationGuard + yerel LLM)
 *        ile ayrıştırır; geçerli öneriyi doğrudan TaskManager.createTask ile başlatır
 *        ve HUD üzerinde 4.5 sn boyunca tek tıkla "Geri Al" (undoTaskId) imkanı sunar.
 *  4. Enerji / Teşhis / RAG Doküman Soruları ("ne kadar tasarruf yaptık", "neden kapanmadı",
 *     "OneDrive yedekleme nasıl çalışır")
 *     -> AgentOrchestrator.runAssistant üzerinden kısa, seslendirmeye uygun yanıt döner.
 */

const { AgentOrchestrator } = require('./AgentOrchestrator');

// Çok dilli iptal/durdurma niyeti (olumsuz görev komutu olan "bilgisayarı kapatma" ile karışmaması için
// hedef kelime olarak zamanlayıcı/görev/geri sayım/iptal/durdur aranır).
const CANCEL_INTENT_RE = /\b(?:zamanlayıcı\w*|görev\w*|gorev\w*|geri\s*sayım\w*|sayac\w*|sayaç\w*|timer|task|countdown|alarm)\b.{0,30}\b(?:durdur\w*|iptal\w*|kapat\w*|bitir\w*|sil\w*|stop|cancel|abort|clear)\b|\b(?:durdur\w*|iptal\s*et\w*|vazgeç|stop\s+timer|cancel\s+timer|cancel\s+task|stop\s+countdown|timer\s+stoppen|abbrechen|annuler\s+le\s+minuteur|cancelar\s+temporizador|остановить\s+таймер|отменить\s+таймер)\b/i;

// Çok dilli durum / kalan süre sorgusu niyeti
const STATUS_INTENT_RE = /\b(?:kalan\s+süre\w*|ne\s+kadar\s+(?:süre|zaman)\s+kaldı|kaç\s+dakika\s+kaldı|aktif\s+(?:görev|zamanlayıcı)\w*|zamanlayıcı\s+durum\w*|durum\s+nedir|ne\s+zaman\s+kapan\w*|time\s+left|remaining\s+time|active\s+timer|timer\s+status|how\s+much\s+time|wie\s+viel\s+zeit|temps\s+restant|tiempo\s+restante|сколько\s+времени\s+осталось)\b/i;

const ACTION_LABEL_KEYS = Object.freeze({
    shutdown: 'actionShutdown',
    restart: 'actionRestart',
    sleep: 'actionSleep',
    hibernate: 'actionHibernate',
    lock: 'actionLock',
    signout: 'actionSignout'
});

function cleanForSpeech(raw, maxLen = 240) {
    const s = String(raw || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/[`*_#>-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length <= maxLen) return s;
    const cut = s.slice(0, maxLen);
    const lastDot = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    return (lastDot > 60 ? cut.slice(0, lastDot + 1) : `${cut}...`).trim();
}

function formatRemainingText(remainingMs, trFn) {
    const totalSec = Math.max(1, Math.round(Number(remainingMs || 0) / 1000));
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const hLabel = trFn('hourShort', null, 'sa');
    const mLabel = trFn('minShort', null, 'dk');
    const sLabel = trFn('secShort', null, 'sn');
    if (hours > 0) {
        return mins > 0 ? `${hours} ${hLabel} ${mins} ${mLabel}` : `${hours} ${hLabel}`;
    }
    if (mins > 0) {
        return `${mins} ${mLabel}`;
    }
    return `${secs} ${sLabel}`;
}

class VoiceCommandRouter {
    constructor({
        taskManager = null,
        warningManager = null,
        agentOrchestrator = null,
        energyService = null,
        historyService = null,
        storageService = null,
        t = null,
        getLanguage = () => 'tr',
        onCancelQuickTimer = null,
        onRequirePinWindow = null,
        onStateChanged = null
    } = {}) {
        this.taskManager = taskManager;
        this.warningManager = warningManager;
        this.agentOrchestrator = agentOrchestrator;
        this.energyService = energyService;
        this.historyService = historyService;
        this.storageService = storageService;
        this.t = typeof t === 'function' ? t : (() => '');
        this.getLanguage = typeof getLanguage === 'function' ? getLanguage : (() => 'tr');
        this.onCancelQuickTimer = onCancelQuickTimer;
        this.onRequirePinWindow = onRequirePinWindow;
        this.onStateChanged = onStateChanged;
    }

    _tr(key, vars = null, fallback = '') {
        if (this.t) {
            const out = vars ? this.t(key, vars) : this.t(key);
            if (typeof out === 'string' && out.trim() && out !== key) {
                return out;
            }
        }
        return fallback || key;
    }

    static detectIntent(text) {
        const input = String(text || '').trim();
        if (!input) return 'empty';
        if (CANCEL_INTENT_RE.test(input)) return 'cancel';
        if (STATUS_INTENT_RE.test(input)) return 'status';
        const routed = AgentOrchestrator.route(input);
        return routed.agentId || 'command';
    }

    _notifyChanged() {
        if (typeof this.onStateChanged === 'function') {
            try { this.onStateChanged(); } catch (_) { /* yut */ }
        }
    }

    _actionLabel(action) {
        const key = ACTION_LABEL_KEYS[action];
        return key ? this._tr(key, null, String(action || 'shutdown')) : String(action || 'shutdown');
    }

    async executeVoiceText(rawText) {
        const text = String(rawText || '').trim();
        if (!text) {
            return {
                ok: false,
                kind: 'error',
                code: 'EMPTY_COMMAND',
                title: this._tr('voiceHudNoSpeechTitle', null, 'Ses algılanamadı'),
                speechText: this._tr('voiceHudNoSpeechDesc', null, 'Komut duyulamadı, lütfen tekrar deneyin.')
            };
        }

        const intent = VoiceCommandRouter.detectIntent(text);

        // 1. İPTAL / DURDURMA NİYETİ
        if (intent === 'cancel') {
            return this._handleCancel(text);
        }

        // 2. CANLI DURUM / KALAN SÜRE SORGUSU
        if (intent === 'status') {
            return this._handleStatus(text);
        }

        // 3. BİLGİ / ENERJİ / TEŞHİS / DOKÜMAN RAG / ÖNERİ NİYETLERİ
        if (intent !== 'command') {
            return await this._handleAssistantQuery(text, intent);
        }

        // 4. DOĞRUDAN GÖREV BAŞLATMA NİYETİ
        return await this._handleCommandStart(text);
    }

    _handleCancel(transcript) {
        if (!this.taskManager) {
            return {
                ok: false,
                kind: 'error',
                code: 'UNAVAILABLE',
                transcript,
                title: this.t('voiceHudErrorTitle') || 'İşlem yapılamadı',
                speechText: this.t('aiTaskFailed') || 'Görev yöneticisi hazır değil.'
            };
        }
        const settings = (this.storageService && typeof this.storageService.getSettings === 'function')
            ? (this.storageService.getSettings() || {})
            : {};

        const activeTasks = typeof this.taskManager.getActiveTasks === 'function'
            ? (this.taskManager.getActiveTasks() || [])
            : [];
        const warnState = (this.warningManager && typeof this.warningManager.getActiveState === 'function')
            ? this.warningManager.getActiveState()
            : null;

        if (activeTasks.length === 0 && !warnState) {
            const msg = this.t('voiceHudNoActiveTimer') || 'Şu anda çalışan aktif bir zamanlayıcı yok.';
            return {
                ok: true,
                kind: 'status_idle',
                transcript,
                title: this.t('activeTask') || 'Aktif Görev Yok',
                speechText: msg
            };
        }

        // Güvenlik kapısı: İptal PIN'i etkinse kesinlikle bypass edilmez!
        if (settings.cancelPinHash) {
            if (typeof this.onRequirePinWindow === 'function') {
                try { this.onRequirePinWindow('cancel'); } catch (_) { /* yut */ }
            }
            const pinMsg = this.t('voiceHudPinRequired') || 'İptal PIN koruması etkin. Lütfen açılan pencereden PIN kodunuzu girin.';
            return {
                ok: false,
                kind: 'pin_required',
                code: 'PIN_REQUIRED',
                openMainWindow: true,
                transcript,
                title: this.t('cancelPinTitle') || 'İptal PIN Koruması',
                speechText: pinMsg
            };
        }

        let cancelledId = null;
        if (warnState && warnState.taskId) {
            cancelledId = warnState.taskId;
            this.taskManager.cancelTask(warnState.taskId);
        } else if (typeof this.taskManager.cancelActiveTask === 'function') {
            const r = this.taskManager.cancelActiveTask();
            cancelledId = (r && r.taskId) || (activeTasks[0] && activeTasks[0].id) || null;
            if (!r || !r.ok) {
                if (activeTasks[0]) this.taskManager.cancelTask(activeTasks[0].id);
            }
        } else if (activeTasks[0]) {
            cancelledId = activeTasks[0].id;
            this.taskManager.cancelTask(activeTasks[0].id);
        }

        if (typeof this.onCancelQuickTimer === 'function') {
            try { this.onCancelQuickTimer(); } catch (_) { /* yut */ }
        }
        this._notifyChanged();

        const msg = this.t('voiceHudTimerCancelled') || 'Aktif zamanlayıcı iptal edildi.';
        return {
            ok: true,
            kind: 'task_cancelled',
            cancelledTaskId: cancelledId,
            transcript,
            title: this.t('cancelTimer') || 'Zamanlayıcı İptal Edildi',
            speechText: msg
        };
    }

    _handleStatus(transcript) {
        const activeTasks = (this.taskManager && typeof this.taskManager.getActiveTasks === 'function')
            ? (this.taskManager.getActiveTasks() || [])
            : [];
        if (activeTasks.length === 0) {
            const msg = this.t('voiceHudNoActiveTimer') || 'Şu anda çalışan aktif bir zamanlayıcı yok.';
            return {
                ok: true,
                kind: 'status_idle',
                transcript,
                title: this.t('activeTask') || 'Aktif Görev',
                speechText: msg
            };
        }
        const task = activeTasks[0];
        const actLabel = this._actionLabel(task.action);
        const now = Date.now();
        let remMs = null;
        if (task.trigger && typeof task.trigger.targetTime === 'number' && task.trigger.targetTime > now) {
            remMs = task.trigger.targetTime - now;
        } else if (task.trigger && typeof task.trigger.durationMs === 'number') {
            const started = task.createdAt ? new Date(task.createdAt).getTime() : now;
            remMs = Math.max(1000, (started + task.trigger.durationMs) - now);
        }

        const timeStr = remMs !== null ? formatRemainingText(remMs, this._tr.bind(this)) : this._tr('statusActive', null, 'etkin');
        const msg = this._tr('voiceHudStatusActive', { action: actLabel, time: timeStr }, `${actLabel} görevi etkin, kalan süre: ${timeStr}.`);

        return {
            ok: true,
            kind: 'status_active',
            taskId: task.id,
            transcript,
            title: actLabel,
            speechText: msg
        };
    }

    async _handleAssistantQuery(transcript, intentHint) {
        if (!this.agentOrchestrator) {
            return {
                ok: false,
                kind: 'error',
                code: 'ORCHESTRATOR_MISSING',
                transcript,
                title: this.t('voiceHudErrorTitle') || 'Asistan hazır değil',
                speechText: this.t('aiNotReady') || 'Yapay zeka hazır değil.'
            };
        }
        const hist = (this.historyService && typeof this.historyService.getHistory === 'function')
            ? this.historyService.getHistory()
            : [];
        const lastBlocked = hist.find((h) => h.resultCode === 'blocked_by_policy');
        const lastBlockedReason = lastBlocked ? `${lastBlocked.taskName}: ${lastBlocked.detail || ''}`.slice(0, 1000) : '';
        const energyStats = (this.energyService && typeof this.energyService.getStatistics === 'function')
            ? this.energyService.getStatistics()
            : {};

        const res = await this.agentOrchestrator.runAssistant(transcript, {
            language: this.getLanguage(),
            intentHint,
            energyStats,
            historyList: hist,
            lastBlockedReason
        });

        const rawAnswer = (res && (res.answer || res.summary || res.explanation || res.message)) || this.t('aiNoResponse') || 'Yanıt üretilemedi.';
        const speechText = cleanForSpeech(rawAnswer, 240);

        return {
            ok: !!(res && res.ok !== false),
            kind: 'assistant_answer',
            agentId: (res && res.agentId) || intentHint,
            transcript,
            title: (res && res.title) || this.t('aiAssistant') || 'Power Pilot Asistan',
            speechText
        };
    }

    async _handleCommandStart(transcript) {
        if (this.taskManager && this.taskManager.pausedAll) {
            return {
                ok: false,
                kind: 'paused',
                code: 'PAUSED',
                transcript,
                title: this.t('voiceHudErrorTitle') || 'Otomasyon Duraklatıldı',
                speechText: this.t('toastAllPaused') || 'Tüm otomasyonlar duraklatılmış durumda.'
            };
        }
        if (!this.agentOrchestrator || !this.taskManager) {
            return {
                ok: false,
                kind: 'error',
                code: 'UNAVAILABLE',
                transcript,
                title: this.t('voiceHudErrorTitle') || 'Servis hazır değil',
                speechText: this.t('aiNotReady') || 'Yapay zeka hazır değil.'
            };
        }

        const parsed = await this.agentOrchestrator.runCommand(transcript);
        if (!parsed || parsed.ok === false || parsed.needsClarification) {
            // Eğer cümle görev komutu değil de genel bir soruysa docs_qa'ya düş
            const questionFallback = /\?|nasıl|nedir|nerede|neden|how|what|why|where/i.test(transcript);
            if (questionFallback && (!parsed || parsed.code !== 'NEGATED_INTENT')) {
                return await this._handleAssistantQuery(transcript, 'docs_qa');
            }
            const clarifyMsg = (parsed && (parsed.question || parsed.message))
                || this.t('aiClarifyGeneric')
                || 'Lütfen eylem ve süreyi net söyleyin. Örneğin 45 dakika sonra kapat.';
            return {
                ok: false,
                kind: 'clarify',
                code: (parsed && parsed.code) || 'NEEDS_CLARIFICATION',
                transcript,
                title: this.t('voiceHudClarifyTitle') || 'Komut Netleştirilmeli',
                speechText: cleanForSpeech(clarifyMsg, 220)
            };
        }

        const proposal = parsed.proposal || parsed;
        const taskData = proposal.taskData || proposal;
        if (!taskData || !taskData.action || !taskData.trigger) {
            return {
                ok: false,
                kind: 'error',
                code: 'INVALID_PROPOSAL',
                transcript,
                title: this.t('voiceHudErrorTitle') || 'Görev oluşturulamadı',
                speechText: this.t('aiTaskFailed') || 'Görev ayarlanamadı.'
            };
        }

        try {
            const actLabel = this._actionLabel(taskData.action);
            const created = this.taskManager.createTask({
                ...taskData,
                name: taskData.name || `${actLabel} (Sesli Komut)`,
                source: 'voice_hud'
            });
            this._notifyChanged();

            let timeDesc = '';
            if (taskData.trigger.type === 'duration' && taskData.trigger.durationMs) {
                timeDesc = formatRemainingText(taskData.trigger.durationMs, this._tr.bind(this));
            } else if (taskData.trigger.type === 'scheduled_time' && taskData.trigger.targetTime) {
                const dt = new Date(taskData.trigger.targetTime);
                timeDesc = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            const speechText = timeDesc
                ? this._tr('voiceHudTaskStartedWithTime', { action: actLabel, time: timeDesc }, `Tamam, ${timeDesc} için ${actLabel} zamanlayıcısı başlatıldı.`)
                : this._tr('voiceHudTaskStarted', { action: actLabel }, `Tamam, ${actLabel} görevi başlatıldı.`);

            return {
                ok: true,
                kind: 'task_started',
                taskId: created.id,
                canUndo: true,
                transcript,
                title: actLabel,
                speechText
            };
        } catch (err) {
            return {
                ok: false,
                kind: 'error',
                code: (err && err.code) || 'CREATE_FAILED',
                transcript,
                title: this._tr('voiceHudErrorTitle', null, 'Görev başlatılamadı'),
                speechText: this._tr('aiTaskFailed', null, 'Görev ayarlanamadı.')
            };
        }
    }
}

module.exports = {
    VoiceCommandRouter,
    CANCEL_INTENT_RE,
    STATUS_INTENT_RE,
    cleanForSpeech,
    formatRemainingText
};
