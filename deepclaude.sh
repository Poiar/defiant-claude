#!/usr/bin/env bash
# deepclaude — Use Claude Code with DeepSeek V4 Pro or other cheap backends
# Usage: deepclaude [--backend ds|or|or2|or3|fw|oc|anthropic] [--remote] [--status] [--cost] [--benchmark]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Config ---
DEEPSEEK_URL="https://api.deepseek.com/anthropic"
OPENROUTER_URL="https://openrouter.ai/api"
FIREWORKS_URL="https://api.fireworks.ai/inference"
OPENCODEZEN_URL="https://opencode.ai/zen"

BACKEND="${DEEPCLAUDE_DEFAULT_BACKEND:-${CHEAPCLAUDE_DEFAULT_BACKEND:-ds}}"
ACTION="launch"
PROXY_PID=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --remote|-r)  ACTION="remote"; shift ;;
        --status)     ACTION="status"; shift ;;
        --cost)       ACTION="cost"; shift ;;
        --benchmark)  ACTION="benchmark"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        *)            break ;;
    esac
done

cleanup_proxy() {
    if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
        kill "$PROXY_PID" 2>/dev/null || true
        echo "  Proxy stopped."
    fi
}
trap cleanup_proxy EXIT

mask_key() {
    local k="$1"
    if [[ -z "$k" ]]; then echo "MISSING"; else echo "set (****${k: -4})"; fi
}

clear_anthropic_env() {
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL \
          ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
          ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL \
          ANTHROPIC_API_KEY 2>/dev/null || true
}

resolve_backend() {
    local url="" key="" opus="" sonnet="" haiku="" subagent=""
    # Alibaba/DashScope configuration
ALIBABA_URL="https://dashscope.aliyuncs.com/api/v1/chat/completions"
ALIBABA_API_KEY="${ALIBABA_DASHSCOPE_API_KEY:-${ALIBABA_DASHSCOPE_API_KEY:-}}"

case "$BACKEND" in
        ds|deepseek)
            key="${DEEPSEEK_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DEEPSEEK_API_KEY not set" >&2; exit 1; }
            url="$DEEPSEEK_URL"
            opus="deepseek-v4-pro"; sonnet="deepseek-v4-pro"
            haiku="deepseek-v4-flash"; subagent="deepseek-v4-flash"
            ;;
        or|openrouter)
            key="${OPENROUTER_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENROUTER_API_KEY not set" >&2; exit 1; }
            url="$OPENROUTER_URL"
            opus="openrouter/owl-alpha"; sonnet="openrouter/owl-alpha"
            haiku="z-ai/glm-4.5-air:free"; subagent="z-ai/glm-4.5-air:free"
            ;;
        or2)
            key="${OPENROUTER_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENROUTER_API_KEY not set" >&2; exit 1; }
            url="$OPENROUTER_URL"
            opus="deepseek/deepseek-v4-pro"; sonnet="deepseek/deepseek-v4-pro"
            haiku="deepseek/deepseek-v4-flash"; subagent="deepseek/deepseek-v4-flash"
            ;;
        or3)
            key="${OPENROUTER_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENROUTER_API_KEY not set" >&2; exit 1; }
            url="$OPENROUTER_URL"
            opus="openai/gpt-oss-120b:free"; sonnet="poolside/laguna-m.1:free"
            haiku="z-ai/glm-4.5-air:free"; subagent="liquid/lfm-2.5-1.2b-instruct:free"
            ;;
        al)
            key="$ALIBABA_API_KEY"
            [[ -z "$key" ]] && { echo "ERROR: ALIBABA_DASHSCOPE_API_KEY not set" >&2; exit 1; }
            url="$ALIBABA_URL"
            opus="alibaba/your-opus-model"
            sonnet="alibaba/your-sonnet-model"
            haiku="alibaba/your-haiku-model"
            subagent="alibaba/your-subagent-model"
            ;;
        fw|fireworks)
            key="${FIREWORKS_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: FIREWORKS_API_KEY not set" >&2; exit 1; }
            url="$FIREWORKS_URL"
            opus="accounts/fireworks/models/deepseek-v4-pro"
            sonnet="accounts/fireworks/models/deepseek-v4-pro"
            haiku="accounts/fireworks/models/deepseek-v4-pro"
            subagent="accounts/fireworks/models/deepseek-v4-pro"
            ;;
        oc|opencodezen)
            key="${OPENCODE_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENCODE_API_KEY not set" >&2; exit 1; }
            url="$OPENCODEZEN_URL"
            opus="big-pickle"; sonnet="big-pickle"
            haiku="big-pickle"; subagent="big-pickle"
            ;;
        anthropic) ;;
        *) echo "ERROR: Unknown backend '$BACKEND'. Use: ds, or, or2, or3, fw, oc, anthropic" >&2; exit 1 ;;
    esac
    RESOLVED_URL="$url"; RESOLVED_KEY="$key"
    RESOLVED_OPUS="$opus"; RESOLVED_SONNET="$sonnet"
    RESOLVED_HAIKU="$haiku"; RESOLVED_SUBAGENT="$subagent"
    RESOLVED_BACKEND_NAME="$BACKEND"
}

set_model_env() {
    export ANTHROPIC_BASE_URL="$RESOLVED_URL"
    export ANTHROPIC_AUTH_TOKEN="$RESOLVED_KEY"
    export ANTHROPIC_MODEL="$RESOLVED_OPUS"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$RESOLVED_OPUS"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$RESOLVED_SONNET"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$RESOLVED_HAIKU"
    export CLAUDE_CODE_SUBAGENT_MODEL="$RESOLVED_SUBAGENT"
    unset ANTHROPIC_API_KEY 2>/dev/null || true
}

