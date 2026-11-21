/**
 * agents/diagnoseAgent.js — F9.1 + WP-8
 * Deterministik teşhisçi: aktif uygulama diline (TR / EN) uyumlu sade açıklama.
 */
'use strict';

function explainBlocked(reason, language = 'tr') {
    const r = String(reason || '');
    const isTr = String(language || 'tr').toLowerCase().startsWith('tr');

    if (/Korunan uygulama|PROTECTED_APP/i.test(r)) {
        return isTr
            ? {
                explanation: `${r} Bu uygulama açıkken otomatik kapatma duraklatıldı; çalışmanız korunuyor.`,
                whatToDo: 'Uygulamayı kapatıp görevi yeniden kurun ya da erteleyin.'
            }
            : {
                explanation: `${r} Automatic shutdown was paused while this protected app is running to keep your work safe.`,
                whatToDo: 'Close the protected app and reschedule, or snooze the task.'
            };
    }
    if (/uzaktan kapatma|USER_ACTIVE/i.test(r)) {
        return isTr
            ? {
                explanation: 'Bilgisayar başında biri aktif olduğu için uzaktan kapatma engellendi.',
                whatToDo: 'Kullanıcı boşta kalınca tekrar deneyin ya da doğrudan zamanlayıcı kurun.'
            }
            : {
                explanation: 'Remote shutdown was blocked because a user is currently active at this PC.',
                whatToDo: 'Retry once the PC is idle, or schedule a timed task directly.'
            };
    }
    if (/Çakışan görev|CONFLICT/i.test(r)) {
        return isTr
            ? {
                explanation: r,
                whatToDo: 'Önce çalışan görevi iptal edin, sonra yenisini kurun.'
            }
            : {
                explanation: r,
                whatToDo: 'Cancel the currently running task first, then create the new one.'
            };
    }
    if (/Tam ekran|FULLSCREEN/i.test(r)) {
        return isTr
            ? {
                explanation: 'Tam ekran bir uygulama (sunum/video/oyun) aktif olduğu için görev bekletildi.',
                whatToDo: 'Tam ekran oturumu sonlandığında tekrar deneyin veya Ayarlar → Otomasyon içinden tam ekran korumasını düzenleyin.'
            }
            : {
                explanation: 'Execution was blocked while a fullscreen session (video, game, or presentation) was active.',
                whatToDo: 'Retry after exiting fullscreen or adjust Fullscreen Protection under Settings → Automation.'
            };
    }
    return isTr
        ? {
            explanation: r || 'Görev güvenlik kuralına takıldı.',
            whatToDo: 'Geçmiş kaydındaki gerekçeyi kontrol edin.'
        }
        : {
            explanation: r || 'The task was blocked by a safety policy.',
            whatToDo: 'Check the exact reason in the History tab.'
        };
}

module.exports = {
    id: 'diagnose',
    version: '1.0.0',
    description: 'Engelleme gerekçesini aktif dilde açıklar.',
    async execute({ reason, language = 'tr' }) {
        return { ok: true, ...explainBlocked(reason, language) };
    }
};
