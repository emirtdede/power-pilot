/**
 * energy-chip-focus.test.mjs - "kWh için watt girin →" kısayolu sözleşmesi.
 *
 * GERÇEK EKSİK (bu turda bulundu ve düzeltildi): İstatistik görünümündeki
 * "kWh için watt girin →" düğmesi kullanıcıyı Ayarlar > Enerji kartına
 * götürüyor ve doğru yere kaydırıyordu, ANCAK giriş alanına ODAKLANMIYORDU
 * (odak `BODY`'de kalıyordu). Düğme "girin" diyor; kullanıcının yazmaya
 * hemen başlayabilmesi gerekir.
 *
 * Ölçüm (öncesi): chip tıkla → view-settings açık, scrollIntoView doğru,
 *   document.activeElement === BODY.
 * Ölçüm (sonrası): document.activeElement.id === 'nrg-watt'.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

function gotoEnergyBlock() {
    const start = appSrc.indexOf('function gotoEnergySettings');
    expect(start, 'gotoEnergySettings tanımlı olmalı').toBeGreaterThan(-1);
    const end = appSrc.indexOf('async function loadStatistics', start);
    expect(end, 'loadStatistics sınırı bulunmalı').toBeGreaterThan(start);
    return appSrc.slice(start, end);
}

describe('Enerji kısayolu - Ayarlar > watt alanına odaklanma', () => {
    it('kısayol Ayarlar görünümüne gider ve doğru karta kaydırır', () => {
        const block = gotoEnergyBlock();
        expect(block).toContain("switchView('nav-settings')");
        expect(block).toContain("getElementById('settings-energy')");
        expect(block).toContain('scrollIntoView');
    });

    it('watt giriş alanına ODAKLANIR (yazmaya hemen başlanabilsin)', () => {
        const block = gotoEnergyBlock();
        expect(block, 'nrg-watt alanı hedeflenmeli').toContain("getElementById('nrg-watt')");
        expect(block, 'watt alanı focus() ile odaklanmalı').toMatch(/\bwatt\.focus\(/);
        // Odak, kaydırmayı bozmasın diye preventScroll tercih edilir.
        expect(block).toContain('preventScroll');
    });

    it('her iki kısayol düğmesi aynı hedefe bağlı', () => {
        expect(appSrc).toContain("getElementById('chip-watt')");
        expect(appSrc).toContain("getElementById('chip-price')");
        const wattBound = /chipWattBtn\.addEventListener\('click',\s*gotoEnergySettings\)/.test(appSrc);
        const priceBound = /chipPriceBtn\.addEventListener\('click',\s*gotoEnergySettings\)/.test(appSrc);
        expect(wattBound, 'chip-watt → gotoEnergySettings').toBe(true);
        expect(priceBound, 'chip-price → gotoEnergySettings').toBe(true);
    });

    it('kWh kartı değer yokken "-" gösterir (uydurma sayı yok)', () => {
        // app.js: `stats.kwhSaved == null ? '-' : ...`
        expect(appSrc).toMatch(/kwhEl\.innerText\s*=\s*stats\.kwhSaved\s*==\s*null\s*\?\s*'-'/);
        expect(appSrc).toMatch(/costEl\.innerText\s*=\s*stats\.costSavedFormatted\s*==\s*null\s*\?\s*'-'/);
    });
});
