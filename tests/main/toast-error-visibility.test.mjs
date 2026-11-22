/**
 * Hata bildirimleri - "Bildirimleri Göster" ayarından bağımsız görünmeli.
 *
 * Bulgu: `showToast` ilk satırda `localStorage.notifications === 'false'` ise
 * **her türde** erken dönüyordu (öncesi: `if (!showNotifs) return;`). Yani
 * kullanıcı bildirimleri kapattığında HATA mesajları da kayboluyordu:
 * "PIN kurulamadı", "görev oluşturulamadı", "klasör açılamadı", "kaydetme
 * başarısız"... (79 hata çağrısı bu yoldan geçiyor). Kullanıcı işleminin
 * başarısız olduğunu hiç öğrenmiyordu.
 *
 * Ölçüm (öncesi): bildirim kapalı + geçersiz PIN → toast adedi **0**.
 * Ölçüm (sonrası): aynı akış → adet **1**, `role="alert"`.
 *
 * Ayarın amacı korunur: başarı/info bildirimleri kapalıyken gizlenir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appSrc = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');

describe('hata toast’ları bildirim ayarından bağımsız', () => {
    it('erken dönüş yalnızca error DIŞINDAKİ türler için', () => {
        expect(appSrc).toMatch(/if \(!showNotifs && type !== 'error'\) return;/);
    });

    it('koşulsuz erken dönüş kalmamış', () => {
        // Eski kusurlu biçim: `if (!showNotifs) return;`
        expect(appSrc).not.toMatch(/if \(!showNotifs\)\s*return;/);
    });

    it('ayar hâlâ okunuyor (davranış kaldırılmadı)', () => {
        expect(appSrc).toMatch(/localStorage\.getItem\('notifications'\) !== 'false'/);
    });

    it('hata toast’ı assertive canlı bölge taşır', () => {
        expect(appSrc).toMatch(/type === 'error' \? 'alert' : 'status'/);
        expect(appSrc).toMatch(/type === 'error' \? 'assertive' : 'polite'/);
    });
});
