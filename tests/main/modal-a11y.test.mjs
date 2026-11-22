/**
 * Modal erişilebilirliği - WCAG 2.4.3 (Focus Order) / 4.1.2 (Name, Role, Value).
 *
 * Bulgu: modallerde (`#modal-pin`, `#modal-delete-data`, `#modal-eula`,
 * `#modal-privacy`, `#modal-oss`, `#modal-confirm-link`) şunlar yoktu:
 *   - `role="dialog"` / `aria-modal="true"`
 *   - erişilebilir ad (başlık bağlantısı)
 *   - Tab odak tuzağı → odak modal dışına (pencere düğmelerine) kaçıyordu
 *   - Escape ile kapanma
 *   - kapanışta odağın tetikleyiciye dönmesi
 *
 * Ölçüm (öncesi): role=null, aria-modal=null, ad=null, Tab 1. basışta
 * `btn-minimize` dışına kaçtı, Escape modalı kapatmadı → 5 FAIL.
 * Ölçüm (sonrası): role=dialog, aria-modal=true, aria-labelledby=<başlık>,
 * 12 Tab içeride, Escape kapattı, odak tetikleyiciye döndü → 8/8 PASS.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appSrc = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

const modalIds = [
    'modal-pin',
    'modal-confirm-link',
    'modal-delete-data',
    'modal-eula',
    'modal-privacy',
    'modal-oss'
];

describe('modal erişilebilirlik katmanı', () => {
    it('openModal role/aria-modal/erişilebilir ad uygular', () => {
        expect(appSrc).toMatch(/function openModal\(id\)/);
        expect(appSrc).toMatch(/el\.setAttribute\('role',\s*'dialog'\)/);
        expect(appSrc).toMatch(/el\.setAttribute\('aria-modal',\s*'true'\)/);
        expect(appSrc).toMatch(/ensureModalLabel\(el\)/);
        expect(appSrc).toMatch(/aria-labelledby/);
    });

    it('açılışta odak modal içine taşınır', () => {
        expect(appSrc).toMatch(/const first = modalFocusables\(el\)\[0\];\s*\n\s*if \(first\) first\.focus\(\);/);
    });

    it('kapanışta odak tetikleyiciye döner', () => {
        expect(appSrc).toMatch(/modalReturnFocus = document\.activeElement/);
        expect(appSrc).toMatch(/if \(target && typeof target\.focus === 'function' && document\.contains\(target\)\) \{\s*\n\s*target\.focus\(\);/);
    });

    it('Tab odak tuzağı capture aşamasında ve döngüsel', () => {
        expect(appSrc).toMatch(/if \(e\.key !== 'Tab'\) return;/);
        expect(appSrc).toMatch(/if \(!openModalEl\.contains\(active\)\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*first\.focus\(\);/);
        expect(appSrc).toMatch(/e\.shiftKey && active === first/);
        expect(appSrc).toMatch(/!e\.shiftKey && active === last/);
        // Capture: üçüncü argüman `true` (başka işleyicilerden önce).
        expect(appSrc).toMatch(/\}, true\);/);
    });

    it('Escape uygulamanın kendi iptal yolunu kullanır', () => {
        expect(appSrc).toMatch(/const MODAL_DISMISS_MAP = \{/);
        for (const id of modalIds) {
            expect(appSrc, `${id} kapatma düğmesi eşlenmeli`).toContain(`'${id}':`);
        }
        expect(appSrc).toMatch(/if \(btn\) btn\.click\(\);/);
    });

    it('modal-focusables görünür öğeleri seçer', () => {
        expect(appSrc).toMatch(/const modalFocusables = \(root\) =>/);
        expect(appSrc).toMatch(/getBoundingClientRect\(\)\.height > 0/);
    });

    it('tüm modal kökleri HTML’de mevcut', () => {
        for (const id of modalIds) {
            expect(html, `${id} HTML’de yok`).toContain(`id="${id}"`);
        }
    });
});
