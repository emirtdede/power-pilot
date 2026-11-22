/**
 * storage-status.test.mjs - bakım modu görünürlüğü (sessiz veri kaybı kapısı)
 *
 * Depo açılamadığında (bozuk DB / migrasyon hatası / denetim zinciri kırığı)
 * her yazma sessizce reddediliyordu ve arayüz normal görünüyordu. Kullanıcı
 * görevinin kaydedildiğini sanıyordu. Bu test üç halkayı kilitler:
 *   StorageService.isMaintenanceMode/getMaintenanceReason → IPC
 *   get-storage-status → preload.getStorageStatus → #storage-warning banner.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import StorageService from '../../src/main/services/StorageService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const mainSource = read('main.js');
const preloadSource = read('preload.js');
const rendererSource = read('src/renderer/app.js');

let dirs = [];
let services = [];

function open(dir) {
    const s = new StorageService(dir);
    services.push(s);
    return s;
}

function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storage-status-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const s of services.splice(0)) {
        try { s.close(); } catch (_) { /* yut */ }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('StorageService - bakım modu salt-okunur erişim', () => {
    it('sağlıklı depoda maintenanceMode false, gerekçe null', () => {
        const s = open(freshDir());
        expect(s.isMaintenanceMode()).toBe(false);
        expect(s.getMaintenanceReason()).toBeNull();
    });

    it('enterMaintenance sonrası true döner ve gerekçeyi taşır', () => {
        const s = open(freshDir());
        s.enterMaintenance('Veritabanı bozuk; son yedekten geri yükleyin.');
        expect(s.isMaintenanceMode()).toBe(true);
        expect(s.getMaintenanceReason()).toMatch(/bozuk/i);
        // Bakım modu yazmayı reddeder - sessiz kabul yok.
        expect(s.save()).toBe(false);
    });

    it('gerekçesiz bakım modunda null döner (uydurma metin yok)', () => {
        const s = open(freshDir());
        s.enterMaintenance('');
        expect(s.isMaintenanceMode()).toBe(true);
        expect(s.getMaintenanceReason()).toBeNull();
    });

    it('bozuk JSON ile açılan depo bakım modunu bildirir (T-STO-03)', () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), '{bozuk', 'utf8');
        const s = open(dir);
        expect(s.isMaintenanceMode()).toBe(true);
        expect(s.getMaintenanceReason()).toBeTruthy();
    });
});

describe('IPC / preload sözleşmesi', () => {
    it('main.js get-storage-status bakım + denetim durumunu döner', () => {
        const start = mainSource.indexOf("ipcHandle('get-storage-status'");
        expect(start).toBeGreaterThan(-1);
        const body = mainSource.slice(start, start + 600);
        expect(body).toMatch(/maintenanceMode:\s*storageService\.isMaintenanceMode\(\)/);
        expect(body).toMatch(/reason:\s*storageService\.getMaintenanceReason\(\)/);
        expect(body).toMatch(/auditTampered:/);
    });

    it('preload getStorageStatus kanalını açar', () => {
        expect(preloadSource).toMatch(
            /getStorageStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-storage-status'\)/
        );
    });

    it('renderer banner\'ı yalnızca sorun varken gösterir', () => {
        expect(rendererSource).toMatch(/getStorageStatus\(\)/);
        expect(rendererSource).toMatch(/getElementById\('storage-warning'\)/);
        expect(rendererSource).toMatch(/classList\.toggle\('hidden',\s*!broken\)/);
        // Çevrilmiş anahtarlar kullanılır; ham metin sızıntısı yok.
        expect(rendererSource).toMatch(/'errorAuditTampered'/);
        expect(rendererSource).toMatch(/'errorStorageMaintenance'/);
    });
});

describe('banner işaretlemesi', () => {
    it('index.html varsayılan olarak gizli, role=alert ve i18n anahtarlı', () => {
        const { document } = new JSDOM(read('src/index.html')).window;
        const box = document.getElementById('storage-warning');
        expect(box).toBeTruthy();
        expect(box.classList.contains('hidden')).toBe(true);
        expect(box.getAttribute('role')).toBe('alert');
        expect(box.querySelector('[data-i18n="statusWarning"]')).toBeTruthy();
        expect(document.getElementById('storage-warning-detail')).toBeTruthy();
    });
});
