---
name: qa-audit-results
description: "2026-06-12 QA audit across 5 dimensions — 59 fixes applied, 5 false positives identified, 3799 tests passing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e3cdae8-9f2b-4455-8f16-b2cf0b62b7a5
---

Completed a multi-agent QA audit of DeepClaude (10 agents across Security, Resilience, Correctness, Edge Cases, Code Quality). 64 initial findings → 5 false positives → 59 fixes applied across 14 files. All tests pass at time of audit (count varies by runner — vitest reports 514 tests across 35 suites; Jest reported ~3800 with its different counting methodology).

Key false positives worth knowing about:
- **Double spend recording** (`start-proxy.ts:1031+1121`): NOT a bug. The two `recordSpend` call sites are mutually exclusive — body branch vs streaming pipeline callback. Only one fires per request.
- **Concurrency slot leak** (`concurrency.ts:101`): NOT a bug. The dual `onClose` + `slotReleased` pattern correctly prevents the race. The agent did a deep trace and confirmed.
- **"All fallbacks exhausted" double-write** (`start-proxy.ts:1169`): NOT a bug. Handlers registered before `headersSent` check, mutually exclusive branches.

Most impactful fixes applied:
- `protocol-translate.ts`: `message_start` guard before `finishStream`, `signature`/`signature_delta` for thinking blocks, `output_tokens`-only in `message_delta`
- `forward.ts`: Deadline split from heartbeat — set once, never reset (was sliding window)
- `routing.ts`: Hardcoded `noAutoFallback` set (`ds`,`oc`,`um`) when `--providers` omitted
- `config.ts`: Guard against empty providers.json wiping all state during config rotation
- `start-proxy.ts`: `exec()`→`execFile()`, PID via `process.kill`, malformed JSON→400, passthrough path allowlist
- `dashboard.ts`: Auto-generated random auth key when `DEEPCLAUDE_DASHBOARD_KEY` unset
- `session-key.ts`: Per-startup random salt prevents cross-session key collisions

**Why:** Comprehensive security/correctness/resilience hardening. The audit found real bugs (orphaned `message_delta`, deadline-as-sliding-window, command injection) plus extensive low-severity code quality improvements.

**How to apply:** Run `npm test` after any further changes. The `QA-AUDIT-REPORT.md` has full details.
