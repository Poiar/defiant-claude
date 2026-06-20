'use strict';

// Anthropic server-side tool handling.
// Converts proprietary Anthropic tool types (web_search_*, web_fetch_*, etc.)
// into generic custom tool definitions that non-Anthropic providers accept.
// Also executes web_search and web_fetch server-side when the provider
// returns empty tool results.

import http from 'http';
import https from 'https';
import dns from 'dns';
import { URL } from 'url';
import { createLogger } from './log';
import { scrubCredentials } from './error-codes';
import { validateUrl } from './ssrf';
import { LruCache } from './lru-cache';
import { getConstraints } from './protocol-types';
import type { ProviderConstraints } from './protocol-types';

const log = createLogger('server-tools');

// --- Concurrency limiter for outbound fetch/search ---
// Prevents burst requests from overwhelming external services.
const MAX_CONCURRENT_FETCHES = 5;
let activeFetches = 0;
const fetchQueue: Array<() => void> = [];

export function acquireFetchSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeFetches < MAX_CONCURRENT_FETCHES) {
      activeFetches++;
      resolve();
    } else {
      fetchQueue.push(() => {
        activeFetches++;
        resolve();
      });
    }
  });
}

export function releaseFetchSlot(): void {
  activeFetches--;
  const next = fetchQueue.shift();
  if (next) next();
}

// Exported for test reset
export function _resetFetchSlots(): void {
  activeFetches = 0;
  fetchQueue.length = 0;
}

// --- Search query cache with TTL ---
// Deduplicates identical queries within a short window.
const SEARCH_CACHE_TTL_MS = 5000;
const searchCache = new LruCache<string>({ maxEntries: 100, ttlMs: SEARCH_CACHE_TTL_MS });
export function getCachedSearch(query: string): string | null {
  return searchCache.get(query) ?? null;
}
export function setCachedSearch(query: string, result: string): void {
  searchCache.set(query, result);
}
// Exported for test reset
export function _resetSearchCache(): void {
  searchCache.clear();
  structuredSearchCache.clear();
}

// Structured cache for webSearchStructured — separate from string cache
// so both code paths can coexist without cross-format deserialization.
const structuredSearchCache = new LruCache<SearchResult[]>({
  maxEntries: 100,
  ttlMs: SEARCH_CACHE_TTL_MS,
});

export function _resetDdgCookies(): void {
  ddgCookieJar = '';
}

/**
 * Slice a string without splitting UTF-16 surrogate pairs.
 * Prevents garbled output for emoji/CJK characters at the boundary.
 */
export function safeSlice(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  // Don't split surrogate pairs
  if (str.charCodeAt(maxLen - 1) >= 0xd800 && str.charCodeAt(maxLen - 1) <= 0xdbff) {
    return str.slice(0, maxLen - 1);
  }
  return str.slice(0, maxLen);
}

// --- Constants ---

const SERVER_TOOL_PREFIXES: string[] = [
  'web_search_',
  'web_fetch_',
  'url_fetch_',
  'reddit_search_',
  'computer_',
  'bash_',
  'text_editor_',
  'memory_',
  'tool_search_tool_',
];

interface WebSearchSchema {
  type: string;
  properties: {
    query: { type: string; description: string };
  };
  required: string[];
}
interface WebFetchSchema {
  type: string;
  properties: {
    url: { type: string; description: string };
  };
  required: string[];
}
const WEB_SEARCH_SCHEMA: WebSearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The search query' },
  },
  required: ['query'],
};

const WEB_FETCH_SCHEMA: WebFetchSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL to fetch content from' },
  },
  required: ['url'],
};

interface RedditSearchSchema {
  type: string;
  properties: {
    query: { type: string; description: string };
  };
  required: string[];
}
const REDDIT_SEARCH_SCHEMA: RedditSearchSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'The topic to search Reddit for. Searches posts and returns the top result with full content.',
    },
  },
  required: ['query'],
};

// --- Types ---

interface ToolDef {
  type: string;
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}
interface ConvertResult {
  tools: ToolDef[];
  hasWebSearch: boolean;
  hasWebFetch: boolean;
  hasRedditSearch: boolean;
}
interface PendingToolResult {
  needsPopulation: boolean;
  emptyResults?: Array<{
    block: Record<string, unknown>;
    toolInfo: { name: string; input: Record<string, unknown> };
  }>;
}
interface MessageBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<Record<string, unknown>>;
}
interface Message {
  role: string;
  content?: string | MessageBlock[];
}
// --- Tool type detection ---

export function isServerToolType(type: string | null | undefined): boolean {
  if (!type || typeof type !== 'string') return false;
  return SERVER_TOOL_PREFIXES.some((prefix) => type.startsWith(prefix));
}

// Anthropic's native API natively executes web_search_* and web_fetch_*
// as server-side tools.  For non-Anthropic providers we must convert them
// to generic custom tools and execute locally via DuckDuckGo.  Returning
// true here tells start-proxy.ts to skip the conversion so the real
// Anthropic API receives its native server-tool types.
export function isNativeAnthropicProvider(providerKey: string, hostname?: string): boolean {
  if (hostname === 'api.anthropic.com') return true;
  return getConstraints(providerKey).nativeServerTools;
}
// --- Server tool conversion ---

