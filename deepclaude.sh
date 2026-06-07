#!/usr/bin/env bash
# deepclaude — Use Claude Code with cheap backends. Provider-agnostic: mix models from different APIs in one config.
# Usage: deepclaude [spec1] [spec2] [spec3] [spec4]   (positional mode)
#        deepclaude [-b backend] [--status] [--doctor] [--version]
#
# Named configs (via -b):
#   deepclaude                  # ds (default) — DeepSeek V4 Pro
#   deepclaude -b or            # OpenRouter (owl-alpha)
#   deepclaude -b or2           # OpenRouter (DeepSeek)
#   deepclaude -b or3           # OpenRouter (best free)
#   deepclaude -b fw            # Fireworks AI
#   deepclaude -b oc            # OpenCode Zen
#   deepclaude -b ds+oc         # DeepSeek main + OpenCode subs
#   deepclaude -b ds+or         # DeepSeek main + OpenRouter subs
#   deepclaude -b anthropic     # Normal Claude Code
#
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

# --- Provider Registry ---
# auth: "x-api-key" or "bearer"
declare -A PROVIDER_URL PROVIDER_AUTH PROVIDER_KEYNAME PROVIDER_NAME
PROVIDER_NAME[ds]="DeepSeek (direct)"
PROVIDER_URL[ds]="https://api.deepseek.com/anthropic"
PROVIDER_AUTH[ds]="x-api-key"
PROVIDER_KEYNAME[ds]="DEEPSEEK_API_KEY"

PROVIDER_NAME[or]="OpenRouter"
PROVIDER_URL[or]="https://openrouter.ai/api"
PROVIDER_AUTH[or]="bearer"
PROVIDER_KEYNAME[or]="OPENROUTER_API_KEY"

PROVIDER_NAME[fw]="Fireworks AI"
PROVIDER_URL[fw]="https://api.fireworks.ai/inference"
PROVIDER_AUTH[fw]="bearer"
PROVIDER_KEYNAME[fw]="FIREWORKS_API_KEY"

PROVIDER_NAME[oc]="OpenCode Zen"
PROVIDER_URL[oc]="https://opencode.ai/zen"
PROVIDER_AUTH[oc]="bearer"
PROVIDER_KEYNAME[oc]="OPENCODE_API_KEY"

PROVIDER_NAME[al]="Alibaba/DashScope"
PROVIDER_URL[al]="https://dashscope.aliyuncs.com/api/v1/chat/completions"
PROVIDER_AUTH[al]="bearer"
PROVIDER_KEYNAME[al]="ALIBABA_DASHSCOPE_API_KEY"

PROVIDER_NAME[km]="Kimi/Moonshot"
PROVIDER_URL[km]="https://api.moonshot.ai/v1"
PROVIDER_AUTH[km]="bearer"
PROVIDER_KEYNAME[km]="KIMI_API_KEY"

PROVIDER_NAME[mm]="Xiaomi Mimo"
PROVIDER_URL[mm]="https://api.xiaomimimo.com/v1"
PROVIDER_AUTH[mm]="bearer"
PROVIDER_KEYNAME[mm]="MIMO_API_KEY"

PROVIDER_NAME[um]="Umans AI"
PROVIDER_URL[um]="https://api.code.umans.ai"
PROVIDER_AUTH[um]="x-api-key"
PROVIDER_KEYNAME[um]="UMANS_API_KEY"

PROVIDER_NAME[gr]="Groq"
PROVIDER_URL[gr]="https://api.groq.com/openai/v1"
PROVIDER_AUTH[gr]="bearer"
PROVIDER_KEYNAME[gr]="GROQ_API_KEY"

PROVIDER_NAME[mt]="Mistral"
PROVIDER_URL[mt]="https://api.mistral.ai/v1"
PROVIDER_AUTH[mt]="bearer"
PROVIDER_KEYNAME[mt]="MISTRAL_API_KEY"

PROVIDER_NAME[mx]="MiniMax"
PROVIDER_URL[mx]="https://api.minimax.chat/v1"
PROVIDER_AUTH[mx]="bearer"
PROVIDER_KEYNAME[mx]="MINIMAX_API_KEY"

