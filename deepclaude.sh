#!/usr/bin/env bash
# deepclaude — Use Claude Code with cheap backends. Provider-agnostic: mix models from different APIs in one config.
# Usage: deepclaude [spec1] [spec2] [spec3] [spec4] [spec5]   (positional mode)
#        deepclaude [-b backend] [--status] [--doctor] [--version]
#
# Named configs (via -b):
#   deepclaude                  # ds (default) — DeepSeek V4 Pro
#   deepclaude -b or            # OpenRouter (DeepSeek)
#   deepclaude -b fw            # Fireworks AI
#   deepclaude -b oc            # OpenCode Zen
#   deepclaude -b ds+oc         # DeepSeek main + OpenCode subs
#   deepclaude -b anthropic     # Normal Claude Code
#
# Model aliases: sonnet, opus, haiku, v4, flash (short names resolve to full model IDs)
# Ad-hoc positional: providerKey:modelId for opus sonnet haiku subagent
#   deepclaude ds:deepseek-v4-pro                                              # 1 spec -> all slots
#   deepclaude ds:deepseek-v4-pro oc:big-pickle                                # 2 specs -> first half / second half
#   deepclaude ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free       # 3 specs -> last repeats
#   deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free  # 4 specs -> direct

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEEPCLAUDE_DIR="${HOME}/.deepclaude"
PROXY_STATE_FILE="${DEEPCLAUDE_DIR}/proxy.json"
CURRENT_ROUTES_FILE="${DEEPCLAUDE_DIR}/current-routes.json"
SLOT_OVERRIDES_FILE="${DEEPCLAUDE_DIR}/slot-overrides.json"
SUBMODEL_FILE="${DEEPCLAUDE_DIR}/subagent-model.json"

# --- API Keys ---
DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
OPENROUTER_KEY="${OPENROUTER_API_KEY:-}"
FIREWORKS_KEY="${FIREWORKS_API_KEY:-}"
OPENCODE_KEY="${OPENCODE_API_KEY:-}"
ALIBABA_KEY="${ALIBABA_DASHSCOPE_API_KEY:-}"
KIMI_KEY="${KIMI_API_KEY:-}"
MIMO_KEY="${MIMO_API_KEY:-}"
UMANS_KEY="${UMANS_API_KEY:-}"
GROQ_KEY="${GROQ_API_KEY:-}"
MISTRAL_KEY="${MISTRAL_API_KEY:-}"
MINIMAX_KEY="${MINIMAX_API_KEY:-}"
ZAI_KEY="${ZAI_API_KEY:-}"
BYTEPLUS_KEY="${BYTEPLUS_API_KEY:-}"
SILICONFLOW_KEY="${SILICONFLOW_API_KEY:-}"
NOVITA_KEY="${NOVITA_API_KEY:-}"

# --- Provider Registry (loaded from providers.json) ---
REGISTRY_FILE="${SCRIPT_DIR}/proxy/providers.json"

declare -A PROVIDER_URL PROVIDER_AUTH PROVIDER_KEYNAME PROVIDER_NAME
declare -A PROVIDER_FORMAT PROVIDER_FALLBACK PROVIDER_SETUP_URL

if ! command -v jq &>/dev/null; then
    echo "ERROR: deepclaude requires jq for JSON processing." >&2
    echo "  Install: brew install jq  (macOS)" >&2
    echo "       or: sudo apt install jq  (Debian/Ubuntu)" >&2
    echo "       or: sudo dnf install jq  (Fedora)" >&2
    exit 1
fi

if [[ ! -f "$REGISTRY_FILE" ]] || ! jq empty "$REGISTRY_FILE" 2>/dev/null; then
    echo "ERROR: providers.json is missing or invalid" >&2
    echo "  Expected at: $REGISTRY_FILE" >&2
    echo "  Ensure the deepclaude repository is complete and the file contains valid JSON." >&2
    exit 1
fi

while IFS=$'\t' read -r pk name url auth keyname format fallback setup_url; do
    PROVIDER_NAME[$pk]="$name"
    PROVIDER_URL[$pk]="$url"
    PROVIDER_AUTH[$pk]="$auth"
    PROVIDER_KEYNAME[$pk]="$keyname"
    PROVIDER_FORMAT[$pk]="$format"
    [[ -n "$fallback" && "$fallback" != "null" ]] && PROVIDER_FALLBACK[$pk]="$fallback"
    [[ -n "$setup_url" && "$setup_url" != "null" ]] && PROVIDER_SETUP_URL[$pk]="$setup_url"
done < <(jq -r '.providers | to_entries[] | [.key, .value.displayName, .value.endpoint, .value.authHeader, .value.keyEnv, .value.wireFormat, (.value.fallback // [] | join(",")), (.value.setupUrl // "")] | @tsv' "$REGISTRY_FILE")

# Anthropic pseudo-provider (not in providers.json — used for --backend anthropic)
PROVIDER_FORMAT[an]="anthropic"

# --- Per-model context window limits (tokens, from providers.json) ---
declare -A MODEL_CTX
while IFS=$'\t' read -r model limit; do
    MODEL_CTX["$model"]="$limit"
done < <(jq -r '.contextLimits | to_entries[] | [.key, .value] | @tsv' "$REGISTRY_FILE")

# --- Per-model compaction window (tokens, from providers.json) ---
# If a model has a compactionWindow, it overrides the auto-calculated value from
# contextLimits. DeepSeek models push near the wall — compaction rewrites history,
# invalidating the disk cache prefix (cache miss = 50× more expensive).
declare -A COMPACTION_WINDOW
if jq -e '.compactionWindow' "$REGISTRY_FILE" > /dev/null 2>&1; then
    while IFS=$'\t' read -r model limit; do
        [[ "$model" == _* ]] && continue
        COMPACTION_WINDOW["$model"]="$limit"
    done < <(jq -r '.compactionWindow | to_entries[] | [.key, .value] | @tsv' "$REGISTRY_FILE")
fi

get_provider_key() {
    local pk="$1"
    case "$pk" in
        ds) echo "$DEEPSEEK_KEY" ;;
        or) echo "$OPENROUTER_KEY" ;;
        fw) echo "$FIREWORKS_KEY" ;;
        oc) echo "$OPENCODE_KEY" ;;
        al) echo "$ALIBABA_KEY" ;;
        km) echo "$KIMI_KEY" ;;
        mm) echo "$MIMO_KEY" ;;
        um) echo "$UMANS_KEY" ;;
        gr) echo "$GROQ_KEY" ;;
        mt) echo "$MISTRAL_KEY" ;;
        mx) echo "$MINIMAX_KEY" ;;
        za) echo "$ZAI_KEY" ;;
        bp) echo "$BYTEPLUS_KEY" ;;
        sf) echo "$SILICONFLOW_KEY" ;;
        nv) echo "$NOVITA_KEY" ;;
        *)  echo "" ;;
    esac
}

mask_key() {
    local k="$1"
    if [[ -z "$k" ]]; then echo "MISSING"; else echo "set (****${k: -4})"; fi
}

# --- Atomic file write ---
write_atomic() {
    local path="$1" content="$2"
    local tmp="${path}.tmp"
    local lock="${path}.lock"
    # Advisory file lock: retry up to 10 times (50ms each) if another
    # session is writing this state file. Stale locks (dead PID) are broken.
    local retry=0
    while [[ $retry -lt 10 ]]; do
        if [[ -f "$lock" ]]; then
            local lock_pid=$(grep -oP 'pid=\K\d+' "$lock" 2>/dev/null || echo "0")
            if [[ "$lock_pid" -gt 0 ]] && kill -0 "$lock_pid" 2>/dev/null; then
                sleep 0.05; retry=$((retry + 1)); continue
            fi
            rm -f "$lock" 2>/dev/null
        fi
        printf 'pid=%s\nts=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock"
        break
    done
    printf '%s' "$content" > "$tmp"
    rm -f "$path"
    mv "$tmp" "$path"
    rm -f "$lock" 2>/dev/null
    chmod 600 "$path" 2>/dev/null || true
}

