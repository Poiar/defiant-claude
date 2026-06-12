# DeepClaude

- **Test**: `npm test` — 627 tests, 36 suites (includes integration). 53 cache-specific tests (thinking + reasoning cache round-trip and regression).
- **Push**: standard git — commit + push, no special workflow. Pre-push hook runs lint (`--max-warnings 0`).
- **Key files**: `proxy/start-proxy.ts` (server), `proxy/providers.json` (config), `deepclaude.ps1`/`.sh` (launchers), `proxy/launcher.mjs` (shared engine), `proxy/forward.ts` (streaming), `proxy/thinking-cache.ts` + `proxy/reasoning-cache.ts` (thinking cache, keyed `sessionKey:toolUseId` — no conversation fingerprint), `proxy/server-tools.ts` (WebSearch/WebFetch interception), `proxy/stats.ts` (circuit breakers, spend), `statusline/statusline.mjs` (status bar).
- **ESLint**: `.eslintrc.json` with TypeScript parser (`@typescript-eslint`), `eslint:recommended` base.
- **Entry points**: `dc` (ds default), `deepclaude -b <config>`, `dc.ps1` delegates to `deepclaude.ps1`.
- **DeepSeek cache**: 50× discount on cache hits (98% typical), compaction at 950K tokens. Thinking mode requires thinking blocks echoed back every turn — caching handles this automatically.
- **README builder**: `npm run build:readme` regenerates `README.md` from `README.template.md` using live data from `providers.json`, file system, and test output.
