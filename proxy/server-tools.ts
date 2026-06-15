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
    return { tools: [], hasWebSearch: false, hasWebFetch: false };
  if (!Array.isArray(tools)) return { tools, hasWebSearch: false, hasWebFetch: false };

  let hasWebSearch = false;
  let hasWebFetch = false;

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
    return tool;
  });

  return { tools: converted, hasWebSearch, hasWebFetch };
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

  if (!body.tools || !Array.isArray(body.tools)) {
    return { modified: false, hadWebSearch: false, hadWebFetch: false };
  }

  // Step 1: Convert Anthropic server-side tool types to generic custom tools
  const conv = convertServerTools(body.tools);
  hadWebSearch = conv.hasWebSearch;
  hadWebFetch = conv.hasWebFetch;
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
  // For backward compatibility (no constraints passed), strip unconditionally
  // as was the historical behavior for all non-Anthropic providers.
  if (constraints && 'tool_choice' in body) {
    if (constraints.forbidsToolChoiceWithThinking) {
      delete body.tool_choice;
      modified = true;
    }
  } else if ('tool_choice' in body) {
    // Legacy: no constraints = strip tool_choice unconditionally
    delete body.tool_choice;
    modified = true;
  }

  return { modified, hadWebSearch, hadWebFetch };
}
// --- Web search execution (DuckDuckGo -- free, no API key) ---

// --- DDG Lite HTML scraper ---
// DuckDuckGo's JSON API only returns instant answers (Wikipedia abstracts).
// The Lite HTML page (lite.duckduckgo.com) returns real web search results
// with titles, snippets, and URLs — and is designed to be scraped (no JS,
// minimal markup). This scraper extracts structured results from that HTML.

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function ddgLiteSearch(query: string): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const shortQuery = query.slice(0, 100);
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    https
      .get(
        url,
        {
          headers: { 'User-Agent': 'deepclaude-proxy/1.0' },
          timeout: 15000,
        },
        (res) => {
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
              // Extract titles from <a class='result-link' href="...">Title</a>
              const titleRe = /<a[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
              const titles: Array<{ title: string; url: string }> = [];
              let tm: RegExpExecArray | null;
              while ((tm = titleRe.exec(data)) !== null) {
                try {
                  const realUrl = decodeURIComponent(tm[1]);
                  const title = tm[2]
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
              while ((sm = snippetRe.exec(data)) !== null) {
                // Snippet may contain <b> and other inline tags
                let text = sm[1];
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
              resolve(results.slice(0, 10));
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
            log.warn(
              null,
              'ddgLiteSearch: response error for: ' + shortQuery + ' — ' + err.message,
            );
            resolve([]);
          });
        },
      )
      .on('error', (err: Error) => {
        log.warn(null, 'ddgLiteSearch: request error for: ' + shortQuery + ' — ' + err.message);
        resolve([]);
      })
      .on('timeout', () => {
        log.warn(null, 'ddgLiteSearch: request timed out for: ' + shortQuery);
        resolve([]);
      });
  });
}

export async function webSearch(query: string): Promise<string> {
  // Check cache first
  const cached = getCachedSearch(query);
  if (cached !== null) return cached;

  await acquireFetchSlot();
  try {
    // Primary: DDG Lite HTML scraper (real search results, free, no API key)
    const liteResults = await ddgLiteSearch(query);
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

    // Fallback: DDG JSON API (instant answers for simple factual queries)
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
    // Cache the result
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
          (typeof block.name === 'string' &&
            (block.name.startsWith('web_search_') ||
              block.name.startsWith('web_fetch_') ||
              block.name.startsWith('url_fetch_'))))
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
  if (!messages || !Array.isArray(messages)) return null;
  // Scan backward for the last user message asking for a web search
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      const m = content.match(/Perform a web search for the query:\s*(.+)/i);
      if (m) return m[1].trim();
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const m = block.text.match(/Perform a web search for the query:\s*(.+)/i);
          if (m) return m[1].trim();
        }
      }
    }
  }
  return null;
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
    }
  }
  return true;
}
