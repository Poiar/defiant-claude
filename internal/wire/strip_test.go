package wire

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStripProviderFields(t *testing.T) {
	in := `{"model":"deepseek-v4-pro","metadata":{"user_id":"u1"},"system":[{"type":"text","text":"x-anthropic-billing-header: cch=abc123"},{"type":"text","text":"real system prompt"}],"messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"type":"text","text":"hi"}]}]}`
	out, err := Strip([]byte(in), "ds")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, "metadata") {
		t.Errorf("metadata not stripped: %s", s)
	}
	if strings.Contains(s, "billing-header") {
		t.Errorf("billing header not stripped: %s", s)
	}
	if strings.Contains(s, "cache_control") {
		t.Errorf("cache_control not stripped: %s", s)
	}
	if !strings.Contains(s, "real system prompt") {
		t.Errorf("non-billing system block wrongly stripped: %s", s)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	msgs := m["messages"].([]any)
	if len(msgs) != 1 {
		t.Errorf("expected 1 message after dedup, got %d: %s", len(msgs), s)
	}
}

func TestStripNoopForAnthropic(t *testing.T) {
	in := `{"model":"x","metadata":{"a":1}}`
	out, err := Strip([]byte(in), "an")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != in {
		t.Errorf("an should be a no-op, got %s", out)
	}
}