# --- Persistent proxy state management ---
get_proxy_state() {
    if [[ ! -f "$PROXY_STATE_FILE" ]]; then return 1; fi
    local pid port
    pid=$(jq -r '.pid' "$PROXY_STATE_FILE" 2>/dev/null) || return 1
    port=$(jq -r '.port' "$PROXY_STATE_FILE" 2>/dev/null) || return 1
    # Check if process is alive
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PROXY_STATE_FILE"
        return 1
    fi
    # Check if port is listening
    if ! command -v nc &>/dev/null || ! nc -z 127.0.0.1 "$port" 2>/dev/null; then
        if ! (command -v bash && echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
            rm -f "$PROXY_STATE_FILE"
            return 1
        fi
    fi
    echo "$pid" "$port"
    return 0
}

save_proxy_state() {
    local pid="$1" port="$2" routes_file="$3"
    mkdir -p -m 700 "$DEEPCLAUDE_DIR"
    local state
    state=$(jq -n --arg pid "$pid" --arg port "$port" --arg routes "$routes_file" \
        --arg started "$(date -Iseconds)" \
        '{pid: ($pid | tonumber), port: ($port | tonumber), routesFile: $routes, startedAt: $started}')
    write_atomic "$PROXY_STATE_FILE" "$state"
}

clear_proxy_state() {
    rm -f "$PROXY_STATE_FILE"
}

# --- Slot overrides ---
init_slot_overrides() {
    local opus_prov="$1" opus_model="$2" sonnet_prov="$3" sonnet_model="$4"
    local haiku_prov="$5" haiku_model="$6" subagent_prov="$7" subagent_model="$8" fable_prov="${9:-}" fable_model="${10:-}"

    mkdir -p -m 700 "$DEEPCLAUDE_DIR"

    # Build defaults
    local defaults
    defaults=$(jq -n \
        --arg opus "${opus_prov}:${opus_model}" \
        --arg sonnet "${sonnet_prov}:${sonnet_model}" \
        --arg haiku "${haiku_prov}:${haiku_model}" \
        --arg subagent "${subagent_prov}:${subagent_model}" \
        --arg fable "${fable_prov}:${fable_model}" \
        '{opus: $opus, sonnet: $sonnet, haiku: $haiku, subagent: $subagent, fable: $fable}')

    local merged
    if [[ -f "$SLOT_OVERRIDES_FILE" ]]; then
        # Merge: existing user overrides win over new defaults
        local existing
        existing=$(cat "$SLOT_OVERRIDES_FILE")
        merged=$(echo "$existing" | jq --argjson defaults "$defaults" '
            ._defaults = $defaults
        ')
    else
        merged=$(echo '{}' | jq --argjson defaults "$defaults" '
            ._defaults = $defaults
        ')
    fi

    echo "$merged" | jq -c '.' > "$SLOT_OVERRIDES_FILE"
}

get_slot_model() {
    local slot="$1" fallback="$2"
    if [[ -f "$SLOT_OVERRIDES_FILE" ]]; then
        local val
        val=$(jq -r --arg s "$slot" '.[$s] // ._defaults[$s] // empty' "$SLOT_OVERRIDES_FILE" 2>/dev/null)
        if [[ -n "$val" ]]; then echo "$val"; return 0; fi
    fi
    echo "$fallback"
}

# --- Config resolution (from providers.json) ---
declare -A CONFIG_NAME CONFIG_OPUS CONFIG_SONNET CONFIG_HAIKU CONFIG_SUBAGENT CONFIG_FABLE

init_configs() {
    while IFS=$'\t' read -r cfg name opus sonnet haiku sub fable; do
        CONFIG_NAME[$cfg]="$name"
        CONFIG_OPUS[$cfg]="$opus"
        CONFIG_SONNET[$cfg]="$sonnet"
        CONFIG_HAIKU[$cfg]="$haiku"
        CONFIG_SUBAGENT[$cfg]="$sub"
        CONFIG_FABLE[$cfg]="${fable:-$opus}"
    done < <(jq -r '.configs | to_entries[] | [.key, .value.name, .value.opus, .value.sonnet, .value.haiku, .value.sub, .value.fable] | @tsv' "$REGISTRY_FILE")
}
init_configs

# --- Pre-flight checks ---
if ! command -v nc &>/dev/null; then
    echo "NOTE: nc (netcat) not found. Port checking may be less reliable." >&2
    echo "  Install: brew install netcat  (macOS)  or  sudo apt install netcat-openbsd" >&2
fi

# Resolve a spec "providerKey:modelId" into provider key and model
parse_spec() {
    local spec="$1"
    if [[ "$spec" =~ ^([a-z][a-z0-9_-]*):(.+)$ ]]; then
        echo "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    else
        echo "ERROR: Invalid model spec '$spec': expected providerKey:modelId (e.g. ds:deepseek-v4-pro)" >&2
        exit 1
    fi
}

# Build ad-hoc config from 1-4 spec strings
build_adhoc_config() {
    local specs=("$@")
    local spec_count=${#specs[@]}
    local slots=(opus sonnet haiku subagent fable)
    # Output: config_name, then for each slot: provider model
    local name_parts=()

    echo "Ad-hoc"

    for i in 0 1 2 3 4; do
        local idx
        case "$spec_count" in
            1) idx=0 ;;
            2) if [[ $i -lt 3 ]]; then idx=0; else idx=1; fi ;;
            3) if [[ $i -eq 0 ]]; then idx=0; elif [[ $i -le 2 ]]; then idx=1; else idx=2; fi ;;
            4) if [[ $i -lt 3 ]]; then idx=$i; else idx=3; fi ;;
            *) idx=$i ;;
        esac
        local spec="${specs[$idx]}"
        local prov_key model_id
        read -r prov_key model_id <<< "$(parse_spec "$spec")"

        local key
        key=$(get_provider_key "$prov_key")
        if [[ -z "$key" ]]; then
            echo "ERROR: ${PROVIDER_KEYNAME[$prov_key]} not set (needed for spec '$spec')" >&2
            if [[ -n "${PROVIDER_SETUP_URL[$prov_key]:-}" ]]; then
                echo "  Get a key: ${PROVIDER_SETUP_URL[$prov_key]}" >&2
            fi
            echo "  Then run: export ${PROVIDER_KEYNAME[$prov_key]}=\"sk-...\"" >&2
            exit 1
        fi

        echo "${slots[$i]}" "$prov_key" "$model_id"
        name_parts+=("$model_id (${PROVIDER_NAME[$prov_key]})")
    done
}

# Resolve a named config
resolve_config() {
    local config_name="$1"
    if [[ -z "${CONFIG_NAME[$config_name]:-}" ]]; then
        echo "ERROR: Unknown config '$config_name'. Known: ${!CONFIG_NAME[*]}" >&2
        exit 1
    fi

    echo "${CONFIG_NAME[$config_name]}"

    for slot in opus sonnet haiku subagent fable; do
        local var="CONFIG_${slot^^}[$config_name]"
        local val="${!var}"
        local prov_key model_id
        read -r prov_key model_id <<< "$(parse_spec "$val")"

        local key
        key=$(get_provider_key "$prov_key")
        if [[ -z "$key" ]]; then
            echo "ERROR: ${PROVIDER_KEYNAME[$prov_key]} not set (needed by config '$config_name')" >&2
            if [[ -n "${PROVIDER_SETUP_URL[$prov_key]:-}" ]]; then
                echo "  Get a key: ${PROVIDER_SETUP_URL[$prov_key]}" >&2
            fi
            echo "  Then run: export ${PROVIDER_KEYNAME[$prov_key]}=\"sk-...\"" >&2
            exit 1
        fi

        echo "$slot" "$prov_key" "$model_id"
    done
}

# --- Build routes JSON for multi-provider proxy ---
build_routes_json() {
    # Reads slot/provider/model lines from stdin, outputs JSON to stdout
    local slots_json routes_json providers_json default_provider
    slots_json="{}"
    routes_json="{}"
    providers_json="{}"
    default_provider=""

    while IFS=' ' read -r slot prov_key model_id; do
        if [[ -z "$default_provider" ]]; then
            default_provider="$prov_key"
        fi

        # Slot entry
        slots_json=$(echo "$slots_json" | jq --arg s "$slot" --arg v "${slot}:${prov_key}:${model_id}" '.[$s] = $v')

        # Route entry
        routes_json=$(echo "$routes_json" | jq --arg m "$model_id" --arg p "$prov_key" \
            '.[$m] = {provider: $p, rewrite: $m}')

        # Provider entry (deduplicated by key)
        if ! echo "$providers_json" | jq -e --arg pk "$prov_key" '.[$pk]' > /dev/null 2>&1; then
            providers_json=$(echo "$providers_json" | jq --arg pk "$prov_key" \
                --arg url "${PROVIDER_URL[$prov_key]}" \
                --arg keyEnv "${PROVIDER_KEYNAME[$prov_key]}" \
                --arg auth "${PROVIDER_AUTH[$prov_key]}" \
                --arg format "${PROVIDER_FORMAT[$prov_key]:-anthropic}" \
                --arg fb "${PROVIDER_FALLBACK[$prov_key]:-}" \
                '.[$pk] = {url: $url, keyEnv: $keyEnv, auth: $auth, format: $format, fallback: ($fb | if . == "" then [] else split(",") end)}')
        fi
    done

    # Include ALL models from ALL configs that have valid keys (for /model switching)
    for cfg in "${!CONFIG_NAME[@]}"; do
        for slot in opus sonnet haiku subagent fable; do
            local var="CONFIG_${slot^^}[$cfg]"
            local val="${!var}"
            local pk mid
            read -r pk mid <<< "$(parse_spec "$val")"
            local key
            key=$(get_provider_key "$pk")
            if [[ -n "$key" ]]; then
                if ! echo "$routes_json" | jq -e --arg m "$mid" '.[$m]' > /dev/null 2>&1; then
                    routes_json=$(echo "$routes_json" | jq --arg m "$mid" --arg p "$pk" \
                        '.[$m] = {provider: $p, rewrite: $m}')
                fi
                if ! echo "$providers_json" | jq -e --arg pk "$pk" '.[$pk]' > /dev/null 2>&1; then
                    providers_json=$(echo "$providers_json" | jq --arg pk "$pk" \
                        --arg url "${PROVIDER_URL[$pk]}" \
                        --arg keyEnv "${PROVIDER_KEYNAME[$pk]}" \
                        --arg auth "${PROVIDER_AUTH[$pk]}" \
                        --arg format "${PROVIDER_FORMAT[$pk]:-anthropic}" \
                        --arg fb "${PROVIDER_FALLBACK[$pk]:-}" \
                        '.[$pk] = {url: $url, keyEnv: $keyEnv, auth: $auth, format: $format, fallback: ($fb | if . == "" then [] else split(",") end)}')
                fi
            fi
        done
    done

    # Build context limits JSON
    local ctx_json="{}"
    for model in "${!MODEL_CTX[@]}"; do
        ctx_json=$(echo "$ctx_json" | jq --arg m "$model" --arg c "${MODEL_CTX[$model]}" '.[$m] = ($c | tonumber)')
    done

    jq -n \
        --argjson slots "$slots_json" \
        --argjson routes "$routes_json" \
        --argjson providers "$providers_json" \
        --arg default "$default_provider" \
        --argjson contextLimits "$ctx_json" \
        '{slots: $slots, routes: $routes, providers: $providers, defaultProvider: $default, contextLimits: $contextLimits}'
}

