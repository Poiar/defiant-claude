'use strict';

import http from 'http';
import { serveDashboard, buildDashboardHtml } from '../dashboard';
import { recordRecentRequest, getFullHealthSnapshot } from '../stats';

// Dashboard now requires authentication.  Use a fixed key for tests.
const TEST_DASHBOARD_KEY = 'test-dashboard-key';
process.env.DEEPCLAUDE_DASHBOARD_KEY = TEST_DASHBOARD_KEY;

describe('buildDashboardHtml', () => {
  test('returns HTML containing key elements', () => {
    const html = buildDashboardHtml();
    expect(html).toContain('<!DOCTYPE');
    expect(html).toContain('</html>');
    expect(html).toContain('DeepClaude');
    expect(html).toContain('Recent Requests');
    expect(html).toContain('Provider');
    expect(html).toContain('Circuit Breaker');
    expect(html).toContain('Success Rate');
  });

  test('HTML is self-contained (no external resources except Chart.js CDN)', () => {
    const html = buildDashboardHtml();
    // Chart.js is loaded from CDN for analytics charts
    expect(html).toContain('chart.js@4');
    // No other external stylesheet or font URLs
    expect(html).not.toMatch(/href=["']https?:\/\//);
    expect(html).not.toMatch(/@import url\(https?:\/\//);
    // Relative URLs (/health, /health/stream) for data fetching are fine
  });

  test('provider display names appear in HTML', () => {
    const html = buildDashboardHtml({ ds: 'DeepSeek Test Provider', or: 'OpenRouter Test' });
    expect(html).toContain('DeepSeek Test Provider');
    expect(html).toContain('OpenRouter Test');
  });

  test('handles empty provider display names', () => {
    const html = buildDashboardHtml();
    expect(html).toContain('PROVIDER_NAMES={}');
  });
});

// =========================================================================
// Error console panel — embedded in dashboard HTML
// =========================================================================

describe('error console panel in dashboard HTML', () => {
  let html: string;

  beforeAll(() => {
    html = buildDashboardHtml();
  });

  test('includes error console container script block', () => {
    expect(html).toContain('vibe-error-console');
    expect(html).toContain('appErrors');
  });

  test('includes Copy Errors button (escaped for innerHTML)', () => {
    // The button is inside p.innerHTML="...", so quotes are backslash-escaped
    expect(html).toContain('vibe-copy');
    expect(html).toContain('Copy Errors');
  });

  test('includes Clear button', () => {
    expect(html).toContain('vibe-clear');
    expect(html).toContain('>Clear<');
  });

  test('includes Close button', () => {
    expect(html).toContain('vibe-close');
    expect(html).toContain('>Close<');
  });

  test('includes error list container', () => {
    expect(html).toContain('vibe-elist');
  });

  test('includes advisory note text', () => {
    expect(html).toContain('Opens automatically on JS errors');
  });

  test('CSS uses dark theme colors matching dashboard', () => {
    expect(html).toContain('rgba(10,11,16,0.97)');
    expect(html).toContain('#f7efdf');
    expect(html).toContain('#2a1118');
  });

  test('error console has fixed positioning with high z-index', () => {
    expect(html).toContain('position:fixed');
    expect(html).toContain('z-index:999999');
  });

  test('registers window error event listener', () => {
    expect(html).toContain('addEventListener("error"');
  });

  test('registers unhandledrejection event listener', () => {
    expect(html).toContain('addEventListener("unhandledrejection"');
  });

  test('includes clipboard copy logic', () => {
    expect(html).toContain('clipboard.writeText');
  });

  test('error data includes timestamp', () => {
    expect(html).toContain('toLocaleTimeString()');
  });

  test('error items include message, source, line, col, and stack', () => {
    expect(html).toContain('payload.message');
    expect(html).toContain('payload.source');
    expect(html).toContain('payload.lineno');
    expect(html).toContain('payload.error');
    expect(html).toContain('.stack');
  });

  test('HTML escaping function escH is present', () => {
    expect(html).toContain('function escH');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&quot;');
  });

  test('error console starts hidden (display:none)', () => {
    expect(html).toContain('display:none');
    expect(html).toContain('vibe-show');
  });

  test('Close button handler hides the panel', () => {
    expect(html).toContain('classList.remove');
  });

  test('Clear button handler empties the error list', () => {
    expect(html).toMatch(/appErrors\.length\s*=\s*0/);
    expect(html).toMatch(/\.innerHTML\s*=\s*""/);
  });

  test('error panel uses prepend for newest-first ordering', () => {
    expect(html).toContain('.prepend(div)');
  });
});

describe('serveDashboard route handling', () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      if (serveDashboard(req, res, {}, {})) return;
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    const timer = setTimeout(() => done(), 2000);
    server.close(() => {
      clearTimeout(timer);
      done();
    });
  });

  function get(urlPath: string): Promise<{ res: http.IncomingMessage; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: urlPath,
          method: 'GET',
          agent: false,
          headers: { 'x-dashboard-key': TEST_DASHBOARD_KEY },
        },
        (res: http.IncomingMessage) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            resolve({ res, body });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.end();
    });
  }

  test('/dashboard returns 200 with text/html', async () => {
    const { res, body } = await get('/dashboard');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    expect(body).toContain('DeepClaude');
    expect(body).toContain('</html>');
  });

  function getFirstSSEEvent(
    urlPath: string,
  ): Promise<{ statusCode: number; contentType: string; firstEvent: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: urlPath,
          method: 'GET',
          agent: false,
          headers: { 'x-dashboard-key': TEST_DASHBOARD_KEY },
        },
        (res: http.IncomingMessage) => {
          let data = '';
          const onData = (chunk: Buffer) => {
            data += chunk.toString();
            if (data.indexOf('\n\n') >= 0) {
              res.removeListener('data', onData);
              res.destroy();
              const firstEvent = data.split('\n\n')[0];
              resolve({
                statusCode: res.statusCode || 0,
                contentType: (res.headers['content-type'] || '') as string,
                firstEvent,
              });
            }
          };
          res.on('data', onData);
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.end();
    });
  }

  test('/health/stream returns text/event-stream content type', async () => {
    const { statusCode, contentType } = await getFirstSSEEvent('/health/stream');
    expect(statusCode).toBe(200);
    expect(contentType).toBe('text/event-stream');
  });

  test('/health/stream sends valid SSE events', async () => {
    const { firstEvent } = await getFirstSSEEvent('/health/stream');
    expect(firstEvent).toMatch(/^data: /);
    const jsonStr = firstEvent.slice(5).trim();
    const json = JSON.parse(jsonStr);
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('uptime');
    expect(json).toHaveProperty('providers');
    expect(json).toHaveProperty('spend');
    expect(json).toHaveProperty('recentRequests');
    expect(json).toHaveProperty('version');
  });

  test('returns 404 for unknown routes', async () => {
    const { res } = await get('/unknown');
    expect(res.statusCode).toBe(404);
  });
});