export function convertServerTools(tools: ToolDef[] | null | undefined): ConvertResult {
  if (tools === null || tools === undefined)
    return { tools: [], hasWebSearch: false, hasWebFetch: false, hasRedditSearch: false };
  if (!Array.isArray(tools))
    return { tools, hasWebSearch: false, hasWebFetch: false, hasRedditSearch: false };

  let hasWebSearch = false;
  let hasWebFetch = false;
  let hasRedditSearch = false;

  const converted: ToolDef[] = tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;

    const type = tool.type || '';
    if (type.startsWith('web_search_')) {
      hasWebSearch = true;
      return {
        name: 'web_search',
        description:
          'Search the web for current, up-to-date information. Returns relevant text snippets and URLs.',
        input_schema: WEB_SEARCH_SCHEMA as unknown as Record<string, unknown>,
      };
    }
    if (type.startsWith('web_fetch_') || type.startsWith('url_fetch_')) {
      hasWebFetch = true;
      return {
        name: 'web_fetch',
        description: 'Fetch and read content from a URL. Returns the text content of the page.',
        input_schema: WEB_FETCH_SCHEMA as unknown as Record<string, unknown>,
      };
    }
    if (type.startsWith('reddit_search_')) {
      hasRedditSearch = true;
      return {
        name: 'reddit_search',
        description:
          'Search Reddit for discussions on a topic. Returns matching post titles, snippets, and the full content of the top result including comments.',
        input_schema: REDDIT_SEARCH_SCHEMA as unknown as Record<string, unknown>,
      };
    }
    return tool;
  });

  return { tools: converted, hasWebSearch, hasWebFetch, hasRedditSearch };
}

// --- Request body preprocessing for non-Anthropic providers ---
// Server-side tools (web_search_*, web_fetch_*) must be converted to generic
// custom tools or stripped before forwarding. The associated tool_choice must
// also be stripped because (a) converted tool names no longer match any
// tool_choice target, and (b) DeepSeek rejects tool_choice when thinking mode
// is enabled ("Thinking mode does not support this tool_choice").

interface PreprocessBody {
  tools?: ToolDef[] | null;
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface PreprocessResult {
  /** Whether the body was modified */
  modified: boolean;
  /** Whether the original request contained web search tools */
  hadWebSearch: boolean;
  /** Whether the original request contained web fetch tools */
  hadWebFetch: boolean;
  /** Whether the original request contained reddit search tools */
  hadRedditSearch: boolean;
}

const WEB_TOOL_PREFIXES = ['web_search_', 'web_fetch_', 'url_fetch_'];
const isWebToolType = (type: string): boolean => WEB_TOOL_PREFIXES.some((p) => type.startsWith(p));

export function preprocessServerTools(
  body: PreprocessBody,
  constraints?: ProviderConstraints,
): PreprocessResult {
  let modified = false;
  let hadWebSearch = false;
  let hadWebFetch = false;
  let hadRedditSearch = false;

  if (!body.tools || !Array.isArray(body.tools)) {
    return { modified: false, hadWebSearch: false, hadWebFetch: false, hadRedditSearch: false };
  }

  // Step 1: Convert Anthropic server-side tool types to generic custom tools
  const conv = convertServerTools(body.tools);
  hadWebSearch = conv.hasWebSearch;
  hadWebFetch = conv.hasWebFetch;
  hadRedditSearch = conv.hasRedditSearch;
  if (conv.tools !== body.tools) {
    body.tools = conv.tools;
    modified = true;
  }

  // Step 2: Strip any remaining unconverted web tools
  type ToolItem = Record<string, unknown>;
  const unconverted = (body.tools as ToolItem[]).filter(
    (t) => t && typeof t.type === 'string' && isWebToolType(t.type as string),
  );
  if (unconverted.length > 0) {
    body.tools = (body.tools as ToolItem[]).filter(
      (t) => !(t && typeof t.type === 'string' && isWebToolType(t.type as string)),
    );
    if (body.tools.length === 0) {
      delete body.tools;
    }
    modified = true;
  }

  // Step 3: Strip tool_choice for providers that reject it with thinking.
  // Encoded in ProviderConstraints.forbidsToolChoiceWithThinking.
  //
  // EXCEPTION: when the request contains web search/fetch tools, keep
  // tool_choice so the model is forced to invoke the tool.  Without it,
  // DeepSeek responds with text instead of tool_use and populateToolResults
  // never fires.  The caller must skip thinking injection when this flag
  // is set — see the hadWebSearch/hadWebFetch return values.
  if (constraints && 'tool_choice' in body) {
    if (constraints.forbidsToolChoiceWithThinking) {
      if (hadWebSearch || hadWebFetch || hadRedditSearch) {
        // Keep tool_choice — web search needs it to force the tool invocation.
        // modified=true signals the caller to skip thinking injection.
        modified = true;
      } else {
        delete body.tool_choice;
        modified = true;
      }
    }
  } else if ('tool_choice' in body) {
    // Legacy: no constraints = strip tool_choice unconditionally
    delete body.tool_choice;
    modified = true;
  }

  return { modified, hadWebSearch, hadWebFetch, hadRedditSearch };
}
// --- Web search execution (DuckDuckGo -- free, no API key) ---

// --- DDG Lite HTML scraper ---
// DuckDuckGo's JSON API only returns instant answers (Wikipedia abstracts).
// The Lite HTML page (lite.duckduckgo.com) returns real web search results
// with titles, snippets, and URLs — and is designed to be scraped (no JS,
// minimal markup). This scraper extracts structured results from that HTML.
//
// Transport: ddgLiteSearch — POST + cookies + rotating browser UA.
// HTML parsing is shared via parseDdgLiteHtml().

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse DDG Lite HTML into structured search results.
 * Handles both current direct-URL format and legacy uddg= redirect format,
 * both quote styles, and both attribute orderings.
 */
export function parseDdgLiteHtml(html: string): SearchResult[] {
  // Two-pass: first find every <a> with class=result-link, then
  // extract href and title. This handles both orderings
  // (href before class, class before href) and both quote styles.
  const anchorRe = /<a\s[^>]*?\bclass=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titles: Array<{ title: string; url: string }> = [];
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(html)) !== null) {
    try {
      const fullAnchor = am[0]; // full <a ...>...</a>
      const innerHtml = am[1]; // content inside <a>
      // Extract href from the opening tag
      const hrefMatch = fullAnchor.match(/\bhref="([^"]*)"/);
      if (!hrefMatch) continue;
      const rawUrl = hrefMatch[1];
      // Decode uddg= redirect wrapper if present (legacy format)
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      const realUrl = decodeURIComponent(uddgMatch ? uddgMatch[1] : rawUrl);
      const title = innerHtml
        .replace(/<[^>]+>/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
      if (title && realUrl) titles.push({ title, url: realUrl });
    } catch (_) {
      /* skip malformed */
    }
  }

  // Extract snippets from <td class='result-snippet'>...snippet...</td>
  const snippetRe = /<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    let text = sm[1];
    // Remove nested result-link anchors (some layouts put them inside snippet td)
    text = text.replace(/<a[^>]*class=["']result-link["'][^>]*>[\s\S]*?<\/a>/gi, '');
    // Remove link-text spans and other nested elements
    text = text.replace(/<span[^>]*class='link-text'[^>]*>[\s\S]*?<\/span>/gi, '');
    text = text.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    text = text.replace(/\s+/g, ' ').trim();
    if (text) snippets.push(text);
  }

  // Pair: first title uses first snippet, etc.
  const results: SearchResult[] = [];
  for (let i = 0; i < titles.length; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] || '',
    });
  }
  return results.slice(0, 10);
}

