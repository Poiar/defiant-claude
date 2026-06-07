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

const log = createLogger('server-tools');

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
    return SERVER_TOOL_PREFIXES.some(prefix => type.startsWith(prefix));
}
// --- Server tool conversion ---

export function convertServerTools(tools: ToolDef[] | null | undefined): ConvertResult {
    if (tools === null || tools === undefined) return { tools: [], hasWebSearch: false, hasWebFetch: false };
    if (!Array.isArray(tools)) return { tools, hasWebSearch: false, hasWebFetch: false };

    let hasWebSearch = false;
    let hasWebFetch = false;

    const converted: ToolDef[] = tools.map(tool => {
        if (!tool || typeof tool !== 'object') return tool;

        const type = tool.type || '';
        if (type.startsWith('web_search_')) {
            hasWebSearch = true;
            return {
                type: 'custom',
                name: 'web_search',
                description: 'Search the web for current, up-to-date information. Returns relevant text snippets and URLs.',
                input_schema: WEB_SEARCH_SCHEMA as unknown as Record<string, unknown>,
            };
        }
        if (type.startsWith('web_fetch_') || type.startsWith('url_fetch_')) {
            hasWebFetch = true;
            return {
                type: 'custom',
                name: 'web_fetch',
                description: 'Fetch and read content from a URL. Returns the text content of the page.',
                input_schema: WEB_FETCH_SCHEMA as unknown as Record<string, unknown>,
            };
        }
        return tool;
    });

    return { tools: converted, hasWebSearch, hasWebFetch };
}
// --- Web search execution (DuckDuckGo -- free, no API key) ---

export function webSearch(query: string): Promise<string> {
    return new Promise((resolve) => {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
        https.get(url, { headers: { 'User-Agent': 'deepclaude-proxy/1.0' }, timeout: 15000 }, (res) => {
            let data = '';
            let dataSize = 0;
            res.on('data', (chunk: Buffer) => {
                dataSize += chunk.length;
                if (dataSize > 5_000_000) { resolve('Search result too large for query: "' + query + '"'); res.destroy(); return; }
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
        }).on('error', (err: Error) => {
            resolve(`Web search failed: ${err.message}. Query was: "${query}"`);
        }).on('timeout', () => {
            resolve(`Web search timed out for query: "${query}"`);
        });
    });
}
// --- Web fetch execution ---

function isPrivateIPv4(host: string): boolean {
    return /^127\./.test(host) || host === '0.0.0.0' ||
        /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^192\.168\./.test(host) || /^169\.254\./.test(host);
}
export function webFetch(url: string, _depth?: number, _visited?: Set<string>): Promise<string> {
    _depth = _depth || 0;
    _visited = _visited || new Set();

    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        const rawHost = hostname.replace(/^\[|\]$/g, ''); // Strip IPv6 brackets

        if (hostname === 'localhost' || /^127\./.test(hostname) ||
            /^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) ||
            /^0\.0\.0\.0$/.test(hostname)) {
            return Promise.resolve('Error: Access to internal/private networks is blocked.');
        }
        if (/^\d+$/.test(hostname)) return Promise.resolve('Error: Access to internal/private networks is blocked.');
        if (/^0x[0-9a-fA-F]+$/.test(hostname)) return Promise.resolve('Error: Access to internal/private networks is blocked.');

        // IPv6 private / loopback / link-local / ULA checks
        if (rawHost === '::1') {
            return Promise.resolve('Error: Access to internal/private networks is blocked.');
        }
        if (rawHost.startsWith('fc') || rawHost.startsWith('fd') ||
            rawHost.startsWith('fe8') || rawHost.startsWith('fe9') ||
            rawHost.startsWith('fea') || rawHost.startsWith('feb')) {
            return Promise.resolve('Error: Access to internal/private networks is blocked.');
        }
        if (rawHost.startsWith('::ffff:')) {
            const raw = rawHost.replace(/^::ffff:/, '');
            if (isPrivateIPv4(raw)) return Promise.resolve('Error: Access to internal/private networks is blocked.');
            // Hex-encoded IPv4 in mapped address (e.g., ::ffff:7f00:1 -> 127.0.0.1)
            const hexMatch = raw.match(/^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/);
            if (hexMatch) {
                const hi = parseInt(hexMatch[1], 16);
                const lo = parseInt(hexMatch[2], 16);
                if (!isNaN(hi) && !isNaN(lo)) {
                    const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
                    if (isPrivateIPv4(ipv4)) return Promise.resolve('Error: Access to internal/private networks is blocked.');
                }
            }
        }
    } catch (e) { return Promise.resolve('Error: Invalid URL.'); }

    if (_depth > 5 || _visited.has(url)) return Promise.resolve('Too many redirects fetching: ' + url);
    _visited.add(url);

    return (async () => {
        // DNS resolution guard -- prevent SSRF bypass via DNS names that
        // resolve to private/internal IPs. Uses dns.lookup (getaddrinfo)
        // which checks /etc/hosts, mDNS, NSS etc. -- the same path http.get
        // uses -- avoiding a mismatch between validation and connection.
        try {
            const resolved = new URL(url);
            const results = await Promise.race([
                dns.promises.lookup(resolved.hostname, { all: true }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
            ]) as dns.LookupAddress[];
            for (const r of results) {
                if (r.family === 4) {
                    if (isPrivateIPv4(r.address)) return 'Error: Access to internal/private networks is blocked.';
                } else {
                    if (r.address === '::1' || r.address.startsWith('fc') ||
                        r.address.startsWith('fd') || r.address.startsWith('fe8') ||
                        r.address.startsWith('fe9') || r.address.startsWith('fea') ||
                        r.address.startsWith('feb') || r.address.startsWith('::ffff:')) {
                        return 'Error: Access to internal/private networks is blocked.';
                    }
                }
            }
        } catch (dnsErr) {
            // DNS failure means we can't validate, so block the request.
            // DNS errors are rare for legitimate URLs and common for SSRF probes.
            log.error(null, 'webFetch DNS lookup failed for ' + scrubCredentials(url) + ': ' + ((dnsErr as Error).message || ''));
            return 'Error: Could not resolve hostname.';
        }
        return new Promise((resolve) => {
            const parsedUrl = new URL(url);
            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const req = transport.get(url, { headers: { 'User-Agent': 'deepclaude-proxy/1.0' }, timeout: 20000 }, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    webFetch(new URL(res.headers.location, url).href, _depth! + 1, _visited).then(resolve);
                    return;
                }
                let data = '';
                res.on('data', (chunk: Buffer) => {
                    data += chunk.toString();
                    if (data.length > 1_000_000) { res.destroy(); resolve(data.slice(0, 1_000_000) + '\n\n[Content truncated at 1MB]'); }
                });
                res.on('end', () => {
                    const text = data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 50000);
                    resolve(text || `Fetched ${url} but could not extract text content.`);
                });
                res.on('error', (err: Error) => resolve(`Web fetch failed: ${err.message}. URL was: ${url}`));
            });
            req.on('error', (err: Error) => resolve(`Web fetch failed: ${err.message}. URL was: ${url}`));
            req.on('timeout', () => { req.destroy(); resolve(`Web fetch timed out for URL: ${url}`); });
        });
    })();
}
// --- Tool result population ---

