/**
 * build-config.test.mjs - WBS-7.1 / P0-3
 * Paketleme sözleşmesi: native modüller ASAR dışında + rebuild hook'u kayıtlı.
 * (CI'da `npm run pack` ile birlikte koşar; config drift'i burada yakalanır.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'));

describe('build yapılandırması (P0-3)', () => {
    it('asarUnpack **/*.node içerir (native ikililer ASAR dışında)', () => {
        const unpack = pkg.build?.asarUnpack || [];
        expect(unpack.some((g) => String(g).includes('.node'))).toBe(true);
    });

    it('postinstall electron-rebuild çalıştırır (ABI uyumu)', () => {
        expect(pkg.scripts?.postinstall || '').toContain('electron-rebuild');
    });

    it('@electron/rebuild dev-bağımlılık olarak kayıtlı', () => {
        expect(pkg.devDependencies?.['@electron/rebuild']).toBeDefined();
    });

    it('node-llama-cpp üretim bağımlılığı olarak kayıtlı', () => {
        expect(pkg.dependencies?.['node-llama-cpp']).toBeDefined();
    });
});