PROVIDER_NAME[za]="Z.ai / GLM"
PROVIDER_URL[za]="https://open.bigmodel.cn/api/paas/v4"
PROVIDER_AUTH[za]="bearer"
PROVIDER_KEYNAME[za]="ZAI_API_KEY"

PROVIDER_NAME[bp]="BytePlus/Doubao"
PROVIDER_URL[bp]="https://ark.cn-beijing.volces.com/api/v3"
PROVIDER_AUTH[bp]="bearer"
PROVIDER_KEYNAME[bp]="BYTEPLUS_API_KEY"

PROVIDER_NAME[sf]="SiliconFlow"
PROVIDER_URL[sf]="https://api.siliconflow.cn/v1"
PROVIDER_AUTH[sf]="bearer"
PROVIDER_KEYNAME[sf]="SILICONFLOW_API_KEY"

PROVIDER_NAME[nv]="Novita"
PROVIDER_URL[nv]="https://api.novita.ai/v3/openai"
PROVIDER_AUTH[nv]="bearer"
PROVIDER_KEYNAME[nv]="NOVITA_API_KEY"

declare -A PROVIDER_SETUP_URL
PROVIDER_SETUP_URL[ds]="https://platform.deepseek.com/api-keys"
PROVIDER_SETUP_URL[or]="https://openrouter.ai/keys"
PROVIDER_SETUP_URL[fw]="https://fireworks.ai/api-keys"
PROVIDER_SETUP_URL[oc]="https://opencode.ai/keys"
PROVIDER_SETUP_URL[gr]="https://console.groq.com/keys"
PROVIDER_SETUP_URL[mt]="https://console.mistral.ai/api-keys"

# --- Per-model context window limits (tokens) ---
declare -A MODEL_CTX
MODEL_CTX["deepseek-v4-pro"]=1048576
MODEL_CTX["deepseek-v4-flash"]=1048576
MODEL_CTX["deepseek/deepseek-v4-pro"]=1048576
MODEL_CTX["deepseek/deepseek-v4-flash"]=1048576
MODEL_CTX["accounts/fireworks/models/deepseek-v4-pro"]=1048576
MODEL_CTX["openrouter/owl-alpha"]=200000
MODEL_CTX["openai/gpt-oss-120b:free"]=131072
MODEL_CTX["poolside/laguna-m.1:free"]=131072
MODEL_CTX["z-ai/glm-4.5-air:free"]=131072
MODEL_CTX["liquid/lfm-2.5-1.2b-instruct:free"]=32768
MODEL_CTX["big-pickle"]=131072
MODEL_CTX["kimi-k2.6"]=262144
MODEL_CTX["mimo-v2.5-pro"]=131072
MODEL_CTX["umans-kimi-k2.6"]=262144
MODEL_CTX["umans-coder"]=262144
MODEL_CTX["umans-flash"]=131072
MODEL_CTX["umans-glm-5.1"]=131072
MODEL_CTX["groq/llama-4-maverick"]=131072
MODEL_CTX["groq/deepseek-r1-distill-qwen-32b"]=131072
MODEL_CTX["mistral/mistral-large"]=131072
MODEL_CTX["mistral/mistral-small"]=131072
MODEL_CTX["minimax/minimax-m1"]=262144
MODEL_CTX["zai/glm-4.5"]=131072
MODEL_CTX["byteplus/doubao-1.5-pro"]=131072
MODEL_CTX["siliconflow/deepseek-v4-pro"]=1048576
MODEL_CTX["novita/deepseek-v4-pro"]=1048576

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
    printf '%s' "$content" > "$tmp"
    rm -f "$path"
    mv "$tmp" "$path"
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
    mkdir -p "$DEEPCLAUDE_DIR"
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
    local haiku_prov="$5" haiku_model="$6" subagent_prov="$7" subagent_model="$8"

    mkdir -p "$DEEPCLAUDE_DIR"

    # Build defaults
    local defaults
    defaults=$(jq -n \
        --arg opus "${opus_prov}:${opus_model}" \
        --arg sonnet "${sonnet_prov}:${sonnet_model}" \
        --arg haiku "${haiku_prov}:${haiku_model}" \
        --arg subagent "${subagent_prov}:${subagent_model}" \
        '{opus: $opus, sonnet: $sonnet, haiku: $haiku, subagent: $subagent}')

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