# --- Start the HTTP routing proxy ---
start_proxy() {
    local routes_file="$1"
    local proxy_script="${SCRIPT_DIR}/proxy/start-proxy.ts"

    if [[ ! -f "$proxy_script" ]]; then
        echo "ERROR: Proxy script not found at $proxy_script" >&2
        exit 1
    fi

    if ! command -v node &>/dev/null; then
        echo "ERROR: Node.js is not installed or not in PATH. Install from https://nodejs.org" >&2
        exit 1
    fi

    local out_file err_file
    out_file=$(mktemp "${TMPDIR:-/tmp}/deepclaude.XXXXXX")
    err_file=$(mktemp "${TMPDIR:-/tmp}/deepclaude.XXXXXX")

    local tsx_bin="${SCRIPT_DIR}/node_modules/.bin/tsx"
    if [[ ! -x "$tsx_bin" ]]; then
        echo "ERROR: Dependencies not installed. Run 'npm install' in ${SCRIPT_DIR} first." >&2
        exit 1
    fi
    "$tsx_bin" "$proxy_script" --routes "$routes_file" --overrides "$SLOT_OVERRIDES_FILE" \
        > "$out_file" 2> "$err_file" &
    local proxy_pid=$!

    # Wait for port output
    echo -n "Starting proxy" >&2
    local tries=0 port=""
    while [[ $tries -lt 150 ]]; do
        echo -n "." >&2
        if [[ -s "$out_file" ]]; then
            port=$(sed -n 's/.*PORT:\([0-9]*\).*/\1/p' "$out_file" 2>/dev/null || true)
            if [[ -n "$port" ]]; then break; fi
        fi
        sleep 0.1
        tries=$((tries + 1))
    done
    echo "" >&2

    if [[ -z "$port" ]]; then
        local err_str
        err_str=$(cat "$err_file" 2>/dev/null || true)
        if kill -0 "$proxy_pid" 2>/dev/null; then kill "$proxy_pid" 2>/dev/null || true; fi
        rm -f "$out_file" "$err_file"
        echo "ERROR: Proxy failed to start. Stderr: $err_str" >&2
        exit 1
    fi

    rm -f "$out_file" "$err_file"
    echo "$port $proxy_pid"
}

stop_proxy_info() {
    local pid="$1"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
    fi
    if [[ -n "${watchdog_pid:-}" ]] && kill -0 "$watchdog_pid" 2>/dev/null; then
        kill "$watchdog_pid" 2>/dev/null || true
    fi
    clear_proxy_state
}

# --- Set CC environment variables ---
set_cc_env() {
    local proxy_port="$1" opus_model="$2" sonnet_model="$3" haiku_model="$4" subagent_model="$5" fable_model="$6"
    local opus_ctxt_model="$7"  # model ID for context limit lookup

    export ANTHROPIC_BASE_URL="http://127.0.0.1:${proxy_port}"
    export ANTHROPIC_AUTH_TOKEN="proxy"
    export ANTHROPIC_MODEL="opus:${opus_model}"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="opus:${opus_model}"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="sonnet:${sonnet_model}"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="haiku:${haiku_model}"
    export ANTHROPIC_DEFAULT_FABLE_MODEL="fable:${fable_model}"
    export CLAUDE_CODE_SUBAGENT_MODEL="subagent:${subagent_model}"
    export CLAUDE_CODE_EFFORT_LEVEL="$EFFORT"
    unset ANTHROPIC_API_KEY 2>/dev/null || true

    local opus_ctx="${COMPACTION_WINDOW[$opus_ctxt_model]:-}"
    if [[ -n "$opus_ctx" ]]; then
        # Per-model compaction window (from compactionWindow in providers.json)
        if (( opus_ctx >= 1000000 )); then
            export CLAUDE_CODE_AUTO_COMPACT_WINDOW="1000000"
        else
            export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$opus_ctx"
        fi
    else
        # Fall back to full context limit (pre-compactionWindow behavior)
        local opus_ctx_fallback="${MODEL_CTX[$opus_ctxt_model]:-}"
        if [[ -n "$opus_ctx_fallback" ]]; then
            if (( opus_ctx_fallback >= 1048576 )); then
                export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$opus_ctx_fallback"
            elif (( opus_ctx_fallback >= 200000 )); then
                export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$opus_ctx_fallback"
                export DISABLE_COMPACT="1"
            elif (( opus_ctx_fallback > 131072 )); then
                export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$opus_ctx_fallback"
                export DISABLE_COMPACT="1"
            else
                export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$opus_ctx_fallback"
            fi
        fi
    fi

    export CLAUDE_CONTEXT_COMPRESSION='true'
}

clear_anthropic_env() {
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL \
          ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
          ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_FABLE_MODEL \
          CLAUDE_CODE_SUBAGENT_MODEL \
          CLAUDE_CODE_EFFORT_LEVEL ANTHROPIC_API_KEY \
          CLAUDE_CODE_MAX_CONTEXT_TOKENS DISABLE_COMPACT \
          CLAUDE_CODE_AUTO_COMPACT_WINDOW \
          CLAUDE_CONTEXT_COMPRESSION 2>/dev/null || true
}

# --- Actions ---
show_status() {
    echo ""
    echo "  deepclaude - Backend Status"
    echo "  ============================"
    echo ""
    echo "  Keys:"
    echo "    DEEPSEEK_API_KEY:             $(mask_key "$DEEPSEEK_KEY")"
    echo "    OPENROUTER_API_KEY:           $(mask_key "$OPENROUTER_KEY")"
    echo "    FIREWORKS_API_KEY:            $(mask_key "$FIREWORKS_KEY")"
    echo "    OPENCODE_API_KEY:             $(mask_key "$OPENCODE_KEY")"
    echo "    ALIBABA_DASHSCOPE_API_KEY:    $(mask_key "$ALIBABA_KEY")"
    echo "    KIMI_API_KEY:                 $(mask_key "$KIMI_KEY")"
    echo "    MIMO_API_KEY:                 $(mask_key "$MIMO_KEY")"
    echo "    UMANS_API_KEY:                $(mask_key "$UMANS_KEY")"
    echo "    GROQ_API_KEY:                 $(mask_key "$GROQ_KEY")"
    echo "    MISTRAL_API_KEY:              $(mask_key "$MISTRAL_KEY")"
    echo "    MINIMAX_API_KEY:              $(mask_key "$MINIMAX_KEY")"
    echo "    ZAI_API_KEY:                  $(mask_key "$ZAI_KEY")"
    echo "    BYTEPLUS_API_KEY:             $(mask_key "$BYTEPLUS_KEY")"
    echo "    SILICONFLOW_API_KEY:          $(mask_key "$SILICONFLOW_KEY")"
    echo "    NOVITA_API_KEY:               $(mask_key "$NOVITA_KEY")"
    echo ""
    echo "  Configurations:"
    for cfg in ds or fw oc km mm um gr mt mx za bp sf nv "ds+oc"; do
        local label=""
        [[ "$cfg" == "ds" ]] && label=" (default)"
        local provs=()
        for slot in opus sonnet haiku subagent fable; do
            local var="CONFIG_${slot^^}[$cfg]"
            local val="${!var}"
            local pk="${val%%:*}"
            if [[ -n "$pk" ]] && [[ ! " ${provs[*]} " =~ " $pk " ]]; then
                provs+=("$pk")
            fi
        done
        local prov_names=""
        for pk in "${provs[@]}"; do
            [[ -n "$prov_names" ]] && prov_names+=" + "
            prov_names+="${PROVIDER_NAME[$pk]}"
        done
        printf "    %-10s %s%s  [%s]\n" "$cfg" "${CONFIG_NAME[$cfg]}" "$label" "$prov_names"
    done

    # Show active slot overrides
    if [[ -f "$SLOT_OVERRIDES_FILE" ]]; then
        echo ""
        echo "  Active slot mapping:"
        for slot in opus sonnet haiku subagent fable; do
            local val pk
            val=$(jq -r --arg s "$slot" '.[$s] // ._defaults[$s] // "—"' "$SLOT_OVERRIDES_FILE" 2>/dev/null)
            pk="${val%%:*}"
            local pname="${PROVIDER_NAME[$pk]:-}"
            if [[ -n "$pname" ]]; then
                printf "    %-10s %s  ->  %s\n" "$slot" "$val" "$pname"
            else
                printf "    %-10s %s\n" "$slot" "$val"
            fi
        done
        local custom
        custom=$(jq -r 'to_entries | map(select(.key != "_defaults")) | map(.key) | join(", ")' "$SLOT_OVERRIDES_FILE" 2>/dev/null)
        if [[ -n "$custom" ]]; then
            echo ""
            echo "  Custom overrides: $custom"
        fi
    fi

    # Show dedicated subagent model
    if [[ -f "$SUBMODEL_FILE" ]]; then
        local sub_prov sub_model sub_full
        sub_prov=$(jq -r '.providerKey // empty' "$SUBMODEL_FILE" 2>/dev/null)
        sub_model=$(jq -r '.modelId // empty' "$SUBMODEL_FILE" 2>/dev/null)
        if [[ -n "$sub_prov" && -n "$sub_model" ]]; then
            sub_full="${sub_prov}:${sub_model}"
            local sub_pname="${PROVIDER_NAME[$sub_prov]:-}"
            echo ""
            if [[ -n "$sub_pname" ]]; then
                echo "  Dedicated subagent model: $sub_full  ->  $sub_pname"
            else
                echo "  Dedicated subagent model: $sub_full"
            fi
        fi
    fi
    echo ""
}

