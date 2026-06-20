#!/usr/bin/env node

/**
 * reddit-search.mjs — Search Reddit via SearXNG + read full post via RSS
 *
 * Usage:
 *   node scripts/reddit-search.mjs <search query>
 *   node scripts/reddit-search.mjs "r/deepseek deepseek v4"
 *   node scripts/reddit-search.mjs --limit 15 "claude code"
 *   node scripts/reddit-search.mjs --raw "deepseek"
 *   node scripts/reddit-search.mjs --url <reddit-post-url>
 *   node scripts/reddit-search.mjs --post <reddit-post-url>
 *
 * Behavior (search mode):
 *   1. Checks SearXNG is running on localhost:8888
 *   2. Tries the SearXNG reddit-html engine first
 *   3. Falls back to SearXNG general search with "site:reddit.com" prefix
 *   4. For the #1 result, fetches full post content + comments from Reddit's RSS feed
 *
 * Behavior (--url/--post mode):
 *   1. Fetches the given Reddit post via www.reddit.com/.../.rss
 *   2. Displays post content + comments (no search involved)
 *
 * RSS is used instead of old.reddit.com HTML scraping because:
 *   - old.reddit.com now returns the new Reddit SPA (no content in HTML)
 *   - old.reddit.com actively blocks automated access (network policy, Cloudflare)
 *   - www.reddit.com/.rss is open, unblocked, and returns full structured content
 */

import http from 'http';
import https from 'https';

const SEARXNG_URL = 'http://localhost:8888/search?format=json&q=';
const SEARXNG_TIMEOUT_MS = 5000;
const RSS_TIMEOUT_MS = 15000;
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

// --- Parse CLI args ---
const args = process.argv.slice(2);
let limit = 5;
let raw = false;
let directUrl = null;

const queryTerms = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) {
    limit = parseInt(args[++i], 10);
    if (isNaN(limit) || limit < 1) limit = 5;
    if (limit > 25) limit = 25;
  } else if (args[i] === '--raw') {
    raw = true;
  } else if (args[i] === '--url' || args[i] === '--post') {
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      directUrl = args[++i];
    } else {
      console.error('Error: --url/--post requires a Reddit post URL as an argument.');
      process.exit(1);
    }
  } else {
    queryTerms.push(args[i]);
  }
}

const query = queryTerms.join(' ');

if (!query && !directUrl) {
  console.error('Usage: node scripts/reddit-search.mjs [--limit N] [--raw] <search query>');
  console.error('       node scripts/reddit-search.mjs --url <reddit-post-url>');
  console.error('       node scripts/reddit-search.mjs --post <reddit-post-url>');
  process.exit(1);
}