// --- Cookie jar (shared across POST requests, persisted to disk) ---
let ddgCookieJar = '';

// Chrome versions to rotate through — prevents fingerprinting based on
// a single UA string. Picked from stable Chrome releases.
const DDG_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

let _uaIdx = 0;
function getDdgUA(): string {
  // Pick next UA in rotation with deterministic offset based on current
  // second — adds jitter without needing Math.random() (banned in this repo).
  const now = new Date();
  _uaIdx = (_uaIdx + now.getSeconds()) % DDG_USER_AGENTS.length;
  return DDG_USER_AGENTS[_uaIdx];
}

function extractDdgCookies(setCookieHeaders: string[] | undefined): void {
  if (!setCookieHeaders) return;
  for (const header of setCookieHeaders) {
    const parts = header.split(';')[0];
    if (!parts) continue;
    const eq = parts.indexOf('=');
    if (eq < 0) continue;
    const name = parts.slice(0, eq).trim();
    const value = parts.slice(eq + 1).trim();
    const prefix = name + '=';
    const re = new RegExp('(^|;\\s*)' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^;]*');
    const pair = prefix + value;
    if (ddgCookieJar.match(re)) {
      ddgCookieJar = ddgCookieJar.replace(re, pair);
    } else {
      ddgCookieJar = ddgCookieJar ? ddgCookieJar + '; ' + pair : pair;
    }
  }
}

/**
 * DDG Lite search via POST (current working method).
 * DDG now requires POST, session cookies, browser UA, and Referer.
 */