show_cost() {
    echo ""
    echo "  Model Pricing (per million tokens)"
    echo "  ==================================="
    echo ""
    echo "  Model                                      Input/M    Output/M"
    echo "  ---------------                            --------   --------"
    while IFS=$'\t' read -r model inp out; do
        if [ "$inp" = "0" ]; then in_str="free"; else in_str=$(printf "\$%.2f" "$inp"); fi
        if [ "$out" = "0" ]; then out_str="free"; else out_str=$(printf "\$%.2f" "$out"); fi
        printf "  %-37s %-10s %s\n" "$model" "$in_str" "$out_str"
    done < <(jq -r '.pricing | to_entries[] | [.key, .value.input, .value.output] | @tsv' "$REGISTRY_FILE")
    echo ""
    echo "  Data sourced from proxy/providers.json pricing section. Cache-hit pricing varies by provider."
    echo ""
}

show_help() {
    echo "deepclaude - Claude Code with cheap backends (provider-agnostic)"
    echo ""
    echo "Usage: deepclaude [spec1] [spec2] [spec3] [spec4] [spec5]   (positional mode)"
    echo "       deepclaude [-b backend] [--status] [--doctor] [--version]"
    echo ""
    echo "  Each positional arg is providerKey:modelId, mapping to opus/sonnet/haiku/subagent/fable/fable."
    echo "  Model aliases: sonnet, opus, haiku, v4, flash, ... (short names resolve to full model IDs)"
    echo "  Fewer than 5 specs repeats the last one for remaining slots."
    echo ""
    echo "  Examples:"
    echo "    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free"
    echo "    deepclaude ds:deepseek-v4-pro oc:big-pickle    (opus/sonnet=DS, haiku/sub=OC)"
    echo "    deepclaude ds:deepseek-v4-pro                  (all slots use DS)"
    echo "    deepclaude -b ds+oc                            (named mixed config)"
    echo "    deepclaude -b or                               (named config)"
    echo ""
    echo "  Named configs: ds, or, fw, oc, km, mm, um, gr, mt, mx, za, bp, sf, nv, ds+oc, anthropic"
    echo "  --status        Show keys, configs, and active slot mapping"
    echo "  --doctor        System health check (prereqs, keys, proxy test)"
    echo "  --cost          Pricing comparison"
    echo "  --benchmark     Latency test across all configs"
    echo "  --models        List all available models (for use with /model in CC)"
    echo "  --effort LEVEL   Claude Code effort level (default: max)"
    echo "  --lint                 Lint with shellcheck"
  echo "  --lint-config          Validate providers.json configuration"
  echo "  --log-all              Log all requests to ~/.deepclaude/requests.log"
  echo "  --skip-startup-check   Skip the provider health check on proxy startup"
  echo "  --fix-av               Windows Defender exclusion reminder"
  echo "  --install-statusline   Auto-install statusline to ~/.claude/"
  echo "  --set-slot SLOT MODEL  Override a slot: opus/sonnet/haiku/subagent/fable/fable"
    echo "  --persist       Keep proxy running after CC exits"
    echo "  --remote              Browser-based remote control (starts proxy automatically)"
    echo "  --switch CONFIG  Switch active config of a running persistent proxy"
    echo "  --stop-proxy    Kill the persistent proxy"
    echo "  --probe [FILE]  Test each configured provider with a minimal prompt"
    echo "  --dry-run [FILE] Show resolved routing table without starting proxy"
    echo "  --dashboard     Start proxy and print health dashboard URL"
    echo "  --open          Open dashboard in browser (use with --dashboard)"
    echo "  --logs, --tail  Tail the proxy log (~/.deepclaude/proxy.log)"
    echo "  --health        Quick health check (one-line summary)"
    echo "  --version       Show version and script location"
    echo "  -h, --help      This help"
    echo ""
    echo "Session switching workflow:"
    echo "  1. deepclaude -b ds --persist     Start proxy + session, keep proxy alive"
    echo "  2. deepclaude --switch or         Switch proxy backend to OpenRouter"
    echo "  3. /model or:new-model            Switch opus within running session"
    echo "  4. deepclaude --set-slot haiku or:model  Override a single slot"
    echo "  5. deepclaude --stop-proxy        Kill the persistent proxy"
    echo ""
    echo "Note: --fix-av, --lint, and --install-statusline are platform-specific."
    echo "      --fix-av is Windows-only (PowerShell alternative to this script)."
    echo "      --lint runs shellcheck on this script (bash only)."
    echo ""
    echo "Model control:"
    echo "  --set-slot SLOT MODEL     Override a slot (opus/sonnet/haiku/subagent/fable/fable)"
    echo "  --subagent-model MODEL    Set dedicated subagent model (e.g. oc:big-pickle)"
    echo ""
}

show_version() {
    local mtime=""
    if [[ -f "$0" ]]; then
        mtime=$(date -r "$0" "+%Y-%m-%d %H:%M" 2>/dev/null || stat -c '%y' "$0" 2>/dev/null | cut -d. -f1 || echo "unknown")
    fi

    # Read version from package.json, fallback to hardcoded default.
    local version="v1.0.0"
    if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
        local pkg_ver
        pkg_ver=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${SCRIPT_DIR}/package.json" | cut -d'"' -f4 2>/dev/null)
        if [[ -n "$pkg_ver" ]]; then
            version="v${pkg_ver}"
        fi
    fi

    # Get short git hash from the repo directory.
    local git_hash="unknown"
    local hash
    hash=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
    if [[ -n "$hash" ]]; then
        git_hash="$hash"
    fi

    echo "deepclaude $version ($git_hash) ($mtime)"
    echo "Proxy: ${SCRIPT_DIR}/proxy/start-proxy.js"
}

show_models() {
    echo ""
    echo "  deepclaude - Available Models"
    echo "  ================================"
    echo ""

    declare -A by_provider
    for cfg in "${!CONFIG_NAME[@]}"; do
        for slot in opus sonnet haiku subagent fable; do
            local var="CONFIG_${slot^^}[$cfg]"
            local val="${!var}"
            local pk="${val%%:*}" mid="${val#*:}"
            by_provider["${pk}:${mid}"]=1
        done
    done

    # Group by provider (dynamically from registry)
    for pk in $(printf '%s\n' "${!PROVIDER_NAME[@]}" | sort); do
        local key
        key=$(get_provider_key "$pk")
        local key_status="set"
        [[ -z "$key" ]] && key_status="MISSING"
        echo ""
        echo "  ${PROVIDER_NAME[$pk]} ($pk) [key: $key_status]:"

        for entry in "${!by_provider[@]}"; do
            if [[ "$entry" == "${pk}:"* ]]; then
                echo "    $entry"
            fi
        done
    done

    # Show slot overrides if proxy is running
    if get_proxy_state &>/dev/null; then
        echo ""
        echo "  Persistent proxy: RUNNING"

        if [[ -f "$SLOT_OVERRIDES_FILE" ]]; then
            local override_keys
            override_keys=$(jq -r 'to_entries | map(select(.key != "_defaults")) | map(.key) | join(", ")' "$SLOT_OVERRIDES_FILE" 2>/dev/null)
            if [[ -n "$override_keys" ]]; then
                echo ""
                echo "  Slot overrides:"
                for slot in opus sonnet haiku subagent fable; do
                    local val
                    val=$(jq -r --arg s "$slot" '.[$s] // empty' "$SLOT_OVERRIDES_FILE" 2>/dev/null)
                    if [[ -n "$val" ]]; then
                        printf "    %-12s %s\n" "$slot" "$val"
                    fi
                done
            fi
        fi
    fi

    echo ""
    echo "  Use /model providerKey:modelId in Claude Code to switch opus."
    echo "  Use deepclaude --set-slot SLOT MODEL to switch sonnet/haiku/subagent."
    echo "  Use deepclaude --switch CONFIG to change all slot mappings at once."
    echo ""
}

