# DeepClaude

- **Test**: `npm test` — 615 tests, 35 suites. Skip integration suite (needs running proxy).
- **Push**: standard git — commit + push, no special workflow.
- **Key files**: `proxy/start-proxy.ts` (server), `proxy/providers.json` (config), `deepclaude.ps1`/`.sh` (launchers), `proxy/forward.ts` (streaming), `proxy/stats.ts` (circuit breakers, spend).
- **No ESLint config** — runs with defaults (`--max-warnings 0`).
- **Integration tests**: `proxy/__tests__/integration.test.ts`, 30s timeout.
- **Entry points**: `dc` (ds default), `deepclaude -b <config>`, `dc.ps1` delegates to `deepclaude.ps1`.
- **DeepSeek cache**: 50× discount on cache hits (98% typical), compaction near 1M wall only.
