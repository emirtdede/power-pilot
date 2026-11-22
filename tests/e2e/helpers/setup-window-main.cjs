'use strict';
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 712,
        height: 496,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.loadFile(path.resolve(__dirname, '../../../installer/ui/index.html'));
});
