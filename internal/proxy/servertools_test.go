package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConvertServerTools(t *testing.T) {
	in := json.RawMessage(`[
		{"type":"web_search_20250305","name":"x"},
		{"type":"web_fetch_20240101","name":"y"},
		{"type":"custom","name":"z","input_schema":{"type":"object"}}
	]`)
	out, changed := convertServerTools(in)
	if !changed {
		t.Fatal("expected change")
	}
	var tools []map[string]any
	if err := json.Unmarshal(out, &tools); err != nil {
		t.Fatal(err)
	}
	if tools[0]["name"] != "web_search" || tools[0]["type"] != nil {
		t.Errorf("tool[0] = %v, want generic web_search", tools[0])
	}
	if tools[1]["name"] != "web_fetch" {
		t.Errorf("tool[1] = %v, want generic web_fetch", tools[1])
	}
	if tools[2]["name"] != "z" {
		t.Errorf("tool[2] = %v, want custom untouched", tools[2])
	}
}

func TestIsEmptyToolResult(t *testing.T) {
	cases := []struct {
		in   any
		want bool
	}{
		{nil, true},
		{"", true},
		{"   ", true},
		{"not recognized", true},
		{"No tool implementation found", true},
		{"Did 0 searches", true},
		{"Error: something", true},
		{"fetch failed", true},
		{[]any{}, true},
		{"real result text", false},
		{[]any{"a"}, false},
	}
	for _, c := range cases {
		if got := isEmptyToolResult(c.in); got != c.want {
			t.Errorf("isEmptyToolResult(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestPopulateToolResults(t *testing.T) {
	// Stub executeTool to avoid network I/O.
	orig := executeTool
	executeTool = func(name string, input map[string]any) (string, error) {
		if name == "web_search" {
			return "SEARCH RESULT for " + input["query"].(string), nil
		}
		return "FETCH RESULT for " + input["url"].(string), nil
	}
	defer func() { executeTool = orig }()

	in := json.RawMessage(`[
		{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"web_search","input":{"query":"golang"}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":""}]}
	]`)
	out, changed, err := populateToolResults(in)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v, want populated", changed, err)
	}
	var msgs []map[string]any
	if err := json.Unmarshal(out, &msgs); err != nil {
		t.Fatal(err)
	}
	content := msgs[1]["content"].([]any)
	block := content[0].(map[string]any)
	if block["content"] != "SEARCH RESULT for golang" {
		t.Fatalf("result = %v", block["content"])
	}
}

func TestPopulateToolResultsNoOp(t *testing.T) {
	// No empty results → unchanged, no network.
	in := json.RawMessage(`[
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"nope","content":"already filled"}]}
	]`)
	_, changed, err := populateToolResults(in)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v, want no-op", changed, err)
	}
}

func TestPreprocessServerTools(t *testing.T) {
	// Non-native: web_search_* tool converted; empty result populated.
	orig := executeTool
	executeTool = func(name string, input map[string]any) (string, error) { return "RESULT", nil }
	defer func() { executeTool = orig }()

	in := []byte(`{
		"model":"claude-sonnet-4-6",
		"tools":[{"type":"web_search_20250305"}],
		"messages":[
			{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"web_search","input":{"query":"q"}}]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":""}]}
		]
	}`)
	out, err := preprocessServerTools(in, true)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `"name":"web_search"`) {
		t.Errorf("tool not converted: %s", s)
	}
	if !strings.Contains(s, "RESULT") {
		t.Errorf("result not populated: %s", s)
	}
}
