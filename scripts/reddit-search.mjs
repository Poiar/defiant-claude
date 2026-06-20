#!/usr/bin/env node

/**
 * reddit-search.mjs — Search Reddit via SearXNG + read full post via old.reddit.com
 *
 * Usage:
 *   node scripts/reddit-search.mjs <search query>
 *   node scripts/reddit-search.mjs "r/deepseek deepseek v4"
 *   node scripts/reddit-search.mjs --limit 15 "claude code"
 *   node scripts/reddit-search.mjs --raw "deepseek"
 *
 * Behavior:
 *   1. Tries the SearXNG reddit-html engine first (scrapes old.reddit.com HTML)
 *   2. Falls back to SearXNG general search with "site:reddit.com" prefix
 *   3. For the #1 result, fetches full post content + comments from old.reddit.com
 */

import http from 'http';
import https from 'https';

const SEARXNG_URL = 'http://localhost:8888/search?format=json&q=';
const TIMEOUT_MS = 10000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// --- Parse CLI args ---
const args = process.argv.slice(2);
let limit = 5;
let raw = false;

const queryTerms = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) {
    limit = parseInt(args[++i], 10);
    if (isNaN(limit) || limit < 1) limit = 5;
    if (limit > 25) limit = 25;
  } else if (args[i] === '--raw') {
    raw = true;
  } else {
    queryTerms.push(args[i]);
  }
}

const query = queryTerms.join(' ');

if (!query) {
  console.error('Usage: node scripts/reddit-search.mjs [--limit N] [--raw] <search query>');
  process.exit(1);
}

// --- HTTP helper ---
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https://') ? https : http;
    const req = transport.get(url, { headers, timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function cleanHtml(str) {
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

// --- Search via SearXNG reddit-html engine (primary) ---
async function searchViaRedditEngine(query) {
  const url = SEARXNG_URL + encodeURIComponent(query) + '&engines=reddit-html';
  const res = await httpGet(url, {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
  });
  if (res.status !== 200) return null;
  try {
    const json = JSON.parse(res.data);
    return (json.results || []).filter(
      (r) => r.url && (r.url.includes('reddit.com') || r.url.includes('old.reddit.com')),
    );
  } catch {
    return null;
  }
}

// --- Search via SearXNG general + site:reddit.com (fallback) ---
async function searchViaSiteReddit(query) {
  const url = SEARXNG_URL + encodeURIComponent('site:reddit.com ' + query);
  const res = await httpGet(url, {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
  });
  if (res.status !== 200) return [];
  try {
    const json = JSON.parse(res.data);
    return (json.results || []).filter((r) => r.url && r.url.includes('reddit.com'));
  } catch {
    return [];
  }
}

// --- Fetch full post content from old.reddit.com ---
async function fetchPostContent(url) {
  const oldUrl = url
    .replace('www.reddit.com', 'old.reddit.com')
    .replace('old.reddit.com', 'old.reddit.com');

  const res = await httpGet(oldUrl, { 'User-Agent': BROWSER_UA });
  if (res.status !== 200) {
    return { title: '(failed to fetch)', body: '', score: '?', commentCount: '?', comments: [] };
  }

  const html = res.data;

  const titleMatch = html.match(/<a class="title may-blank[^"]*"[^>]*>([^<]+)<\/a>/);
  const title = titleMatch ? titleMatch[1].trim() : '(no title)';

  let body = '(no text content)';
  const postFormMatch = html.match(
    /<input type="hidden" name="thing_id" value="t3_[^"]*"[^>]*\/>([\s\S]*?)<\/form>/,
  );
  if (postFormMatch) {
    const mdMatch = postFormMatch[1].match(/<div class="md"[^>]*>([\s\S]*?)<\/div>/);
    if (mdMatch) body = cleanHtml(mdMatch[1]);
  }

  const comments = [];
  const commentFormRegex =
    /<input type="hidden" name="thing_id" value="t1_[^"]*"[^>]*\/>([\s\S]*?)<\/form>/g;
  let cfMatch;
  while ((cfMatch = commentFormRegex.exec(html)) !== null) {
    const mdMatch = cfMatch[1].match(/<div class="md"[^>]*>([\s\S]*?)<\/div>/);
    if (mdMatch) {
      const text = cleanHtml(mdMatch[1]);
      if (text && text.length > 20) comments.push(text);
    }
  }

  const scoreMatch = html.match(/data-score="(\d+)"/);
  const score = scoreMatch ? scoreMatch[1] : '?';
  const ccMatch = html.match(/data-comments-count="(\d+)"/);
  const commentCount = ccMatch ? ccMatch[1] : '?';

  return { title, body, score, commentCount, comments: comments.slice(0, 5) };
}

// --- Main ---
async function main() {
  console.log(`🔍 Searching Reddit for: "${query}"\n`);

  // Try the dedicated reddit-html engine first
  let results = await searchViaRedditEngine(query);

  // Fallback: general search with site:reddit.com
  if (!results || results.length === 0) {
    if (results === null) {
      console.log('(reddit-html engine unavailable, falling back to site:reddit.com search)');
    }
    results = await searchViaSiteReddit(query);
  }

  if (!results || results.length === 0) {
    console.log('No Reddit results found.');
    process.exit(0);
  }

  console.log(`Found ${results.length} result(s):\n`);
  results.slice(0, limit).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.title || '(no title)'}`);
    console.log(`     ${r.url}`);
    if (r.content) console.log(`     ${r.content.slice(0, 120)}`);
    console.log();
  });

  if (raw) process.exit(0);

  // Fetch full content for the top result
  const top = results[0];
  console.log('─'.repeat(60));
  console.log(`📄 Full post: ${top.title}`);
  console.log(`   ${top.url}\n`);

  const post = await fetchPostContent(top.url);

  console.log(`Score: ${post.score} · Comments: ${post.commentCount}`);
  console.log(`\n${post.body.slice(0, 2000)}`);

  if (post.comments.length > 0) {
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`💬 Top comments (${post.comments.length}):\n`);
    post.comments.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.slice(0, 300)}`);
      console.log();
    });
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
