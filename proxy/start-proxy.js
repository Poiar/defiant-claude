const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const args = process.argv.slice(2);

function readJson(path) {
    const raw = fs.readFileSync(path, 'utf-8').replace(/^﻿/, '');
    return JSON.parse(raw);
}

let routesFile = null;
let routesMtime = 0;
let overridesFile = null;
let overridesMtime = 0;
let singleUrl = null;
let singleKey = null;

if (args[0] === '--routes' && args[1]) {
    routesFile = args[1];
    if (args[2] === '--overrides' && args[3]) {
        overridesFile = args[3];
    }
} else if (args.length >= 2) {
    singleUrl = args[0];
    singleKey = args[1];
} else {
    console.error('Usage: node start-proxy.js <provider_url> <api_key>');
    console.error('       node start-proxy.js --routes <routes.json> [--overrides <overrides.json>]');
    process.exit(1);
}

let routing = null;
if (routesFile) {
    routing = readJson(routesFile);
    routesMtime = fs.statSync(routesFile).mtimeMs;
}

let slotOverrides = {};
if (overridesFile) {
    try {
        slotOverrides = readJson(overridesFile);
        overridesMtime = fs.statSync(overridesFile).mtimeMs;
    } catch (e) {
        // Overrides file optional — may not exist yet
    }
}

function checkReload() {
    if (routesFile) {
        try {
            const stat = fs.statSync(routesFile);
            if (stat.mtimeMs > routesMtime) {
                routing = readJson(routesFile);
                routesMtime = stat.mtimeMs;
            }
        } catch (e) { /* keep old routes */ }
    }
    if (overridesFile) {
        try {
            const stat = fs.statSync(overridesFile);
            if (stat.mtimeMs > overridesMtime) {
                slotOverrides = readJson(overridesFile);
                overridesMtime = stat.mtimeMs;
            }
        } catch (e) { /* keep old overrides */ }
    }
}

function resolveTarget(model) {
    if (!routing) {
        const targetUrl = new URL(singleUrl);
        const isBearer = !targetUrl.hostname.includes('deepseek.com');
        return { url: singleUrl, key: singleKey, isBearer, rewriteModel: null };
    }

    // Slot prefix: "sonnet:oc:big-pickle" → check overrides, fall back to model after prefix
    const slotMatch = model && model.match(/^(sonnet|opus|haiku|subagent):(.+)$/);
    if (slotMatch) {
        const slot = slotMatch[1];
        const fallback = slotMatch[2];
        model = slotOverrides[slot] || fallback;
    }

    let providerKey, rewriteModel = null;

    // Check for providerKey:modelId prefix (explicit provider override from /model)
    const prefixMatch = model && model.match(/^([a-z][a-z0-9_-]*):(.+)$/);
    if (prefixMatch && routing.providers[prefixMatch[1]]) {
        providerKey = prefixMatch[1];
        rewriteModel = prefixMatch[2];
    } else {
        // Fall back to routes table lookup
        const route = (model && routing.routes[model]) || null;

        if (!route) {
            providerKey = routing.defaultProvider || null;
        } else if (typeof route === 'string') {
            providerKey = route;
        } else if (route && typeof route === 'object' && route.provider) {
            providerKey = route.provider;
            rewriteModel = route.rewrite || null;
        } else {
            providerKey = routing.defaultProvider || null;
        }
    }

    const provider = providerKey ? routing.providers[providerKey] : null;
    if (!provider) {
        // No matching provider — return error payload so the proxy sends 502
        return { url: null, key: null, isBearer: true, rewriteModel: null, error: providerKey ? `Unknown provider: ${providerKey}` : 'No default provider configured' };
    }

    const targetUrl = new URL(provider.url);
    return {
        url: provider.url,
        key: process.env[provider.keyEnv] || provider.key,
        isBearer: provider.auth === 'bearer',
        targetUrl: targetUrl,
        rewriteModel: rewriteModel,
    };
}

const startTime = Date.now();

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: Date.now() - startTime }));
        return;
    }

    checkReload();

    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 10_000_000) { res.writeHead(413); res.end(); req.destroy(); }
    });
    req.on('end', () => {
        const start = Date.now();
        let model = null;
        try { model = JSON.parse(body).model; } catch (e) {}

        const target = resolveTarget(model);

        if (target.error) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: target.error }));
            return;
        }

        // Rewrite model in body if needed
        let forwardedBody = body;
        if (target.rewriteModel) {
            try {
                const parsed = JSON.parse(body);
                if (parsed.model !== target.rewriteModel) {
                    parsed.model = target.rewriteModel;
                    forwardedBody = JSON.stringify(parsed);
                }
            } catch (e) {
                forwardedBody = body;
            }
        }

        const upstreamPath = target.targetUrl.pathname.replace(/\/+$/, '') + req.url;

        const options = {
            hostname: target.targetUrl.hostname,
            port: target.targetUrl.port || (target.targetUrl.protocol === 'https:' ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers: { ...req.headers },
            timeout: 60000,
        };

        delete options.headers['host'];
        delete options.headers['connection'];
        delete options.headers['proxy-authorization'];
        delete options.headers['content-length'];
        delete options.headers['transfer-encoding'];

        if (target.isBearer) {
            options.headers['authorization'] = `Bearer ${target.key}`;
            delete options.headers['x-api-key'];
        } else {
            options.headers['x-api-key'] = target.key;
            delete options.headers['authorization'];
        }

        const transport = options.port === 443 ? https : http;
        const proxy = transport.request(options, (proxyRes) => {
            const ms = Date.now() - start;
            console.error(`${req.method} ${model || '-'} → ${proxyRes.statusCode} ${ms}ms`);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxy.on('timeout', () => {
            proxy.destroy();
            res.writeHead(504);
            res.end(JSON.stringify({ error: 'Upstream timeout after 60s' }));
        });

        proxy.on('error', (err) => {
            console.error(`${req.method} ${model || '-'} → ERR ${err.message}`);
            res.writeHead(502);
            res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
        });

        proxy.write(forwardedBody);
        proxy.end();
    });
});

server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.stdout.write('PORT:' + String(port));
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});
