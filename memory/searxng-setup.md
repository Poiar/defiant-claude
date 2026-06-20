---
name: searxng-setup
description: "SearXNG local Docker instance for Defiant web search — configuration, registry keys, and code defaults"
metadata:
  type: project
---

## SearXNG Local Setup (this machine, 2026-06-18)

SearXNG runs in Docker on port 8888 as the primary web search engine for Defiant. It's free, unlimited, and bypasses CAPTCHAs that break DuckDuckGo.

**Why:** DDG Lite is broken by CAPTCHA, Brave requires an API key with a 2000/mo limit. SearXNG (self-hosted) is free, unlimited, and actually works. It aggregates DuckDuckGo + Startpage under the hood.

**How to apply:** When `DEFIANT_SEARCH_ENGINES` is unset, the proxy defaults to `searxng,ddg` — SearXNG is tried first. The proxy reads `DEFIANT_SEARXNG_URL` from `HKCU:\Environment` via PowerShell on startup. If SearXNG is down, hardcoded fallback instances (etsi.me, search.sapti.me, searx.tiekoetter.com) are tried sequentially.

### Current configuration

| Setting | Value |
|---------|-------|
| Docker container | `searxng` (port 8888→8080) |
| Registry key | `HKCU:\Environment\DEFIANT_SEARXNG_URL` = `http://localhost:8888/search?format=json&q=` |
| Default engines | `searxng,ddg` (in `proxy/server-tools.ts:567`) |
| Transport | `http` for localhost, `https` for remote instances |
| Fallback instances | `etsi.me`, `search.sapti.me`, `searx.tiekoetter.com` |
| Relevant code | `proxy/server-tools.ts` — `searchSearXNG()`, `webSearchStructured()`, `envWithRegistry()` |

### Key code details

- `envWithRegistry()` reads from `process.env` first, then falls back to PowerShell `Get-ItemProperty` on `HKCU:\Environment` (not `reg.exe` — avoids MSYS2 path mangling)
- `searchSearXNG()` builds a URL list: self-hosted → `XNG_SEARXNG_INSTANCES` env → hardcoded fallbacks. Tries sequentially, first result set wins, 3s per-instance timeout
- Transport selection: `const transport = url.startsWith('https://') ? https : http;` — was hardcoded to `https` before 2026-06-18, breaking localhost

### Verification

```bash
curl -s "http://localhost:8888/search?format=json&q=test" | head -c 200
```

### Related

- [[claude-code-websearch-provider-failure]] — The other search failure mode (DeepSeek thinking cache, now fixed)
- [[never-kill-proxy]] — Restarting proxy kills the CC session
- Skill: `setup-searxng` at `.claude/skills/setup-searxng/SKILL.md`