run_doctor() {
    local test_config="${1:-ds}"
    local all_ok=true
    local pass='\033[32mPASS\033[0m'
    local fail='\033[31mFAIL\033[0m'
    local warn='\033[33mWARN\033[0m'

    echo ""
    echo "  deepclaude System Check"
    echo "  ======================"

    # 1. Node.js
    echo ""
    echo "  Prerequisites:"
    if command -v node &>/dev/null; then
        local node_ver node_path
        node_ver=$(node -v)
        node_path=$(command -v node)
        echo -e "    Node.js           $pass  $node_path ($node_ver)"
    else
        echo -e "    Node.js           $fail  Not found in PATH. Install from https://nodejs.org"
        all_ok=false
    fi

    # 2. Proxy script
    local proxy_script="${SCRIPT_DIR}/proxy/start-proxy.ts"
    if [[ -f "$proxy_script" ]]; then
        echo -e "    Proxy script      $pass  $proxy_script"
    else
        echo -e "    Proxy script      $fail  Not found at $proxy_script"
        all_ok=false
    fi

    # 3. jq (needed for JSON manipulation)
    if command -v jq &>/dev/null; then
        echo -e "    jq                $pass  $(jq --version)"
    else
        echo -e "    jq                $fail  Required. Install: apt install jq / brew install jq"
        all_ok=false
    fi

    # 4. State directory
    mkdir -p -m 700 "$DEEPCLAUDE_DIR"

    # 5. Stale .tmp files
    local stale_tmps
    stale_tmps=$(find "$DEEPCLAUDE_DIR" -name "*.tmp" -type f 2>/dev/null | wc -l)
    if [[ $stale_tmps -gt 0 ]]; then
        echo -e "    Stale .tmp files  $warn  $stale_tmps found (cleaned)"
        find "$DEEPCLAUDE_DIR" -name "*.tmp" -type f -delete 2>/dev/null || true
    fi

    # 6. API keys
    echo ""
    echo "  API Keys:"
    local keys_ok=0 keys_total=15
    for pk in ds or fw oc al km mm um gr mt mx za bp sf nv; do
        local key
        key=$(get_provider_key "$pk")
        if [[ -n "$key" ]]; then
            echo -e "    ${PROVIDER_KEYNAME[$pk]}  $pass  (****${key: -4})"
            keys_ok=$((keys_ok + 1))
        else
            echo -e "    ${PROVIDER_KEYNAME[$pk]}  $warn  Not set (provider '$pk' unavailable)"
        fi
    done
    echo "    $keys_ok/$keys_total keys configured"

    # 7. Slot overrides
    echo ""
    echo "  Slot Overrides:"
    if [[ -f "$SLOT_OVERRIDES_FILE" ]]; then
        for slot in opus sonnet haiku subagent fable; do
            local val
            val=$(jq -r --arg s "$slot" '.[$s] // ._defaults[$s] // empty' "$SLOT_OVERRIDES_FILE" 2>/dev/null)
            if [[ -z "$val" ]]; then
                echo -e "    ${slot}       $fail  No mapping"
                all_ok=false
            else
                local pk="${val%%:*}"
                local prov_name="${PROVIDER_NAME[$pk]:-unknown}"
                local key
                key=$(get_provider_key "$pk")
                if [[ -n "$key" ]]; then
                    echo -e "    ${slot}       $pass  $val  ->  $prov_name"
                else
                    echo -e "    ${slot}       $warn  $val (provider '$pk' unavailable)"
                fi
            fi
        done
    else
        echo -e "    $warn  No slot-overrides.json (will be created on first launch)"
    fi

    # 8. Proxy startup test
    if command -v node &>/dev/null && [[ -f "$proxy_script" ]] && command -v jq &>/dev/null; then
        echo ""
        echo "  Proxy Test:"

        local test_routes_file="${DEEPCLAUDE_DIR}/doctor-test-routes.json"

        # Check for any valid config with keys before attempting proxy test
        local test_slot_data=""
        test_slot_data=$(resolve_config "$test_config" 2>/dev/null | tail -n +2) || true
        if [[ -z "$test_slot_data" ]]; then
            for cfg in ds or fw oc km mm um gr mt mx za bp sf nv ds+oc anthropic; do
                test_slot_data=$(resolve_config "$cfg" 2>/dev/null | tail -n +2) || true
                [[ -n "$test_slot_data" ]] && break
            done
        fi

        if [[ -z "$test_slot_data" ]]; then
            echo -e "    $warn  Proxy test: SKIP (no valid API keys configured)"
        else
            local test_routes_json
            test_routes_json=$(echo "$test_slot_data" | build_routes_json)
            write_atomic "$test_routes_file" "$test_routes_json"

            local test_port test_pid
            local doctor_start
            doctor_start=$(start_proxy "$test_routes_file" 2>/dev/null) || true
            if [[ -n "$doctor_start" ]]; then
                read -r test_port test_pid <<< "$doctor_start"
                local health
                if health=$(curl -sf "http://127.0.0.1:${test_port}/health" 2>/dev/null); then
                    local uptime_ms
                    uptime_ms=$(echo "$health" | jq -r '.uptime' 2>/dev/null || echo "?")
                    echo -e "    Health endpoint   $pass  http://127.0.0.1:${test_port} (uptime ${uptime_ms}ms)"
                else
                    echo -e "    Health endpoint   $fail  Proxy started but /health failed"
                    all_ok=false
                fi
                if [[ -n "$test_pid" ]]; then kill "$test_pid" 2>/dev/null || true; fi
            else
                echo -e "    Proxy startup     $fail"
                all_ok=false
            fi
            rm -f "$test_routes_file"

            # Also test provider API key validity via probe
            echo ""
            echo "  Key Validation (probe each provider):"
            if [[ -n "$test_slot_data" ]]; then
                local probe_routes_json probe_routes_file
                probe_routes_json=$(echo "$test_slot_data" | build_routes_json)
                probe_routes_file="${DEEPCLAUDE_DIR}/doctor-probe-routes.json"
                write_atomic "$probe_routes_file" "$probe_routes_json"
                if "$SCRIPT_DIR/node_modules/.bin/tsx" "$proxy_script" --probe "$probe_routes_file" 2>&1; then
                    :  # output already printed by probe
                else
                    all_ok=false
                fi
                rm -f "$probe_routes_file"
            fi
        fi
    fi

    echo ""
    if $all_ok; then
        echo -e "  Result: All checks passed. Ready to launch."
    else
        echo -e "  Result: Some checks failed. See above for details."
    fi
    echo ""
    $all_ok || exit 1
}

run_benchmark() {
    echo ""
    echo "  Latency Benchmark"
    echo "  =================="

    local configs="ds or fw oc km mm um gr mt mx za bp sf nv"
    local results_dir
    results_dir=$(mktemp -d "${TMPDIR:-/tmp}/deepclaude.XXXXXX")
    trap "rm -rf \"$results_dir\"" EXIT

    for id in $configs; do
        (
            set +e
            config_name=$(resolve_config "$id" 2>/dev/null | head -1) || { echo "  $id - SKIP" > "$results_dir/$id"; exit; }
            slot_data=$(resolve_config "$id" 2>/dev/null | tail -n +2) || { echo "  $id - SKIP" > "$results_dir/$id"; exit; }

            opus_spec=$(echo "$slot_data" | grep "^opus " | head -1)
            read -r _ prov_key model_id <<< "$opus_spec"
            key=$(get_provider_key "$prov_key")
            if [[ -z "$key" ]]; then
                echo "  $config_name - SKIP" > "$results_dir/$id"
                exit
            fi

            url="${PROVIDER_URL[$prov_key]}"
            auth="${PROVIDER_AUTH[$prov_key]}"

            local auth_header
            if [[ "$auth" == "bearer" ]]; then
                auth_header="Authorization: Bearer $key"
            else
                auth_header="x-api-key: $key"
            fi

            start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || echo "0")
            status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url/v1/messages" \
                -H "$auth_header" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
                -d "{\"model\":\"$model_id\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply: ok\"}]}" \
                --max-time 30 2>/dev/null || echo "timeout")
            end_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || echo "0")
            elapsed=$((end_ms - start_ms))

            if [[ "$status" == "200" ]]; then
                printf "  %-35s OK (%dms)\n" "$config_name" "$elapsed" > "$results_dir/$id"
            else
                printf "  %-35s FAIL (%s, %dms)\n" "$config_name" "$status" "$elapsed" > "$results_dir/$id"
            fi
        ) &
    done
    wait || true

    for id in $configs; do
        cat "$results_dir/$id" 2>/dev/null || echo "  $id - SKIP"
    done
    echo ""
}

handle_set_slot() {
    local slot_name="$1" slot_model="${2:-}"

    if [[ ! "$slot_name" =~ ^(opus|sonnet|haiku|subagent|fable)$ ]]; then
        echo "ERROR: Invalid slot '$slot_name'. Use: opus, sonnet, haiku, subagent, fable" >&2
        exit 1
    fi

    mkdir -p -m 700 "$DEEPCLAUDE_DIR"

    # Read current overrides
    local overrides="{}"
    if [[ -f "$SLOT_OVERRIDES_FILE" ]]; then
        overrides=$(cat "$SLOT_OVERRIDES_FILE")
    fi

    if [[ -z "$slot_model" ]]; then
        # Clear override
        overrides=$(echo "$overrides" | jq "del(.${slot_name})")
        local default_model
        default_model=$(echo "$overrides" | jq -r --arg s "$slot_name" '._defaults[$s] // "unknown"')
        echo ""
        echo "  Cleared $slot_name override (reverts to $default_model)."
    else
        # Validate format
        if [[ ! "$slot_model" =~ ^[a-z][a-z0-9_-]*:.+$ ]]; then
            echo "ERROR: Model must be in providerKey:modelId format (e.g. or:z-ai/glm-4.5-air:free)" >&2
            exit 1
        fi
        local prov_key="${slot_model%%:*}"
        local key
        key=$(get_provider_key "$prov_key")
        if [[ -z "${PROVIDER_URL[$prov_key]:-}" ]]; then
            echo "ERROR: Unknown provider '$prov_key'. Known: ${!PROVIDER_URL[*]}" >&2
            exit 1
        fi
        if [[ -z "$key" ]]; then
            echo "ERROR: No API key set for provider '$prov_key'." >&2
            exit 1
        fi

        # Warn if model not in context limits
        local plain_model="${slot_model#*:}"
        if [[ -z "${MODEL_CTX[$plain_model]:-}" ]]; then
            echo "  Note: Model '$plain_model' not in context-limit registry. Statusline won't show context usage."
        fi

        overrides=$(echo "$overrides" | jq --arg s "$slot_name" --arg v "$slot_model" '.[$s] = $v')
        echo ""
        echo "  Set $slot_name override: $slot_model"
    fi

    write_atomic "$SLOT_OVERRIDES_FILE" "$(echo "$overrides" | jq -c '.')"

    if get_proxy_state &>/dev/null; then
        echo "  Proxy is running -- change takes effect immediately."
    else
        echo "  No proxy running. Override saved for next launch."
    fi
    echo ""
}