export function ddgLiteSearch(query: string): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const shortQuery = query.slice(0, 100);
    const postData = 'q=' + encodeURIComponent(query);
    const headers: Record<string, string> = {
      'User-Agent': getDdgUA(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://lite.duckduckgo.com/lite/',
    };
    if (ddgCookieJar) {
      headers['Cookie'] = ddgCookieJar;
    }

    const req = https.request(
      'https://lite.duckduckgo.com/lite/',
      {
        method: 'POST',
        headers,
        timeout: 15000,
      },
      (res) => {
        extractDdgCookies(res.headers['set-cookie'] as string[] | undefined);

        let data = '';
        let dataSize = 0;
        res.on('data', (chunk: Buffer) => {
          dataSize += chunk.length;
          if (dataSize > 500_000) {
            log.warn(null, 'ddgLiteSearch: response exceeded 500KB limit for: ' + shortQuery);
            resolve([]);
            res.destroy();
            return;
          }
          data += chunk.toString();
        });
        res.on('end', () => {
          if (!data) {
            log.warn(null, 'ddgLiteSearch: empty response body for: ' + shortQuery);
            resolve([]);
            return;
          }
          try {
            resolve(parseDdgLiteHtml(data));
          } catch (e) {
            log.error(
              null,
              'ddgLiteSearch: HTML parse failure for: ' +
                shortQuery +
                ' — ' +
                ((e as Error).message || ''),
            );
            resolve([]);
          }
        });
        res.on('error', (err: Error) => {
          log.warn(null, 'ddgLiteSearch: response error for: ' + shortQuery + ' — ' + err.message);
          resolve([]);
        });
      },
    );

    req.on('error', (err: Error) => {
      log.warn(null, 'ddgLiteSearch: request error for: ' + shortQuery + ' — ' + err.message);
      resolve([]);
    });
    req.on('timeout', () => {
      req.destroy();
      log.warn(null, 'ddgLiteSearch: request timed out for: ' + shortQuery);
      resolve([]);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * DDG Lite search via GET (legacy method — kept for reference).
 *
 * This was the original implementation using a simple GET with minimal
 * headers. DDG changed their bot detection in mid-2026 and now returns
 * empty search forms (or CAPTCHAs) for these requests.
 *
 * Revival path: use Playwright to drive a real browser — DDG can't
 * distinguish a headful Chromium from a human user. See
 * [[playwright-ddg-search]] for a potential implementation.
 */
// -- Env helper: process.env first, fallback to Windows Registry -----------------

import { execSync } from 'child_process';

function envWithRegistry(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  // Fallback: read Windows Registry (HKCU\Environment) for detached proxy starts.
  // Use PowerShell instead of reg.exe to avoid MSYS2 path mangling of HKCU\Environment.
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' | Select-Object -ExpandProperty '${name}'"`,
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const trimmed = out.trim();
      if (trimmed) return trimmed;
    } catch {
      // Key not in registry — return undefined
    }
  }
  return undefined;
}

export async function webSearchStructured(query: string): Promise<SearchResult[]> {
  // Check structured cache (LruCache.get returns T|undefined)
  const cached = structuredSearchCache.get(query);
  if (cached) return cached;

  // Env-controlled engine selection.
  // Default: searxng first (local Docker, fastest), then ddg (free, no key).
  // Add 'brave' when DEEPCLAUDE_BRAVE_API_KEY is set (2000 free calls/mo).
  // Add 'exa' when EXA_API_KEY is set (20,000 free requests/mo).
  const engines = (envWithRegistry('DEEPCLAUDE_SEARCH_ENGINES') || 'searxng,ddg')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());

  // Run enabled search engines in parallel. Any single engine failure
  // is non-fatal — we merge whatever results we get.
  const tasks: Array<Promise<SearchResult[]>> = [];

  if (engines.includes('ddg')) tasks.push(searchDDG(query));
  if (engines.includes('searxng')) tasks.push(searchSearXNG(query));
  if (engines.includes('brave')) tasks.push(searchBrave(query));
  if (engines.includes('exa')) tasks.push(searchExa(query));

  const settled = await Promise.allSettled(tasks);
  const engineResults: SearchResult[][] = settled.map((s) =>
    s.status === 'fulfilled' ? (s.value as SearchResult[]) : [],
  );

  const deduped = mergeAndDedup(...engineResults);

  structuredSearchCache.set(query, deduped);
  return deduped;
}

// -- Individual engine search functions ----------------------------------------

/** DDG Lite — POST scraper with GET fallback. */
async function searchDDG(query: string): Promise<SearchResult[]> {
  if (process.env.DEEPCLAUDE_SEARCH_NO_NETWORK) {
    return [
      {
        title: `Search: ${query}`,
        url: 'https://example.com/search?q=test',
        snippet: 'Mock search result for offline testing.',
      },
    ];
  }
  await acquireFetchSlot();
  try {
    return await ddgLiteSearch(query);
  } catch {
    return [];
  } finally {
    releaseFetchSlot();
  }
}

/** SearXNG — self-hosted or public instance, JSON API, no key needed.
 *
 *  Priority:
 *  1. DEEPCLAUDE_SEARXNG_URL — self-hosted (e.g. http://localhost:8888/search?format=json&q=)
 *     Run `docker run -d -p 8888:8080 searxng/searxng` once, always available, no rate limits.
 *  2. XNG_SEARXNG_INSTANCES — comma-separated fallback URLs
 *  3. Public instance discovery via searx.space (cached 24h)
 *  4. Hardcoded fallback list
 *
 *  Total deadline: 8s. First valid JSON response wins.
 */
async function searchSearXNG(query: string): Promise<SearchResult[]> {
  if (process.env.DEEPCLAUDE_SEARCH_NO_NETWORK) return [];

  const selfHosted = envWithRegistry('DEEPCLAUDE_SEARXNG_URL');
  const fallbackEnv = process.env.XNG_SEARXNG_INSTANCES;

  // Build instance list: self-hosted first, then env overrides, then hardcoded.
  const urls: string[] = [];
  if (selfHosted) urls.push(selfHosted);
  if (fallbackEnv) urls.push(...fallbackEnv.split(',').map((s) => s.trim()));

  // Hardcoded fallbacks — these rotate as instances come and go.
  // Source: searx.space (filter: uptime >95%, <2s search latency, !anubis)
  urls.push(
    'https://etsi.me/search?format=json&q=',
    'https://search.sapti.me/search?format=json&q=',
    'https://searx.tiekoetter.com/search?format=json&q=',
  );

  const INSTANCE_TIMEOUT_MS = 3000;

  const fetchOne = (baseUrl: string): Promise<SearchResult[]> =>
    new Promise<SearchResult[]>((resolve) => {
      const url = baseUrl + encodeURIComponent(query);
      const transport = url.startsWith('https://') ? https : http;
      const req = transport.get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          timeout: INSTANCE_TIMEOUT_MS,
        },
        (res) => {
          // Reject non-JSON responses (Anubis challenges, HTML, etc.)
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (!ct.includes('json') && !ct.includes('text/plain')) {
            res.destroy();
            resolve([]);
            return;
          }
          let data = '';
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 500_000) {
              res.destroy();
              resolve([]);
              return;
            }
            data += chunk.toString();
          });
          res.on('end', () => {
            try {
              // If response looks like HTML (Anubis), skip it
              if (data.trim().startsWith('<')) {
                resolve([]);
                return;
              }
              const parsed = JSON.parse(data);
              const raw = (parsed.results || []) as Array<Record<string, unknown>>;
              const mapped = raw
                .filter((r) => r.url && r.title)
                .slice(0, 20)
                .map((r) => ({
                  title: String(r.title || '').slice(0, 200),
                  url: String(r.url || ''),
                  snippet: String(r.content || r.snippet || '').slice(0, 500),
                }));
              resolve(mapped.length > 0 ? mapped : []);
            } catch {
              resolve([]);
            }
          });
        },
      );
      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });
    });

  // Try instances sequentially until one returns results.
  // Each has a 3s per-instance timeout; first success returns immediately.
  // Self-hosted DEEPCLAUDE_SEARXNG_URL is tried first (near-instant when local).
  for (const url of urls.slice(0, 4)) {
    try {
      const result = await fetchOne(url);
      if (result.length > 0) return result;
    } catch {
      // Try next
    }
  }
  return [];
}

