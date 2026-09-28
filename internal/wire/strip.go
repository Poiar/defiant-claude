package wire

import (
	"encoding/json"
	"reflect"
	"strings"
)

// stripFieldsByProvider mirrors the TS PROVIDER_CONSTRAINTS stripFields.
// Providers absent from the map are not stripped.
var stripFieldsByProvider = map[string][]string{
	"an": {},
	"ds": {"metadata"},
	"or": {"top_k", "metadata"},
	"fw": {},
	"oc": {"metadata"},
	"al": {"top_k", "metadata"},
	"km": {"top_k", "metadata"},
	"mm": {"top_k", "metadata"},
	"um": {},
	"gr": {"top_k", "metadata"},
	"mt": {"top_k", "metadata"},
	"mx": {"top_k", "metadata"},
	"za": {"top_k", "metadata"},
	"bp": {"top_k", "metadata"},
	"sf": {"top_k", "metadata"},
	"nv": {"top_k", "metadata"},
	"oa": {"top_k", "metadata"},
	"xa": {"top_k", "metadata"},
	"lo": {"top_k", "metadata"},
	"gm": {"top_k", "metadata", "stop_sequences"},
}

// Strip removes provider-unsupported Anthropic fields, the x-anthropic
// billing-header system block, prompt-cache cache_control markers, and
// consecutive duplicate messages. Applied to the Anthropic body before
// translation; for Anthropic-format providers (ds, oc) it keeps the upstream
// body byte-stable so DeepSeek's disk cache hits ($0.0036/M vs $0.435/M).
func Strip(body []byte, providerKey string) ([]byte, error) {
	fields, ok := stripFieldsByProvider[providerKey]
	if !ok || len(fields) == 0 {
		return body, nil
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	for _, f := range fields {
		delete(m, f)
	}
	stripBillingHeader(m)
	stripCacheControl(m)
	stripDuplicateMessages(m)
	return json.Marshal(m)
}

// stripBillingHeader removes the system text block containing the
// x-anthropic-billing-header marker (Anthropic billing metadata with a
// per-request cch hash that defeats upstream disk caching).
func stripBillingHeader(m map[string]any) {
	system, ok := m["system"].([]any)
	if !ok {
		return
	}
	for i, raw := range system {
		block, ok := raw.(map[string]any)
		if !ok || block["type"] != "text" {
			continue
		}
		if text, ok := block["text"].(string); ok && strings.Contains(text, "x-anthropic-billing-header") {
			m["system"] = append(system[:i], system[i+1:]...)
			return
		}
	}
}

// stripCacheControl removes cache_control from every content block — it is
// Anthropic prompt-caching metadata that non-Anthropic providers ignore but
// that adds per-turn variance.
func stripCacheControl(m map[string]any) {
	messages, ok := m["messages"].([]any)
	if !ok {
		return
	}
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok {
			continue
		}
		for _, rawBlock := range content {
			if block, ok := rawBlock.(map[string]any); ok {
				delete(block, "cache_control")
			}
		}
	}
}

// stripDuplicateMessages removes consecutive messages with identical role and
// content (Claude Code sometimes resends a tool_result on retry).
func stripDuplicateMessages(m map[string]any) {
	messages, ok := m["messages"].([]any)
	if !ok || len(messages) < 2 {
		return
	}
	i := 1
	for i < len(messages) {
		prev, ok1 := messages[i-1].(map[string]any)
		curr, ok2 := messages[i].(map[string]any)
		if ok1 && ok2 && prev["role"] == curr["role"] &&
			reflect.DeepEqual(prev["content"], curr["content"]) {
			messages = append(messages[:i], messages[i+1:]...)
			m["messages"] = messages
		} else {
			i++
		}
	}
}
