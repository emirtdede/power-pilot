/**
 * Portable.js - taşınabilir (portable) dağıtım farkları.
 *
 * electron-builder'ın `portable` hedefi uygulamayı geçici bir dizine açar ve
 * iki ortam değişkeni verir:
 *   - `PORTABLE_EXECUTABLE_DIR`  → kullanıcının gördüğü SFX dosyasının klasörü
 *   - `PORTABLE_EXECUTABLE_FILE` → SFX dosyasının tam yolu
 *
 * İki sonuç bu modülde toplanır:
 *  1. **Veri yeri.** Veri varsayılan `%APPDATA%` altında kalırsa "taşınabilir"
 *     adı yanıltıcı olur: USB'ye kopyalanan uygulama ayarlarını geride bırakır
 *     ve başka makinede boş açılır. Bu yüzden veri SFX'in yanında durur.
 *  2. **Zamanlayıcı yolu.** `app.getPath('exe')` geçici çıkarma dizinini
 *     gösterir; oraya Windows Görev Zamanlayıcı kaydı yazmak, uygulama kapandıktan
 *     sonra silinmiş bir yolu çalıştırmaya çalışmak demektir. Kayıt SFX'in
 *     kendisine yönlendirilir (SFX komut satırı argümanlarını uygulamaya geçirir).
 *
 * Electron'a bağımlı değildir; birim testleri doğrudan çağırır.
 */

'use strict';

const path = require('path');

/** SFX'in yanında oluşturulan veri klasörü. */
const PORTABLE_DATA_DIR = 'PowerPilotData';

function resolveRoot(env) {
    const dir = env && env.PORTABLE_EXECUTABLE_DIR;
    if (typeof dir !== 'string' || dir.trim().length === 0) return null;
    return path.resolve(dir);
}

/**
 * Taşınabilir veri klasörü; taşınabilir değilse `null`.
 * @param {NodeJS.ProcessEnv|object} env
 * @returns {string|null}
 */
function portableDataDir(env) {
    const root = resolveRoot(env);
    return root ? path.join(root, PORTABLE_DATA_DIR) : null;
}

/**
 * Zamanlayıcı kaydında kullanılacak çalıştırılabilir yol.
 * Taşınabilir modda SFX dosyası (geçici çıkarma dizini değil), aksi hâlde `null`
 * → çağıran taraf `app.getPath('exe')` kullanır.
 *
 * @param {NodeJS.ProcessEnv|object} env
 * @param {(p: string) => boolean} [existsSync] dosyanın gerçekten var olduğunu doğrular
 * @returns {string|null}
 */
function portableExePath(env, existsSync = null) {
    const file = env && env.PORTABLE_EXECUTABLE_FILE;
    if (typeof file !== 'string' || file.trim().length === 0) return null;
    const resolved = path.resolve(file);
    // Var olmayan bir yolu Windows'a yazmak, sessizce hiç tetiklenmeyen bir görev
    // üretir. Doğrulama başarısızsa çağıran taraf normal yola düşer.
    if (typeof existsSync === 'function' && !existsSync(resolved)) return null;
    return resolved;
}

/** Taşınabilir modda mı çalışıyoruz? */
function isPortable(env) {
    return resolveRoot(env) !== null;
}

module.exports = {
    PORTABLE_DATA_DIR,
    isPortable,
    portableDataDir,
    portableExePath
};
