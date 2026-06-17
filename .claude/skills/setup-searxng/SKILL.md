---
name: setup-searxng
description: Set up a local SearXNG instance via Docker for DeepClaude web search — free, no API key, unlimited queries. Already installed and configured on this machine.
---

# Setup SearXNG for DeepClaude Web Search

Sets up a self-hosted SearXNG search engine that DeepClaude uses for web search. SearXNG aggregates results from multiple engines (Google, DuckDuckGo, Brave, etc.) and bypasses their CAPTCHAs. No API keys, no rate limits, no cost.

## Current state (this machine)

- ✅ Docker Desktop installed, SearXNG container running on port 8888
- ✅ `DEEPCLAUDE_SEARXNG_URL` set in `HKCU:\Environment` → `http://localhost:8888/search?format=json&q=`
- ✅ Default engines in code: `searxng,ddg` (`proxy/server-tools.ts:567`)
- ✅ `http` transport works (fixed — was hardcoded to `https` before 2026-06-18)
- ✅ Registry reads use PowerShell (not `reg.exe`) to avoid MSYS2 path mangling
- ✅ Hardcoded fallback instances: `etsi.me`, `search.sapti.me`, `searx.tiekoetter.com`

## Prerequisites

- Docker Desktop must be running
- DeepClaude project at `C:\Dev\deepclaude`

## Quick Setup (new machine)

### 1. Start Docker Desktop

```powershell
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```
Wait for Docker engine to be ready (`docker ps` should work).

### 2. Create config files

```bash
mkdir -p ~/searxng-config

cat > ~/searxng-config/settings.yml << 'YML'
use_default_settings: true
server:
  secret_key: "searxng-local-deepclaude-$(date +%s)"
  bind_address: "0.0.0.0"
  limiter: false
search:
  safe_search: 0
  formats:
    - html
    - json
YML

cat > ~/searxng-config/limiter.toml << 'TOML'
[botdetection.ip_limit]
link_token = false
TOML
```

### 3. Run SearXNG

```bash
docker rm -f searxng 2>/dev/null
docker run -d --name searxng -p 8888:8080 \
  -v ~/searxng-config/settings.yml:/etc/searxng/settings.yml:ro \
  -v ~/searxng-config/limiter.toml:/etc/searxng/limiter.toml:ro \
  searxng/searxng
```

### 4. Verify it works

```bash
curl -s "http://localhost:8888/search?format=json&q=test" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"results\",[]))} results')"
```

Should print something like `20 results`.

### 5. Configure DeepClaude

Set the SearXNG URL in Windows Registry (or shell profile):

```powershell
Set-ItemProperty -Path 'HKCU:\Environment' -Name 'DEEPCLAUDE_SEARXNG_URL' -Value 'http://localhost:8888/search?format=json&q=' -Type String
```

Or in `.env` / shell profile:
```bash
export DEEPCLAUDE_SEARXNG_URL="http://localhost:8888/search?format=json&q="
```

No need to set `DEEPCLAUDE_SEARCH_ENGINES` — the code default is `searxng,ddg` which puts SearXNG first.

### 6. Restart DeepClaude

Exit Claude Code and run `dc` again from PowerShell. The proxy reads `HKCU:\Environment` on startup via PowerShell.

## How it works

The DeepClaude proxy reads `DEEPCLAUDE_SEARCH_ENGINES` (comma-separated engine list) and queries each enabled engine in parallel, merges results, and deduplicates by URL. Default order: `searxng,ddg` (SearXNG first since DDG is broken by CAPTCHA).

| Engine | Requires | Free tier |
|--------|----------|-----------|
| `searxng` | Docker (or `DEEPCLAUDE_SEARXNG_URL`) | Unlimited |
| `brave` | `DEEPCLAUDE_BRAVE_API_KEY` | 2000/mo |
| `ddg` | Nothing | Broken (CAPTCHA) |

The proxy selects `http` or `https` transport based on the URL scheme — `http://localhost` uses the `http` module, remote instances use `https`.

## Troubleshooting

### 403 Forbidden from SearXNG
The limiter.toml and settings.yml must both be present inside the container. If volume mounts don't work (Git Bash path issues on Windows), write directly:
```bash
docker exec searxng sh -c 'cat > /etc/searxng/limiter.toml << "TOML"
[botdetection.ip_limit]
link_token = false
TOML
'
docker restart searxng
```

### "Docker engine not available"
Docker Desktop must be running. Start it from the Start Menu or via `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`.

### 0 results from SearXNG
Common causes:
- `DEEPCLAUDE_SEARCH_NO_NETWORK` is set (even empty string from some shells) — unset it with `delete process.env.DEEPCLAUDE_SEARCH_NO_NETWORK`
- SearXNG container not running → `docker ps | grep searxng`
- Proxy not restarted after setting registry → exit and restart `dc`
- Port conflict → check with `curl http://localhost:8888/search?format=json&q=test`

## Related

- [[search-debug]] — Full pipeline diagnostics
- [[never-kill-proxy]] — NEVER restart from within a CC session
- `proxy/server-tools.ts` — `searchSearXNG()`, `webSearchStructured()`, engine dispatch, default engine order
- `proxy/__tests__/server-tools.test.ts` — 7 SearXNG tests (http/https transport, fallback, dedup)
