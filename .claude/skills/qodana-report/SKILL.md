---
name: qodana-report
description: Use this skill when the user asks about the Qodana code analysis report, Qodana issues, or how to access/inspect the Qodana results for this project.
---

The Qodana report surfaces static analysis issues (unused symbols, duplicate declarations, try/catch abuse, readonly fields, etc.) across the codebase.

## How to Access the Report

### Option A: Via the IDE (recommended — no rate limiting)

Open WebStorm → **Qodana** tool window (View → Tool Windows → Qodana). Results appear inline with full navigation, no rate limiting.

### Option B: Via browser (has rate limiting on first load)

The report is served by WebStorm's built-in Qodana plugin on port 63342:

```
http://localhost:63342/qodana.ide/idea.html?projectKey=d3ba4650b7715fd1a93c3c273f4cb326&_qdt=6033ddae-4b83-44e8-b35d-4326f24cad18&theme=dark
```

> **Note:** The `projectKey` and `_qdt` params are session-specific. If the URL doesn't work, get the current URL from WebStorm's Qodana tool window (right-click the report → "Open in Browser").

### Option C: Via Docker (clean static report, no rate limiting)

```bash
docker run --rm -it \
  -v C:\OC\deepclaude:/data/project \
  -v C:\OC\deepclaude\qodana-results:/data/results \
  jetbrains/qodana-js:2026.1
```

Then open the generated `qodana-results/report/index.html` in a browser. This bypasses WebStorm's rate-limited API server entirely.

### Option D: CI (GitHub Actions)

Add a Qodana workflow to `.github/workflows/qodana.yml` for per-PR reports in the cloud.

## What the Report Shows

- **Dashboard summary**: total problems (28), baseline count (0), inspection count (120), license audit, code coverage
- **Problems list**: grouped by file, filterable by severity/category/type
- **Severity levels**: High (23), Moderate (5)
- **Categories**: Unused symbols, Try statement issues, TypeScript, General, Validity issues, Async code and promises, Duplicate declarations

## Configuration

The analysis is configured in `qodana.yaml` at the project root:
- **Profile**: `qodana.starter` (120 inspections)
- **Linter**: `jetbrains/qodana-js:2026.1`

## Troubleshooting

- **429 Too Many Requests**: The browser-based Qodana UI fires ~15 parallel API calls at once, and WebStorm's built-in server rate-limits them. **_Reload the page_** — the second load almost always succeeds because the server has warmed up. Alternatively, use Option A (IDE tool window) or Option C (Docker) to avoid the issue entirely.
- **404 on API endpoints**: The server session may have expired. Re-open the report from WebStorm's Qodana tool window.
- **"0 folders, 0 files with problems"**: All data files failed to load (check console for 429/404 errors). Reload the page.
- **Server not running on port 63342**: Ensure WebStorm is open with the Qodana plugin enabled. The server only runs while the IDE is open.
- **Dashboard embedded JS false positives**: Qodana reports ~14 "unused" symbols in `dashboard.ts`. These are false positives — the JS is embedded via a template literal and Qodana can't trace identifiers across the interpolation boundary. All symbols are used at runtime in the browser.
