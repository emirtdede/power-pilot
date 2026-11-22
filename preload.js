const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimize: () => ipcRenderer.send('window-minimize'),
    close: () => ipcRenderer.send('window-close'),
    maximizeToggle: () => ipcRenderer.send('window-maximize-toggle'),

    // Legacy quick timer IPC
    scheduleAction: (args) => ipcRenderer.invoke('schedule-action', args),
    cancelAction: (pin) => ipcRenderer.invoke('cancel-action', pin === undefined ? undefined : { pin }),
    setAutostart: (enable) => ipcRenderer.send('setting-autostart', enable),
    hideMiniWidget: () => ipcRenderer.send('hide-mini-widget'),
    restoreMainWindow: () => ipcRenderer.send('restore-main-window'),

    // Comprehensive Tasks API
    getTasks: () => ipcRenderer.invoke('get-tasks'),
    getActiveState: () => ipcRenderer.invoke('get-active-state'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    createTask: (taskData) => ipcRenderer.invoke('create-task', taskData),
    cancelTask: (taskId, pin) => ipcRenderer.invoke('cancel-task', pin === undefined ? taskId : { taskId, pin }),
    snoozeTask: (args) => ipcRenderer.invoke('snooze-task', args),
    pauseTask: (taskId) => ipcRenderer.invoke('pause-task', taskId),
    resumeTask: (taskId) => ipcRenderer.invoke('resume-task', taskId),
    removeTask: (taskId) => ipcRenderer.invoke('remove-task', taskId),
    removeTerminalTasks: () => ipcRenderer.invoke('remove-terminal-tasks'),
    // Cancel PIN API (WBS-11.2)
    setCancelPin: (pin, currentPin) => ipcRenderer.invoke('set-cancel-pin', { pin, currentPin }),
    clearCancelPin: (pin) => ipcRenderer.invoke('clear-cancel-pin', pin === undefined ? undefined : { pin }),
    getCancelPinState: () => ipcRenderer.invoke('get-cancel-pin-state'),

    // History & Stats API
    getHistory: (filter) => ipcRenderer.invoke('get-history', filter),
    clearHistory: () => ipcRenderer.invoke('clear-history'),
    getStatistics: (options) => ipcRenderer.invoke('get-statistics', options),
    exportStatistics: (args) => ipcRenderer.invoke('export-statistics', args),

    // Templates API (WP-7: tam CRUD + varsayılan sıfırlama/geri getirme)
    getTemplates: (options) => ipcRenderer.invoke('get-templates', options),
    getHiddenTemplates: () => ipcRenderer.invoke('get-hidden-templates'),
    saveTemplate: (tpl) => ipcRenderer.invoke('save-template', tpl),
    deleteTemplate: (templateId) => ipcRenderer.invoke('delete-template', templateId),
    resetTemplate: (templateId) => ipcRenderer.invoke('reset-template', templateId),
    restoreDefaultTemplates: (options) => ipcRenderer.invoke('restore-default-templates', options),
    exportTemplates: () => ipcRenderer.invoke('export-templates'),
    importTemplates: () => ipcRenderer.invoke('import-templates'),

    // AI Assistant API (WBS-7.4 + WP-8: şablon, bağlantı, yerel Docs RAG)
    aiStatus: () => ipcRenderer.invoke('ai-status'),
    aiParse: (text) => ipcRenderer.invoke('ai-parse', text),
    aiAssist: (payload) => ipcRenderer.invoke('ai-assist', payload),
    searchDocs: (query) => ipcRenderer.invoke('search-docs', query),
    aiDiagnose: (reason) => ipcRenderer.invoke('ai-diagnose', reason),
    aiEnergy: () => ipcRenderer.invoke('ai-energy'),
    aiSuggest: () => ipcRenderer.invoke('ai-suggest'),
    aiDismissSuggestion: (topic) => ipcRenderer.invoke('ai-dismiss-suggestion', topic),
    warningCancel: (pin) => ipcRenderer.invoke('warning-cancel', pin === undefined ? undefined : { pin }),
    warningSnooze: (minutes, pin) => ipcRenderer.invoke('warning-snooze', typeof minutes === 'object' ? minutes : { minutes, pin }),
    warningConfirm: (taskId) => ipcRenderer.invoke('warning-confirm', taskId ? { taskId } : undefined),
    // AI Model API (WBS-7.5 + WP-3.3 3 Kademeli Yerel AI)
    aiModelDownload: (tierId) => ipcRenderer.invoke('ai-model-download', tierId ? { tierId } : undefined),
    aiModelCancel: () => ipcRenderer.invoke('ai-model-cancel'),
    aiModelDelete: (tierId) => ipcRenderer.invoke('ai-model-delete', tierId ? { tierId } : undefined),
    aiSelectTier: (tierId) => ipcRenderer.invoke('ai-select-tier', tierId ? { tierId } : undefined),
    aiModelLoad: (tierId) => ipcRenderer.invoke('ai-model-load', tierId ? { tierId } : undefined),
    aiModelUnload: () => ipcRenderer.invoke('ai-model-unload'),
    // Voice API (WBS-8.3 + WP-4.2 Görev Çubuğu Üstü Sesli Dikte HUD)
    sttStatus: () => ipcRenderer.invoke('stt-status'),
    sttTranscribe: (payload) => ipcRenderer.invoke('stt-transcribe', payload),
    getVoiceHudConfig: () => ipcRenderer.invoke('get-voice-hud-config'),
    openVoiceHud: () => ipcRenderer.invoke('open-voice-hud'),
    closeVoiceHud: () => ipcRenderer.send('close-voice-hud'),
    voiceHudProcessAudio: (payload) => ipcRenderer.invoke('voice-hud-process-audio', payload),
    voiceHudExecuteText: (text) => ipcRenderer.invoke('voice-hud-execute-text', { text }),
    onVoiceHudTrigger: (callback) => {
        const h = (event, action) => callback(action);
        ipcRenderer.on('voice-hud-trigger', h);
        return () => ipcRenderer.removeListener('voice-hud-trigger', h);
    },
    // Device profiler API (WBS-E3)
    deviceEstimate: () => ipcRenderer.invoke('device-estimate'),

    // Settings & Integrations API
    // K-01: get-settings artık redakte edilmiş DTO döner (sırlar/PIN özeti yok).
    getSettings: () => ipcRenderer.invoke('get-settings'),
    getPublicSettings: () => ipcRenderer.invoke('get-settings'),
    getDistribution: () => ipcRenderer.invoke('get-distribution'),
    getStorageStatus: () => ipcRenderer.invoke('get-storage-status'),
    // C5: yerel sağlık özeti (telemetri yok; yalnızca cihazdaki kayıtlar).
    getHealthSummary: () => ipcRenderer.invoke('get-health-summary'),
    openStartupSettings: () => ipcRenderer.invoke('open-startup-settings'),
    // PIN kurtarma: uygulamanın gerçek veri klasörünü açar (yol istemciden gelmez).
    openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
    deleteAllData: (args) => ipcRenderer.invoke('delete-all-data', args),
    getLocale: (lang) => ipcRenderer.invoke('get-locale', lang),
    reportCspViolation: (data) => ipcRenderer.send('csp-violation', data),
    saveSettings: (newSettings) => ipcRenderer.invoke('save-settings', newSettings),
    saveSettingsAtomic: (args) => ipcRenderer.invoke('save-settings-atomic', args),
    // WP-10.T4: güvenlik bayrakları ve API anahtarı PIN gerektirir.
    securitySettingsUpdate: (args) => ipcRenderer.invoke('security-settings-update', args),
    generateApiKey: (args) => ipcRenderer.invoke('generate-api-key', args),
    getWebhooks: () => ipcRenderer.invoke('get-webhooks'),
    saveWebhooks: (webhooks) => ipcRenderer.invoke('save-webhooks', webhooks),
    testWebhook: (hook) => ipcRenderer.invoke('test-webhook', hook),
    sendWakeOnLan: (args) => ipcRenderer.invoke('send-wol', args),
    getWolDevices: () => ipcRenderer.invoke('get-wol-devices'),
    saveWolDevices: (devices) => ipcRenderer.invoke('save-wol-devices', devices),
    testUps: (args) => ipcRenderer.invoke('test-ups', args),
    getMcpConfig: () => ipcRenderer.invoke('get-mcp-config'),

    // App Icon & Desktop Shortcut API (WP-2)
    getAppIconStatus: () => ipcRenderer.invoke('get-app-icon-status'),
    createDesktopShortcut: () => ipcRenderer.invoke('create-desktop-shortcut'),
    saveCustomAppIcon: (payload) => ipcRenderer.invoke('save-custom-app-icon', payload),
    setUiZoom: (zoom) => ipcRenderer.invoke('set-ui-zoom', zoom),
    getSystemTheme: () => ipcRenderer.invoke('get-system-theme'),
    getGlobalShortcutStatus: () => ipcRenderer.invoke('get-global-shortcut-status'),
    getSystemDiagnosticText: (args) => ipcRenderer.invoke('get-system-diagnostic-text', args),

    // Diagnostics & Crash Reports API (WP-5)
    getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
    clearDiagnostics: () => ipcRenderer.invoke('clear-diagnostics'),
    reportRendererError: (payload) => ipcRenderer.send('report-renderer-error', payload),
    createSupportBundle: () => ipcRenderer.invoke('create-support-bundle'),
    revealSupportBundle: (filePath) => ipcRenderer.invoke('reveal-support-bundle', filePath),
    openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
    composeSupportMail: (args) => ipcRenderer.invoke('compose-support-mail', args),
    openGithubIssue: () => ipcRenderer.invoke('open-github-issue'),

    // Settings Backup & Test Notification API (WP-9)
    exportSettings: () => ipcRenderer.invoke('export-settings'),
    importSettings: (args) => ipcRenderer.invoke('import-settings', args),
    testDesktopNotification: () => ipcRenderer.invoke('test-desktop-notification'),

    // OneDrive Serverless Cloud Backup & Sync API
    getOneDriveStatus: () => ipcRenderer.invoke('onedrive-status'),
    connectOneDrive: () => ipcRenderer.invoke('onedrive-connect'),
    disconnectOneDrive: () => ipcRenderer.invoke('onedrive-disconnect'),
    syncOneDriveNow: () => ipcRenderer.invoke('onedrive-sync-now'),
    restoreOneDrive: (args) => ipcRenderer.invoke('onedrive-restore', args),
    setOneDriveAutoSync: (enabled) => ipcRenderer.invoke('onedrive-set-autosync', { enabled }),
    openOneDriveFolder: () => ipcRenderer.invoke('onedrive-open-folder'),
    selectOneDriveFolder: () => ipcRenderer.invoke('onedrive-select-folder'),
    resetOneDriveFolder: () => ipcRenderer.invoke('onedrive-reset-folder'),
    useCloudProvider: (providerId) => ipcRenderer.invoke('onedrive-use-provider', { providerId }),
    dismissOneDriveRecovery: () => ipcRenderer.invoke('onedrive-dismiss-recovery'),

    // Software Update API (Channel-Aware: Store OFF / Portable Notify / Direct NSIS electron-updater)
    getUpdateStatus: () => ipcRenderer.invoke('update-get-status'),
    checkForUpdates: () => ipcRenderer.invoke('update-check'),
    downloadUpdate: () => ipcRenderer.invoke('update-download'),
    installUpdateNow: (pin) => ipcRenderer.invoke('update-install-now', pin === undefined ? undefined : { pin }),
    setInstallUpdateOnQuit: (enabled) => ipcRenderer.invoke('update-set-install-on-quit', { enabled }),
    openUpdateReleasePage: () => ipcRenderer.invoke('update-open-release-page'),

    // Enterprise pilot API (FAZ B/D) - konsol eşleştirme, envanter, denetim
    getInventory: () => ipcRenderer.invoke('get-inventory'),
    getExemptions: () => ipcRenderer.invoke('get-exemptions'),
    getSecurityStatus: () => ipcRenderer.invoke('get-security-status'),
    getAudit: (args) => ipcRenderer.invoke('get-audit', args),
    consoleSync: () => ipcRenderer.invoke('console-sync'),

    // Event listeners (D-04: tüm abonelikler removeListener temizlik fonksiyonu döner)
    onTimerCancelled: (callback) => {
        const h = (event, ...args) => callback(event, ...args);
        ipcRenderer.on('timer-cancelled-from-tray', h);
        return () => ipcRenderer.removeListener('timer-cancelled-from-tray', h);
    },
    onWindowStateChanged: (callback) => {
        const h = (event, state) => callback(state);
        ipcRenderer.on('window-state-changed', h);
        return () => ipcRenderer.removeListener('window-state-changed', h);
    },
    onTimerTick: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('timer-tick', h);
        return () => ipcRenderer.removeListener('timer-tick', h);
    },
    getMiniLabels: () => ipcRenderer.invoke('get-mini-labels'),
    // WP-08.T3/T2: gerçek yürütme sonucu ve uykudan dönüş.
    onTaskExecuted: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('task-executed', h);
        return () => ipcRenderer.removeListener('task-executed', h);
    },
    onTaskFailed: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('task-failed', h);
        return () => ipcRenderer.removeListener('task-failed', h);
    },
    // A6: kapatma Windows tarafından engellendi (açık uygulamalar onay bekliyor).
    onShutdownVetoed: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('shutdown-vetoed', h);
        return () => ipcRenderer.removeListener('shutdown-vetoed', h);
    },
    onSystemResumed: (callback) => {
        const h = () => callback();
        ipcRenderer.on('system-resumed', h);
        return () => ipcRenderer.removeListener('system-resumed', h);
    },
    onSystemThemeChanged: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('system-theme-changed', h);
        return () => ipcRenderer.removeListener('system-theme-changed', h);
    },
    onUpdateStateChanged: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('update-state-changed', h);
        return () => ipcRenderer.removeListener('update-state-changed', h);
    },
    onRequestAutonomyChange: (callback) => {
        const h = (event, mode) => callback(mode);
        ipcRenderer.on('request-autonomy-change', h);
        return () => ipcRenderer.removeListener('request-autonomy-change', h);
    },
    onRequestTrayPinAction: (callback) => {
        const h = (event, reason) => callback(reason);
        ipcRenderer.on('request-tray-pin-action', h);
        return () => ipcRenderer.removeListener('request-tray-pin-action', h);
    },
    togglePauseAll: (pin) => ipcRenderer.invoke('toggle-pause-all', pin === undefined ? undefined : { pin }),
    quitApp: (pin) => ipcRenderer.invoke('quit-app', pin === undefined ? undefined : { pin }),
    onRequestAiSilence: (callback) => {
        const h = (event, until) => callback(until);
        ipcRenderer.on('request-ai-silence', h);
        return () => ipcRenderer.removeListener('request-ai-silence', h);
    },
    onWarningStarted: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('warning-started', h);
        return () => ipcRenderer.removeListener('warning-started', h);
    },
    onWarningTick: (callback) => {
        const h = (event, data) => callback(data);
        ipcRenderer.on('warning-tick', h);
        return () => ipcRenderer.removeListener('warning-tick', h);
    },
    // WBS-9.4: Banner kapatma - üç terminal olaydan biri.
    // D-04: abonelikten çıkma fonksiyonu döner; HMR/yeniden yüklemede listener birikmez.
    onWarningEnded: (callback) => {
        const h = (event, data) => callback(data);
        const channels = ['warning-cancelled', 'warning-snoozed', 'warning-finished'];
        channels.forEach((c) => ipcRenderer.on(c, h));
        return () => channels.forEach((c) => ipcRenderer.removeListener(c, h));
    },

    // External link
    openExternal: (url) => ipcRenderer.send('open-external-link', url)
});
