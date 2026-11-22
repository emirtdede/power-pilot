'use strict';

/**
 * UpdateService.js - Dagitim kanalina duyarli kurumsal guncelleme yoneticisi.
 *
 * 3 kanal kati ayrimi:
 * - Microsoft Store (MSIX): Tamamen kapali (storeUpdatesOnly). Hicbir ag istegi
 *   atmaz, electron-updater yuklemez; guncellemeleri Store yonetir.
 * - Portable (.exe): Asla NSIS Setup .exe indirmez veya calistirmaz (portable
 *   kurulumu bozmaz). Statik releases/latest/download/latest.yml uzerinden yeni
 *   surum denetler ve resmi indirme sayfasini acar.
 * - Direct NSIS: electron-updater ile statik GitHub latest.yml + .blockmap
 *   (delta indirme + SHA-512 dogrulama) kullanir; GitHub API 60/saat limitine
 *   takilmaz, surum notlarini gosterir ve "Cikista Guncelle" destekler.
 *
 * Gizlilik kurali: autoCheckUpdates varsayilan KAPALIDIR (false). Kullanici
 * acmadikca veya elle "Guncellemeleri Denetle" demedikce internete cikilmaz.
 */

const https = require('https');

const GITHUB_OWNER = 'emirtdede';
const GITHUB_REPO = 'power-pilot';
const RELEASE_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const STATIC_LATEST_YML_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/latest.yml`;
const ALLOWED_UPDATE_HOSTS = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
]);

function parseSemver(raw) {
    if (typeof raw !== 'string') return null;
    const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(raw.trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
}

function sanitizeReleaseNotes(raw) {
    if (!raw) return null;
    let text = '';
    if (typeof raw === 'string') {
        text = raw;
    } else if (Array.isArray(raw)) {
        text = raw
            .map((entry) => {
                if (!entry) return '';
                if (typeof entry === 'string') return entry;
                const ver = entry.version ? `v${String(entry.version).replace(/^v/i, '')}: ` : '';
                return `${ver}${String(entry.note || '')}`;
            })
            .filter(Boolean)
            .join('\n\n');
    } else {
        return null;
    }
    const cleaned = text
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<\s*li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\uff0d]/g, '-')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return cleaned ? cleaned.slice(0, 4000) : null;
}

function parseLatestYml(yamlText) {
    if (typeof yamlText !== 'string' || !yamlText.trim()) return null;
    const lines = yamlText.replace(/\r\n/g, '\n').split('\n');
    const out = {
        version: null,
        path: null,
        sha512: null,
        releaseDate: null,
        releaseNotes: null
    };
    const stripQuotes = (s) => {
        const trimmed = s.trim();
        if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
            return trimmed.slice(1, -1);
        }
        return trimmed;
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line || /^\s*#/.test(line)) continue;
        const m = /^(version|path|sha512|releaseDate|releaseNotes):\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        const val = m[2].trim();
        if (key === 'releaseNotes' && (val === '|' || val === '|-' || val === '>' || val === '>-')) {
            const block = [];
            let j = i + 1;
            while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j] === '')) {
                block.push(lines[j].replace(/^\s{2}/, ''));
                j += 1;
            }
            out.releaseNotes = sanitizeReleaseNotes(block.join('\n'));
            i = j - 1;
        } else if (key === 'releaseNotes') {
            out.releaseNotes = sanitizeReleaseNotes(stripQuotes(val));
        } else {
            out[key] = stripQuotes(val) || null;
        }
    }
    return out.version ? out : null;
}

function fetchHttpsText(urlString, { timeoutMs = 12000, maxRedirects = 5, maxBytes = 256 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(urlString);
        } catch (_) {
            reject(Object.assign(new Error('Invalid URL'), { code: 'INVALID_URL' }));
            return;
        }
        if (parsed.protocol !== 'https:' || !ALLOWED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase())) {
            reject(Object.assign(new Error('Disallowed update host'), { code: 'DISALLOWED_HOST' }));
            return;
        }

        const req = https.get(parsed, {
            headers: {
                'User-Agent': 'PowerPilot-Updater/1.0',
                Accept: 'text/yaml, text/plain, */*'
            },
            timeout: timeoutMs
        }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (maxRedirects <= 0) {
                    reject(Object.assign(new Error('Too many redirects'), { code: 'TOO_MANY_REDIRECTS' }));
                    return;
                }
                const nextUrl = new URL(res.headers.location, parsed).toString();
                fetchHttpsText(nextUrl, { timeoutMs, maxRedirects: maxRedirects - 1, maxBytes }).then(resolve, reject);
                return;
            }
            if (status === 404) {
                res.resume();
                reject(Object.assign(new Error('No published release metadata found'), { code: 'NO_RELEASE_METADATA' }));
                return;
            }
            if (status === 403 || status === 429) {
                res.resume();
                reject(Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED' }));
                return;
            }
            if (status < 200 || status >= 300) {
                res.resume();
                reject(Object.assign(new Error(`HTTP ${status}`), { code: 'HTTP_ERROR', status }));
                return;
            }
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    req.destroy();
                    reject(Object.assign(new Error('Metadata too large'), { code: 'PAYLOAD_TOO_LARGE' }));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });
        req.on('timeout', () => {
            req.destroy();
            reject(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' }));
        });
        req.on('error', reject);
    });
}

function classifyErrorCode(err) {
    const code = String((err && err.code) || '').toUpperCase();
    const msg = String((err && err.message) || '');
    if (code === 'RATE_LIMITED' || /\b429\b|rate limit/i.test(msg)) return 'RATE_LIMITED';
    if (code === 'NO_RELEASE_METADATA' || /\b404\b|cannot find latest\.yml/i.test(msg)) return 'NO_RELEASE_METADATA';
    if (/sha512|checksum|signature|publisher|authenticode|integrity|verify/i.test(msg)) return 'SIGNATURE_OR_HASH_ERROR';
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|TIMEOUT|network/i.test(`${code} ${msg}`)) {
        return 'OFFLINE_OR_NETWORK';
    }
    return 'CHECK_FAILED';
}

class UpdateService {
    constructor(options = {}) {
        this.currentVersion = String(options.currentVersion || '1.0.0');
        this.isStore = options.isStore === true;
        this.isPortable = options.isPortable === true && !this.isStore;
        this.isPackaged = options.isPackaged === true;
        this.logger = options.logger || null;
        this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
        this.onBeforeQuitAndInstall = typeof options.onBeforeQuitAndInstall === 'function' ? options.onBeforeQuitAndInstall : null;
        this.fetchText = typeof options.fetchText === 'function' ? options.fetchText : fetchHttpsText;
        this.loadAutoUpdater = typeof options.loadAutoUpdater === 'function'
            ? options.loadAutoUpdater
            : () => require('electron-updater').autoUpdater;
        this.latestYmlUrl = options.latestYmlUrl || STATIC_LATEST_YML_URL;
        this.releasePageUrl = options.releasePageUrl || RELEASE_PAGE_URL;

        this.mode = this.isStore ? 'store' : (this.isPortable ? 'portable' : 'nsis');
        this._updater = null;
        this._updaterBound = false;
        this._busy = false;

        this._state = {
            mode: this.mode,
            status: this.isStore ? 'store-managed' : 'idle',
            currentVersion: this.currentVersion,
            availableVersion: null,
            releaseDate: null,
            releaseNotes: null,
            releaseUrl: this.releasePageUrl,
            canAutoInstall: this.mode === 'nsis' && this.isPackaged,
            installOnQuit: false,
            progress: null,
            checkedAt: null,
            errorCode: null
        };
    }

    _logInfo(msg) {
        if (this.logger && typeof this.logger.info === 'function') this.logger.info(msg);
    }

    _logWarn(msg, err) {
        if (this.logger && typeof this.logger.warn === 'function') {
            this.logger.warn(msg, err && err.message ? err.message : (err || ''));
        }
    }

    getState() {
        return {
            ...this._state,
            progress: this._state.progress ? { ...this._state.progress } : null
        };
    }

    _setState(patch) {
        this._state = { ...this._state, ...patch };
        if (this.onStateChange) {
            try { this.onStateChange(this.getState()); } catch (_) { /* yut */ }
        }
        return this.getState();
    }

    _ensureNsisUpdater() {
        if (this.mode !== 'nsis' || !this.isPackaged) return null;
        if (this._updater) return this._updater;
        const updater = this.loadAutoUpdater();
        if (!updater) return null;
        this._updater = updater;
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = this._state.installOnQuit === true;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        if (this.logger) updater.logger = this.logger;
        if (typeof updater.setFeedURL === 'function') {
            try {
                updater.setFeedURL({
                    provider: 'github',
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    releaseType: 'release'
                });
            } catch (err) {
                this._logWarn('[Update] setFeedURL atlandi:', err);
            }
        }
        if (!this._updaterBound && typeof updater.on === 'function') {
            this._updaterBound = true;
            updater.on('checking-for-update', () => {
                this._setState({ status: 'checking', errorCode: null, progress: null });
            });
            updater.on('update-available', (info) => {
                this._setState({
                    status: 'available',
                    availableVersion: info && info.version ? String(info.version) : null,
                    releaseDate: info && info.releaseDate ? String(info.releaseDate) : null,
                    releaseNotes: sanitizeReleaseNotes(info && info.releaseNotes),
                    checkedAt: new Date().toISOString(),
                    progress: null,
                    errorCode: null
                });
            });
            updater.on('update-not-available', () => {
                this._setState({
                    status: 'up-to-date',
                    availableVersion: null,
                    releaseDate: null,
                    releaseNotes: null,
                    checkedAt: new Date().toISOString(),
                    progress: null,
                    errorCode: null
                });
            });
            updater.on('download-progress', (p) => {
                const percent = Number.isFinite(p && p.percent)
                    ? Math.min(100, Math.max(0, Math.round(p.percent)))
                    : 0;
                this._setState({
                    status: 'downloading',
                    progress: {
                        percent,
                        transferred: Number(p && p.transferred) || 0,
                        total: Number(p && p.total) || 0,
                        bytesPerSecond: Number(p && p.bytesPerSecond) || 0
                    },
                    errorCode: null
                });
            });
            updater.on('update-downloaded', (info) => {
                this._setState({
                    status: 'downloaded',
                    availableVersion: (info && info.version ? String(info.version) : this._state.availableVersion),
                    releaseDate: (info && info.releaseDate ? String(info.releaseDate) : this._state.releaseDate),
                    releaseNotes: sanitizeReleaseNotes(info && info.releaseNotes) || this._state.releaseNotes,
                    progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
                    errorCode: null
                });
            });
            updater.on('error', (err) => {
                const code = classifyErrorCode(err);
                this._logWarn(`[Update] electron-updater hatasi (${code}):`, err);
                this._setState({
                    status: 'error',
                    errorCode: code,
                    progress: null
                });
            });
        }
        return this._updater;
    }

    async _checkStaticLatestYml() {
        this._setState({ status: 'checking', errorCode: null, progress: null });
        try {
            const raw = await this.fetchText(this.latestYmlUrl);
            const parsed = parseLatestYml(raw);
            if (!parsed || !parsed.version) {
                this._setState({
                    status: 'up-to-date',
                    availableVersion: null,
                    releaseDate: null,
                    releaseNotes: null,
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
                return { ok: true, state: this.getState() };
            }
            const isNewer = compareSemver(parsed.version, this.currentVersion) > 0;
            if (isNewer) {
                this._setState({
                    status: 'available',
                    availableVersion: parsed.version,
                    releaseDate: parsed.releaseDate,
                    releaseNotes: parsed.releaseNotes,
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
            } else {
                this._setState({
                    status: 'up-to-date',
                    availableVersion: null,
                    releaseDate: null,
                    releaseNotes: null,
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
            }
            return { ok: true, state: this.getState() };
        } catch (err) {
            const code = classifyErrorCode(err);
            // Henuz GitHub Release yayinlanmadiysa kullaniciya korkutucu hata yerine "guncel" don.
            if (code === 'NO_RELEASE_METADATA') {
                this._setState({
                    status: 'up-to-date',
                    availableVersion: null,
                    releaseDate: null,
                    releaseNotes: null,
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
                return { ok: true, state: this.getState() };
            }
            this._logWarn(`[Update] statik latest.yml denetimi basarisiz (${code}):`, err);
            this._setState({
                status: 'error',
                checkedAt: new Date().toISOString(),
                errorCode: code
            });
            return { ok: false, code, state: this.getState() };
        }
    }

    async checkForUpdates() {
        if (this.mode === 'store') {
            return { ok: false, code: 'STORE_MANAGED', state: this.getState() };
        }
        if (this._busy) {
            return { ok: true, busy: true, state: this.getState() };
        }
        this._busy = true;
        try {
            // Portable modda (veya paketlenmemis dev modda) yalnizca statik latest.yml okunur;
            // Setup .exe ASLA indirilmez.
            if (this.mode === 'portable' || !this.isPackaged) {
                return await this._checkStaticLatestYml();
            }
            const updater = this._ensureNsisUpdater();
            if (!updater || typeof updater.checkForUpdates !== 'function') {
                return await this._checkStaticLatestYml();
            }
            this._setState({ status: 'checking', errorCode: null, progress: null });
            const res = await updater.checkForUpdates();
            const info = res && res.updateInfo;
            if (info && info.version && compareSemver(String(info.version), this.currentVersion) > 0) {
                this._setState({
                    status: this._state.status === 'downloaded' ? 'downloaded' : 'available',
                    availableVersion: String(info.version),
                    releaseDate: info.releaseDate ? String(info.releaseDate) : null,
                    releaseNotes: sanitizeReleaseNotes(info.releaseNotes),
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
            } else if (this._state.status === 'checking') {
                this._setState({
                    status: 'up-to-date',
                    availableVersion: null,
                    releaseDate: null,
                    releaseNotes: null,
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
            }
            return { ok: true, state: this.getState() };
        } catch (err) {
            const code = classifyErrorCode(err);
            if (code === 'NO_RELEASE_METADATA') {
                this._setState({
                    status: 'up-to-date',
                    availableVersion: null,
                    releaseDate: null,
                    releaseNotes: null,
                    checkedAt: new Date().toISOString(),
                    errorCode: null
                });
                return { ok: true, state: this.getState() };
            }
            this._logWarn(`[Update] guncelleme denetimi hatasi (${code}):`, err);
            this._setState({
                status: 'error',
                checkedAt: new Date().toISOString(),
                errorCode: code
            });
            return { ok: false, code, state: this.getState() };
        } finally {
            this._busy = false;
        }
    }

    async downloadUpdate() {
        if (this.mode === 'store') {
            return { ok: false, code: 'STORE_MANAGED', state: this.getState() };
        }
        if (this.mode === 'portable') {
            return { ok: false, code: 'PORTABLE_MANUAL_ONLY', state: this.getState() };
        }
        if (!this.isPackaged) {
            return { ok: false, code: 'UNPACKAGED_DEV', state: this.getState() };
        }
        if (this._state.status !== 'available' && this._state.status !== 'error') {
            return { ok: false, code: 'NO_UPDATE_AVAILABLE', state: this.getState() };
        }
        const updater = this._ensureNsisUpdater();
        if (!updater || typeof updater.downloadUpdate !== 'function') {
            return { ok: false, code: 'UPDATER_UNAVAILABLE', state: this.getState() };
        }
        this._busy = true;
        this._setState({
            status: 'downloading',
            progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
            errorCode: null
        });
        try {
            await updater.downloadUpdate();
            if (this._state.status !== 'downloaded') {
                this._setState({
                    status: 'downloaded',
                    progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
                    errorCode: null
                });
            }
            return { ok: true, state: this.getState() };
        } catch (err) {
            const code = classifyErrorCode(err);
            this._logWarn(`[Update] indirme hatasi (${code}):`, err);
            this._setState({ status: 'error', errorCode: code, progress: null });
            return { ok: false, code, state: this.getState() };
        } finally {
            this._busy = false;
        }
    }

    setInstallOnQuit(enabled) {
        if (this.mode !== 'nsis' || !this.isPackaged) {
            return { ok: false, code: this.mode === 'store' ? 'STORE_MANAGED' : 'PORTABLE_MANUAL_ONLY', state: this.getState() };
        }
        const flag = Boolean(enabled);
        if (this._updater) {
            this._updater.autoInstallOnAppQuit = flag;
        }
        this._setState({ installOnQuit: flag });
        return { ok: true, state: this.getState() };
    }

    installNow() {
        if (this.mode === 'store') {
            return { ok: false, code: 'STORE_MANAGED', state: this.getState() };
        }
        if (this.mode === 'portable') {
            return { ok: false, code: 'PORTABLE_MANUAL_ONLY', state: this.getState() };
        }
        if (!this.isPackaged || !this._updater || this._state.status !== 'downloaded') {
            return { ok: false, code: 'NOT_DOWNLOADED', state: this.getState() };
        }
        try {
            if (this.onBeforeQuitAndInstall) this.onBeforeQuitAndInstall();
            this._logInfo('[Update] Yeniden baslat ve guncelle calistiriliyor (quitAndInstall).');
            this._updater.quitAndInstall(false, true);
            return { ok: true, state: this.getState() };
        } catch (err) {
            const code = classifyErrorCode(err);
            this._logWarn('[Update] quitAndInstall basarisiz:', err);
            this._setState({ status: 'error', errorCode: code });
            return { ok: false, code, state: this.getState() };
        }
    }
}

module.exports = {
    UpdateService,
    GITHUB_OWNER,
    GITHUB_REPO,
    RELEASE_PAGE_URL,
    STATIC_LATEST_YML_URL,
    parseSemver,
    compareSemver,
    parseLatestYml,
    sanitizeReleaseNotes,
    classifyErrorCode
};