describe('recent request ring buffer', () => {
  // Fill buffer with padding to ensure clean test state
  beforeAll(() => {
    for (let i = 0; i < 50; i++) {
      recordRecentRequest({
        timestamp: Date.now(),
        model: 'pad-' + i,
        provider: 'test',
        status: 200,
        ms: 0,
        tokens: { input: 0, output: 0 },
        fallback: false,
      });
    }
  });

  test('oldest entries evicted after 50', () => {
    for (let i = 0; i < 60; i++) {
      recordRecentRequest({
        timestamp: Date.now(),
        model: 'test-entry-' + i,
        provider: 'test',
        status: 200,
        ms: 100,
        tokens: { input: 10, output: 20 },
        fallback: false,
      });
    }
    const snapshot = getFullHealthSnapshot(null, null);
    const recent = snapshot.recentRequests as Array<{ model: string }>;
    expect(recent.length).toBe(50);
    // Newest entry should be the last one recorded (test-entry-59)
    expect(recent[0].model).toBe('test-entry-59');
    // Oldest remaining should be test-entry-10 (entries 0-9 were evicted)
    expect(recent[49].model).toBe('test-entry-10');
  });

  test('ring buffer contains no more than 50 entries', () => {
    // Record 10 more entries on top of the 50 already in buffer
    for (let i = 0; i < 10; i++) {
      recordRecentRequest({
        timestamp: Date.now(),
        model: 'extra-' + i,
        provider: 'test',
        status: 200,
        ms: 50,
        tokens: { input: 1, output: 2 },
        fallback: false,
      });
    }
    const snapshot = getFullHealthSnapshot(null, null);
    const recent = snapshot.recentRequests as Array<{ model: string }>;
    expect(recent.length).toBe(50);
    // Should contain extra-9 .. extra-0 then entries from before
    expect(recent[0].model).toBe('extra-9');
  });
});

