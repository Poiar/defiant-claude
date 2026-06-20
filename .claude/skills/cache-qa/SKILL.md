---
name: cache-qa
description: >-
  Re-run the cache QA audit workflow to detect cache-invalidation and
  cost-inefficiency issues in the Defiant Claude proxy.
---

# Cache QA

Invokes the multi-agent QA workflow that analyzes Defiant Claude's caching
pipeline for bugs that can invalidate DeepSeek's disk cache or inflate costs.

Run this after making changes to:
- `proxy/thinking-cache.ts` — thinking block injection
- `proxy/reasoning-cache.ts` — reasoning content re-injection
- `proxy/forward.ts` — SSE forwarding, timeouts, usage extraction
- `proxy/protocol-types.ts` — body normalization strips
- `proxy/start-proxy.ts` — request pipeline ordering
- `proxy/config.ts` — hot-reload, schema validation
- `proxy/launcher.mjs` — compaction window calculation

## Usage

Invoke with:
```
/cache-qa
```

Or run the targeted test suite:
```
npm run qa:cache
```

Or run the full QA workflow (requires Claude Code Workflow runner):
```bash
npx tsx -e "require('./.claude/workflows/cache-qa.js')"
```
