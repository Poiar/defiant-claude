---
name: setup-searxng
description: Set up a local SearXNG instance via Docker for DeepClaude web search — free, no API key, unlimited queries
---

# Setup SearXNG for DeepClaude Web Search

Sets up a self-hosted SearXNG search engine that DeepClaude uses for web search. SearXNG aggregates results from multiple engines (Google, DuckDuckGo, Brave, etc.) and bypasses their CAPTCHAs. No API keys, no rate limits, no cost.

## Prerequisites

- Docker Desktop must be running
- DeepClaude project at `C:\Dev\deepclaude`

## Quick Setup

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

Set these in Windows Registry (or your shell profile):

```powershell
reg add "HKCU\Environment" /v DEEPCLAUDE_SEARXNG_URL /t REG_SZ /d "http://localhost:8888/search?format=json&q=" /f
reg add "HKCU\Environment" /v DEEPCLAUDE_SEARCH_ENGINES /t REG_SZ /d "searxng" /f
```

Or in `.env` / shell profile:
```bash
export DEEPCLAUDE_SEARXNG_URL="http://localhost:8888/search?format=json&q="
export DEEPCLAUDE_SEARCH_ENGINES="searxng"
```

### 6. Restart DeepClaude

Exit Claude Code and run `dc` again from PowerShell. The new proxy picks up the env vars on startup.

## How it works

The DeepClaude proxy reads `DEEPCLAUDE_SEARCH_ENGINES` (comma-separated engine list) and queries each enabled engine in parallel, merges results, and deduplicates by URL.

| Engine | Requires | Free tier |
|--------|----------|-----------|
| `searxng` | Docker (or `DEEPCLAUDE_SEARXNG_URL`) | Unlimited |
| `brave` | `DEEPCLAUDE_BRAVE_API_KEY` | 2000/mo |
| `ddg` | Nothing | Broken (CAPTCHA) |

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

### "Did 0 searches" after setup
Run the search-debug skill to trace the pipeline. Common causes:
- Proxy not restarted after setting env vars
- `DEEPCLAUDE_SEARCH_ENGINES` still defaulting to `brave` (fixed in code — default is now `ddg,searxng`)
- SearXNG container not running (`docker ps | grep searxng`)

## Related

- [[search-debug]] — Full pipeline diagnostics
- [[restart-proxy]] — NEVER restart from within a CC session
- `proxy/server-tools.ts` — `searchSearXNG()`, `webSearchStructured()`, engine dispatch
