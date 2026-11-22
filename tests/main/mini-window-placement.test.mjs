/**
 * mini-window-placement.test.mjs - B5 çoklu monitör/DPI yerleşimi
 *
 * Mini widget birincil ekrana sabitlenmemeli: ana pencerenin (yoksa imlecin)
 * bulunduğu ekrana yerleşmeli ve her zaman o ekranın çalışma alanı içinde
 * kalmalı. Ekran sökülüp takıldığında görünmez koordinatta kalmamalı.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const placement = require('../../src/main/services/MiniWindowPlacement.js');

const primary = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1
};
// Sağda ikinci monitör, farklı DPI ölçeği.
const secondary = {
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
    scaleFactor: 1.5
};

describe('B5 - mini pencere yerleşimi', () => {
    it('ana pencere ikincil ekrandaysa mini widget oraya yerleşir', () => {
        const anchor = { x: 2400, y: 200, width: 800, height: 600 };
        const result = placement.computePlacement({
            displays: [primary, secondary],
            primaryDisplay: primary,
            anchorBounds: anchor
        });
        // İkincil ekranın sağ-alt köşesinde olmalı.
        expect(result.x).toBeGreaterThanOrEqual(secondary.workArea.x);
        expect(result.x + result.width).toBeLessThanOrEqual(
            secondary.workArea.x + secondary.workArea.width
        );
        expect(result.x).toBeGreaterThan(1920);
    });

    it('ana pencere yoksa imlecin bulunduğu ekranı kullanır', () => {
        const result = placement.computePlacement({
            displays: [primary, secondary],
            primaryDisplay: primary,
            anchorBounds: null,
            cursorPoint: { x: 3000, y: 700 }
        });
        expect(result.x).toBeGreaterThan(1920);
    });

    it('ana pencere ve imleç yoksa birincil ekrana düşer', () => {
        const result = placement.computePlacement({
            displays: [primary, secondary],
            primaryDisplay: primary
        });
        expect(result.x).toBeLessThan(1920);
        expect(result.x + result.width).toBeLessThanOrEqual(primary.workArea.width);
    });

    it('çalışma alanı içinde kalır (görev çubuğu payı korunur)', () => {
        const result = placement.computePlacement({
            displays: [primary],
            primaryDisplay: primary,
            width: 280,
            height: 76,
            margin: 20
        });
        expect(result.y + result.height).toBeLessThanOrEqual(
            primary.workArea.y + primary.workArea.height
        );
        expect(result.x + result.width).toBeLessThanOrEqual(
            primary.workArea.x + primary.workArea.width
        );
    });

    it('çalışma alanı pencereden küçükse taşmaz, boyut küçülür', () => {
        const tiny = {
            bounds: { x: 0, y: 0, width: 200, height: 60 },
            workArea: { x: 0, y: 0, width: 200, height: 60 }
        };
        const result = placement.computePlacement({
            displays: [tiny],
            primaryDisplay: tiny,
            width: 280,
            height: 76
        });
        expect(result.width).toBeLessThanOrEqual(200);
        expect(result.height).toBeLessThanOrEqual(60);
        expect(result.x).toBeGreaterThanOrEqual(0);
        expect(result.y).toBeGreaterThanOrEqual(0);
    });

    it('boş/geçersiz ekran listesinde güvenli varsayılana döner', () => {
        const result = placement.computePlacement({ displays: [], primaryDisplay: null });
        expect(result).toEqual({ x: 0, y: 0, width: placement.DEFAULT_WIDTH, height: placement.DEFAULT_HEIGHT });
    });

    it('displayContainingPoint sınırları doğru ele alır', () => {
        expect(placement.displayContainingPoint([primary, secondary], { x: 0, y: 0 })).toBe(primary);
        expect(placement.displayContainingPoint([primary, secondary], { x: 1919, y: 500 })).toBe(primary);
        expect(placement.displayContainingPoint([primary, secondary], { x: 1920, y: 500 })).toBe(secondary);
        expect(placement.displayContainingPoint([primary], { x: -1, y: 0 })).toBeNull();
    });

    it('negatif koordinatlı ekran (sol/üst monitör) doğru çalışır', () => {
        const left = {
            bounds: { x: -1280, y: -200, width: 1280, height: 1024 },
            workArea: { x: -1280, y: -200, width: 1280, height: 984 }
        };
        const result = placement.computePlacement({
            displays: [primary, left],
            primaryDisplay: primary,
            anchorBounds: { x: -1000, y: 0, width: 400, height: 300 }
        });
        expect(result.x).toBeGreaterThanOrEqual(left.workArea.x);
        expect(result.x).toBeLessThan(0);
    });

    it('sabitler beklenen değerde (renderer mini.html ile uyumlu)', () => {
        expect(placement.DEFAULT_WIDTH).toBe(280);
        expect(placement.DEFAULT_HEIGHT).toBe(76);
        expect(placement.DEFAULT_MARGIN).toBe(20);
    });

    it('TS-4.2: computeBottomCenterPlacement görev çubuğunun tam 18px üst-ortasına yerleşir (çoklu monitör destekli)', () => {
        const resPrimary = placement.computeBottomCenterPlacement({
            displays: [primary, secondary],
            primaryDisplay: primary,
            cursorPoint: { x: 500, y: 500 },
            width: 440,
            height: 116,
            margin: 18
        });
        expect(resPrimary).toEqual({
            x: Math.round((1920 - 440) / 2),
            y: 1040 - 116 - 18,
            width: 440,
            height: 116
        });

        const resSecondary = placement.computeBottomCenterPlacement({
            displays: [primary, secondary],
            primaryDisplay: primary,
            cursorPoint: { x: 2500, y: 500 },
            width: 440,
            height: 116,
            margin: 18
        });
        expect(resSecondary).toEqual({
            x: 1920 + Math.round((2560 - 440) / 2),
            y: 1400 - 116 - 18,
            width: 440,
            height: 116
        });
    });
});
