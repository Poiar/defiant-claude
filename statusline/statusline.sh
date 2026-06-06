#!/usr/bin/env bash
input=$(cat)
cwd=$(echo "$input" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d?.workspace?.current_dir||d?.cwd||'')" 2>/dev/null)
branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)

echo "$input" | OVERRIDES_FILE="$USERPROFILE/.deepclaude/slot-overrides.json" ROUTES_FILE="$USERPROFILE/.deepclaude/current-routes.json" GIT_BRANCH="$branch" node -e "
const path = require('path');
const fs   = require('fs');
const d    = JSON.parse(require('fs').readFileSync(0, 'utf8'));

const fg    = (r,g,b) => '\x1b[38;2;'+r+';'+g+';'+b+'m';
const reset = '\x1b[0m';
const bold  = '\x1b[1m';
const dim   = '\x1b[2m';

const cwd    = d?.workspace?.current_dir || d?.cwd || '';
const dir    = path.win32.basename(cwd) || path.posix.basename(cwd) || '';
const branch = process.env.GIT_BRANCH || '';
let   model     = d?.model?.id || d?.model?.display_name || '';
const effort    = d?.effort?.level || '';
let   slotLabel = '';

// Check slot overrides — resolve actual model BEFORE token lookup.
try {
  const overrides = JSON.parse(fs.readFileSync(process.env.OVERRIDES_FILE, 'utf8'));
  const slotMatch = model && model.match(/^(sonnet|opus|haiku|sub):(.+)$/);
  if (slotMatch) {
    const slot = slotMatch[1];
    const fallback = slotMatch[2];
    const slotAbbr = { opus: 'o', sonnet: 's', haiku: 'h', subagent: 'sub' }[slot] || slot;
    slotLabel = slotAbbr + ' ';
    model = overrides[slot] || fallback;
  }
} catch(e) {}

// Strip providerKey: prefix for token lookup (modelKey is used for display)
const modelKey = model;
const modelLookup = modelKey.replace(/^[a-z][a-z0-9_-]*:/, '');

const tokens = d?.context_window?.total_input_tokens;
let ctxMap = {};
try {
  const routes = JSON.parse(fs.readFileSync(process.env.ROUTES_FILE, 'utf8'));
  if (routes.contextLimits) { ctxMap = routes.contextLimits; }
} catch(e) {}
const maxTokens = d?.context_window?.max_input_tokens || ctxMap[modelLookup];
const tokStr = tokens != null ? (tokens >= 1000 ? Math.round(tokens/1000)+'k' : ''+tokens) : '';
let pct = null;
if (tokens != null && maxTokens != null && maxTokens > 0) {
  pct = Math.round((tokens / maxTokens) * 100);
}
const ctxStr = tokStr + (tokStr && pct != null ? '/' + pct + '%' : (pct != null ? pct + '%' : ''));

const effortColor = effort === 'high' ? fg(255,80,80) : effort === 'medium' ? fg(255,180,50) : fg(100,160,255);
const ctxColor    = (pct != null && pct >= 80) ? fg(255,80,80) : (pct != null && pct >= 50) ? fg(255,180,50) : fg(80,200,120);

const narrow = '  ';
const wide   = '     ';

const locationGroup = [
  dir    ? bold + fg(100,180,255) + dir    + reset : '',
  branch ? bold + fg(255,80,180)  + branch + reset : '',
].filter(Boolean).join(narrow);

const modelGroup = [
  (slotLabel || model) ? bold + fg(200,100,255) + slotLabel + modelKey + reset : '',
  effort ? bold + effortColor + effort + reset : '',
].filter(Boolean).join(narrow);

const ctxGroup = ctxStr ? bold + ctxColor + ctxStr + reset : '';

console.log([locationGroup, modelGroup, ctxGroup].filter(Boolean).join(wide));
" 2>/dev/null