// --- HTTP helper ---
function httpGet(url, headers = {}, timeoutMs = RSS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https://') ? https : http;
    const req = transport.get(url, { headers, timeout: timeoutMs }, (res) => {
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

let _uaIndex = 0;
function nextUA() {
  const ua = BROWSER_UAS[_uaIndex % BROWSER_UAS.length];
  _uaIndex++;
  return ua;
}

// --- SearXNG health check ---
async function checkSearxng() {
  try {
    const res = await httpGet(
      'http://localhost:8888/search?format=json&q=health',
      { 'User-Agent': nextUA(), Accept: 'application/json' },
      SEARXNG_TIMEOUT_MS,
    );
    return res && res.status === 200;
  } catch {
    return false;
  }
}

// --- Search via SearXNG reddit-html engine (primary) ---
async function searchViaRedditEngine(query) {
  const url = SEARXNG_URL + encodeURIComponent(query) + '&engines=reddit-html';
  const res = await httpGet(
    url,
    { 'User-Agent': nextUA(), Accept: 'application/json' },
    SEARXNG_TIMEOUT_MS,
  );
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
  const res = await httpGet(
    url,
    { 'User-Agent': nextUA(), Accept: 'application/json' },
    SEARXNG_TIMEOUT_MS,
  );
  if (res.status !== 200) return [];
  try {
    const json = JSON.parse(res.data);
    return (json.results || []).filter((r) => r.url && r.url.includes('reddit.com'));
  } catch {
    return [];
  }
}

// --- Convert any Reddit URL to RSS feed URL ---
// Takes: https://www.reddit.com/r/SUBREDDIT/comments/POSTID/SLUG/
//        https://old.reddit.com/r/SUBREDDIT/comments/POSTID/SLUG/
// Returns: https://www.reddit.com/r/SUBREDDIT/comments/POSTID/.rss
function toRssUrl(url) {
  // Strip trailing slash
  url = url.replace(/\/$/, '');
  // Normalize: old.reddit.com -> www.reddit.com, strip slug after POSTID
  url = url.replace('old.reddit.com', 'www.reddit.com');
  // Match pattern /r/SUBREDDIT/comments/POSTID
  const match = url.match(/\/r\/([^/]+)\/comments\/([^/]+)/);
  if (!match) return null;
  return `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/.rss`;
}

// --- Fetch post content from Reddit RSS feed ---
async function fetchPostViaRss(url) {
  const rssUrl = toRssUrl(url);
  if (!rssUrl) {
    return {
      title: '(invalid URL)',
      body: 'Not a valid Reddit post URL. Expected: https://www.reddit.com/r/SUBREDDIT/comments/POSTID/...',
      score: '?',
      commentCount: '?',
      comments: [],
    };
  }

  // Try fetching RSS with retry on 429
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await httpGet(rssUrl, { 'User-Agent': nextUA() });
    if (res && (res.status === 429 || res.status === 503)) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    break;
  }
  if (!res || res.status !== 200) {
    const reason =
      res && res.status === 429 ? 'rate-limited' : `HTTP ${res ? res.status : 'error'}`;
    return {
      title: '(failed to fetch)',
      body: `Reddit RSS feed returned "${reason}". Try again later.`,
      score: '?',
      commentCount: '?',
      comments: [],
    };
  }

  const xml = res.data;

  // Extract post title from <title> (before <entry>)
  const titleMatch = xml.match(/<title>(.*?)<\/title>/);
  const title = titleMatch ? decodeHtml(titleMatch[1].trim()) : '(no title)';

  // Extract all content blocks: first is the post, rest are comments
  const contentRegex = /<content type="html">(.*?)<\/content>/g;
  const blocks = [];
  let cm;
  while ((cm = contentRegex.exec(xml)) !== null) {
    blocks.push(decodeHtml(cm[1]));
  }

  // Post body is the first content block (strip HTML tags)
  let body = '(no text content)';
  if (blocks.length > 0) {
    body = stripHtml(blocks[0]);
  }

  // Comments are remaining content blocks
  const comments = [];
  for (let i = 1; i < blocks.length; i++) {
    const text = stripHtml(blocks[i]);
    if (text && text.length > 20) {
      comments.push(text);
    }
  }

  // Extract upvote score (from post's <updated> or search for "upvote" pattern)
  let score = '?';
  const scoreMatch = xml.match(/score["']?\s*[:=]\s*["']?(\d+)/);
  if (scoreMatch) score = scoreMatch[1];

  const commentCount = comments.length > 0 ? String(comments.length) : '?';

  return {
    title,
    body,
    score,
    commentCount,
    comments: comments.slice(0, 5),
  };
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x?[a-fA-F0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(str) {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Display a post (from --url/--post or search results) ---
function displayPost(post) {
  console.log('Score: ' + post.score + ' · Comments: ' + post.commentCount);
  console.log('');
  console.log(post.body.slice(0, 2000));

  if (post.comments.length > 0) {
    console.log('');
    console.log('─'.repeat(40));
    console.log('💬 Top comments (' + post.comments.length + '):');
    console.log('');
    post.comments.forEach((c, i) => {
      console.log('  ' + (i + 1) + '. ' + c.slice(0, 300));
      console.log('');
    });
  }
}

// --- Main ---
async function main() {
  // --- Mode 1: Direct URL fetch (--url/--post) ---
  if (directUrl) {
    console.log('📄 Fetching post: ' + directUrl + '\n');
    const post = await fetchPostViaRss(directUrl);
    console.log(post.title);
    console.log('');
    displayPost(post);
    process.exit(0);
  }

  // --- Mode 2: Search ---
  console.log('🔍 Searching Reddit for: "' + query + '"\n');

  // Check SearXNG health before searching
  const searxngOk = await checkSearxng();
  if (!searxngOk) {
    console.log('⚠️  SearXNG is not running at http://localhost:8888');
    console.log('   SearXNG is used to search Reddit (find relevant posts).');
    console.log('   Start it with: docker start searxng');
    console.log(
      '   Or use --url to fetch a post directly: node scripts/reddit-search.mjs --url <reddit-url>',
    );
    process.exit(0);
  }

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

  console.log('Found ' + results.length + ' result(s):\n');
  results.slice(0, limit).forEach((r, i) => {
    console.log('  ' + (i + 1) + '. ' + (r.title || '(no title)'));
    console.log('     ' + (r.url || ''));
    if (r.content) console.log('     ' + r.content.slice(0, 120));
    console.log('');
  });

  if (raw) process.exit(0);

  // Fetch full content for the top result via RSS
  const top = results[0];
  console.log('─'.repeat(60));
  console.log('📄 Full post: ' + (top.title || ''));
  console.log('   ' + (top.url || ''));
  console.log('');

  const post = await fetchPostViaRss(top.url || '');
  displayPost(post);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