export function hasPendingToolResult(messages: Message[]): PendingToolResult {
    if (!messages || !Array.isArray(messages)) return { needsPopulation: false };

    const toolUseIds = new Map<string, { name: string; input: Record<string, unknown> }>();

    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (block.type === 'tool_use' && (block.name === 'web_search' || block.name === 'web_fetch')) {
                toolUseIds.set(block.id!, { name: block.name, input: block.input || {} });
            }
        }
    }
    if (toolUseIds.size === 0) return { needsPopulation: false };

    const emptyResults: Array<{ block: Record<string, unknown>; toolInfo: { name: string; input: Record<string, unknown> } }> = [];
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const toolUseId = block.tool_use_id;
            const toolInfo = toolUseIds.get(toolUseId!);
            if (!toolInfo) continue;

            const resultContent = block.content;
            const isEmpty = !resultContent ||
                (typeof resultContent === 'string' && resultContent.trim() === '') ||
                (typeof resultContent === 'string' && resultContent.includes('not recognized')) ||
                (typeof resultContent === 'string' && resultContent.includes('No tool implementation found')) ||
                (Array.isArray(resultContent) && resultContent.length === 0);

            if (isEmpty) {
                emptyResults.push({ block: block as unknown as Record<string, unknown>, toolInfo });
            }
        }
    }
    return { needsPopulation: emptyResults.length > 0, emptyResults };
}
export async function populateToolResults(messages: Message[]): Promise<boolean> {
    const { emptyResults } = hasPendingToolResult(messages);
    if (!emptyResults || emptyResults.length === 0) return false;

    for (const { block, toolInfo } of emptyResults) {
        if (toolInfo.name === 'web_search') {
            const query = (toolInfo.input.query || toolInfo.input.q || toolInfo.input.search || '') as string;
            if (query) {
                const result = await webSearch(query);
                block.content = result;
            }
        } else if (toolInfo.name === 'web_fetch') {
            const url = (toolInfo.input.url || toolInfo.input.uri || '') as string;
            if (url) {
                const result = await webFetch(url);
                block.content = result;
            }
        }
    }
    return true;
}
