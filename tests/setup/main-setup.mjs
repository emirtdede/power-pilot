/**
 * tests/setup/main-setup.mjs - WBS-4.1
 * NODE_ENV=test => src/main/logger.js no-op olur (dosyaya yazmaz).
 */
process.env.NODE_ENV = 'test';
process.env.VITEST = 'true';

import { vi } from 'vitest';

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => '/tmp/powerpilot-test'),
        getVersion: vi.fn(() => '1.0.0-test'),
        on: vi.fn(),
        quit: vi.fn()
    },
    BrowserWindow: vi.fn(),
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    Tray: vi.fn(),
    Menu: vi.fn(),
    screen: { getPrimaryDisplay: vi.fn() },
    shell: { openExternal: vi.fn() }
}));
