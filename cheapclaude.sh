#!/usr/bin/env bash
# cheapclaude — Use Claude Code with DeepSeek V4 Pro or other cheap backends
# Usage: cheapclaude [--backend ds|or|fw|anthropic] [--status] [--cost] [--benchmark]

set -euo pipefail

# --- Config ---
DEEPSEEK_URL="https://api.deepseek.com/anthropic"
OPENROUTER_URL="https://openrouter.ai/api"
FIREWORKS_URL="https://api.fireworks.ai/inference"

BACKEND="${CHEAPCLAUDE_DEFAULT_BACKEND:-ds}"
ACTION="launch"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --status)     ACTION="status"; shift ;;
        --cost)       ACTION="cost"; shift ;;
        --benchmark)  ACTION="benchmark"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        *)            break ;;  # pass remaining args to claude
    esac
done

mask_key() {
    local k="$1"
    if [[ -z "$k" ]]; then echo "MISSING"; else echo "set (****${k: -4})"; fi
}

show_status() {
    echo ""
    echo "  cheapclaude — Backend Status"
    echo "  ============================"
    echo ""
    echo "  Keys:"
    echo "    DEEPSEEK_API_KEY:    $(mask_key "${DEEPSEEK_API_KEY:-}")"
    echo "    OPENROUTER_API_KEY:  $(mask_key "${OPENROUTER_API_KEY:-}")"
    echo "    FIREWORKS_API_KEY:   $(mask_key "${FIREWORKS_API_KEY:-}")"
    echo ""
    echo "  Backends:"
    echo "    cheapclaude              # DeepSeek V4 Pro (default)"
    echo "    cheapclaude -b or        # OpenRouter (cheapest)"
    echo "    cheapclaude -b fw        # Fireworks AI (fastest)"
    echo "    cheapclaude -b anthropic # Normal Claude Code"
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
    echo "  Monthly estimate (heavy use, 25 days): \$30-80"
    echo ""
}

show_help() {
    echo "cheapclaude — Claude Code with cheap backends"
    echo ""
    echo "Usage: cheapclaude [options] [-- claude-args...]"
    echo ""
    echo "Options:"
    echo "  -b, --backend <ds|or|fw|anthropic>  Backend (default: ds)"
    echo "  --status                             Show keys and backends"
    echo "  --cost                               Show pricing"
    echo "  --benchmark                          Latency test"
    echo "  -h, --help                           This help"
    echo ""
    echo "Environment variables:"
    echo "  DEEPSEEK_API_KEY      DeepSeek API key (required for ds)"
    echo "  OPENROUTER_API_KEY    OpenRouter API key (required for or)"
    echo "  FIREWORKS_API_KEY     Fireworks API key (required for fw)"
    echo "  CHEAPCLAUDE_DEFAULT_BACKEND  Default backend (default: ds)"
}

run_benchmark() {
    echo ""
    echo "  Latency Benchmark (1 request each)"
    echo "  ==================================="
    for name in deepseek openrouter fireworks; do
        case "$name" in
            deepseek)   url="$DEEPSEEK_URL"; key="${DEEPSEEK_API_KEY:-}"; model="deepseek-v4-pro" ;;
            openrouter) url="$OPENROUTER_URL"; key="${OPENROUTER_API_KEY:-}"; model="deepseek/deepseek-v4-pro" ;;
            fireworks)  url="$FIREWORKS_URL"; key="${FIREWORKS_API_KEY:-}"; model="accounts/fireworks/models/deepseek-v4-pro" ;;
        esac
        if [[ -z "$key" ]]; then echo "  $name: SKIP (no key)"; continue; fi
        local start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url/v1/messages" \
            -H "x-api-key: $key" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
            -d "{\"model\":\"$model\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply: ok\"}]}" \
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
    local url="" key="" opus="" sonnet="" haiku="" subagent=""

    case "$BACKEND" in
        ds|deepseek)
            key="${DEEPSEEK_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DEEPSEEK_API_KEY not set"; exit 1; }
            url="$DEEPSEEK_URL"
            opus="deepseek-v4-pro"; sonnet="deepseek-v4-pro"
            haiku="deepseek-v4-flash"; subagent="deepseek-v4-flash"
            ;;
        or|openrouter)
            key="${OPENROUTER_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENROUTER_API_KEY not set"; exit 1; }
            url="$OPENROUTER_URL"
            opus="deepseek/deepseek-v4-pro"; sonnet="deepseek/deepseek-v4-pro"
            haiku="deepseek/deepseek-v4-pro"; subagent="deepseek/deepseek-v4-pro"
            ;;
        fw|fireworks)
            key="${FIREWORKS_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: FIREWORKS_API_KEY not set"; exit 1; }
            url="$FIREWORKS_URL"
            opus="accounts/fireworks/models/deepseek-v4-pro"
            sonnet="accounts/fireworks/models/deepseek-v4-pro"
            haiku="accounts/fireworks/models/deepseek-v4-pro"
            subagent="accounts/fireworks/models/deepseek-v4-pro"
            ;;
        anthropic)
            echo "  Launching Claude Code (normal Anthropic backend)..."
            unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
            unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
            unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
            unset CLAUDE_CODE_EFFORT_LEVEL
            exec claude "$@"
            ;;
        *)
            echo "ERROR: Unknown backend '$BACKEND'. Use: ds, or, fw, anthropic"
            exit 1
            ;;
    esac

    echo "  Launching Claude Code via $BACKEND..."
    echo "  Endpoint: $url"
    echo "  Model: $opus (main) + $haiku (subagents)"
    echo ""

    export ANTHROPIC_BASE_URL="$url"
    export ANTHROPIC_AUTH_TOKEN="$key"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$opus"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$sonnet"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$haiku"
    export CLAUDE_CODE_SUBAGENT_MODEL="$subagent"
    export CLAUDE_CODE_EFFORT_LEVEL="max"
    unset ANTHROPIC_API_KEY

    exec claude "$@"
}

# --- Main ---
case "$ACTION" in
    status)    show_status ;;
    cost)      show_cost ;;
    benchmark) run_benchmark ;;
    help)      show_help ;;
    launch)    launch_claude "$@" ;;
esac