# --- Config resolution ---
declare -A CONFIG_NAME CONFIG_OPUS CONFIG_SONNET CONFIG_HAIKU CONFIG_SUBAGENT

init_configs() {
    CONFIG_NAME[ds]="DeepSeek V4 Pro"
    CONFIG_OPUS[ds]="ds:deepseek-v4-pro"; CONFIG_SONNET[ds]="ds:deepseek-v4-pro"
    CONFIG_HAIKU[ds]="ds:deepseek-v4-flash"; CONFIG_SUBAGENT[ds]="ds:deepseek-v4-flash"

    CONFIG_NAME[or]="OpenRouter (owl-alpha)"
    CONFIG_OPUS[or]="or:openrouter/owl-alpha"; CONFIG_SONNET[or]="or:openrouter/owl-alpha"
    CONFIG_HAIKU[or]="or:z-ai/glm-4.5-air:free"; CONFIG_SUBAGENT[or]="or:z-ai/glm-4.5-air:free"

    CONFIG_NAME[or2]="OpenRouter (DeepSeek)"
    CONFIG_OPUS[or2]="or:deepseek/deepseek-v4-pro"; CONFIG_SONNET[or2]="or:deepseek/deepseek-v4-pro"
    CONFIG_HAIKU[or2]="or:deepseek/deepseek-v4-flash"; CONFIG_SUBAGENT[or2]="or:deepseek/deepseek-v4-flash"

    CONFIG_NAME[or3]="OpenRouter (best free)"
    CONFIG_OPUS[or3]="or:openai/gpt-oss-120b:free"; CONFIG_SONNET[or3]="or:poolside/laguna-m.1:free"
    CONFIG_HAIKU[or3]="or:z-ai/glm-4.5-air:free"; CONFIG_SUBAGENT[or3]="or:liquid/lfm-2.5-1.2b-instruct:free"

    CONFIG_NAME[fw]="Fireworks AI"
    CONFIG_OPUS[fw]="fw:accounts/fireworks/models/deepseek-v4-pro"
    CONFIG_SONNET[fw]="fw:accounts/fireworks/models/deepseek-v4-pro"
    CONFIG_HAIKU[fw]="fw:accounts/fireworks/models/deepseek-v4-pro"
    CONFIG_SUBAGENT[fw]="fw:accounts/fireworks/models/deepseek-v4-pro"

    CONFIG_NAME[oc]="OpenCode Zen"
    CONFIG_OPUS[oc]="oc:big-pickle"; CONFIG_SONNET[oc]="oc:big-pickle"
    CONFIG_HAIKU[oc]="oc:big-pickle"; CONFIG_SUBAGENT[oc]="oc:big-pickle"

    CONFIG_NAME["ds+oc"]="DeepSeek + OpenCode subs"
    CONFIG_OPUS["ds+oc"]="ds:deepseek-v4-pro"; CONFIG_SONNET["ds+oc"]="ds:deepseek-v4-pro"
    CONFIG_HAIKU["ds+oc"]="oc:big-pickle"; CONFIG_SUBAGENT["ds+oc"]="oc:big-pickle"

    CONFIG_NAME["ds+or"]="DeepSeek + OpenRouter subs"
    CONFIG_OPUS["ds+or"]="ds:deepseek-v4-pro"; CONFIG_SONNET["ds+or"]="ds:deepseek-v4-pro"
    CONFIG_HAIKU["ds+or"]="or:z-ai/glm-4.5-air:free"; CONFIG_SUBAGENT["ds+or"]="or:z-ai/glm-4.5-air:free"

    CONFIG_NAME[km]="Kimi K2.6"
    CONFIG_OPUS[km]="km:kimi-k2.6"; CONFIG_SONNET[km]="km:kimi-k2.6"
    CONFIG_HAIKU[km]="km:kimi-k2.6"; CONFIG_SUBAGENT[km]="km:kimi-k2.6"

    CONFIG_NAME[mm]="Xiaomi Mimo V2.5 Pro"
    CONFIG_OPUS[mm]="mm:mimo-v2.5-pro"; CONFIG_SONNET[mm]="mm:mimo-v2.5-pro"
    CONFIG_HAIKU[mm]="mm:mimo-v2.5-pro"; CONFIG_SUBAGENT[mm]="mm:mimo-v2.5-pro"

    CONFIG_NAME[um]="Umans Coder (Kimi K2.6)"
    CONFIG_OPUS[um]="um:umans-coder"; CONFIG_SONNET[um]="um:umans-coder"
    CONFIG_HAIKU[um]="um:umans-coder"; CONFIG_SUBAGENT[um]="um:umans-coder"

    CONFIG_NAME[gr]="Groq (Llama 4 Maverick)"
    CONFIG_OPUS[gr]="gr:groq/llama-4-maverick"; CONFIG_SONNET[gr]="gr:groq/llama-4-maverick"
    CONFIG_HAIKU[gr]="gr:groq/deepseek-r1-distill-qwen-32b"; CONFIG_SUBAGENT[gr]="gr:groq/deepseek-r1-distill-qwen-32b"

    CONFIG_NAME[mt]="Mistral Large"
    CONFIG_OPUS[mt]="mt:mistral/mistral-large"; CONFIG_SONNET[mt]="mt:mistral/mistral-large"
    CONFIG_HAIKU[mt]="mt:mistral/mistral-small"; CONFIG_SUBAGENT[mt]="mt:mistral/mistral-small"

    CONFIG_NAME[mx]="MiniMax M1"
    CONFIG_OPUS[mx]="mx:minimax/minimax-m1"; CONFIG_SONNET[mx]="mx:minimax/minimax-m1"
    CONFIG_HAIKU[mx]="mx:minimax/minimax-m1"; CONFIG_SUBAGENT[mx]="mx:minimax/minimax-m1"

    CONFIG_NAME[za]="Z.ai GLM 4.5"
    CONFIG_OPUS[za]="za:zai/glm-4.5"; CONFIG_SONNET[za]="za:zai/glm-4.5"
    CONFIG_HAIKU[za]="za:zai/glm-4.5"; CONFIG_SUBAGENT[za]="za:zai/glm-4.5"

    CONFIG_NAME[bp]="BytePlus Doubao 1.5 Pro"
    CONFIG_OPUS[bp]="bp:byteplus/doubao-1.5-pro"; CONFIG_SONNET[bp]="bp:byteplus/doubao-1.5-pro"
    CONFIG_HAIKU[bp]="bp:byteplus/doubao-1.5-pro"; CONFIG_SUBAGENT[bp]="bp:byteplus/doubao-1.5-pro"

    CONFIG_NAME[sf]="SiliconFlow (DeepSeek V4 Pro)"
    CONFIG_OPUS[sf]="sf:siliconflow/deepseek-v4-pro"; CONFIG_SONNET[sf]="sf:siliconflow/deepseek-v4-pro"
    CONFIG_HAIKU[sf]="sf:siliconflow/deepseek-v4-pro"; CONFIG_SUBAGENT[sf]="sf:siliconflow/deepseek-v4-pro"

    CONFIG_NAME[nv]="Novita (DeepSeek V4 Pro)"
    CONFIG_OPUS[nv]="nv:novita/deepseek-v4-pro"; CONFIG_SONNET[nv]="nv:novita/deepseek-v4-pro"
    CONFIG_HAIKU[nv]="nv:novita/deepseek-v4-pro"; CONFIG_SUBAGENT[nv]="nv:novita/deepseek-v4-pro"
}
init_configs

