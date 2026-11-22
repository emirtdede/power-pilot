/**
 * vitest.config.js - WBS-4.1
 * Multi-project: main (node) + renderer (jsdom).
 * Kapsam kapısı: satır %80 altında CI kırmızı (WBS-4.2 / TS-4.2).
 */
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        // Zaman-duyarlı performans testleri (T-CON-05 p95, T-STO-13 event-loop lag)
        // CPU çekişmesinde ölçüm hatası üretir; işçi sayısı sabitlenir.
        maxWorkers: 2,
        minWorkers: 1,
        testTimeout: 30000,
        hookTimeout: 30000,
        projects: [
            {
                test: {
                    name: 'main',
                    root: './tests/main',
                    environment: 'node',
                    testTimeout: 30000,
                    hookTimeout: 30000,
                    include: ['**/*.test.mjs'],
                    setupFiles: ['../setup/main-setup.mjs']
                }
            },
            {
                test: {
                    name: 'renderer',
                    root: './tests/renderer',
                    environment: 'jsdom',
                    testTimeout: 30000,
                    hookTimeout: 30000,
                    include: ['**/*.test.mjs'],
                    setupFiles: ['../setup/renderer-setup.mjs']
                }
            }
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            include: ['src/main/**/*.js'],
            exclude: ['src/main/**/*.test.js'],
            thresholds: {
                lines: 80,
                functions: 70,
                branches: 65,
                statements: 80
            }
        }
    }
});
