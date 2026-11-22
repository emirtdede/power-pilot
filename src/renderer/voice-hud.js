'use strict';

/**
 * voice-hud.js - WP-4.2
 * Görev Çubuğu Üstü Sıfır-Arayüz (Zero-UI) Sesli Dikte HUD Kapsülü + Yerel Offline TTS.
 */
(function () {
    const TARGET_SR = 16000;
    const SILENCE_RMS = 0.016;
    const AUTO_STOP_SILENCE_MS = 1400;
    const NO_SPEECH_TIMEOUT_MS = 8000;
    const MAX_RECORD_MS = 14000;

    const pillEl = document.getElementById('hud-pill');
    const orbEl = document.getElementById('btn-hud-mic');
    const iconEl = document.getElementById('hud-mic-icon');
    const titleEl = document.getElementById('hud-title');
    const subEl = document.getElementById('hud-subtitle');
    const badgeEl = document.getElementById('hud-badge');
    const waveEl = document.getElementById('hud-wave');
    const waveBars = waveEl ? Array.from(waveEl.querySelectorAll('.pp-wave-bar')) : [];
    const btnUndo = document.getElementById('btn-hud-undo');
    const btnClose = document.getElementById('btn-hud-close');

    let hudLabels = {};
    let uiLang = 'tr';
    let ttsEnabled = true;
    let sessionState = 'idle'; // idle | listening | processing | result
    let mediaStream = null;
    let audioCtx = null;
    let sourceNode = null;
    let procNode = null;
    let muteGain = null;
    let pcmChunks = [];
    let hasDetectedSpeech = false;
    let lastVoiceAt = 0;
    let recordStartedAt = 0;
    let vadTimer = null;
    let autoHideTimer = null;
    let lastCreatedTaskId = null;

    function label(key, fallback) {
        return (hudLabels && hudLabels[key]) || fallback;
    }

    function clearAutoHide() {
        if (autoHideTimer) {
            clearTimeout(autoHideTimer);
            autoHideTimer = null;
        }
    }

    function scheduleAutoHide(ms = 4500) {
        clearAutoHide();
        autoHideTimer = setTimeout(() => {
            closeHud();
        }, ms);
    }

    function setVisualState(mode, title, subtitle, iconName) {
        if (pillEl) pillEl.dataset.state = mode;
        if (orbEl) orbEl.dataset.state = mode;
        if (iconEl && iconName) iconEl.textContent = iconName;
        if (titleEl && title !== undefined) titleEl.textContent = title;
        if (subEl && subtitle !== undefined) subEl.textContent = subtitle;
        if (waveEl) {
            waveEl.style.display = mode === 'listening' ? 'inline-flex' : 'none';
        }
        if (badgeEl) {
            badgeEl.style.display = (mode === 'success' || mode === 'error') ? 'none' : 'inline-block';
        }
    }

    function updateWaveBars(rms) {
        if (!waveBars.length) return;
        const norm = Math.min(1, Math.max(0, rms * 14));
        const weights = [0.45, 0.85, 1.0, 0.75, 0.5];
        waveBars.forEach((bar, idx) => {
            const h = Math.round(4 + norm * 11 * weights[idx % weights.length]);
            bar.style.height = `${h}px`;
        });
    }

    // Yumuşak 60ms WebAudio "Dinliyorum" ses sinyali (520Hz -> 660Hz)
    function playReadyChime() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(520, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.065);
            gain.gain.setValueAtTime(0.045, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.075);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.08);
            setTimeout(() => { try { ctx.close(); } catch (_) { } }, 140);
        } catch (_) { /* ses cihazı yoksa sessiz geç */ }
    }

    // Windows SAPI / OneCore yerel çevrimdışı TTS (3 kademeli BCP-47 fallback)
    function getVoicesAsync() {
        return new Promise((resolve) => {
            if (!window.speechSynthesis || typeof window.speechSynthesis.getVoices !== 'function') {
                resolve([]);
                return;
            }
            let list = window.speechSynthesis.getVoices();
            if (list && list.length > 0) {
                resolve(list);
                return;
            }
            let settled = false;
            const finish = (v) => {
                if (settled) return;
                settled = true;
                clearInterval(poll);
                clearTimeout(timeout);
                try { window.speechSynthesis.onvoiceschanged = null; } catch (_) { }
                resolve(v || []);
            };
            window.speechSynthesis.onvoiceschanged = () => {
                const v = window.speechSynthesis.getVoices();
                if (v && v.length > 0) finish(v);
            };
            const poll = setInterval(() => {
                const v = window.speechSynthesis.getVoices();
                if (v && v.length > 0) finish(v);
            }, 50);
            const timeout = setTimeout(() => {
                finish(window.speechSynthesis.getVoices() || []);
            }, 1200);
        });
    }

    async function speakOffline(text, langCode) {
        if (!ttsEnabled || !text || !window.speechSynthesis) return;
        try {
            window.speechSynthesis.cancel();
            const voices = await getVoicesAsync();
            const norm = (t) => String(t || '').replace('_', '-').toLowerCase();
            const req = norm(langCode || uiLang || 'tr');
            const primary = req.split('-')[0];

            const localVoices = voices.filter((v) => v && v.localService !== false);
            const pool = localVoices.length > 0 ? localVoices : voices;

            let chosen = pool.find((v) => norm(v.lang) === req)
                || pool.find((v) => norm(v.lang).startsWith(`${primary}-`) || norm(v.lang) === primary)
                || pool.find((v) => v.default)
                || pool[0]
                || null;

            const utt = new SpeechSynthesisUtterance(String(text));
            if (chosen) {
                utt.voice = chosen;
                utt.lang = chosen.lang;
            } else {
                utt.lang = langCode || uiLang || 'tr-TR';
            }
            utt.rate = 1.04;
            utt.pitch = 1.0;
            window.speechSynthesis.speak(utt);
        } catch (_) { /* TTS desteklenmiyorsa görsel yanıt yeterli */ }
    }

    function downsampleTo16k(input, inRate) {
        if (!input || input.length === 0) return new Float32Array(0);
        if (inRate === TARGET_SR) return new Float32Array(input);
        const ratio = inRate / TARGET_SR;
        const outLen = Math.max(1, Math.floor(input.length / ratio));
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const start = Math.floor(i * ratio);
            const end = Math.min(input.length, Math.floor((i + 1) * ratio));
            let sum = 0;
            let count = 0;
            for (let j = start; j < end; j++) {
                sum += input[j];
                count++;
            }
            out[i] = count > 0 ? sum / count : input[start];
        }
        return out;
    }

    async function cleanupAudioGraph() {
        if (vadTimer) {
            clearInterval(vadTimer);
            vadTimer = null;
        }
        try { if (procNode) procNode.disconnect(); } catch (_) { }
        try { if (sourceNode) sourceNode.disconnect(); } catch (_) { }
        try { if (muteGain) muteGain.disconnect(); } catch (_) { }
        procNode = null;
        sourceNode = null;
        muteGain = null;
        if (mediaStream) {
            try { mediaStream.getTracks().forEach((tr) => tr.stop()); } catch (_) { }
            mediaStream = null;
        }
        if (audioCtx) {
            try { await audioCtx.close(); } catch (_) { }
            audioCtx = null;
        }
        updateWaveBars(0);
    }

    async function refreshHudConfig() {
        if (!window.electronAPI || !window.electronAPI.getVoiceHudConfig) return;
        try {
            const cfg = await window.electronAPI.getVoiceHudConfig();
            if (cfg) {
                uiLang = cfg.language || 'tr';
                ttsEnabled = cfg.voiceReplyTtsEnabled !== false;
                hudLabels = cfg.labels || {};
                if (badgeEl && cfg.tierLabel) badgeEl.textContent = cfg.tierLabel;
                if (btnUndo) btnUndo.textContent = label('voiceHudUndoBtn', 'Geri Al');
            }
        } catch (_) { }
    }

    async function startListeningSession() {
        clearAutoHide();
        await cleanupAudioGraph();
        await refreshHudConfig();

        lastCreatedTaskId = null;
        if (btnUndo) btnUndo.classList.add('hidden');

        // Önce STT modelinin indirilmiş olup olmadığını kontrol et
        if (window.electronAPI && window.electronAPI.sttStatus) {
            try {
                const st = await window.electronAPI.sttStatus();
                if (!st || !st.modelPresent) {
                    sessionState = 'result';
                    const msg = label('voiceHudModelMissingDesc', 'Ses modeli henüz indirilmedi. Ayarlar > Yapay Zeka Paketi üzerinden kurabilirsiniz.');
                    setVisualState('error', label('voiceHudModelMissingTitle', 'Ses Modeli Kurulu Değil'), msg, 'download');
                    scheduleAutoHide(5000);
                    return;
                }
            } catch (_) { }
        }

        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            sessionState = 'result';
            setVisualState('error', label('voiceHudMicErrorTitle', 'Mikrofon Bulunamadı'), label('voiceHudMicErrorDesc', 'Ses giriş cihazına erişilemedi.'), 'mic_off');
            scheduleAutoHide(4500);
            return;
        }

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
        } catch (_) {
            sessionState = 'result';
            setVisualState('error', label('voiceHudMicErrorTitle', 'Mikrofon İzni Gerekli'), label('voiceHudMicErrorDesc', 'Mikrofon erişimi reddedildi veya cihaz bağlı değil.'), 'mic_off');
            scheduleAutoHide(4500);
            return;
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
        const inRate = audioCtx.sampleRate || 48000;
        sourceNode = audioCtx.createMediaStreamSource(mediaStream);
        procNode = audioCtx.createScriptProcessor(4096, 1, 1);
        muteGain = audioCtx.createGain();
        muteGain.gain.value = 0;

        pcmChunks = [];
        hasDetectedSpeech = false;
        recordStartedAt = Date.now();
        lastVoiceAt = recordStartedAt;
        sessionState = 'listening';

        setVisualState(
            'listening',
            label('voiceHudListeningTitle', 'Dinleniyor...'),
            label('voiceHudListeningHint', '"45 dakika sonra kapat", "Zamanlayıcıyı durdur" veya "Kalan süre ne kadar?"'),
            'mic'
        );
        playReadyChime();

        procNode.onaudioprocess = (ev) => {
            if (sessionState !== 'listening') return;
            const chan = ev.inputBuffer.getChannelData(0);
            let sumSq = 0;
            for (let i = 0; i < chan.length; i++) {
                sumSq += chan[i] * chan[i];
            }
            const rms = Math.sqrt(sumSq / chan.length);
            updateWaveBars(rms);
            if (rms >= SILENCE_RMS) {
                hasDetectedSpeech = true;
                lastVoiceAt = Date.now();
            }
            pcmChunks.push(downsampleTo16k(chan, inRate));
        };

        sourceNode.connect(procNode);
        procNode.connect(muteGain);
        muteGain.connect(audioCtx.destination);

        vadTimer = setInterval(() => {
            if (sessionState !== 'listening') return;
            const now = Date.now();
            const elapsed = now - recordStartedAt;
            if (hasDetectedSpeech && (now - lastVoiceAt) >= AUTO_STOP_SILENCE_MS && elapsed >= 900) {
                finishAndProcessRecording();
            } else if (!hasDetectedSpeech && elapsed >= NO_SPEECH_TIMEOUT_MS) {
                finishAndProcessRecording();
            } else if (elapsed >= MAX_RECORD_MS) {
                finishAndProcessRecording();
            }
        }, 120);
    }

    async function finishAndProcessRecording() {
        if (sessionState !== 'listening') return;
        sessionState = 'processing';
        const chunks = pcmChunks.splice(0);
        const hadSpeech = hasDetectedSpeech;
        await cleanupAudioGraph();

        let totalLen = 0;
        for (const c of chunks) totalLen += c.length;
        if (!hadSpeech || totalLen < 8000) {
            sessionState = 'result';
            const msg = label('voiceHudNoSpeechDesc', 'Konuşma algılanamadı. Kısayola basıp tekrar söyleyebilirsiniz.');
            setVisualState('error', label('voiceHudNoSpeechTitle', 'Ses Algılanamadı'), msg, 'hearing_disabled');
            scheduleAutoHide(3500);
            return;
        }

        const merged = new Float32Array(Math.min(totalLen, 240000));
        let offset = 0;
        for (const c of chunks) {
            const room = merged.length - offset;
            if (room <= 0) break;
            merged.set(c.length > room ? c.subarray(0, room) : c, offset);
            offset += Math.min(c.length, room);
        }

        setVisualState(
            'processing',
            label('voiceHudProcessingTitle', 'Komut Çözümleniyor...'),
            label('voiceHudProcessingDesc', 'Yerel yapay zeka sesinizi işliyor...'),
            'graphic_eq'
        );

        try {
            const res = await window.electronAPI.voiceHudProcessAudio({
                samples: merged,
                sampleRate: TARGET_SR,
                uiLang
            });
            sessionState = 'result';
            if (!res || res.ok === false) {
                const errTitle = (res && res.title) || label('voiceHudErrorTitle', 'Komut Anlaşılamadı');
                const errSub = (res && (res.speechText || res.message)) || label('voiceHudNoSpeechDesc', 'Lütfen tekrar deneyin.');
                setVisualState('error', errTitle, errSub, res && res.code === 'PIN_REQUIRED' ? 'lock' : 'error_outline');
                await speakOffline(errSub, uiLang);
                scheduleAutoHide(5200);
                return;
            }

            if (res.kind === 'task_started' && res.taskId && res.canUndo && btnUndo) {
                lastCreatedTaskId = res.taskId;
                btnUndo.classList.remove('hidden');
            }

            const title = res.transcript ? `"${res.transcript}"` : (res.title || 'Power Pilot');
            const sub = res.speechText || res.message || '';
            const icon = res.kind === 'task_cancelled' ? 'timer_off' : (res.kind === 'task_started' ? 'check_circle' : 'smart_toy');
            setVisualState('success', title, sub, icon);
            await speakOffline(sub, uiLang);
            scheduleAutoHide(5500);
        } catch (_) {
            sessionState = 'result';
            setVisualState('error', label('voiceHudErrorTitle', 'Hata Oluştu'), label('voiceHudNoSpeechDesc', 'Lütfen tekrar deneyin.'), 'error_outline');
            scheduleAutoHide(4200);
        }
    }

    async function closeHud() {
        clearAutoHide();
        sessionState = 'idle';
        await cleanupAudioGraph();
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { }
        if (window.electronAPI && window.electronAPI.closeVoiceHud) {
            window.electronAPI.closeVoiceHud();
        }
    }

    if (orbEl) {
        orbEl.addEventListener('click', () => {
            if (sessionState === 'listening') {
                finishAndProcessRecording();
            } else {
                startListeningSession();
            }
        });
    }

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            closeHud();
        });
    }

    if (btnUndo) {
        btnUndo.addEventListener('click', async () => {
            if (!lastCreatedTaskId || !window.electronAPI || !window.electronAPI.cancelTask) return;
            const id = lastCreatedTaskId;
            lastCreatedTaskId = null;
            btnUndo.classList.add('hidden');
            try {
                await window.electronAPI.cancelTask(id);
                const msg = label('voiceHudUndoneDesc', 'Başlatılan görev geri alındı ve iptal edildi.');
                setVisualState('success', label('voiceHudUndoneTitle', 'Geri Alındı'), msg, 'undo');
                await speakOffline(msg, uiLang);
                scheduleAutoHide(3200);
            } catch (_) { }
        });
    }

    if (window.electronAPI && window.electronAPI.onVoiceHudTrigger) {
        window.electronAPI.onVoiceHudTrigger((rawAction) => {
            const action = String(rawAction || '').toLowerCase();
            if (action === 'toggle') {
                if (sessionState === 'listening') {
                    finishAndProcessRecording();
                } else {
                    startListeningSession();
                }
            } else if (action === 'start') {
                startListeningSession();
            } else if (action === 'stop') {
                closeHud();
            }
        });
    }
})();