/** Brave Search API — requires DEEPCLAUDE_BRAVE_API_KEY env var, 2000 free calls/month. */
async function searchBrave(query: string): Promise<SearchResult[]> {
  if (process.env.DEEPCLAUDE_SEARCH_NO_NETWORK) return [];
  const apiKey = envWithRegistry('DEEPCLAUDE_BRAVE_API_KEY');
  if (!apiKey) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
          'User-Agent': 'deepclaude-proxy/1.0',
        },
        signal: controller.signal,
      },
    );

    clearTimeout(timer);
    if (!res.ok) return [];

    const text = await res.text();
    if (text.length > 500_000) return [];

    const parsed = JSON.parse(text);
    const web = (parsed.web?.results || parsed.results || []) as Array<Record<string, unknown>>;
    return web
      .filter((r) => r.url && r.title)
      .slice(0, 20)
      .map((r) => ({
        title: String(r.title || '').slice(0, 200),
        url: String(r.url || ''),
        snippet: String(r.description || r.snippet || '').slice(0, 500),
      }));
  } catch {
    return [];
  }
}

/** Exa Search API — requires EXA_API_KEY env var, 20,000 free requests/month. */
async function searchExa(query: string): Promise<SearchResult[]> {
  if (process.env.DEEPCLAUDE_SEARCH_NO_NETWORK) return [];
  const apiKey = envWithRegistry('EXA_API_KEY');
  if (!apiKey) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'User-Agent': 'deepclaude-proxy/1.0',
      },
      body: JSON.stringify({
        query,
        numResults: 10,
        text: true,
        type: 'auto',
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) return [];

    const text = await res.text();
    if (text.length > 500_000) return [];

    const parsed = JSON.parse(text);
    const results = (parsed.results || []) as Array<Record<string, unknown>>;
    return results
      .filter((r) => r.url && r.title)
      .slice(0, 20)
      .map((r) => ({
        title: String(r.title || '').slice(0, 200),
        url: String(r.url || ''),
        snippet: String((r as any).highlights?.[0] || r.text || '').slice(0, 500),
      }));
  } catch {
    return [];
  }
}

// -- Result merging -----------------------------------------------------------

/** Merge results from multiple engines, deduplicate by URL, preserve diversity. */
export function mergeAndDedup(...engineResults: SearchResult[][]): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Normalize URL for dedup: strip protocol, trailing slash, lowercase
  const normUrl = (u: string): string => {
    try {
      let n = u
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '')
        .toLowerCase();
      // Strip www. prefix for comparison
      n = n.replace(/^www\./, '');
      return n;
    } catch {
      return u;
    }
  };

  // Interleave: round-robin across engines for source diversity
  const maxLen = Math.max(...engineResults.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) {
    for (const results of engineResults) {
      if (i >= results.length) continue;
      const r = results[i];
      const norm = normUrl(r.url);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      merged.push(r);
    }
  }

  return merged;
}

export async function webSearch(query: string): Promise<string> {
  // Check string cache first
  const cached = getCachedSearch(query);
  if (cached !== null) return cached;

  // Try structured search (Tiers 1-2) first
  const liteResults = await webSearchStructured(query);
  if (liteResults.length > 0) {
    const lines: string[] = [];
    for (let i = 0; i < liteResults.length; i++) {
      const r = liteResults[i];
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    }
    const result = lines.join('\n').trim() || `No results found for query: "${query}"`;
    setCachedSearch(query, result);
    return result;
  }

  await acquireFetchSlot();
  try {
    // Tier 4: DDG JSON API (instant answers for simple factual queries)
    const result = await new Promise<string>((resolve) => {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
      https
        .get(url, { headers: { 'User-Agent': 'deepclaude-proxy/1.0' }, timeout: 15000 }, (res) => {
          let data = '';
          let dataSize = 0;
          res.on('data', (chunk: Buffer) => {
            dataSize += chunk.length;
            if (dataSize > 5_000_000) {
              resolve('Search result too large for query: "' + query + '"');
              res.destroy();
              return;
            }
            data += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const results: string[] = [];
              if (parsed.AbstractText) results.push(parsed.AbstractText);
              if (parsed.AbstractURL) results.push(`Source: ${parsed.AbstractURL}`);
              if (parsed.Answer) results.push(`Answer: ${parsed.Answer}`);
              const topics = parsed.RelatedTopics || [];
              for (const topic of topics.slice(0, 8)) {
                if (topic.Text) results.push(`- ${topic.Text}`);
                if (topic.FirstURL) results.push(`  ${topic.FirstURL}`);
              }
              const text = results.join('\n') || `No results found for query: "${query}"`;
              resolve(text);
            } catch {
              resolve(`Search completed but results could not be parsed for: "${query}"`);
            }
          });
          res.on('error', (err: Error) => {
            resolve(`Web search failed: ${err.message}. Query was: "${query}"`);
          });
        })
        .on('error', (err: Error) => {
          resolve(`Web search failed: ${err.message}. Query was: "${query}"`);
        })
        .on('timeout', () => {
          resolve(`Web search timed out for query: "${query}"`);
        });
    });
    setCachedSearch(query, result);
    return result;
  } finally {
    releaseFetchSlot();
  }
}
// --- Web fetch execution ---

