        // D-03: mini pencere araç ipuçları aktif dile göre (hardcoded Türkçe değil).
        async function applyMiniLabels() {
            if (!window.electronAPI || !window.electronAPI.getMiniLabels) return;
            try {
                const labels = await window.electronAPI.getMiniLabels();
                if (!labels) return;
                document.querySelectorAll('[data-i18n-title]').forEach((el) => {
                    const key = el.getAttribute('data-i18n-title');
                    if (key && labels[key]) {
                        el.title = labels[key];
                        el.setAttribute('aria-label', labels[key]);
                    }
                });
            } catch (_) { /* varsayılan başlıklar kalır */ }
        }
        applyMiniLabels();

        // Listen for ticks
        if (window.electronAPI && window.electronAPI.onTimerTick) {
            window.electronAPI.onTimerTick((data) => {
                const actionText = document.getElementById('action-text');
                const countdownText = document.getElementById('countdown-text');
                if (!data) return;

                // Koşullu görevlerde (Smart Finish) hedef zaman yoktur; geri
                // sayım uydurmak yerine "İzleniyor" ve ilerleme metni gösterilir.
                if (data.monitoring) {
                    if (actionText) {
                        actionText.textContent = data.actionText || data.statusText || '--';
                        actionText.title = data.progressText || data.actionText || '';
                    }
                    if (countdownText) {
                        countdownText.textContent = data.progressText || data.statusText || '--';
                        countdownText.classList.add('text-sm');
                        countdownText.classList.remove('text-2xl');
                    }
                    return;
                }

                if (actionText) {
                    actionText.textContent = data.actionText || '--';
                    actionText.title = data.actionText || '';
                }
                if (countdownText) {
                    countdownText.classList.remove('text-sm');
                    countdownText.classList.add('text-2xl');
                    countdownText.textContent = data.formattedCountdown || '00:00';
                }
            });
        }

        // Hide button action (send widget to background)
        const btnHide = document.getElementById('btn-hide');
        if (btnHide) {
            btnHide.addEventListener('click', () => {
                if (window.electronAPI && window.electronAPI.hideMiniWidget) {
                    window.electronAPI.hideMiniWidget();
                }
            });
        }

        // Restore button action (show main app window)
        const btnRestore = document.getElementById('btn-restore');
        if (btnRestore) {
            btnRestore.addEventListener('click', () => {
                if (window.electronAPI && window.electronAPI.restoreMainWindow) {
                    window.electronAPI.restoreMainWindow();
                }
            });
        }

        // Cancel button action (cancel active timer and restore main app)
        const btnCancel = document.getElementById('btn-cancel');
        if (btnCancel) {
            btnCancel.addEventListener('click', async () => {
                try {
                    if (!window.electronAPI || !window.electronAPI.cancelAction) return;
                    const res = await window.electronAPI.cancelAction();
                    // WBS-11.2: PIN korumalıysa mini pencerede sorulamaz - ana pencere açılır.
                    if (res && res.success === false && window.electronAPI.restoreMainWindow) {
                        window.electronAPI.restoreMainWindow();
                    }
                } catch (err) {
                    console.warn('[Mini] iptal başarısız:', err && err.message);
                }
            });
        }
    