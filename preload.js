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
    // AI Model API (WBS-7.5)
    aiModelDownload: () => ipcRenderer.invoke('ai-model-download'),
    aiModelLoad: () => ipcRenderer.invoke('ai-model-load'),
    aiModelUnload: () => ipcRenderer.invoke('ai-model-unload'),
    // Voice API (WBS-8.3)
    sttStatus: () => ipcRenderer.invoke('stt-status'),
    sttTranscribe: (payload) => ipcRenderer.invoke('stt-transcribe', payload),
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
    dismissOneDriveRecovery: () => ipcRenderer.invoke('onedrive-dismiss-recovery'),

    // Enterprise pilot API (FAZ B/D) - konsol eşleştirme, envanter, denetim
    getInventory: () => ipcRenderer.invoke('get-inventory'),
    getExemptions: () => ipcRenderer.invoke('get-exemptions'),
    getSecurityStatus: () => ipcRenderer.invoke('get-security-status'),
    getAudit: (args) => ipcRenderer.invoke('get-audit', args),
    consoleSync: () => ipcRenderer.invoke('console-sync'),

    // Event listeners
    onTimerCancelled: (callback) => ipcRenderer.on('timer-cancelled-from-tray', callback),
    onWindowStateChanged: (callback) => ipcRenderer.on('window-state-changed', (event, state) => callback(state)),
    onTimerTick: (callback) => ipcRenderer.on('timer-tick', (event, data) => callback(data)),
    getMiniLabels: () => ipcRenderer.invoke('get-mini-labels'),
    // WP-08.T3/T2: gerçek yürütme sonucu ve uykudan dönüş.
    onTaskExecuted: (callback) => ipcRenderer.on('task-executed', (event, data) => callback(data)),
    onTaskFailed: (callback) => ipcRenderer.on('task-failed', (event, data) => callback(data)),
    // A6: kapatma Windows tarafından engellendi (açık uygulamalar onay bekliyor).
    onShutdownVetoed: (callback) => ipcRenderer.on('shutdown-vetoed', (event, data) => callback(data)),
    onSystemResumed: (callback) => ipcRenderer.on('system-resumed', () => callback()),
    onRequestAutonomyChange: (callback) => ipcRenderer.on('request-autonomy-change', (event, mode) => callback(mode)),
    onRequestTrayPinAction: (callback) => ipcRenderer.on('request-tray-pin-action', (event, reason) => callback(reason)),
    togglePauseAll: (pin) => ipcRenderer.invoke('toggle-pause-all', pin === undefined ? undefined : { pin }),
    quitApp: (pin) => ipcRenderer.invoke('quit-app', pin === undefined ? undefined : { pin }),
    onRequestAiSilence: (callback) => ipcRenderer.on('request-ai-silence', (event, until) => callback(until)),
    onWarningStarted: (callback) => ipcRenderer.on('warning-started', (event, data) => callback(data)),
    onWarningTick: (callback) => ipcRenderer.on('warning-tick', (event, data) => callback(data)),
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