describe('getFullHealthSnapshot', () => {
  test('includes spend and recentRequests fields', () => {
    const snapshot = getFullHealthSnapshot(null, null);
    expect(snapshot).toHaveProperty('spend');
    expect(snapshot).toHaveProperty('recentRequests');
    expect(typeof snapshot.spend).toBe('number');
    expect(Array.isArray(snapshot.recentRequests)).toBe(true);
  });

  test('recentRequests are ordered newest first', () => {
    recordRecentRequest({
      timestamp: 1000,
      model: 'req-a',
      provider: 'test',
      status: 200,
      ms: 50,
      tokens: { input: 1, output: 2 },
      fallback: false,
    });
    recordRecentRequest({
      timestamp: 2000,
      model: 'req-b',
      provider: 'test',
      status: 200,
      ms: 60,
      tokens: { input: 3, output: 4 },
      fallback: false,
    });
    const snapshot = getFullHealthSnapshot(null, null);
    const recent = snapshot.recentRequests as Array<{ model: string; timestamp: number }>;
    // Find the entries we just added in the reversed list
    const aIdx = recent.findIndex((r) => r.model === 'req-a');
    const bIdx = recent.findIndex((r) => r.model === 'req-b');
    // req-b was recorded last so it must appear first (lower index)
    expect(bIdx).toBeLessThan(aIdx);
  });

  test('includes circuitBreaker state per provider', () => {
    const snapshot = getFullHealthSnapshot(null, null);
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(providers)) {
      expect(providers[key]).toHaveProperty('circuitBreaker');
      expect(['CLOSED', 'OPEN']).toContain(providers[key].circuitBreaker);
    }
  });
});

describe('serveDashboard standalone function', () => {
  test('returns true for GET /dashboard', () => {
    const req = new http.IncomingMessage(null as any);
    req.method = 'GET';
    req.url = '/dashboard';
    const res = new http.ServerResponse(req);
    const result = serveDashboard(req, res, {}, {});
    expect(result).toBe(true);
  });

  test('returns true for GET /health/stream', () => {
    const req = new http.IncomingMessage(null as any);
    req.method = 'GET';
    req.url = '/health/stream';
    const res = new http.ServerResponse(req);
    const result = serveDashboard(req, res, {}, {});
    expect(result).toBe(true);
  });

  test('returns false for non-GET methods', () => {
    const req = new http.IncomingMessage(null as any);
    req.method = 'POST';
    req.url = '/dashboard';
    const res = new http.ServerResponse(req);
    const result = serveDashboard(req, res, {}, {});
    expect(result).toBe(false);
  });

  test('returns false for unknown URLs', () => {
    const req = new http.IncomingMessage(null as any);
    req.method = 'GET';
    req.url = '/unknown';
    const res = new http.ServerResponse(req);
    const result = serveDashboard(req, res, {}, {});
    expect(result).toBe(false);
  });
});
