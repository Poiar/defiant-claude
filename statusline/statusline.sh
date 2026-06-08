#!/usr/bin/env bash
input=$(cat)
cwd=$(echo "$input" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d?.workspace?.current_dir||d?.cwd||'')" 2>/dev/null)
branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)

DEEPCLAUDE_DIR="${HOME}/.deepclaude"
[[ -n "${USERPROFILE:-}" ]] && DEEPCLAUDE_DIR="${USERPROFILE}/.deepclaude"

# Circuit breaker health indicator
CB_STATE=""
PROXY_FILE="$DEEPCLAUDE_DIR/proxy.json"
if [[ -f "$PROXY_FILE" ]]; then
  PROXY_PORT=$(node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.port||''))" < "$PROXY_FILE" 2>/dev/null)
  if [[ -n "$PROXY_PORT" ]] && command -v curl &>/dev/null; then
    CB_STATE=$(curl -s --max-time 1 "http://127.0.0.1:$PROXY_PORT/health" 2>/dev/null | node -e "
      const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      let ws = 'CLOSED', hd = false;
      for (const v of Object.values(d.providers || {})) {
        if (v.requests > 0) hd = true;
        if (v.circuitBreaker === 'OPEN') { ws = 'OPEN'; break; }
        if (v.circuitBreaker === 'HALF_OPEN' && ws !== 'OPEN') ws = 'HALF_OPEN';
      }
      process.stdout.write(hd ? ws : '');
    " 2>/dev/null)
  fi
fi

echo "$input" | CB_STATE="$CB_STATE" OVERRIDES_FILE="$DEEPCLAUDE_DIR/slot-overrides.json" ROUTES_FILE="$DEEPCLAUDE_DIR/current-routes.json" GIT_BRANCH="$branch" node -e "
const path = require('path');
const fs   = require('fs');
const d    = JSON.parse(require('fs').readFileSync(0, 'utf8'));

const fg    = (r,g,b) => '\x1b[38;2;'+r+';'+g+';'+b+'m';
const reset = '\x1b[0m';
const bold  = '\x1b[1m';
const dim   = '\x1b[2m';

const cwd    = d?.workspace?.current_dir || d?.cwd || '';
const sep    = cwd.includes('\\') ? '\\' : '/';
const dir    = cwd.split(sep).filter(Boolean).pop() || '';
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
    // Slot override takes highest priority
    model = overrides[slot] || fallback;
    // Check dedicated subagent model when no override and slot is subagent
    if (!overrides[slot] && (slot === 'sub' || slot === 'subagent')) {
      try {
        const subModelFile = (process.env.USERPROFILE || require('os').homedir()) + '/.deepclaude/subagent-model.json';
        const subData = JSON.parse(fs.readFileSync(subModelFile, 'utf8'));
        if (subData.providerKey && subData.modelId) {
          model = subData.providerKey + ':' + subData.modelId;
        }
      } catch(e) {}
    }
  }
} catch(e) {}

// Resolve slot + providerKey for display
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

// Circuit breaker indicator
const cbIndicator = (() => {
  const s = process.env.CB_STATE;
  if (s === 'OPEN') return bold + fg(255,80,80) + '✕' + reset;
  if (s === 'HALF_OPEN') return bold + fg(255,180,50) + '◐' + reset;
  if (s === 'CLOSED') return bold + fg(80,200,120) + '·' + reset;
  return '';
})();

const locationGroup = [
  dir    ? bold + fg(100,180,255) + dir    + reset : '',
  branch ? bold + fg(255,80,180)  + branch + reset : '',
].filter(Boolean).join(narrow);

const modelGroup = [
  (slotLabel || model) ? bold + fg(200,100,255) + slotLabel + modelKey + reset : '',
  effort ? bold + effortColor + effort + reset : '',
  cbIndicator,
].filter(Boolean).join(narrow);

const ctxGroup = ctxStr ? bold + ctxColor + ctxStr + reset : '';

let spendTotal = null;
try {
  const spendDir = process.env.USERPROFILE ? process.env.USERPROFILE + '/.deepclaude' : require('os').homedir() + '/.deepclaude';
  const spendData = JSON.parse(fs.readFileSync(spendDir + '/spend.json', 'utf8'));
  if (spendData.total > 0) spendTotal = spendData.total;
} catch(e) {}
const spendGroup = spendTotal ? bold + fg(80,200,120) + '$' + Number(spendTotal).toFixed(4) + reset : '';

console.log([locationGroup, modelGroup, ctxGroup, spendGroup].filter(Boolean).join(wide));
" 2>/dev/null
