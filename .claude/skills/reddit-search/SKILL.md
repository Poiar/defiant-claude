---
name: reddit-search
description: Search Reddit and fetch post content via RSS. Usage: /reddit-search &lt;query&gt; or /reddit-search --url &lt;reddit-url&gt;
---

# Reddit Search

Search Reddit for discussions, or fetch a specific post by URL. Uses SearXNG for search and Reddit's RSS feed for post content (bypasses Cloudflare and bot detection).

## Usage

### Search Reddit
```
/reddit-search <search query>
/reddit-search --limit 15 "advanced query with quotes"
/reddit-search --raw "just show results, skip post content"
```

Examples:
```
/reddit-search deepseek v4 pricing
/reddit-search --limit 10 "claude code vs cursor"
/reddit-search --raw "neuralwatt glm-5.2"
```

### Fetch a specific post by URL
```
/reddit-search --url <full-reddit-post-url>
/reddit-search --post <reddit-post-url>
```

Examples:
```
/reddit-search --url https://www.reddit.com/r/opencodeCLI/comments/1u8l3qb/
/reddit-search --post https://old.reddit.com/r/ClaudeCode/comments/1t3hrcx/
```

## How It Works

1. **Search mode**: Queries local SearXNG (localhost:8888) using the `reddit-html` engine first, falls back to `site:reddit.com` general search
2. **URL mode**: Converts any Reddit URL to `www.reddit.com/r/{sub}/comments/{id}/.rss` and fetches via RSS
3. **Post content**: The RSS feed returns full post body + all comments as structured XML — no HTML scraping, no Cloudflare issues

## Why RSS (Not old.reddit.com scraping)

- `old.reddit.com` HTML — Blocked by Reddit network policy
- `www.reddit.com` — Cloudflare challenge
- Reddit JSON API (`.json`) — 403 blocked
- **`www.reddit.com/.rss`** — ✅ Works (200 OK, full content + comments)
- RSS doesn't include upvote scores (always shows "?")

## Key Files

- `scripts/reddit-search.mjs` — Standalone search + fetch script
- `proxy/server-tools.ts` — Proxy-side `redditSearch()` function
- `proxy/__tests__/reddit-search.test.ts` — Unit tests (27 tests)