show_status() {
    echo ""
    echo "  deepclaude - Backend Status"
    echo "  ============================"
    echo ""
    echo "  Keys:"
    echo "    DEEPSEEK_API_KEY:    $(mask_key "${DEEPSEEK_API_KEY:-}")"
    echo "    OPENROUTER_API_KEY:  $(mask_key "${OPENROUTER_API_KEY:-}")"
    echo "    FIREWORKS_API_KEY:   $(mask_key "${FIREWORKS_API_KEY:-}")"
    echo "    OPENCODE_API_KEY: $(mask_key "${OPENCODE_API_KEY:-}")"
    echo ""
    echo "  Backends:"
    echo "    deepclaude              # DeepSeek V4 Pro (default)"
    echo "    deepclaude -b or        # OpenRouter (owl-alpha)"
    echo "    deepclaude -b or2       # OpenRouter (deepseek)"
    echo "    deepclaude -b or3       # OpenRouter (best free)"
    echo "    deepclaude -b fw        # Fireworks AI (fastest)"
    echo "    deepclaude -b oc        # OpenCode Zen"
    echo "    deepclaude -b anthropic # Normal Claude Code"
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
    echo "deepclaude - Claude Code with cheap backends"
    echo ""
    echo "Usage: deepclaude [-b backend] [--status] [--cost] [--benchmark]"
    echo ""
    echo "  -b, --backend   ds (default), or, or2, or3, fw, oc, anthropic"
    echo "  --status        Show keys and backends"
    echo "  --cost          Pricing comparison"
    echo "  --benchmark     Latency test"
}

run_benchmark() {
    echo ""
    echo "  Latency Benchmark"
    echo "  =================="
    for id in ds or or2 or3 fw oc; do
        BACKEND="$id"
        resolve_backend
        local name="$RESOLVED_URL"
        # Extract provider name from URL
        case "$id" in
            ds)  name="DeepSeek (direct)" ;;
            or)  name="OpenRouter" ;;
            or2) name="OpenRouter (or2)" ;;
            or3) name="OpenRouter (or3)" ;;
            fw)  name="Fireworks AI" ;;
            oc)  name="OpenCode Zen" ;;
        esac
        if [[ -z "$RESOLVED_KEY" ]]; then echo "  $name: SKIP (no key)"; continue; fi

        # Bearer auth for OpenRouter/Fireworks/OpenCodeZen, x-api-key for DeepSeek
        local auth_header=""
        case "$id" in
            or|or2|or3|fw|oc) auth_header="Authorization: Bearer $RESOLVED_KEY" ;;
            ds)               auth_header="x-api-key: $RESOLVED_KEY" ;;
        esac

        local start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$RESOLVED_URL/v1/messages" \
            -H "$auth_header" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
            -d "{\"model\":\"$RESOLVED_OPUS\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply: ok\"}]}" \
            --max-time 30 2>/dev/null || echo "timeout")
        local end_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local elapsed=$((end_ms - start_ms))
        if [[ "$status" == "200" ]]; then
            echo "  $name: OK (${elapsed}ms)"
        else
            echo "  $name: FAIL ($status, ${elapsed}ms)"
        fi
    done
    echo ""
}

launch_claude() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        clear_anthropic_env
        echo ""
        echo "  Launching Claude Code (normal Anthropic)..."
        echo ""
        exec claude --effort max --dangerously-skip-permissions "$@"
    fi

    resolve_backend

    echo ""
    echo "  Launching Claude Code via $BACKEND..."
    echo "  Endpoint: $RESOLVED_URL"
    echo "  Model: $RESOLVED_OPUS (main) + $RESOLVED_HAIKU (subagents)"
    echo ""

    set_model_env

    exec claude --effort max --dangerously-skip-permissions "$@"

    clear_anthropic_env
}

launch_remote() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        clear_anthropic_env
        echo ""
        echo "  Launching remote control (Anthropic)..."
        echo ""
        exec claude --effort max --dangerously-skip-permissions remote-control "$@"
    fi

    resolve_backend

    echo ""
    echo "  Starting model proxy for $BACKEND..."

    if ! command -v node &>/dev/null; then
        echo "ERROR: node is not installed or not in PATH" >&2
        exit 1
    fi

    local proxy_script="$SCRIPT_DIR/proxy/start-proxy.js"
    if [[ ! -f "$proxy_script" ]]; then
        echo "ERROR: Proxy script not found at $proxy_script" >&2
        exit 1
    fi

    local port_file
    port_file=$(mktemp)
    local proxy_err_file
    proxy_err_file=$(mktemp)
    node "$proxy_script" "$RESOLVED_URL" "$RESOLVED_KEY" > "$port_file" 2> "$proxy_err_file" &
    PROXY_PID=$!

    local tries=0
    while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
        sleep 0.2
        tries=$((tries + 1))
    done

    if [[ ! -s "$port_file" ]]; then
        echo "ERROR: Proxy failed to start" >&2
        if [[ -s "$proxy_err_file" ]]; then
            echo "  Proxy stderr:" >&2
            cat "$proxy_err_file" >&2
        fi
        rm -f "$port_file" "$proxy_err_file"
        exit 1
    fi

    local proxy_port
    proxy_port=$(head -1 "$port_file")
    rm -f "$port_file" "$proxy_err_file"

    echo "  Proxy on :$proxy_port -> $RESOLVED_URL"
    echo "  Launching remote control via $BACKEND..."
    echo ""

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    set_model_env
    unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || true

    claude --effort max --dangerously-skip-permissions remote-control "$@"
}

# --- Main ---
case "$ACTION" in
    status)    show_status ;;
    cost)      show_cost ;;
    benchmark) run_benchmark ;;
    help)      show_help ;;
    remote)    launch_remote "$@" ;;
    launch)    launch_claude "$@" ;;
esac
