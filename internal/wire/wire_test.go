package wire

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/Poiar/defiant-claude/internal/config"
)

func TestTranslateRequestAnthropicPassthrough(t *testing.T) {
	in := []byte(`{"model":"x","messages":[]}`)
	out, err := TranslateRequest(in, "anthropic", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, in) {
		t.Fatalf("anthropic format should pass through unchanged, got %s", out)
	}
}

func TestTranslateRequestOpenAI(t *testing.T) {
	in := `{
		"model": "claude-sonnet-4-6",
		"max_tokens": 100,
		"stream": true,
		"system": "You are a helpful assistant",
		"messages": [
			{"role": "user", "content": "Hello"},
			{"role": "assistant", "content": "Hi there"},
			{"role": "user", "content": [{"type": "text", "text": "What is 2+2?"}]}
		]
	}`
	out, err := TranslateRequest([]byte(in), "openai", nil)
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	if o["model"] != "claude-sonnet-4-6" {
		t.Errorf("model = %v", o["model"])
	}
	msgs := o["messages"].([]any)
	if len(msgs) != 4 {
		t.Fatalf("messages len = %d, want 4 (system + user + assistant + user)", len(msgs))
	}
	if msgs[0].(map[string]any)["role"] != "system" {
		t.Errorf("messages[0].role = %v, want system", msgs[0].(map[string]any)["role"])
	}
	if o["max_tokens"].(float64) != 100 {
		t.Errorf("max_tokens = %v, want 100", o["max_tokens"])
	}
	so := o["stream_options"].(map[string]any)
	if so["include_usage"] != true {
		t.Errorf("stream_options.include_usage = %v, want true", so["include_usage"])
	}
}

func TestTranslateRequestToolCalls(t *testing.T) {
	in := `{
		"model": "claude-sonnet-4-6",
		"messages": [
			{"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Paris"}}]},
			{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "sunny"}]}
		]
	}`
	out, err := TranslateRequest([]byte(in), "openai", nil)
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	msgs := o["messages"].([]any)

	// assistant message has tool_calls
	asst := msgs[0].(map[string]any)
	if asst["role"] != "assistant" {
		t.Errorf("messages[0].role = %v", asst["role"])
	}
	tcs := asst["tool_calls"].([]any)
	if len(tcs) != 1 {
		t.Fatalf("tool_calls len = %d, want 1", len(tcs))
	}
	fn := tcs[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "get_weather" {
		t.Errorf("tool name = %v, want get_weather", fn["name"])
	}

	// tool result becomes a "tool" role message
	tool := msgs[1].(map[string]any)
	if tool["role"] != "tool" {
		t.Errorf("messages[1].role = %v, want tool", tool["role"])
	}
	if tool["tool_call_id"] != "toolu_1" {
		t.Errorf("tool_call_id = %v, want toolu_1", tool["tool_call_id"])
	}
	if tool["content"] != "sunny" {
		t.Errorf("tool content = %v, want sunny", tool["content"])
	}
}

func TestOpenAIStreamReader(t *testing.T) {
	upstream := `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`
	r := NewOpenAIStreamReader(strings.NewReader(upstream), "deepseek-v4-pro")
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		"message_start", "content_block_start", "text_delta",
		"content_block_stop", "message_delta", "message_stop",
		"Hello", " world", "end_turn", "deepseek-v4-pro",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("output missing %q\n--- full output ---\n%s", want, s)
		}
	}
}

func TestOpenAIStreamToolCall(t *testing.T) {
	upstream := `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

`
	r := NewOpenAIStreamReader(strings.NewReader(upstream), "m")
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		"tool_use", "get_weather", "input_json_delta", "partial_json",
		`{\"city\"`, "stop_reason\":\"tool_use\"",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("output missing %q\n--- full output ---\n%s", want, s)
		}
	}
}

func TestTranslateOpenAIResponse(t *testing.T) {
	in := `{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"Hello world","reasoning_content":"thinking...","tool_calls":[{"id":"c1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`
	out, err := TranslateOpenAIResponse([]byte(in), "deepseek-v4-pro")
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	if o["type"] != "message" || o["role"] != "assistant" {
		t.Errorf("type/role = %v/%v", o["type"], o["role"])
	}
	if o["model"] != "deepseek-v4-pro" {
		t.Errorf("model = %v", o["model"])
	}
	if o["stop_reason"] != "tool_use" {
		t.Errorf("stop_reason = %v, want tool_use", o["stop_reason"])
	}
	blocks := o["content"].([]any)
	if len(blocks) != 3 {
		t.Fatalf("content blocks = %d, want 3 (thinking + text + tool_use)", len(blocks))
	}
	if blocks[0].(map[string]any)["type"] != "thinking" {
		t.Errorf("block[0] type = %v, want thinking", blocks[0].(map[string]any)["type"])
	}
	if blocks[1].(map[string]any)["type"] != "text" {
		t.Errorf("block[1] type = %v, want text", blocks[1].(map[string]any)["type"])
	}
	tu := blocks[2].(map[string]any)
	if tu["type"] != "tool_use" || tu["name"] != "get_weather" {
		t.Errorf("block[2] = %v, want tool_use get_weather", tu)
	}
	usage := o["usage"].(map[string]any)
	if usage["input_tokens"].(float64) != 10 || usage["output_tokens"].(float64) != 5 {
		t.Errorf("usage = %v", usage)
	}
}

func TestThinkingInjection(t *testing.T) {
	thinking := map[string]config.Thinking{
		"deepseek-v4-pro": {Type: "enabled", BudgetTokens: 32000},
	}
	in := `{"model":"deepseek-v4-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	out, err := TranslateRequest([]byte(in), "openai", thinking)
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	th, ok := o["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("no thinking field in %s", out)
	}
	if th["type"] != "enabled" || th["reasoning_effort"] != "high" {
		t.Errorf("thinking = %v, want {enabled high}", th)
	}
}

func TestThinkingEffortFromBudget(t *testing.T) {
	thinking := map[string]config.Thinking{
		"deepseek-v4-pro": {Type: "enabled", BudgetTokens: 32000},
	}
	in := `{"model":"deepseek-v4-pro","stream":true,"thinking":{"budget_tokens":2000},"messages":[{"role":"user","content":"hi"}]}`
	out, err := TranslateRequest([]byte(in), "openai", thinking)
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	th := o["thinking"].(map[string]any)
	if th["reasoning_effort"] != "low" {
		t.Errorf("reasoning_effort = %v, want low", th["reasoning_effort"])
	}
}

func TestThinkingLastSegmentMatch(t *testing.T) {
	thinking := map[string]config.Thinking{
		"deepseek-v4-pro": {Type: "enabled", BudgetTokens: 16000},
	}
	// model has a provider path prefix; match by last segment
	in := `{"model":"or/deepseek-v4-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	out, err := TranslateRequest([]byte(in), "openai", thinking)
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	th := o["thinking"].(map[string]any)
	if th["reasoning_effort"] != "medium" {
		t.Errorf("reasoning_effort = %v, want medium", th["reasoning_effort"])
	}
}