export function isPrivateIPv4(host: string): boolean {
  return (
    /^127\./.test(host) ||
    host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host)
  );
}
// Internal implementation without concurrency slot management.
// Recursive redirect calls skip the slot to avoid deadlock.

/**
 * Attempt a single HTTP request pinned to one validated IP address.
 * Used by webFetchImpl to try every DNS-resolved address until one connects.
 * Returns the response body text on success, or an error string on failure.
 */
async function tryAddress(
  url: string,
  address: string,
  family: number,
  depth: number,
  visited: Set<string>,
): Promise<string> {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const requestOptions: http.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : isHttps ? 443 : 80,
    path: parsedUrl.pathname + parsedUrl.search || '/',
    method: 'GET',
    headers: { 'User-Agent': 'deepclaude-proxy/1.0' },
    timeout: 20000,
    lookup(_hostname, _opts, callback) {
      callback(null, address, family);
    },
  };

  return new Promise((resolve) => {
    let req: http.ClientRequest;
    try {
      req = transport.request(requestOptions, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          res.on('error', () => {
            /* suppress — redirect already in progress */
          });
          webFetchImpl(new URL(res.headers.location, url).href, depth + 1, visited).then(resolve);
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.length > 1_000_000) {
            res.destroy();
            resolve(data.slice(0, 1_000_000) + '\n\n[Content truncated at 1MB]');
          }
        });
        res.on('end', () => {
          const text = safeSlice(
            data
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim(),
            50000,
          );
          resolve(text || `Fetched ${scrubCredentials(url)} but could not extract text content.`);
        });
        res.on('error', (err: Error) =>
          resolve(
            `Web fetch failed: ${scrubCredentials(err.message)}. URL was: ${scrubCredentials(url)}`,
          ),
        );
      });
    } catch (e) {
      resolve(
        `Web fetch failed: ${scrubCredentials((e as Error).message)}. URL was: ${scrubCredentials(url)}`,
      );
      return;
    }
    req.on('error', (err: Error) =>
      resolve(
        `Web fetch failed: ${scrubCredentials(err.message)}. URL was: ${scrubCredentials(url)}`,
      ),
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(`Web fetch timed out for URL: ${scrubCredentials(url)}`);
    });
    req.end();
  });
}