# --- Pre-flight checks ---
if ! command -v jq &>/dev/null; then
    echo "ERROR: deepclaude requires jq for JSON processing." >&2
    echo "  Install: brew install jq  (macOS)" >&2
    echo "       or: sudo apt install jq  (Debian/Ubuntu)" >&2
    echo "       or: sudo dnf install jq  (Fedora)" >&2
    exit 1
fi

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
    local slots=(opus sonnet haiku subagent)
    # Output: config_name, then for each slot: provider model
    local name_parts=()

    echo "Ad-hoc"

    for i in 0 1 2 3; do
        local idx
        case "$spec_count" in
            1) idx=0 ;;
            2) if [[ $i -lt 2 ]]; then idx=0; else idx=1; fi ;;
            3) if [[ $i -eq 0 ]]; then idx=0; elif [[ $i -eq 1 ]]; then idx=1; else idx=2; fi ;;
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

    for slot in opus sonnet haiku subagent; do
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
                '.[$pk] = {url: $url, keyEnv: $keyEnv, auth: $auth}')
        fi
    done

    # Include ALL models from ALL configs that have valid keys (for /model switching)
    for cfg in "${!CONFIG_NAME[@]}"; do
        for slot in opus sonnet haiku subagent; do
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
                        '.[$pk] = {url: $url, keyEnv: $keyEnv, auth: $auth}')
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
    local proxy_script="${SCRIPT_DIR}/proxy/start-proxy.js"

    if [[ ! -f "$proxy_script" ]]; then
        echo "ERROR: Proxy script not found at $proxy_script" >&2
        exit 1
    fi

    if ! command -v node &>/dev/null; then
        echo "ERROR: Node.js is not installed or not in PATH. Install from https://nodejs.org" >&2
        exit 1
    fi

    local out_file err_file
    out_file=$(mktemp)
    err_file=$(mktemp)

    node "$proxy_script" --routes "$routes_file" --overrides "$SLOT_OVERRIDES_FILE" \
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
    clear_proxy_state
}

