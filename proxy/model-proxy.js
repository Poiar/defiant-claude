import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';

const ANTHROPIC_FALLBACK = 'https://api.anthropic.com';
const MODEL_PATHS = ['/v1/messages'];

export function startModelProxy({ targetUrl, apiKey, startPort = 3200 }) {
    return new Promise((resolve, reject) => {
        const target = new URL(targetUrl);
        const useBearer = targetUrl.includes('openrouter') || targetUrl.includes('fireworks');

        const server = createServer((clientReq, clientRes) => {
            const isModelCall = MODEL_PATHS.some(p => clientReq.url.startsWith(p));
            const dest = isModelCall ? target : new URL(ANTHROPIC_FALLBACK);
            const fullPath = isModelCall ? `${target.pathname}${clientReq.url}` : clientReq.url;

            const headers = { ...clientReq.headers, host: dest.host };
            delete headers['content-length'];

            if (isModelCall) {
                delete headers['authorization'];
                delete headers['x-api-key'];
                if (useBearer) {
                    headers['authorization'] = `Bearer ${apiKey}`;
                } else {
                    headers['x-api-key'] = apiKey;
                }
            }

            const chunks = [];
            clientReq.on('data', c => chunks.push(c));
            clientReq.on('end', () => {
                const body = Buffer.concat(chunks);
                const opts = {
                    hostname: dest.hostname,
                    port: dest.port || 443,
                    path: fullPath,
                    method: clientReq.method,
                    headers: { ...headers, 'content-length': body.length },
                };

                const proxyReq = httpsRequest(opts, (proxyRes) => {
                    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                    proxyRes.pipe(clientRes);
                });

                proxyReq.on('error', (err) => {
                    console.error(`[MODEL-PROXY] ${dest.hostname}${fullPath}: ${err.message}`);
                    if (!clientRes.headersSent) {
                        clientRes.writeHead(502, { 'content-type': 'application/json' });
                    }
                    clientRes.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
                });

                proxyReq.end(body);
            });
        });

        function tryListen(port) {
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE' && port < startPort + 20) {
                    tryListen(port + 1);
                } else {
                    reject(err);
                }
            });
            server.listen(port, '127.0.0.1', () => {
                const actualPort = server.address().port;
                console.log(`[MODEL-PROXY] Listening on 127.0.0.1:${actualPort} → ${targetUrl}`);
                resolve({ port: actualPort, close: () => server.close() });
            });
        }

        tryListen(startPort);
    });
}