handle_subagent_model() {
    local model="${1:-}"

    mkdir -p -m 700 "$DEEPCLAUDE_DIR"

    if [[ -z "$model" ]]; then
        if [[ -f "$SUBMODEL_FILE" ]]; then
            rm -f "$SUBMODEL_FILE"
            echo ""
            echo "  Cleared dedicated subagent model."
        else
            echo ""
            echo "  No dedicated subagent model is set."
        fi
        echo ""
        exit 0
    fi

    if [[ ! "$model" =~ ^[a-z][a-z0-9_-]*:.+$ ]]; then
        echo "ERROR: Subagent model must be in providerKey:modelId format (e.g. oc:big-pickle)" >&2
        exit 1
    fi
    local prov_key="${model%%:*}"
    local key
    key=$(get_provider_key "$prov_key")
    if [[ -z "${PROVIDER_URL[$prov_key]:-}" ]]; then
        echo "ERROR: Unknown provider '$prov_key'. Known: ${!PROVIDER_URL[*]}" >&2
        exit 1
    fi
    if [[ -z "$key" ]]; then
        echo "ERROR: No API key set for provider '$prov_key'." >&2
        exit 1
    fi

    local model_id="${model#*:}"
    printf '{"providerKey":"%s","modelId":"%s"}\n' "$prov_key" "$model_id" > "$SUBMODEL_FILE"
    echo ""
    echo "  Set dedicated subagent model: $model"

    if get_proxy_state &>/dev/null; then
        echo "  Proxy is running -- change takes effect immediately."
    else
        echo "  No proxy running. Subagent model saved for next launch."
    fi
    echo ""
}

handle_switch() {
    local target="$1"

    mkdir -p -m 700 "$DEEPCLAUDE_DIR"

    local config_name slot_data
    if [[ -n "${CONFIG_NAME[$target]:-}" ]]; then
        config_name=$(resolve_config "$target" | head -1)
        slot_data=$(resolve_config "$target" | tail -n +2)
    else
        # Treat as ad-hoc specs
        local specs=($target)
        config_name="Ad-hoc"
        slot_data=$(build_adhoc_config "${specs[@]}" | tail -n +2)  # skip name line
    fi

    local routes_json
    routes_json=$(echo "$slot_data" | build_routes_json)

    write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"

    local proxy_state proxy_pid proxy_port
    if proxy_state=$(get_proxy_state); then
        read -r proxy_pid proxy_port <<< "$proxy_state"
        echo ""
        echo "  Proxy routes updated to: $config_name"
        echo "  Proxy on port $proxy_port (persistent)"
    else
        echo ""
        echo "  Starting persistent proxy for $config_name..."
        local port proxy_pid
        read -r port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")"
        save_proxy_state "$proxy_pid" "$port" "$CURRENT_ROUTES_FILE"
        echo "  Proxy on port $port"
    fi

    # Initialize slot overrides
    # Get first 4 lines of slot_data: opus provider model, sonnet provider model, etc.
    local opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
    local haiku_prov="" haiku_model="" subagent_prov="" subagent_model="" fable_prov="" fable_model=""
    while IFS=' ' read -r slot prov model; do
        case "$slot" in
            opus) opus_prov="$prov"; opus_model="$model" ;;
            sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
            haiku) haiku_prov="$prov"; haiku_model="$model" ;;
            subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            fable) fable_prov="$prov"; fable_model="$model" ;;
        esac
    done <<< "$slot_data"
    init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
        "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model" \
            "$fable_prov" "$fable_model"

    echo "  Slot mappings:"
    while IFS=' ' read -r slot prov model; do
        printf "    %-10s %s:%s  ->  %s\n" "$slot" "$prov" "$model" "${PROVIDER_NAME[$prov]}"
    done <<< "$slot_data"

    echo ""
    echo "  Use /model providerKey:modelId in Claude Code to switch individual models."
    echo "  Use 'deepclaude --stop-proxy' to stop the proxy when done."
    echo ""
}

# --- Main ---
ACTION="launch"
BACKEND=""
PERSIST=false
REMOTE=false
EFFORT="max"
declare -a SPECS=()
DASHBOARD=false
OPEN_BROWSER=false
PROBE_FILE=""
DRY_RUN_FILE=""
SUBAGENT_MODEL=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--backend)
            BACKEND="$2"; shift 2 ;;
        -r|--remote)
            REMOTE=true; ACTION="remote"; shift ;;
        --effort)
            EFFORT="$2"
            case "$EFFORT" in
                low|medium|high|max) ;;
                *) echo "ERROR: Invalid effort level '$EFFORT'. Valid values: low, medium, high, max" >&2; exit 1 ;;
            esac
            shift 2 ;;
        --persist)
            PERSIST=true; shift ;;
        --status)
            ACTION="status"; shift ;;
        --cost)
            ACTION="cost"; shift ;;
        --benchmark)
            ACTION="benchmark"; shift ;;
        --help|-h)
            ACTION="help"; shift ;;
        --version)
            ACTION="version"; shift ;;
        --doctor)
            ACTION="doctor"
            # Optional config name
            if [[ -n "${2:-}" && "$2" != -* ]]; then
                BACKEND="$2"; shift
            fi
            shift ;;
        --models)
            ACTION="models"; shift ;;
        --install-statusline)
            dest="$HOME/.claude/statusline.sh"
            cp "$SCRIPT_DIR/statusline/statusline.sh" "$dest"
            chmod +x "$dest"

            settings="$HOME/.claude/settings.json"
            if [[ -f "$settings" ]]; then
                tmp=$(mktemp "${TMPDIR:-/tmp}/deepclaude.XXXXXX")
                jq '.statusLine = {"type": "command", "command": ("bash " + $dest)}' --arg dest "$dest" "$settings" > "$tmp" && mv "$tmp" "$settings"
            else
                mkdir -p "$HOME/.claude"
                printf '{"statusLine": {"type": "command", "command": "bash %s"}}\n' "$dest" > "$settings"
            fi
            echo "Statusline installed to $dest"
            echo "Added to $settings"
            exit 0
            ;;
        --stop-proxy)
            ACTION="stop-proxy"; shift ;;
        --dashboard)
            DASHBOARD=true; shift ;;
        --open)
            OPEN_BROWSER=true; shift ;;
        --logs|--tail)
            ACTION="logs"; shift ;;
        --health)
            ACTION="health"; shift ;;
        --probe)
            ACTION="probe"
            if [[ -n "${2:-}" && "$2" != -* ]]; then
                PROBE_FILE="$2"; shift
            fi
            shift ;;
        --dry-run|--what-if)
            ACTION="dry-run"
            if [[ -n "${2:-}" && "$2" != -* ]]; then
                DRY_RUN_FILE="$2"; shift
            fi
            shift ;;
        --set-slot)
            slot_name="${2:-}" slot_model="$3"
            ACTION="set-slot"
            SLOT_NAME="$slot_name"
            SLOT_MODEL="$slot_model"
            if [[ -n "${3:-}" ]]; then shift 3; else shift 2; fi
            [[ "$slot_name" == -* ]] && { echo "ERROR: --set-slot requires SLOT and MODEL"; exit 1; }
            ;;
        --subagent-model)
            SUBAGENT_MODEL="${2:-}"
            ACTION="subagent-model"
            if [[ -n "${2:-}" && "$2" != -* ]]; then shift 2; else shift; fi
            ;;
        --switch)
            ACTION="switch"
            SWITCH_TARGET="$2"; shift 2
            ;;
        --lint)
            echo ""; echo "  Linting deepclaude.sh with shellcheck..."; echo ""
            if command -v shellcheck &>/dev/null; then
                shellcheck -x "$0"
            else
                echo "  shellcheck not installed. Install: brew install shellcheck (macOS) or apt install shellcheck (Linux)" >&2
                exit 1
            fi
            exit 0 ;;
        --lint-config)
            ACTION="lint-config"; shift ;;
        --log-all)
            export DEEPCLAUDE_LOG_ALL_REQUESTS=true
            shift ;;
        --skip-startup-check)
            export DEEPCLAUDE_SKIP_STARTUP_CHECK=true
            shift ;;
        --fix-av)
            echo "AV exclusion is Windows-only. Ensure $(dirname "$0") is excluded."; exit 0 ;;
        *)
            if [[ "$1" =~ ^[a-z][a-z0-9_-]*:.+$ ]]; then
                SPECS+=("$1")
                if [[ "$ACTION" != "remote" && "$ACTION" != "launch-named" ]]; then
                    ACTION="launch-pos"
                fi
                shift
            elif [[ "$1" == "anthropic" ]]; then
                BACKEND="anthropic"
                shift
            else
                echo "ERROR: Unknown option '$1'" >&2
                exit 1
            fi
            ;;
    esac
done