# --- Set CC environment variables ---
set_cc_env() {
    local proxy_port="$1" opus_model="$2" sonnet_model="$3" haiku_model="$4" subagent_model="$5"
    local opus_ctxt_model="$6"  # model ID for context limit lookup

    export ANTHROPIC_BASE_URL="http://127.0.0.1:${proxy_port}"
    export ANTHROPIC_AUTH_TOKEN="proxy"
    export ANTHROPIC_MODEL="opus:${opus_model}"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="opus:${opus_model}"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="sonnet:${sonnet_model}"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="haiku:${haiku_model}"
    export CLAUDE_CODE_SUBAGENT_MODEL="subagent:${subagent_model}"
    export CLAUDE_CODE_EFFORT_LEVEL="$EFFORT"
    unset ANTHROPIC_API_KEY 2>/dev/null || true

    local opus_ctx="${MODEL_CTX[$opus_ctxt_model]:-}"
    if [[ -n "$opus_ctx" ]]; then
        if (( opus_ctx >= 1048576 )); then
            export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$opus_ctx"
        elif (( opus_ctx >= 200000 )); then
            export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$opus_ctx"
            export DISABLE_COMPACT="1"
        elif (( opus_ctx > 131072 )); then
            export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$opus_ctx"
            export DISABLE_COMPACT="1"
        else
            export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$opus_ctx"
        fi
    fi

    export CLAUDE_CONTEXT_COMPRESSION='true'
}

clear_anthropic_env() {
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL \
          ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
          ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL \
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
    for cfg in ds or or2 or3 fw oc km mm um gr mt mx za bp sf nv "ds+oc" "ds+or"; do
        local label=""
        [[ "$cfg" == "ds" ]] && label=" (default)"
        local provs=()
        for slot in opus sonnet haiku subagent; do
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
        for slot in opus sonnet haiku subagent; do
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
    echo ""
}

show_cost() {
    echo ""
    echo "  DeepSeek V4 Pro Pricing"
    echo "  ======================="
    echo ""
    echo "  Provider        Input/M    Output/M   Cache Hit/M"
    echo "  ----------      --------   --------   -----------"
    echo "  DeepSeek        \$0.44      \$0.87      \$0.004"
    echo "  OpenRouter      \$0.44      \$0.87      (provider)"
    echo "  Fireworks       \$1.74      \$3.48      (provider)"
    echo "  Anthropic       \$3.00      \$15.00     \$0.30"
    echo ""
    echo "  Monthly estimate (heavy use): \$30-80 vs \$200 Anthropic"
    echo ""
}

