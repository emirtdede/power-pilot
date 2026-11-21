#!/usr/bin/env node

/**
 * powerpilot.js
 * Controlled CLI interface for the running Power Pilot Local API.
 *
 * B2: Komut kataloğu `commands.js` içinde saf ve test edilebilir tutulur;
 * bu dosya yalnızca HTTP taşımasını yapar.
 */

const {
    parseArgs,
    buildRequest,
    validate,
    usageText,
    renderResponse
} = require('./commands');
const { resolveConnection, requestJson } = require('../shared/localApiConnection');

// P0-4: tek kaynak — kanonik `POWERPILOT_API_*`, alt çizgili ad fallback.
const connection = resolveConnection(process.env);
const apiKey = connection.apiKey;
const host = connection.host;
const port = connection.port;

function requestApi(method, path, body = null) {
    return requestJson(connection, method, path, body).catch((err) => {
        if (err && err.code === 'ECONNREFUSED') {
            throw new Error(
                `Power Pilot yerel API'sine bağlanılamadı (${host}:${port}). ` +
                'Uygulama çalışıyor mu ve Entegrasyonlar sekmesinde API açık mı?'
            );
        }
        throw err instanceof Error ? err : new Error(`API bağlantı hatası: ${err && err.message}`);
    });
}

async function main() {
    const rawArgs = process.argv.slice(2);
    if (rawArgs[0] === 'mcp') {
        const { startStdioServer } = require('../mcp/server');
        startStdioServer();
        return;
    }
    const parsed = parseArgs(rawArgs);

    if (parsed.flags.help) {
        console.log(usageText());
        return;
    }
    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) console.error(`Hata: ${err}`);
        console.error('');
        console.error(usageText());
        process.exitCode = 2;
        return;
    }
    const check = validate(parsed);
    if (!check.ok) {
        console.error(`Hata: ${check.error}`);
        console.error('');
        console.error(usageText());
        process.exitCode = 2;
        return;
    }
    if (!apiKey) {
        console.error('Hata: POWERPILOT_API_KEY tanımlı değil. Entegrasyonlar sekmesinden anahtar üretip ortam değişkenine atayın.');
        process.exitCode = 2;
        return;
    }

    const request = buildRequest(parsed);
    try {
        const res = await requestApi(request.method, request.path, request.body);
        const output = renderResponse(request, res, parsed.flags);
        if (res.status >= 400) {
            console.error(output);
            process.exitCode = 1;
            return;
        }
        console.log(output);
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}

main();
