'use strict';

/**
 * Playwright-based DuckDuckGo Lite search.
 *
 * Drives a real headless Chromium browser to fetch search results from
 * lite.duckduckgo.com. DDG's bot detection cannot distinguish a real
 * browser from a human — this permanently bypasses CAPTCHAs.
 *
 * Called from webSearch() in server-tools.ts as an optional tier.
 * Loaded lazily via dynamic require so the proxy doesn't fail if
 * Playwright isn't installed.
 */

export interface PlaywrightDdgResult {
  html: string;
  error?: string;
}

let _chromium: typeof import('playwright').chromium | null = null;

function getChromium(): typeof import('playwright').chromium {
  if (!_chromium) {
    _chromium = require('playwright').chromium;
  }
  return _chromium!;
}

export async function ddgSearchPlaywright(query: string): Promise<PlaywrightDdgResult> {
  let browser: import('playwright').Browser | undefined;
  try {
    const chromium = getChromium();
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Hide automation signals that DDG's bot detection checks
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // @ts-expect-error navigator.chrome is non-standard
      window.chrome = { runtime: {} };
      // Override permissions to look human
      const originalQuery = window.navigator.permissions.query;
      // @ts-expect-error monkey-patching permissions
      window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);
    });

    await page.goto('https://lite.duckduckgo.com/lite/', {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    // Fill the search input and submit the form
    const input = page.locator('input[name="q"]');
    await input.fill(query);
    await input.press('Enter');

    // Wait for results
    await page.waitForLoadState('domcontentloaded');
    try {
      await page.waitForSelector('a.result-link', { timeout: 8000 });
    } catch {
      /* may have no results */
    }
    await page.waitForTimeout(300);

    const html = await page.content();
    await context.close();
    await browser.close();

    return { html };
  } catch (e) {
    try {
      if (browser) await browser.close();
    } catch (_) {
      /* already closed */
    }
    return { html: '', error: (e as Error).message || 'Playwright search failed' };
  }
}