show_help() {
    echo "deepclaude - Claude Code with cheap backends (provider-agnostic)"
    echo ""
    echo "Usage: deepclaude [spec1] [spec2] [spec3] [spec4]   (positional mode)"
    echo "       deepclaude [-b backend] [--status] [--doctor] [--version]"
    echo ""
    echo "  Each positional arg is providerKey:modelId, mapping to opus/sonnet/haiku/subagent."
    echo "  Fewer than 4 specs repeats the last one for remaining slots."
    echo ""
    echo "  Examples:"
    echo "    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free"
    echo "    deepclaude ds:deepseek-v4-pro oc:big-pickle    (opus/sonnet=DS, haiku/sub=OC)"
    echo "    deepclaude ds:deepseek-v4-pro                  (all slots use DS)"
    echo "    deepclaude -b ds+oc                            (named mixed config)"
    echo "    deepclaude -b or                               (named config)"
    echo ""
    echo "  Named configs: ds, or, or2, or3, fw, oc, km, mm, um, gr, mt, mx, za, bp, sf, nv, ds+oc, ds+or, anthropic"
    echo "  --status        Show keys, configs, and active slot mapping"
    echo "  --doctor        System health check (prereqs, keys, proxy test)"
    echo "  --cost          Pricing comparison"
    echo "  --benchmark     Latency test across all configs"
    echo "  --models        List all available models (for use with /model in CC)"
    echo "  --effort LEVEL   Claude Code effort level (default: max)"
    echo "  --lint                 Lint with shellcheck"
  echo "  --fix-av               Windows Defender exclusion reminder"
  echo "  --install-statusline   Auto-install statusline to ~/.claude/"
  echo "  --set-slot SLOT MODEL  Override a slot: opus/sonnet/haiku/subagent"
    echo "  --persist       Keep proxy running after CC exits"
    echo "  --switch CONFIG  Switch active config of a running persistent proxy"
    echo "  --stop-proxy    Kill the persistent proxy"
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
}

show_version() {
    local mtime=""
    if [[ -f "$0" ]]; then
        mtime=$(date -r "$0" "+%Y-%m-%d %H:%M" 2>/dev/null || stat -c '%y' "$0" 2>/dev/null | cut -d. -f1 || echo "unknown")
    fi
    echo "deepclaude v1.0.0 ($mtime)"
    echo "Proxy: ${SCRIPT_DIR}/proxy/start-proxy.js"
}

