/**
 * layout-structure.test.mjs - Responsive iskelet sözleşmesi (statik)
 *
 * E2E pencereleri gerçek davranışı ölçer; bu test ise HTML iskeletinin
 * yapısal bozulmalarını (iç içe geçmiş görünümler, eksik çekmece parçaları,
 * etiketsiz nav) hızlıca yakalar.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const dom = new JSDOM(html);
const { document } = dom.window;

const VIEWS = [
    'view-dashboard', 'view-active', 'view-tasks', 'view-smartfinish', 'view-assistant',
    'view-templates', 'view-history', 'view-stats', 'view-integrations', 'view-docs', 'view-settings', 'view-about'
];

describe('Responsive iskelet - yapı', () => {
    it('tek iskelet kabuğu, tek sidebar, tek scrim ve menü düğmesi var', () => {
        expect(document.querySelectorAll('.app-shell')).toHaveLength(1);
        expect(document.querySelectorAll('#app-sidebar')).toHaveLength(1);
        expect(document.querySelectorAll('#nav-scrim')).toHaveLength(1);
        expect(document.querySelectorAll('#btn-nav-toggle')).toHaveLength(1);
        expect(document.querySelectorAll('#main-content.app-main')).toHaveLength(1);
    });

    it('sidebar çekmece erişilebilirlik bağları doğru', () => {
        const toggle = document.getElementById('btn-nav-toggle');
        expect(toggle.getAttribute('aria-controls')).toBe('app-sidebar');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        const sidebar = document.getElementById('app-sidebar');
        expect(sidebar.classList.contains('app-sidebar')).toBe(true);
        expect(sidebar.classList.contains('w-64')).toBe(false); // sabit genişlik kaldırıldı
    });

    it('her görünüm ayrı ve birbirinin içine geçmemiş', () => {
        for (const id of VIEWS) {
            const el = document.getElementById(id);
            expect(el, id).toBeTruthy();
            expect(el.classList.contains('view-section')).toBe(true);
        }
        const tasks = document.getElementById('view-tasks');
        const history = document.getElementById('view-history');
        expect(tasks.contains(document.getElementById('tasks-table-body'))).toBe(true);
        expect(tasks.contains(document.getElementById('history-table-body'))).toBe(false);
        expect(history.contains(document.getElementById('history-table-body'))).toBe(true);
        expect(history.contains(document.getElementById('tasks-table-body'))).toBe(false);
    });

    it('tablolar yatay kaydırma sarmalayıcısında', () => {
        for (const id of ['tasks-table-body', 'history-table-body']) {
            const tbody = document.getElementById(id);
            const wrap = tbody.closest('table').parentElement;
            expect(wrap.classList.contains('table-scroll'), id).toBe(true);
        }
    });

    it('12 nav öğesi etiketli, ipucu anahtarlı ve klavye ile erişilebilir', () => {
        const navs = [...document.querySelectorAll('.nav-btn')];
        expect(navs).toHaveLength(12);
        for (const nav of navs) {
            expect(nav.querySelector('.nav-label'), nav.id).toBeTruthy();
            expect(nav.getAttribute('data-nav-key'), nav.id).toBeTruthy();
        }
    });

    it('zamanlayıcı halkası ölçeklenebilir (viewBox) ve sabit ölçü yok', () => {
        const ring = document.getElementById('timer-ring');
        expect(ring).toBeTruthy();
        expect(ring.className).not.toMatch(/\bw-48\b/);
        const svg = ring.querySelector('svg');
        expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
        const circle = document.getElementById('progress-circle');
        expect(circle.getAttribute('r')).toBe('46');
        expect(circle.getAttribute('stroke-dasharray')).toBe('289');
    });

    it('taşma koruması: ana kolon ve kartlar sabit genişlik kullanmıyor', () => {
        const main = document.getElementById('main-content');
        expect(main.classList.contains('overflow-hidden')).toBe(true);
        expect(document.querySelectorAll('#main-content .view-section').length).toBe(VIEWS.length);
    });
});
