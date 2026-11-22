(function () {
  'use strict';

  const I18N = window.PP_SETUP_I18N || { languages: [], strings: {} };

  const state = {
    appName: 'Power Pilot',
    version: '1.0.0',
    installedVersion: null,
    mode: 'install', // 'install' | 'uninstall'
    screen: 'welcome', // 'welcome' | 'progress' | 'done' | 'uninstall' | 'uninstalled' | 'error'
    lang: 'en',
    installDir: 'C:\\Users\\User\\AppData\\Local\\Programs\\Power Pilot',
    userDataDir: 'C:\\Users\\User\\AppData\\Roaming\\powerpilot',
    requiredMb: 240,
    desktopShortcut: true,
    startMenuShortcut: true,
    runAtStartup: false,
    addToPath: true,
    deleteUserData: false,
    optionsOpen: false,
    progressStepKey: 'stepPrepare',
    progressPercent: 0,
    lastError: ''
  };

  function el(id) {
    return document.getElementById(id);
  }

  function hasLang(code) {
    return Boolean(code && I18N.strings && Object.prototype.hasOwnProperty.call(I18N.strings, code));
  }

  function getLangMeta(code) {
    return (I18N.languages || []).find((l) => l.code === code) || { code: 'en', rtl: false, label: 'English' };
  }

  function resolveLanguageCode(raw) {
    if (!raw || typeof raw !== 'string') return 'en';
    const norm = raw.trim().toLowerCase().replace(/_/g, '-');
    if (hasLang(norm)) return norm;
    if (norm === 'zh-tw' || norm === 'zh-hk' || norm === 'zh-mo' || norm === 'zh-hant') return 'zh-tw';
    const base = norm.split('-')[0];
    if (base === 'nb' || base === 'nn') return 'no';
    if (base === 'tl') return 'fil';
    if (hasLang(base)) return base;
    return 'en';
  }

  function formatString(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (
      vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`
    ));
  }

  function t(key, extraVars) {
    const dict = (I18N.strings && I18N.strings[state.lang]) || (I18N.strings && I18N.strings.en) || {};
    const fallback = (I18N.strings && I18N.strings.en && I18N.strings.en[key]) || key;
    const vars = Object.assign({
      app: state.appName,
      ver: state.version,
      installed: state.installedVersion || '',
      size: `${state.requiredMb} MB`,
      path: state.userDataDir,
      percent: `${state.progressPercent}%`
    }, extraVars || {});
    return formatString(dict[key] || fallback, vars);
  }

  function sendNative(action, payload) {
    const msg = JSON.stringify(Object.assign({ action }, payload || {}));
    if (window.PP_SETUP_BRIDGE && typeof window.PP_SETUP_BRIDGE.postMessage === 'function') {
      window.PP_SETUP_BRIDGE.postMessage(msg);
      return;
    }
    if (window.ipc && typeof window.ipc.postMessage === 'function') {
      window.ipc.postMessage(msg);
    }
  }

  function populateLanguageSelect() {
    const select = el('opt-language');
    if (!select) return;
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const item of (I18N.languages || [])) {
      const opt = document.createElement('option');
      opt.value = item.code;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
    select.value = state.lang;
  }

  function applyTranslations() {
    const meta = getLangMeta(state.lang);
    document.documentElement.lang = meta.code;
    document.documentElement.dir = meta.rtl ? 'rtl' : 'ltr';

    const titleText = state.mode === 'uninstall' ? t('uninstallTitle') : t('setupTitle');
    document.title = titleText;
    el('titlebar-title').textContent = titleText;
    el('setup-card').setAttribute('aria-label', titleText);
    el('btn-minimize').setAttribute('aria-label', t('ariaMinimize'));
    el('btn-close-win').setAttribute('aria-label', t('btnClose'));

    el('welcome-app-name').textContent = state.appName;
    el('welcome-version-pill').textContent = `v${state.version}`;
    const isUpgrade = Boolean(state.installedVersion);
    el('welcome-desc').textContent = isUpgrade ? t('welcomeDescUpgrade') : t('welcomeDescInstall');
    const primaryLabel = isUpgrade ? t('btnUpgrade') : t('btnInstall');
    el('btn-welcome-install').textContent = primaryLabel;
    el('btn-sheet-install').textContent = primaryLabel;
    el('txt-open-options').textContent = t('btnOptions');
    el('welcome-footer').textContent = t('footerNotice');

    el('sheet-title').textContent = t('optionsTitle');
    el('txt-hide-options').textContent = t('btnHide');
    el('lbl-language').textContent = t('labelLanguage');
    el('lbl-install-dir').textContent = t('labelInstallDir');
    el('btn-browse-dir').textContent = t('btnChange');
    el('txt-opt-desktop').textContent = t('optDesktop');
    el('txt-opt-startmenu').textContent = t('optStartMenu');
    el('txt-opt-startup').textContent = t('optStartup');
    el('txt-opt-path').textContent = t('optPath');
    el('txt-disk-space').textContent = t('diskSpace');

    el('progress-title').textContent = state.mode === 'uninstall' ? t('uninstallingTitle') : t('installingTitle');
    el('progress-step').textContent = t(state.progressStepKey);
    el('progress-percent').textContent = `${state.progressPercent}%`;

    el('done-title').textContent = t('doneTitle');
    el('done-desc').textContent = t('doneDesc');
    el('btn-done-close').textContent = t('btnClose');
    el('btn-done-launch').textContent = t('btnLaunch');

    el('uninstall-heading').textContent = t('uninstallHeading');
    el('uninstall-desc').textContent = t('uninstallDesc');
    el('txt-delete-data').textContent = t('uninstallDeleteData');
    el('uninstall-data-hint').textContent = t('uninstallDataHint');
    el('btn-uninstall-cancel').textContent = t('btnCancel');
    el('btn-uninstall-confirm').textContent = t('btnUninstall');

    el('uninstalled-title').textContent = t('uninstalledTitle');
    el('uninstalled-desc').textContent = t('uninstalledDesc');
    el('btn-uninstalled-close').textContent = t('btnClose');

    el('error-title').textContent = t('errorTitle');
    el('error-message').textContent = state.lastError || '';
    el('btn-error-close').textContent = t('btnClose');
    el('btn-error-retry').textContent = t('btnRetry');

    const langSelect = el('opt-language');
    if (langSelect && langSelect.value !== state.lang) {
      langSelect.value = state.lang;
    }
  }

  function setOptionsOpen(open) {
    state.optionsOpen = Boolean(open);
    const sheet = el('options-sheet');
    const toggle = el('btn-open-options');
    if (sheet) {
      sheet.classList.toggle('is-open', state.optionsOpen);
      sheet.setAttribute('aria-hidden', state.optionsOpen ? 'false' : 'true');
    }
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.optionsOpen ? 'true' : 'false');
    }
  }

  function showScreen(name) {
    state.screen = name;
    if (name !== 'welcome') setOptionsOpen(false);
    const all = document.querySelectorAll('.screen');
    for (const node of all) {
      const active = node.getAttribute('data-screen') === name;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    if (name === 'done') {
      const b = el('done-check-burst');
      if (b) { b.classList.remove('play'); void b.offsetWidth; b.classList.add('play'); }
    } else if (name === 'uninstalled') {
      const b = el('uninstalled-check-burst');
      if (b) { b.classList.remove('play'); void b.offsetWidth; b.classList.add('play'); }
    }
    applyTranslations();
  }

  function setProgress(percent, stepKey) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    state.progressPercent = pct;
    if (stepKey) state.progressStepKey = stepKey;
    el('progress-percent').textContent = `${pct}%`;
    el('progress-step').textContent = t(state.progressStepKey);
    const fill = el('progress-bar-fill');
    const track = el('progress-bar-track');
    if (fill) fill.style.width = `${pct}%`;
    if (track) track.setAttribute('aria-valuenow', String(pct));
  }

  function startInstallFlow() {
    state.mode = 'install';
    const dirInput = el('opt-install-dir');
    if (dirInput && dirInput.value.trim()) state.installDir = dirInput.value.trim();
    state.desktopShortcut = Boolean(el('opt-desktop').checked);
    state.startMenuShortcut = Boolean(el('opt-startmenu').checked);
    state.runAtStartup = Boolean(el('opt-startup').checked);
    state.addToPath = Boolean(el('opt-path').checked);

    setOptionsOpen(false);
    showScreen('progress');
    setProgress(5, 'stepPrepare');
    sendNative('install', {
      installDir: state.installDir,
      lang: state.lang,
      desktopShortcut: state.desktopShortcut,
      startMenuShortcut: state.startMenuShortcut,
      runAtStartup: state.runAtStartup,
      addToPath: state.addToPath
    });
  }

  function startUninstallFlow() {
    state.mode = 'uninstall';
    state.deleteUserData = Boolean(el('chk-delete-data').checked);
    showScreen('progress');
    setProgress(8, 'stepClose');
    sendNative('uninstall', {
      installDir: state.installDir,
      deleteUserData: state.deleteUserData,
      lang: state.lang
    });
  }

  function handleNativeEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'init') {
      if (ev.appName) state.appName = String(ev.appName);
      if (ev.version) state.version = String(ev.version);
      state.installedVersion = ev.installedVersion ? String(ev.installedVersion) : null;
      if (ev.installDir) state.installDir = String(ev.installDir);
      if (ev.userDataDir) state.userDataDir = String(ev.userDataDir);
      if (Number.isFinite(ev.requiredMb) && ev.requiredMb > 0) state.requiredMb = Math.round(ev.requiredMb);
      if (ev.mode === 'uninstall') state.mode = 'uninstall';
      else state.mode = 'install';

      state.lang = resolveLanguageCode(ev.lang || navigator.language || 'en');
      if (typeof ev.desktopShortcut === 'boolean') state.desktopShortcut = ev.desktopShortcut;
      if (typeof ev.startMenuShortcut === 'boolean') state.startMenuShortcut = ev.startMenuShortcut;
      if (typeof ev.runAtStartup === 'boolean') state.runAtStartup = ev.runAtStartup;
      if (typeof ev.addToPath === 'boolean') state.addToPath = ev.addToPath;

      el('opt-install-dir').value = state.installDir;
      el('opt-desktop').checked = state.desktopShortcut;
      el('opt-startmenu').checked = state.startMenuShortcut;
      el('opt-startup').checked = state.runAtStartup;
      el('opt-path').checked = state.addToPath;
      el('chk-delete-data').checked = false;

      populateLanguageSelect();
      showScreen(state.mode === 'uninstall' ? 'uninstall' : 'welcome');
      return;
    }
    if (ev.type === 'folderSelected' && typeof ev.path === 'string' && ev.path.trim()) {
      state.installDir = ev.path.trim();
      el('opt-install-dir').value = state.installDir;
      return;
    }
    if (ev.type === 'progress') {
      if (state.screen !== 'progress') showScreen('progress');
      setProgress(ev.percent, ev.stepKey || state.progressStepKey);
      return;
    }
    if (ev.type === 'done') {
      setProgress(100, state.mode === 'uninstall' ? 'stepRefresh' : 'stepRefresh');
      showScreen(state.mode === 'uninstall' ? 'uninstalled' : 'done');
      return;
    }
    if (ev.type === 'error') {
      state.lastError = String(ev.message || 'Unknown error');
      showScreen('error');
    }
  }

  // SoftBackdrop: 3 monochrome platinum/white radial orbs at 30 FPS (static when reduced motion is enabled)
  function initSoftBackdrop() {
    const canvas = el('soft-backdrop');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const orbs = [
      { bx: w * 0.22, by: h * 0.24, r: 220, ax: 38, ay: 22, sx: 0.00028, sy: 0.00021, phase: 0.4, alpha: 0.09 },
      { bx: w * 0.80, by: h * 0.30, r: 240, ax: 42, ay: 28, sx: 0.00022, sy: 0.00026, phase: 2.1, alpha: 0.085 },
      { bx: w * 0.50, by: h * 0.88, r: 260, ax: 48, ay: 18, sx: 0.00019, sy: 0.00017, phase: 4.3, alpha: 0.09 }
    ];

    function renderFrame(ts) {
      ctx.clearRect(0, 0, w, h);
      for (const orb of orbs) {
        const cx = orb.bx + Math.sin(ts * orb.sx + orb.phase) * orb.ax;
        const cy = orb.by + Math.cos(ts * orb.sy + orb.phase * 1.3) * orb.ay;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orb.r);
        grad.addColorStop(0, `rgba(255, 255, 255, ${orb.alpha})`);
        grad.addColorStop(0.45, `rgba(228, 228, 231, ${orb.alpha * 0.38})`);
        grad.addColorStop(1, 'rgba(17, 17, 19, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
    }

    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderFrame(0);
    if (reducedMotion) return;

    let last = 0;
    const FRAME_MS = 1000 / 30;
    function tick(now) {
      if (now - last >= FRAME_MS) {
        last = now;
        renderFrame(now);
      }
      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  function bindEvents() {
    const drag = el('titlebar-drag');
    if (drag) {
      drag.addEventListener('mousedown', (e) => {
        if (e.button === 0) sendNative('startDrag');
      });
    }
    el('btn-minimize').addEventListener('click', () => sendNative('minimize'));
    el('btn-close-win').addEventListener('click', () => sendNative('close'));

    el('btn-open-options').addEventListener('click', () => setOptionsOpen(true));
    el('btn-hide-options').addEventListener('click', () => setOptionsOpen(false));
    el('opt-language').addEventListener('change', (e) => {
      state.lang = resolveLanguageCode(e.target.value);
      applyTranslations();
    });
    el('btn-browse-dir').addEventListener('click', () => {
      const current = (el('opt-install-dir').value || state.installDir || '').trim();
      sendNative('browseFolder', { currentDir: current });
    });

    el('btn-welcome-install').addEventListener('click', startInstallFlow);
    el('btn-sheet-install').addEventListener('click', startInstallFlow);

    el('btn-done-close').addEventListener('click', () => sendNative('close'));
    el('btn-done-launch').addEventListener('click', () => sendNative('launchAndClose', { installDir: state.installDir }));

    el('btn-uninstall-cancel').addEventListener('click', () => sendNative('close'));
    el('btn-uninstall-confirm').addEventListener('click', startUninstallFlow);
    el('btn-uninstalled-close').addEventListener('click', () => sendNative('close'));

    el('btn-error-close').addEventListener('click', () => sendNative('close'));
    el('btn-error-retry').addEventListener('click', () => {
      showScreen(state.mode === 'uninstall' ? 'uninstall' : 'welcome');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.optionsOpen) {
        setOptionsOpen(false);
      }
    });
  }

  // Expose controlled API for native WebView2 host & Playwright E2E harness
  window.__PP_SETUP__ = {
    receive: handleNativeEvent,
    getState: () => ({ ...state }),
    setLanguage: (code) => {
      state.lang = resolveLanguageCode(code);
      applyTranslations();
    },
    setOptionsOpen,
    showScreen,
    resolveLanguageCode
  };

  function boot() {
    initSoftBackdrop();
    bindEvents();
    const initialLang = resolveLanguageCode(navigator.language || 'en');
    state.lang = initialLang;
    populateLanguageSelect();
    el('opt-install-dir').value = state.installDir;
    applyTranslations();
    sendNative('ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
