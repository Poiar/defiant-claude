---
name: qodana-report
description: Use this skill when the user asks about the Qodana code analysis report, Qodana issues, or how to access/inspect the Qodana results for this project.
---

The Qodana report surfaces static analysis issues (unused symbols, duplicate declarations, try/catch abuse, readonly fields, etc.) across the codebase.

## How to Access the Report

### Step 1: Ensure the Qodana server is running

The report is served by a local dev server on port 63342. If it isn't running, start it:

```bash
docker run --rm -it -p 8080:8080 \
  -v C:\OC\deepclaude:/data/project \
  -v C:\OC\deepclaude\qodana:/data/results \
  jetbrains/qodana-js:2026.1
```

After the Docker run completes, the results land in `qodana/` under the project root.

### Step 2: Open the report

Navigate to:

```
http://localhost:63342/qodana.ide/idea.html?projectKey=d3ba4650b7715fd1a93c3c273f4cb326&_qdt=6033ddae-4b83-44e8-b35d-4326f24cad18&theme=dark
```

> **Note:** The `projectKey` and `_qdt` params are session-specific. Save the URL from the Qodana launch output or from a previous session.

### If the server isn't running

Ask the user to restart it with the Docker command above, or check if the Qodana results are open in their IDE (the IntelliJ/JetBrains Qodana plugin serves the report on port 63342).

## What the Report Shows

- **Dashboard summary**: total problems, baseline count, inspection count, license audit, code coverage
- **Problems list**: grouped by file, filterable by severity/category/type
- **Severity levels**: High, Moderate, Generic
- **Categories**: Unused symbols, Try statement issues, TypeScript, General, Validity issues, Async code and promises, Duplicate declarations

## Configuration

The analysis is configured in `qodana.yaml` at the project root:
- **Profile**: `qodana.starter` (120 inspections)
- **Linter**: `jetbrains/qodana-js:2026.1`

## Troubleshooting

- **429 Too Many Requests**: The Qodana UI fires many parallel API calls. If you see "Failed to request data", reload the page — the second load usually succeeds as the server settles.
- **404 on API endpoints**: The server may be serving stale results. Re-run the Docker analysis to regenerate the report data.
- **"0 folders, 0 files"**: Means the data files failed to load (check console for 429/404 errors). Reload.
