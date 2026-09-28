package wire

import (
	"io"
	"strings"
	"testing"
)

func TestExtractOpenAIUsage(t *testing.T) {
	body := []byte(`{"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}`)
	u := ExtractOpenAIUsage(body)
	if u.InputTokens != 100 || u.OutputTokens != 50 || u.CacheReadTokens != 80 || u.CacheWriteTokens != 20 {
		t.Fatalf("got %+v", u)
	}
}

func TestExtractOpenAIUsageNoCache(t *testing.T) {
	body := []byte(`{"usage":{"prompt_tokens":7,"completion_tokens":3}}`)
	u := ExtractOpenAIUsage(body)
	if u.InputTokens != 7 || u.OutputTokens != 3 || u.CacheReadTokens != 0 || u.CacheWriteTokens != 0 {
		t.Fatalf("got %+v", u)
	}
}

func TestExtractAnthropicUsage(t *testing.T) {
	body := []byte(`{"usage":{"input_tokens":11,"output_tokens":22}}`)
	u := ExtractAnthropicUsage(body)
	if u.InputTokens != 11 || u.OutputTokens != 22 {
		t.Fatalf("got %+v", u)
	}
}

func TestAnthropicUsageTee(t *testing.T) {
	sse := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":123}}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n" +
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":456}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	var u Usage
	tee := NewAnthropicUsageTee(strings.NewReader(sse), &u)
	out, err := io.ReadAll(tee)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(out) != sse {
		t.Errorf("tee altered bytes:\n%s", out)
	}
	if u.InputTokens != 123 || u.OutputTokens != 456 {
		t.Fatalf("usage = %+v, want in=123 out=456", u)
	}
}

func TestOpenAIStreamUsage(t *testing.T) {
	upstream := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"prompt_cache_hit_tokens\":4,\"prompt_cache_miss_tokens\":6}}\n\n" +
		"data: [DONE]\n\n"
	r := NewOpenAIStreamReader(strings.NewReader(upstream), "m")
	if _, err := io.ReadAll(r); err != nil {
		t.Fatalf("read: %v", err)
	}
	rep, ok := r.(UsageReporter)
	if !ok {
		t.Fatal("reader does not implement UsageReporter")
	}
	u := rep.Usage()
	if u.InputTokens != 10 || u.OutputTokens != 5 || u.CacheReadTokens != 4 || u.CacheWriteTokens != 6 {
		t.Fatalf("usage = %+v", u)
	}
}