show_models() {
    echo ""
    echo "  deepclaude - Available Models"
    echo "  ================================"
    echo ""

    declare -A by_provider
    for cfg in "${!CONFIG_NAME[@]}"; do
        for slot in opus sonnet haiku subagent; do
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
                for slot in opus sonnet haiku subagent; do
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
    local proxy_script="${SCRIPT_DIR}/proxy/start-proxy.js"
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
    mkdir -p "$DEEPCLAUDE_DIR"

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
        for slot in opus sonnet haiku subagent; do
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
            for cfg in ds or or2 or3 fw oc km mm um gr mt mx za bp sf nv ds+oc ds+or anthropic; do
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

    local configs="ds or or2 or3 fw oc km mm um gr mt mx za bp sf nv"
    local results_dir
    results_dir=$(mktemp -d)
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

    if [[ ! "$slot_name" =~ ^(opus|sonnet|haiku|subagent)$ ]]; then
        echo "ERROR: Invalid slot '$slot_name'. Use: opus, sonnet, haiku, subagent" >&2
        exit 1
    fi

    mkdir -p "$DEEPCLAUDE_DIR"

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

handle_switch() {
    local target="$1"

    mkdir -p "$DEEPCLAUDE_DIR"

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
    local haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
    while IFS=' ' read -r slot prov model; do
        case "$slot" in
            opus) opus_prov="$prov"; opus_model="$model" ;;
            sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
            haiku) haiku_prov="$prov"; haiku_model="$model" ;;
            subagent) subagent_prov="$prov"; subagent_model="$model" ;;
        esac
    done <<< "$slot_data"
    init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
        "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model"

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

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--backend)
            BACKEND="$2"; shift 2 ;;
        -r|--remote)
            REMOTE=true; ACTION="remote"; shift ;;
        --effort)
            EFFORT="$2"; shift 2 ;;
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
                tmp=$(mktemp)
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
        --set-slot)
            local slot_name="${2:-}" slot_model="$3"
            ACTION="set-slot"
            SLOT_NAME="$slot_name"
            SLOT_MODEL="$slot_model"
            shift 3
            [[ "$slot_name" == -* ]] && { echo "ERROR: --set-slot requires SLOT and MODEL"; exit 1; }
            ;;
        --switch)
            ACTION="switch"
            SWITCH_TARGET="$2"; shift 2
            ;;
        --lint)
            echo "Lint: Use shellcheck on this script."; exit 0 ;;
        --fix-av)
            echo "AV exclusion is Windows-only. Ensure $(dirname "$0") is excluded."; exit 0 ;;
        *)
            if [[ "$1" =~ ^[a-z][a-z0-9_-]*:.+$ ]]; then
                SPECS+=("$1")
                ACTION="launch-pos"
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
case "$ACTION" in
    status)     show_status ;;
    cost)       show_cost ;;
    benchmark)  run_benchmark ;;
    help)       show_help ;;
    version)    show_version ;;
    doctor)     run_doctor "${BACKEND:-ds}" ;;
    models)     show_models ;;
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
        local config_name slot_data
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
        local routes_json
        routes_json=$(echo "$slot_data" | build_routes_json)

        local proxy_port proxy_pid
        mkdir -p "$DEEPCLAUDE_DIR"

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
                for attempt in 1 2; do
                    wait "$proxy_pid" 2>/dev/null
                    wait_rc=$?
                    if [[ $wait_rc -le 128 ]]; then
                        break
                    fi
                    echo "Proxy crashed. Restarting (attempt $attempt)..." >&2
                    read -r proxy_port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")" || true
                done
            ) &
            watchdog_pid=$!
        fi

        # Init slot overrides
        local opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
        local haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
        while IFS=' ' read -r slot prov model; do
            case "$slot" in
                opus) opus_prov="$prov"; opus_model="$model" ;;
                sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
                haiku) haiku_prov="$prov"; haiku_model="$model" ;;
                subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            esac
        done <<< "$slot_data"
        init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
            "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model"

        # Get actual models from overrides
        local opus_m sonnet_m haiku_m sub_m
        opus_m=$(get_slot_model "opus" "${opus_prov}:${opus_model}")
        sonnet_m=$(get_slot_model "sonnet" "${sonnet_prov}:${sonnet_model}")
        haiku_m=$(get_slot_model "haiku" "${haiku_prov}:${haiku_model}")
        sub_m=$(get_slot_model "subagent" "${subagent_prov}:${subagent_model}")

        echo "  Launching remote control..."
        echo ""

        set_cc_env "$proxy_port" "$opus_m" "$sonnet_m" "$haiku_m" "$sub_m" "$opus_model"
        claude --effort "$EFFORT" --dangerously-skip-permissions remote-control "$@"
        local claude_exit=$?
        if ! $PERSIST; then
            stop_proxy_info "$proxy_pid"
        fi
        clear_anthropic_env
        exit $claude_exit
        ;;
    launch-pos)
        # Ad-hoc positional specs
        local config_name slot_data
        config_name=$(build_adhoc_config "${SPECS[@]}" | head -1)
        slot_data=$(build_adhoc_config "${SPECS[@]}" | tail -n +2)

        echo ""
        echo "  Launching Claude Code via $config_name..."

        # Build routes
        local routes_json
        routes_json=$(echo "$slot_data" | build_routes_json)

        mkdir -p "$DEEPCLAUDE_DIR"
        local proxy_port proxy_pid

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
                for attempt in 1 2; do
                    wait "$proxy_pid" 2>/dev/null
                    wait_rc=$?
                    if [[ $wait_rc -le 128 ]]; then
                        break
                    fi
                    echo "Proxy crashed. Restarting (attempt $attempt)..." >&2
                    read -r proxy_port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")" || true
                done
            ) &
            watchdog_pid=$!
        fi

        # Init slot overrides
        local opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
        local haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
        while IFS=' ' read -r slot prov model; do
            case "$slot" in
                opus) opus_prov="$prov"; opus_model="$model" ;;
                sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
                haiku) haiku_prov="$prov"; haiku_model="$model" ;;
                subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            esac
        done <<< "$slot_data"
        init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
            "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model"

        # Resolve actual models from overrides
        local opus_m sonnet_m haiku_m sub_m
        opus_m=$(get_slot_model "opus" "${opus_prov}:${opus_model}")
        sonnet_m=$(get_slot_model "sonnet" "${sonnet_prov}:${sonnet_model}")
        haiku_m=$(get_slot_model "haiku" "${haiku_prov}:${haiku_model}")
        sub_m=$(get_slot_model "subagent" "${subagent_prov}:${subagent_model}")

        # Show routing
        echo "  Routing:"
        while IFS=' ' read -r slot prov model; do
            printf "    %-10s %s:%s  ->  %s\n" "$slot" "$prov" "$model" "${PROVIDER_NAME[$prov]}"
        done <<< "$slot_data"
        echo ""

        set_cc_env "$proxy_port" "$opus_m" "$sonnet_m" "$haiku_m" "$sub_m" "$opus_model"

        # Setup cleanup trap
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
        trap cleanup_proxy EXIT

        claude --effort "$EFFORT" --dangerously-skip-permissions "$@"
        local claude_exit=$?
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
        local config_name slot_data
        config_name=$(resolve_config "$BACKEND" | head -1)
        slot_data=$(resolve_config "$BACKEND" | tail -n +2)

        echo ""
        echo "  Launching Claude Code via $config_name..."

        # Show provider names
        local prov_keys=()
        while IFS=' ' read -r _ prov _; do
            if [[ ! " ${prov_keys[*]} " =~ " $prov " ]]; then
                prov_keys+=("$prov")
            fi
        done <<< "$slot_data"
        local prov_names=""
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
        local routes_json
        routes_json=$(echo "$slot_data" | build_routes_json)

        mkdir -p "$DEEPCLAUDE_DIR"
        local proxy_port proxy_pid

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
                for attempt in 1 2; do
                    wait "$proxy_pid" 2>/dev/null
                    wait_rc=$?
                    if [[ $wait_rc -le 128 ]]; then
                        break
                    fi
                    echo "Proxy crashed. Restarting (attempt $attempt)..." >&2
                    read -r proxy_port proxy_pid <<< "$(start_proxy "$CURRENT_ROUTES_FILE")" || true
                done
            ) &
            watchdog_pid=$!
        fi

        # Init slot overrides
        local opus_prov="" opus_model="" sonnet_prov="" sonnet_model=""
        local haiku_prov="" haiku_model="" subagent_prov="" subagent_model=""
        while IFS=' ' read -r slot prov model; do
            case "$slot" in
                opus) opus_prov="$prov"; opus_model="$model" ;;
                sonnet) sonnet_prov="$prov"; sonnet_model="$model" ;;
                haiku) haiku_prov="$prov"; haiku_model="$model" ;;
                subagent) subagent_prov="$prov"; subagent_model="$model" ;;
            esac
        done <<< "$slot_data"
        init_slot_overrides "$opus_prov" "$opus_model" "$sonnet_prov" "$sonnet_model" \
            "$haiku_prov" "$haiku_model" "$subagent_prov" "$subagent_model"

        # Resolve actual models from overrides
        local opus_m sonnet_m haiku_m sub_m
        opus_m=$(get_slot_model "opus" "${opus_prov}:${opus_model}")
        sonnet_m=$(get_slot_model "sonnet" "${sonnet_prov}:${sonnet_model}")
        haiku_m=$(get_slot_model "haiku" "${haiku_prov}:${haiku_model}")
        sub_m=$(get_slot_model "subagent" "${subagent_prov}:${subagent_model}")

        set_cc_env "$proxy_port" "$opus_m" "$sonnet_m" "$haiku_m" "$sub_m" "$opus_model"

        # Setup cleanup trap
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
        trap cleanup_proxy EXIT

        claude --effort "$EFFORT" --dangerously-skip-permissions "$@"
        local claude_exit=$?
        cleanup_proxy
        exit $claude_exit
        ;;
esac
