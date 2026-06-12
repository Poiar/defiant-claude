# DeepClaude

- **Test**: `npm test` — 625 tests, 36 suites. Skip integration suite (needs running proxy).
- **Push**: standard git — commit + push, no special workflow.
- **Key files**: `proxy/start-proxy.ts` (server), `proxy/providers.json` (config), `deepclaude.ps1`/`.sh` (launchers), `proxy/launcher.mjs` (shared engine), `statusline/statusline.mjs` (status bar), `proxy/forward.ts` (streaming), `proxy/stats.ts` (circuit breakers, spend).
- **No ESLint config** — runs with defaults (`--max-warnings 0`).
- **Integration tests**: `proxy/__tests__/integration.test.ts`, 30s timeout.
- **Entry points**: `dc` (ds default), `deepclaude -b <config>`, `dc.ps1` delegates to `deepclaude.ps1`.
- **DeepSeek cache**: 50× discount on cache hits (98% typical), compaction near 1M wall only.
- **README builder**: `npm run build:readme` regenerates `README.md` from `README.template.md` using live data from `providers.json`, file system, and test output.
