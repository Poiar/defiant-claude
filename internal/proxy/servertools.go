package proxy

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Poiar/defiant-claude/internal/servertools"
)

// preprocessServerTools rewrites the Anthropic-format request body:
//   - for non-native providers, converts web_search_*/web_fetch_* tool defs
//     into generic web_search/web_fetch custom tools the provider can invoke;
//   - fills empty web_search/web_fetch tool_results with server-side results
//     (the upstream provider returned a tool_use that Claude Code can't run).
//
// Returns the (possibly unchanged) body. Network I/O happens only when there
// are empty web tool_results to populate.
func preprocessServerTools(body []byte, nonNative bool) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body, nil
	}
	modified := false

	if nonNative {
		if raw, ok := m["tools"]; ok {
			converted, changed := convertServerTools(raw)
			if changed {
				m["tools"] = converted
				modified = true
			}
		}
	}

	if raw, ok := m["messages"]; ok {
		populated, changed, err := populateToolResults(raw)
		if err != nil {
			return body, err
		}
		if changed {
			m["messages"] = populated
			modified = true
		}
	}

	if !modified {
		return body, nil
	}
	return json.Marshal(m)
}

// convertServerTools rewrites Anthropic web_search_*/web_fetch_*/url_fetch_*
// tool definitions into generic web_search/web_fetch custom tools. Returns the
// converted tools and whether anything changed.
func convertServerTools(toolsRaw json.RawMessage) (json.RawMessage, bool) {
	var tools []map[string]any
	if err := json.Unmarshal(toolsRaw, &tools); err != nil {
		return toolsRaw, false
	}
	changed := false
	for i, t := range tools {
		typ, _ := t["type"].(string)
		switch {
		case strings.HasPrefix(typ, "web_search_"):
			tools[i] = map[string]any{
				"name":        "web_search",
				"description": "Search the web for current information. Returns relevant text snippets and URLs.",
				"input_schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{"query": map[string]any{"type": "string", "description": "The search query"}},
					"required":   []string{"query"},
				},
			}
			changed = true
		case strings.HasPrefix(typ, "web_fetch_"), strings.HasPrefix(typ, "url_fetch_"):
			tools[i] = map[string]any{
				"name":        "web_fetch",
				"description": "Fetch and read content from a URL. Returns the text content of the page.",
				"input_schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{"url": map[string]any{"type": "string", "description": "URL to fetch content from"}},
					"required":   []string{"url"},
				},
			}
			changed = true
		}
	}
	if !changed {
		return toolsRaw, false
	}
	out, err := json.Marshal(tools)
	if err != nil {
		return toolsRaw, false
	}
	return out, true
}

// executeTool runs a web tool server-side. It's a var so tests can stub it.
var executeTool = func(name string, input map[string]any) (string, error) {
	if isWebSearch(name) {
		return servertools.Search(firstString(input, "query", "q", "search"))
	}
	if isWebFetch(name) {
		return servertools.Fetch(firstString(input, "url", "uri"))
	}
	return "", fmt.Errorf("unknown server tool %q", name)
}

// populateToolResults scans messages for web_search/web_fetch tool_use blocks
// whose tool_result is empty, executes them, and fills the results. Returns
// the (possibly unchanged) messages and whether anything was populated.
func populateToolResults(messagesRaw json.RawMessage) (json.RawMessage, bool, error) {
	var msgs []map[string]any
	if err := json.Unmarshal(messagesRaw, &msgs); err != nil {
		return messagesRaw, false, nil
	}

	type toolInfo struct {
		name  string
		input map[string]any
	}
	pending := map[string]toolInfo{}
	for _, m := range msgs {
		if m["role"] != "assistant" {
			continue
		}
		content, _ := m["content"].([]any)
		for _, c := range content {
			blk, ok := c.(map[string]any)
			if !ok || blk["type"] != "tool_use" {
				continue
			}
			name, _ := blk["name"].(string)
			if !isWebTool(name) {
				continue
			}
			id, _ := blk["id"].(string)
			input, _ := blk["input"].(map[string]any)
			if id != "" {
				pending[id] = toolInfo{name: name, input: input}
			}
		}
	}
	if len(pending) == 0 {
		return messagesRaw, false, nil
	}

	changed := false
	for _, m := range msgs {
		if m["role"] != "user" {
			continue
		}
		content, _ := m["content"].([]any)
		for _, c := range content {
			blk, ok := c.(map[string]any)
			if !ok || blk["type"] != "tool_result" {
				continue
			}
			id, _ := blk["tool_use_id"].(string)
			info, ok := pending[id]
			if !ok || !isEmptyToolResult(blk["content"]) {
				continue
			}
			result, err := executeTool(info.name, info.input)
			if err != nil {
				continue
			}
			blk["content"] = result
			blk["is_error"] = false
			changed = true
		}
	}
	if !changed {
		return messagesRaw, false, nil
	}
	out, err := json.Marshal(msgs)
	return out, true, err
}

func isWebTool(name string) bool {
	return isWebSearch(name) || isWebFetch(name)
}

func isWebSearch(name string) bool {
	return name == "web_search" || strings.HasPrefix(name, "web_search_")
}

func isWebFetch(name string) bool {
	return name == "web_fetch" || strings.HasPrefix(name, "web_fetch_") || strings.HasPrefix(name, "url_fetch_")
}

// isEmptyToolResult reports whether a tool_result carries no usable content
// (empty, or a "couldn't run this tool" marker), matching the TS detection.
func isEmptyToolResult(content any) bool {
	switch c := content.(type) {
	case nil:
		return true
	case string:
		t := strings.TrimSpace(c)
		if t == "" {
			return true
		}
		for _, m := range []string{"not recognized", "No tool implementation found", "Did 0 searches"} {
			if strings.Contains(t, m) {
				return true
			}
		}
		lower := strings.ToLower(t)
		for _, p := range []string{"error", "fetch failed", "search failed", "web fetch failed", "transport error", "network error", "timed out", "no results found"} {
			if strings.HasPrefix(lower, p) {
				return true
			}
		}
		return false
	case []any:
		return len(c) == 0
	default:
		return false
	}
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}