# Default config
if [[ -z "$BACKEND" && ${#SPECS[@]} -eq 0 ]]; then
    BACKEND="${DEEPCLAUDE_DEFAULT_BACKEND:-${CHEAPCLAUDE_DEFAULT_BACKEND:-ds}}"
fi

# Execute action

# cleanup_proxy is defined here (outside the case) so both launch-pos and launch
# branches can reference it. Bash registers functions at execution time, not
# parse time, so a function inside a case branch is invisible to other branches.
cleanup_proxy() {
    if [[ -n "${watchdog_pid:-}" ]]; then
        kill "$watchdog_pid" 2>/dev/null || true
    fi
    if ! $PERSIST; then
        if [[ -n "${proxy_pid:-}" ]]; then
            stop_proxy_info "$proxy_pid"
        fi
    fi
    clear_anthropic_env
}

case "$ACTION" in
    logs)
        local log_path="${DEEPCLAUDE_DIR}/proxy.log"
        if [[ ! -f "$log_path" ]]; then
            echo "No proxy log found at $log_path"
            echo "Start the proxy first with: deepclaude --persist"
            exit 1
        fi
        echo "Tailing $log_path (Ctrl+C to stop)..."
        echo "---"
        tail -f "$log_path"
        exit 0 ;;
    status)     show_status ;;
    health)
        local state_file="${DEEPCLAUDE_DIR}/proxy.json"
        if [[ ! -f "$state_file" ]]; then echo "No proxy running. Start one first."; exit 1; fi
        local port; port=$(jq -r '.port' "$state_file" 2>/dev/null)
        local health; health=$(curl -sf "http://127.0.0.1:${port}/health" 2>/dev/null || true)
        if [[ -z "$health" ]]; then echo "Proxy not responding on port $port"; exit 1; fi
        local up down; up=$(echo "$health" | jq '[.providers // {} | to_entries[] | select(.value.circuitBreaker != "OPEN")] | length' 2>/dev/null || echo 0)
        down=$(echo "$health" | jq '[.providers // {} | to_entries[] | select(.value.circuitBreaker == "OPEN")] | length' 2>/dev/null || echo 0)
        local total=$((up + down))
        local spend_str=""
        local spend_file="${DEEPCLAUDE_DIR}/spend.json"
        if [[ -f "$spend_file" ]]; then
            local sess; sess=$(jq -r '(.sessions // [])[0].total // ""' "$spend_file" 2>/dev/null || true)
            if [[ -n "$sess" && "$sess" != "null" ]]; then spend_str=" | \$$(printf '%.2f' "$sess") session"; fi
        fi
        echo "${up}/${total} up${spend_str}"
        if [[ "$down" -gt 0 ]]; then
            local open_list; open_list=$(echo "$health" | jq -r '[.providers // {} | to_entries[] | select(.value.circuitBreaker == "OPEN") | .key] | join(", ")' 2>/dev/null)
            echo "  down: $open_list"
        fi
        exit 0 ;;
    cost)       show_cost ;;
    benchmark)  run_benchmark ;;
    help)       show_help ;;
    version)    show_version ;;
    doctor)     run_doctor "${BACKEND:-ds}" ;;
    probe)
        # Build routes file if none provided
        local probe_routes="${PROBE_FILE}"
        if [[ -z "$probe_routes" ]]; then
            local slot_data=""
            if [[ ${#SPECS[@]} -gt 0 ]]; then
                slot_data=$(build_adhoc_config "${SPECS[@]}" | tail -n +2)
            else
                slot_data=$(resolve_config "${BACKEND:-ds}" | tail -n +2)
            fi
            probe_routes="${DEEPCLAUDE_DIR}/probe-routes.json"
            mkdir -p -m 700 "$DEEPCLAUDE_DIR"
            echo "$slot_data" | build_routes_json > "$probe_routes"
        fi
        "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/proxy/start-proxy.ts" --probe "$probe_routes"
        exit $? ;;
    dry-run)
        local dry_routes="${DRY_RUN_FILE}"
        if [[ -z "$dry_routes" ]]; then
            local dry_slot_data=""
            if [[ ${#SPECS[@]} -gt 0 ]]; then
                dry_slot_data=$(build_adhoc_config "${SPECS[@]}" | tail -n +2)
            else
                dry_slot_data=$(resolve_config "${BACKEND:-ds}" | tail -n +2)
            fi
            dry_routes="${DEEPCLAUDE_DIR}/dryrun-routes.json"
            mkdir -p -m 700 "$DEEPCLAUDE_DIR"
            echo "$dry_slot_data" | build_routes_json > "$dry_routes"
        fi
        "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/proxy/start-proxy.ts" --dry-run "$dry_routes"
        exit $? ;;
    models)     show_models ;;
    lint-config)
        echo ""
        echo "  Validating providers.json configuration..."
        echo ""
        "${SCRIPT_DIR}/node_modules/.bin/tsx" "${SCRIPT_DIR}/proxy/config-lint.ts"
        exit $? ;;
    stop-proxy)
        if proxy_state=$(get_proxy_state); then
            read -r pid port <<< "$proxy_state"
            stop_proxy_info "$pid"
            echo "  Proxy stopped."
        else
            echo "  No persistent proxy is running."
        fi
        ;;
    set-slot)   handle_set_slot "$SLOT_NAME" "$SLOT_MODEL" ;;
    subagent-model) handle_subagent_model "$SUBAGENT_MODEL" ;;
    switch)     handle_switch "$SWITCH_TARGET" ;;
    remote)
        if [[ "$BACKEND" == "anthropic" ]]; then
            clear_anthropic_env
            echo ""
            echo "  Launching remote control (Anthropic)..."
            echo ""
            claude --effort "$EFFORT" --dangerously-skip-permissions remote-control "$@"
            exit $?
        fi

        # Resolve config
        config_name="" slot_data=""
        if [[ ${#SPECS[@]} -gt 0 ]]; then
            config_name="Ad-hoc"
            slot_data=$(build_adhoc_config "${SPECS[@]}" | tail -n +2)
        else
            config_name=$(resolve_config "$BACKEND" | head -1)
            slot_data=$(resolve_config "$BACKEND" | tail -n +2)
        fi

        echo ""
        echo "  Starting routing proxy for $config_name..."

        # Build routes and start proxy
        routes_json=""
        routes_json=$(echo "$slot_data" | build_routes_json)

        proxy_port="" proxy_pid=""
        mkdir -p -m 700 "$DEEPCLAUDE_DIR"

        if proxy_state=$(get_proxy_state); then
            read -r proxy_pid proxy_port <<< "$proxy_state"
            echo "  Reusing persistent proxy on port $proxy_port"
            write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"
        else
            write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"
            read -r proxy_port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")"
            save_proxy_state "$proxy_pid" "$proxy_port" "$CURRENT_ROUTES_FILE"
            echo "  Proxy on :$proxy_port (persistent)"
        fi

        watchdog_pid=""
        if [[ "${DEEPCLAUDE_WATCHDOG:-}" == "true" ]] && [[ -n "$proxy_pid" ]]; then
            (
                set +e
                max_restarts=5
                restart_count=0
                for attempt in 1 2 3 4 5; do
                    wait "$proxy_pid" 2>/dev/null
                    wait_rc=$?
                    if [[ $wait_rc -le 128 ]]; then
                        break
                    fi
                    restart_count=$((restart_count + 1))
                    echo "Proxy crashed. Restarting (attempt $restart_count)..." >&2
                    sleep 2
                    read -r restart_port restart_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")" || true
                    if [[ -n "$restart_pid" ]] && [[ -n "$restart_port" ]]; then
                        proxy_pid="$restart_pid"
                        save_proxy_state "$restart_pid" "$restart_port" "$CURRENT_ROUTES_FILE"
                    fi
                done
                if [[ $restart_count -ge $max_restarts ]]; then
                    echo "ERROR: Proxy restarted $max_restarts times. Watchdog giving up." >&2
                fi
            ) &
            watchdog_pid=$!
        fi

        # Init slot overrides
        opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
        haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
        while IFS=' ' read -r slot prov model; do
            case "$slot" in
                opus) opus_prov="$prov"; opus_model="$model" ;;
                sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
                haiku) haiku_prov="$prov"; haiku_model="$model" ;;
                subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            fable) fable_prov="$prov"; fable_model="$model" ;;
            esac
        done <<< "$slot_data"
        init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
            "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model" \
            "$fable_prov" "$fable_model"

        # Get actual models from overrides
        opus_m="" sonnet_m="" haiku_m="" sub_m=""
        opus_m=$(get_slot_model "opus" "${opus_prov}:${opus_model}")
        sonnet_m=$(get_slot_model "sonnet" "${sonnet_prov}:${sonnet_model}")
        haiku_m=$(get_slot_model "haiku" "${haiku_prov}:${haiku_model}")
        sub_m=$(get_slot_model "subagent" "${subagent_prov}:${subagent_model}")
        fable_m=$(get_slot_model "fable" "${fable_prov}:${fable_model}")



        echo "  Launching remote control..."
        echo ""

        if $DASHBOARD; then
            echo "  Dashboard: http://127.0.0.1:${proxy_port}/dashboard"
            if $OPEN_BROWSER; then
                open "http://127.0.0.1:${proxy_port}/dashboard" 2>/dev/null || \
                xdg-open "http://127.0.0.1:${proxy_port}/dashboard" 2>/dev/null || true
            fi
        fi

        set_cc_env "$proxy_port" "$opus_m" "$sonnet_m" "$haiku_m" "$sub_m" "$fable_m" "$opus_model"
        claude --effort "$EFFORT" --dangerously-skip-permissions remote-control "$@"
        claude_exit=$?
        if ! $PERSIST; then
            stop_proxy_info "$proxy_pid"
        fi
        clear_anthropic_env
        exit $claude_exit
        ;;
    launch-pos)
        # Ad-hoc positional specs
        config_name="" slot_data=""
        config_name=$(build_adhoc_config "${SPECS[@]}" | head -1)
        slot_data=$(build_adhoc_config "${SPECS[@]}" | tail -n +2)

        echo ""
        echo "  Launching Claude Code via $config_name..."

        # Build routes
        routes_json=""
        routes_json=$(echo "$slot_data" | build_routes_json)

        mkdir -p -m 700 "$DEEPCLAUDE_DIR"
        proxy_port="" proxy_pid=""

        if proxy_state=$(get_proxy_state); then
            read -r proxy_pid proxy_port <<< "$proxy_state"
            echo "  Reusing persistent proxy on :$proxy_port"
            write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"
        else
            write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"
            read -r proxy_port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")"
            if $PERSIST; then
                save_proxy_state "$proxy_pid" "$proxy_port" "$CURRENT_ROUTES_FILE"
                echo "  Proxy on :$proxy_port (persistent)"
            else
                echo "  Proxy on :$proxy_port"
            fi
        fi

        watchdog_pid=""
        if [[ "${DEEPCLAUDE_WATCHDOG:-}" == "true" ]] && [[ -n "$proxy_pid" ]]; then
            (
                set +e
                max_restarts=5
                restart_count=0
                for attempt in 1 2 3 4 5; do
                    wait "$proxy_pid" 2>/dev/null
                    wait_rc=$?
                    if [[ $wait_rc -le 128 ]]; then
                        break
                    fi
                    restart_count=$((restart_count + 1))
                    echo "Proxy crashed. Restarting (attempt $restart_count)..." >&2
                    sleep 2
                    read -r restart_port restart_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")" || true
                    if [[ -n "$restart_pid" ]] && [[ -n "$restart_port" ]]; then
                        proxy_pid="$restart_pid"
                        save_proxy_state "$restart_pid" "$restart_port" "$CURRENT_ROUTES_FILE"
                    fi
                done
                if [[ $restart_count -ge $max_restarts ]]; then
                    echo "ERROR: Proxy restarted $max_restarts times. Watchdog giving up." >&2
                fi
            ) &
            watchdog_pid=$!
        fi

        # Init slot overrides
        opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
        haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
        while IFS=' ' read -r slot prov model; do
            case "$slot" in
                opus) opus_prov="$prov"; opus_model="$model" ;;
                sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
                haiku) haiku_prov="$prov"; haiku_model="$model" ;;
                subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            fable) fable_prov="$prov"; fable_model="$model" ;;
            esac
        done <<< "$slot_data"
        init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
            "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model" \
            "$fable_prov" "$fable_model"

        # Resolve actual models from overrides
        opus_m="" sonnet_m="" haiku_m="" sub_m=""
        opus_m=$(get_slot_model "opus" "${opus_prov}:${opus_model}")
        sonnet_m=$(get_slot_model "sonnet" "${sonnet_prov}:${sonnet_model}")
        haiku_m=$(get_slot_model "haiku" "${haiku_prov}:${haiku_model}")
        sub_m=$(get_slot_model "subagent" "${subagent_prov}:${subagent_model}")
        fable_m=$(get_slot_model "fable" "${fable_prov}:${fable_model}")



        # Show routing
        echo "  Routing:"
        while IFS=' ' read -r slot prov model; do
            printf "    %-10s %s:%s  ->  %s\n" "$slot" "$prov" "$model" "${PROVIDER_NAME[$prov]}"
        done <<< "$slot_data"
        echo ""

        if $DASHBOARD; then
            echo "  Dashboard: http://127.0.0.1:${proxy_port}/dashboard"
            if $OPEN_BROWSER; then
                open "http://127.0.0.1:${proxy_port}/dashboard" 2>/dev/null || \
                xdg-open "http://127.0.0.1:${proxy_port}/dashboard" 2>/dev/null || true
            fi
        fi

        set_cc_env "$proxy_port" "$opus_m" "$sonnet_m" "$haiku_m" "$sub_m" "$fable_m" "$opus_model"

        trap cleanup_proxy EXIT

        claude --effort "$EFFORT" --dangerously-skip-permissions "$@"
        claude_exit=$?
        cleanup_proxy
        exit $claude_exit
        ;;
    launch)
        if [[ "$BACKEND" == "anthropic" ]]; then
            clear_anthropic_env
            echo ""
            echo "  Launching Claude Code (normal Anthropic)..."
            echo ""
            claude --effort "$EFFORT" --dangerously-skip-permissions "$@"
            exit $?
        fi

        # Same as launch-pos but uses named config
        config_name="" slot_data=""
        config_name=$(resolve_config "$BACKEND" | head -1)
        slot_data=$(resolve_config "$BACKEND" | tail -n +2)

        echo ""
        echo "  Launching Claude Code via $config_name..."

        # Show provider names
        prov_keys=()
        while IFS=' ' read -r _ prov _; do
            if [[ ! " ${prov_keys[*]} " =~ " $prov " ]]; then
                prov_keys+=("$prov")
            fi
        done <<< "$slot_data"
        prov_names=""
        for pk in "${prov_keys[@]}"; do
            [[ -n "$prov_names" ]] && prov_names+=" + "
            prov_names+="${PROVIDER_NAME[$pk]}"
        done
        echo "  Providers: $prov_names"
        echo "  Routing:"
        while IFS=' ' read -r slot prov model; do
            printf "    %-10s %s:%s  ->  %s\n" "$slot" "$prov" "$model" "${PROVIDER_NAME[$prov]}"
        done <<< "$slot_data"
        echo ""

        # Build routes
        routes_json=""
        routes_json=$(echo "$slot_data" | build_routes_json)

        mkdir -p -m 700 "$DEEPCLAUDE_DIR"
        proxy_port="" proxy_pid=""

        if proxy_state=$(get_proxy_state); then
            read -r proxy_pid proxy_port <<< "$proxy_state"
            echo "  Reusing persistent proxy on :$proxy_port"
            write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"
        else
            write_atomic "$CURRENT_ROUTES_FILE" "$routes_json"
            read -r proxy_port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")"
            if $PERSIST; then
                save_proxy_state "$proxy_pid" "$proxy_port" "$CURRENT_ROUTES_FILE"
                echo "  Proxy on :$proxy_port (persistent)"
            else
                echo "  Proxy on :$proxy_port"
            fi
        fi

        watchdog_pid=""
        if [[ "${DEEPCLAUDE_WATCHDOG:-}" == "true" ]] && [[ -n "$proxy_pid" ]]; then
            (
                set +e
                max_restarts=5
                restart_count=0
                for attempt in 1 2 3 4 5; do
                    wait "$proxy_pid" 2>/dev/null
                    wait_rc=$?
                    if [[ $wait_rc -le 128 ]]; then
                        break
                    fi
                    restart_count=$((restart_count + 1))
                    echo "Proxy crashed. Restarting (attempt $restart_count)..." >&2
                    sleep 2
                    read -r restart_port restart_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")" || true
                    if [[ -n "$restart_pid" ]] && [[ -n "$restart_port" ]]; then
                        proxy_pid="$restart_pid"
                        save_proxy_state "$restart_pid" "$restart_port" "$CURRENT_ROUTES_FILE"
                    fi
                done
                if [[ $restart_count -ge $max_restarts ]]; then
                    echo "ERROR: Proxy restarted $max_restarts times. Watchdog giving up." >&2
                fi
            ) &
            watchdog_pid=$!
        fi

        # Init slot overrides
        opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
        haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
        while IFS=' ' read -r slot prov model; do
            case "$slot" in
                opus) opus_prov="$prov"; opus_model="$model" ;;
                sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
                haiku) haiku_prov="$prov"; haiku_model="$model" ;;
                subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            fable) fable_prov="$prov"; fable_model="$model" ;;
            esac
        done <<< "$slot_data"
        init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
            "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model" \
            "$fable_prov" "$fable_model"

        # Resolve actual models from overrides
        opus_m="" sonnet_m="" haiku_m="" sub_m=""
        opus_m=$(get_slot_model "opus" "${opus_prov}:${opus_model}")
        sonnet_m=$(get_slot_model "sonnet" "${sonnet_prov}:${sonnet_model}")
        haiku_m=$(get_slot_model "haiku" "${haiku_prov}:${haiku_model}")
        sub_m=$(get_slot_model "subagent" "${subagent_prov}:${subagent_model}")
        fable_m=$(get_slot_model "fable" "${fable_prov}:${fable_model}")



        if $DASHBOARD; then
            echo "  Dashboard: http://127.0.0.1:${proxy_port}/dashboard"
            if $OPEN_BROWSER; then
                open "http://127.0.0.1:${proxy_port}/dashboard" 2>/dev/null || \
                xdg-open "http://127.0.0.1:${proxy_port}/dashboard" 2>/dev/null || true
            fi
        fi

        set_cc_env "$proxy_port" "$opus_m" "$sonnet_m" "$haiku_m" "$sub_m" "$fable_m" "$opus_model"

        trap cleanup_proxy EXIT

        claude --effort "$EFFORT" --dangerously-skip-permissions "$@"
        claude_exit=$?
        cleanup_proxy
        exit $claude_exit
        ;;
esac
