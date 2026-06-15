# DeepClaude

- **Test**: `npm test` — 1412 tests, 46 suites (includes integration). 53 cache-specific tests (thinking + reasoning cache round-trip and regression).
- **Verify**: `npm run verify` — full suite: tests + ESLint (`--max-warnings 0`). Also `node scripts/verify.mjs`.
- **Push**: standard git — commit + push, no special workflow. Pre-push hook runs lint (`--max-warnings 0`).
- **Proxy restart**: `npm run restart-proxy` or `node scripts/restart-proxy.mjs` — hot-swap to a new proxy.
- **Key files**: `proxy/start-proxy.ts` (server, hot-swap), `proxy/providers.json` (config), `deepclaude.ps1`/`.sh` (launchers), `proxy/launcher.mjs` (shared engine), `proxy/forward.ts` (streaming), `proxy/thinking-cache.ts` + `proxy/reasoning-cache.ts` (thinking cache, keyed `sessionKey:toolUseId` — no conversation fingerprint), `proxy/server-tools.ts` (WebSearch/WebFetch interception), `proxy/stats.ts` (circuit breakers, spend), `statusline/statusline.mjs` (status bar), `scripts/restart-proxy.mjs` (hot-swap automation), `scripts/verify.mjs` (test+lint runner).
- **ESLint**: `.eslintrc.json` with TypeScript parser (`@typescript-eslint`), `eslint:recommended` base.
- **Shellcheck**: Lints `deepclaude.sh` via WSL (requires sudo) — `echo 'testtest' | wsl bash -c "sudo -S shellcheck /mnt/c/OC/deepclaude/deepclaude.sh"`. Part of `npm run lint`.
- **Entry point**: `scripts/cli.mjs` (Node.js) — handles all flags, config, proxy launch, and CC spawn. `deepclaude.ps1`/`.sh` are thin 10-line wrappers.
- **DeepSeek cache**: 50× discount on cache hits (98% typical), compaction at 950K tokens. Thinking mode requires thinking blocks echoed back every turn — caching handles this automatically.
- **README builder**: `npm run build:readme` regenerates `README.md` from `README.template.md` using live data from `providers.json`, file system, and test output.
