/**
 * modern-setup.test.mjs
 *
 * Unit verification for the frameless 640x420 monochrome single-card Setup & Uninstaller:
 *  - 73 languages with unique LCIDs, 43 keys each, ZERO English fallback leaks
 *  - ZERO Unicode long dashes and ZERO emojis across all 73 languages and UI files
 *  - Exact monochrome design tokens (640x420, 22px radius, #111113, #1C1C1F, #FAFAFA,
 *    #DC2626 close hover, 340ms cubic-bezier(0.22, 1, 0.36, 1) Options Sheet, ShimmerBar,
 *    CheckBurst, SoftBackdrop 30 FPS + prefers-reduced-motion)
 *  - Frameless TitleBar has ONLY Minimize & Close buttons (no Maximize button)
 *  - Zero innerHTML/eval/unsafe-inline in setup UI
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetupI18nBundle, SETUP_I18N_KEYS } from '../../scripts/generate-setup-i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_DIR = path.join(ROOT, 'installer', 'ui');
const LONG_DASH_RE = /[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\uff0d]/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe('Modern Frameless 640x420 Monochrome Setup & Uninstaller', () => {
    it('73 dilin tamami 43 anahtarla eksiksiz, 0 Ingilizce sizintisi, 0 uzun cizgi ve 0 emoji icerir', () => {
        const bundle = buildSetupI18nBundle();
        expect(bundle.languages).toHaveLength(73);
        expect(bundle.keys).toEqual(SETUP_I18N_KEYS);

        const codes = new Set(bundle.languages.map((l) => l.code));
        const lcids = new Set(bundle.languages.map((l) => l.lcid));
        expect(codes.size).toBe(73);
        expect(lcids.size).toBe(73);

        const rtlCodes = bundle.languages.filter((l) => l.rtl).map((l) => l.code).sort();
        expect(rtlCodes).toEqual(['ar', 'fa', 'he', 'ur']);

        const en = bundle.strings.en;
        for (const lang of bundle.languages) {
            const dict = bundle.strings[lang.code];
            expect(dict).toBeDefined();
            for (const key of SETUP_I18N_KEYS) {
                const val = dict[key];
                expect(typeof val).toBe('string');
                expect(val.trim().length).toBeGreaterThan(0);
                expect(LONG_DASH_RE.test(val), `Long dash in ${lang.code}.${key}`).toBe(false);
                expect(EMOJI_RE.test(val), `Emoji in ${lang.code}.${key}`).toBe(false);
                if (lang.code !== 'en') {
                    expect(val, `English leak in ${lang.code}.${key}`).not.toBe(en[key]);
                }
            }
        }
    });

    it('uretilen i18n-73.json ve i18n-73.js guncel katalogla birebir eslesir', () => {
        const expected = buildSetupI18nBundle();
        const diskJson = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'i18n-73.json'), 'utf8'));
        expect(diskJson.languages).toHaveLength(73);
        expect(diskJson.keys).toEqual(expected.keys);
        expect(diskJson.strings.tr.setupTitle).toBe('{app} Kurulumu');
        expect(diskJson.strings.tr.uninstallTitle).toBe('{app} Kaldırma');
        expect(diskJson.strings.tr.optPath).toBe('CLI komutunu PATH değişkenine ekle');
        expect(fs.existsSync(path.join(UI_DIR, 'i18n-73.js'))).toBe(true);
    });

    it('HTML ve CSS 1:1 640x420 monokrom tasarim kurallarina ve guvenlik hijyenine uyar', () => {
        const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
        const css = fs.readFileSync(path.join(UI_DIR, 'setup.css'), 'utf8');
        const js = fs.readFileSync(path.join(UI_DIR, 'setup.js'), 'utf8');

        // Exact visual tokens
        expect(css).toContain('width: 640px;');
        expect(css).toContain('height: 420px;');
        expect(css).toContain('border-radius: 22px;');
        expect(css).toContain('--card-bg: #111113;');
        expect(css).toContain('--surface-bg: #1C1C1F;');
        expect(css).toContain('rgba(255, 255, 255, 0.12)');
        expect(css).toContain('0 14px 36px rgba(0, 0, 0, 0.55)');
        expect(css).toContain('height: 42px;');
        expect(css).toContain('width: 34px;');
        expect(css).toContain('height: 28px;');
        expect(css).toContain('#DC2626');
        expect(css).toContain('340ms var(--ease-sheet)');
        expect(css).toContain('cubic-bezier(0.22, 1, 0.36, 1)');
        expect(css).toContain('linear-gradient(90deg, #d4d4d8 0%, #ffffff 50%, #d4d4d8 100%)');
        expect(css).toContain('height: 7px;');
        expect(css).toContain('prefers-reduced-motion: reduce');

        // TitleBar: ONLY minimize + close (no maximize button)
        expect(html).toContain('id="btn-minimize"');
        expect(html).toContain('id="btn-close-win"');
        expect(html).not.toMatch(/maximize/i);

        // All required screens & components present
        for (const id of [
            'soft-backdrop', 'screen-welcome', 'screen-progress', 'screen-done',
            'screen-uninstall', 'screen-uninstalled', 'options-sheet',
            'done-check-burst', 'uninstalled-check-burst',
            'opt-language', 'opt-install-dir', 'btn-browse-dir',
            'opt-desktop', 'opt-startmenu', 'opt-startup', 'opt-path', 'chk-delete-data'
        ]) {
            expect(html, `Missing element #${id}`).toContain(`id="${id}"`);
        }

        // Security hygiene: zero innerHTML, eval, unsafe-inline, long dashes, emojis, or publisher ad leaks
        for (const content of [html, css, js]) {
            expect(LONG_DASH_RE.test(content)).toBe(false);
            expect(EMOJI_RE.test(content)).toBe(false);
            expect(content).not.toMatch(/\.(inner|outer)HTML\s*=/);
            expect(content).not.toMatch(/\beval\s*\(/);
            expect(content).not.toContain('unsafe-inline');
            expect(content).not.toContain('Filee');
        }
    });

    it('Rust kurucu kaynaklari sessiz CLI (/S, /SILENT, /VERYSILENT, /P, /DIR) ve Windows sistem kayitlarini icerir', () => {
        const cliRs = fs.readFileSync(path.join(ROOT, 'installer', 'src', 'cli.rs'), 'utf8');
        const winRs = fs.readFileSync(path.join(ROOT, 'installer', 'src', 'win_sys.rs'), 'utf8');
        const engRs = fs.readFileSync(path.join(ROOT, 'installer', 'src', 'engine.rs'), 'utf8');

        for (const flag of ['/S', '/SILENT', '/VERYSILENT', '/P', '/DIR=']) {
            expect(cliRs).toContain(flag);
        }
        expect(winRs).toContain('SHChangeNotify');
        expect(winRs).toContain('GetUserDefaultUILanguage');
        expect(winRs).toContain('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Power Pilot');
        expect(winRs).toContain('IShellLinkW');
        expect(winRs).toContain('IFileOpenDialog');
        expect(winRs).toContain('WM_SETTINGCHANGE');
        expect(engRs).toContain('write_uninstaller_stub');
    });
});