async function webFetchImpl(
  url: string,
  depth: number = 0,
  visited: Set<string> = new Set(),
): Promise<string> {
  try {
    const parsed = new URL(url);
    // FIX 3: Explicit scheme validation -- reject non-HTTP schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Error: Only http and https URLs are supported.';
    }
  } catch (_e) {
    return 'Error: Invalid URL.';
  }

  if (depth > 5 || visited.has(url)) return 'Too many redirects fetching: ' + url;
  // Normalize URL for dedup to catch equivalent-form redirects
  // (trailing slashes, case differences, fragments)
  try {
    const norm = new URL(url);
    norm.hash = '';
    norm.pathname = norm.pathname.replace(/\/+$/, '') || '/';
    visited.add(norm.href.toLowerCase());
  } catch (_) {
    visited.add(url);
  }

  // FIX 4: Use shared validateUrl from ssrf.ts as the primary SSRF check
  // (scheme validation, metadata IPs, private ranges, DNS resolution)
  const validation = await validateUrl(url);
  if (!validation.valid) {
    return 'Error: ' + validation.reason;
  }

  // Collect every validated address from the SSRF check so we can try
  // them all — not just the first one.  Pinning to a single IP (old
  // behaviour) caused ECONNREFUSED when that IP's server wasn't
  // reachable even though other DNS entries work fine.
  const validAddresses: Array<{ address: string; family: number }> = [];
  if (validation.addresses && validation.addresses.length > 0) {
    for (const addr of validation.addresses) {
      if (addr.includes(':')) {
        if (
          addr === '::1' ||
          addr.startsWith('fc') ||
          addr.startsWith('fd') ||
          addr.startsWith('fe8') ||
          addr.startsWith('fe9') ||
          addr.startsWith('fea') ||
          addr.startsWith('feb') ||
          addr.startsWith('::ffff:')
        ) {
          continue;
        }
        validAddresses.push({ address: addr, family: 6 });
      } else {
        if (isPrivateIPv4(addr)) continue;
        validAddresses.push({ address: addr, family: 4 });
      }
    }
  }

  // Fallback: if validateUrl returned no addresses (shouldn't happen for a
  // valid result, but guard anyway), do a one-shot DNS lookup.
  if (validAddresses.length === 0) {
    try {
      const resolved = new URL(url);
      const results = (await Promise.race([
        dns.promises.lookup(resolved.hostname, { all: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
      ])) as dns.LookupAddress[];
      for (const r of results) {
        if (r.family === 4) {
          if (!isPrivateIPv4(r.address)) validAddresses.push({ address: r.address, family: 4 });
        } else {
          if (
            r.address !== '::1' &&
            !r.address.startsWith('fc') &&
            !r.address.startsWith('fd') &&
            !r.address.startsWith('fe8') &&
            !r.address.startsWith('fe9') &&
            !r.address.startsWith('fea') &&
            !r.address.startsWith('feb') &&
            !r.address.startsWith('::ffff:')
          ) {
            validAddresses.push({ address: r.address, family: 6 });
          }
        }
      }
    } catch (dnsErr) {
      log.error(
        null,
        'webFetch DNS lookup failed for ' +
          scrubCredentials(url) +
          ': ' +
          ((dnsErr as Error).message || ''),
      );
      return 'Error: Could not resolve hostname.';
    }
  }

  if (validAddresses.length === 0) {
    return 'Error: Could not resolve hostname to any valid address.';
  }

  // Try every validated address until one connects.  ECONNREFUSED on one IP
  // does not mean the whole host is down — the next IP may work.
  let lastError = '';
  for (const addr of validAddresses) {
    const result = await tryAddress(url, addr.address, addr.family, depth, visited);
    // If the result starts with an error marker, keep trying the next address.
    if (
      result.startsWith('Web fetch failed:') ||
      result.startsWith('Web fetch timed out') ||
      result.startsWith('Error:')
    ) {
      lastError = result;
      continue;
    }
    // Success — return the fetched content.
    return result;
  }
  return (
    lastError ||
    'Web fetch failed: all ' +
      validAddresses.length +
      ' resolved address(es) unreachable. URL was: ' +
      scrubCredentials(url)
  );
}

// Public webFetch with concurrency limiting.
// Only the top-level call (depth 0) acquires a slot; recursive redirects
// call webFetchImpl directly, bypassing the slot to avoid deadlock.
export async function webFetch(
  url: string,
  depth: number = 0,
  visited: Set<string> = new Set(),
): Promise<string> {
  await acquireFetchSlot();
  try {
    return await webFetchImpl(url, depth, visited);
  } finally {
    releaseFetchSlot();
  }
}
// --- Reddit search ---

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface RedditSearchResult {
  title: string | null;
  body: string;
  score: string;
  commentCount: string;
  comments: string[];
}

/**
 * Clean HTML entities and tags from a string.
 */
function cleanHtml(str: string): string {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#32;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch a URL via HTTP/HTTPS and return status code + body as text.
 * Returns null on error or timeout.
 */
function simpleHttpGet(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = 15000,
): Promise<{ status: number; data: string } | null> {
  return new Promise((resolve) => {
    const transport = url.startsWith('https://') ? https : http;
    const req = transport.get(url, { headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, data });
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Search Reddit via SearXNG and fetch the top result's full content from old.reddit.com.
 *
 * 1. Queries local SearXNG with "site:reddit.com <query>"
 * 2. Returns top results with titles + snippets
 * 3. For the #1 result, fetches full post content + comments from old.reddit.com
 */
export async function redditSearch(query: string): Promise<string> {
  if (!query || typeof query !== 'string') {
    return 'Error: No query provided for Reddit search.';
  }

  // Step 1: Search via SearXNG
  const searxngUrl =
    'http://localhost:8888/search?format=json&q=' + encodeURIComponent('site:reddit.com ' + query);

  const searchRes = await simpleHttpGet(searxngUrl, {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
  });

  if (!searchRes) {
    return 'Error: SearXNG search failed (connection error or timeout).';
  }
  if (searchRes.status !== 200) {
    return 'Error: SearXNG returned HTTP ' + searchRes.status;
  }

  let results: Array<{ title?: string; url?: string; content?: string }> = [];
  try {
    const json = JSON.parse(searchRes.data);
    results = (json.results || []).filter(
      (r: { url?: string }) => r.url && r.url.includes('reddit.com'),
    );
  } catch {
    return 'Error: Failed to parse SearXNG response.';
  }

  if (results.length === 0) {
    return 'No Reddit results found for: ' + query;
  }

  // Build result listing
  const lines: string[] = [];
  lines.push('🔍 Reddit search results for: "' + query + '"');
  lines.push('');

  const topN = results.slice(0, 5);
  topN.forEach((r, i) => {
    lines.push('  ' + (i + 1) + '. ' + (r.title || '(no title)'));
    lines.push('     ' + (r.url || ''));
    if (r.content) {
      lines.push('     ' + r.content.slice(0, 120));
    }
    lines.push('');
  });

  // Step 2: Fetch full content for the top result
  const top = results[0];
  if (!top || !top.url) {
    return lines.join('\n') + '\n(no further details available)';
  }

  lines.push('─'.repeat(60));
  lines.push('📄 Full post: ' + (top.title || ''));
  lines.push('   ' + top.url);
  lines.push('');

  const oldUrl = top.url.replace('www.reddit.com', 'old.reddit.com');
  const postRes = await simpleHttpGet(oldUrl, {
    'User-Agent': BROWSER_UA,
  });

  if (!postRes || postRes.status !== 200) {
    lines.push('(failed to fetch post content)');
    return lines.join('\n');
  }

  const html = postRes.data;

  // Find post title
  const titleMatch = html.match(/<a class="title may-blank[^"]*"[^>]*>([^<]+)<\/a>/);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const title = titleMatch ? titleMatch[1].trim() : '(no title)';

  // Find post self-text: look for form with thing_id="t3_..." then .md inside
  let body = '(no text content)';
  const postFormMatch = html.match(
    /<input type="hidden" name="thing_id" value="t3_[^"]*"[^>]*\/>([\s\S]*?)<\/form>/,
  );
  if (postFormMatch) {
    const mdMatch = postFormMatch[1].match(/<div class="md"[^>]*>([\s\S]*?)<\/div>/);
    if (mdMatch) {
      body = cleanHtml(mdMatch[1]);
    }
  }

  // Find top-level comments
  const comments: string[] = [];
  const commentFormRegex =
    /<input type="hidden" name="thing_id" value="t1_[^"]*"[^>]*\/>([\s\S]*?)<\/form>/g;
  let cfMatch: RegExpExecArray | null;
  while ((cfMatch = commentFormRegex.exec(html)) !== null) {
    const mdMatch = cfMatch[1].match(/<div class="md"[^>]*>([\s\S]*?)<\/div>/);
    if (mdMatch) {
      const text = cleanHtml(mdMatch[1]);
      if (text && text.length > 20) comments.push(text);
    }
  }

  // Score and comment count
  const scoreMatch = html.match(/data-score="(\d+)"/);
  const score = scoreMatch ? scoreMatch[1] : '?';
  const ccMatch = html.match(/data-comments-count="(\d+)"/);
  const commentCount = ccMatch ? ccMatch[1] : '?';

  lines.push('Score: ' + score + ' · Comments: ' + commentCount);
  lines.push('');
  lines.push(body.slice(0, 2000));

  if (comments.length > 0) {
    lines.push('');
    lines.push('─'.repeat(40));
    lines.push('💬 Top comments (' + comments.length + '):');
    lines.push('');
    comments.slice(0, 5).forEach((c, i) => {
      lines.push('  ' + (i + 1) + '. ' + c.slice(0, 300));
      lines.push('');
    });
  }

  return lines.join('\n');
}
// --- Tool result population ---

export function hasPendingToolResult(messages: Message[]): PendingToolResult {
  if (!messages || !Array.isArray(messages)) return { needsPopulation: false };

  const toolUseIds = new Map<string, { name: string; input: Record<string, unknown> }>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        (block.name === 'web_search' ||
          block.name === 'web_fetch' ||
          block.name === 'reddit_search' ||
          (typeof block.name === 'string' &&
            (block.name.startsWith('web_search_') ||
              block.name.startsWith('web_fetch_') ||
              block.name.startsWith('url_fetch_') ||
              block.name.startsWith('reddit_search_'))))
      ) {
        toolUseIds.set(block.id!, { name: block.name, input: block.input || {} });
      }
    }
  }
  if (toolUseIds.size === 0) return { needsPopulation: false };

  const emptyResults: Array<{
    block: Record<string, unknown>;
    toolInfo: { name: string; input: Record<string, unknown> };
  }> = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      const toolInfo = toolUseIds.get(toolUseId!);
      if (!toolInfo) continue;

      const resultContent = block.content;
      const isEmpty =
        !resultContent ||
        (Array.isArray(resultContent) && resultContent.length === 0) ||
        (typeof resultContent === 'string' &&
          (() => {
            const t = resultContent.trim();
            if (t === '') return true;
            if (t.includes('not recognized')) return true;
            if (t.includes('No tool implementation found')) return true;
            if (t.includes('Did 0 searches')) return true;
            if (/^\s*(Error|fetch failed|Search failed|Web fetch failed)/i.test(t)) return true;
            if (/^\s*(Transport error|Network error|Timed out|No results found)/i.test(t))
              return true;
            return false;
          })()) ||
        (typeof resultContent === 'object' &&
          resultContent !== null &&
          !Array.isArray(resultContent) &&
          ('is_error' in resultContent || 'error' in resultContent));

      if (isEmpty) {
        emptyResults.push({ block: block as unknown as Record<string, unknown>, toolInfo });
      }
    }
  }
  return { needsPopulation: emptyResults.length > 0, emptyResults };
}

// Extract a web search query from a request if it follows CC's web search pattern.
// Returns the query string or null.
export function extractSearchQuery(messages: Message[]): string | null {
  const all = extractSearchQueries(messages);
  // Return the LAST query (most recent) to match backward-scan behavior
  return all.length > 0 ? all[all.length - 1] : null;
}

// Extract ALL web search queries from a request. Returns an array of queries
// (empty if none found). Supports multi-search where CC or the model requests
// multiple searches in a single API call.
export function extractSearchQueries(messages: Message[]): string[] {
  if (!messages || !Array.isArray(messages)) return [];
  const queries: string[] = [];
  const RE = /Perform a web search for the query:\s*(.+)/i;
  // Scan forward for chronological order across messages
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      const m = content.match(RE);
      if (m) queries.push(m[1].trim());
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const m = block.text.match(RE);
          if (m) queries.push(m[1].trim());
        }
      }
    }
  }
  return queries;
}

export async function populateToolResults(messages: Message[]): Promise<boolean> {
  const { emptyResults } = hasPendingToolResult(messages);
  if (!emptyResults || emptyResults.length === 0) return false;

  for (const { block, toolInfo } of emptyResults) {
    const name = toolInfo.name || '';
    if (name === 'web_search' || name.startsWith('web_search_')) {
      const query = (toolInfo.input.query ||
        toolInfo.input.q ||
        toolInfo.input.search ||
        '') as string;
      if (query) {
        const result = await webSearch(query);
        block.content = result;
      }
    } else if (
      name === 'web_fetch' ||
      name.startsWith('web_fetch_') ||
      name.startsWith('url_fetch_')
    ) {
      const url = (toolInfo.input.url || toolInfo.input.uri || '') as string;
      if (url) {
        const result = await webFetch(url);
        block.content = result;
      }
    } else if (name === 'reddit_search' || name.startsWith('reddit_search_')) {
      const query = (toolInfo.input.query || '') as string;
      if (query) {
        const result = await redditSearch(query);
        block.content = result;
      }
    }
  }
  return true;
}
