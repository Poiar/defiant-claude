package wire

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
)

// Usage is the token-usage summary of a completed response, in Anthropic
// terms. CacheReadTokens/CacheWriteTokens are OpenAI/DeepSeek disk-cache
// accounting (cache-hit and cache-miss input tokens); they stay 0 for
// providers that don't report them.
type Usage struct {
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
}

// UsageReporter is implemented by streaming readers that accumulate usage as
// they translate (e.g. the OpenAI SSE reader).
type UsageReporter interface {
	Usage() Usage
}

// ExtractOpenAIUsage pulls token counts from a non-streaming OpenAI chat
// completion body.
func ExtractOpenAIUsage(body []byte) Usage {
	var in struct {
		Usage *struct {
			PromptTokens     int  `json:"prompt_tokens"`
			CompletionTokens int  `json:"completion_tokens"`
			PromptCacheHit   *int `json:"prompt_cache_hit_tokens"`
			PromptCacheMiss  *int `json:"prompt_cache_miss_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &in); err != nil || in.Usage == nil {
		return Usage{}
	}
	u := Usage{InputTokens: int64(in.Usage.PromptTokens), OutputTokens: int64(in.Usage.CompletionTokens)}
	if in.Usage.PromptCacheHit != nil {
		u.CacheReadTokens = int64(*in.Usage.PromptCacheHit)
	}
	if in.Usage.PromptCacheMiss != nil {
		u.CacheWriteTokens = int64(*in.Usage.PromptCacheMiss)
	}
	return u
}

// ExtractAnthropicUsage pulls input/output tokens from a non-streaming
// Anthropic Messages response body.
func ExtractAnthropicUsage(body []byte) Usage {
	var in struct {
		Usage *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &in); err != nil || in.Usage == nil {
		return Usage{}
	}
	return Usage{InputTokens: int64(in.Usage.InputTokens), OutputTokens: int64(in.Usage.OutputTokens)}
}

// NewAnthropicUsageTee wraps an Anthropic SSE stream, passing bytes through
// unchanged while accumulating usage from message_start / message_delta
// events into dst.
func NewAnthropicUsageTee(src io.Reader, dst *Usage) io.Reader {
	return &usageTee{src: bufio.NewReader(src), dst: dst}
}

type usageTee struct {
	src  *bufio.Reader
	dst  *Usage
	line []byte
}

func (t *usageTee) Read(p []byte) (int, error) {
	n, err := t.src.Read(p)
	if n > 0 {
		t.scan(p[:n])
	}
	return n, err
}

func (t *usageTee) scan(chunk []byte) {
	for len(chunk) > 0 {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			t.line = append(t.line, chunk...)
			return
		}
		line := append(t.line, chunk[:i]...)
		t.line = t.line[:0]
		t.processLine(line)
		chunk = chunk[i+1:]
	}
}

func (t *usageTee) processLine(line []byte) {
	s := bytes.TrimSpace(line)
	if !bytes.HasPrefix(s, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(s[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	var ev struct {
		Usage struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
		Message struct {
			Usage struct {
				InputTokens int64 `json:"input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(payload, &ev) != nil {
		return
	}
	if ev.Message.Usage.InputTokens > 0 {
		t.dst.InputTokens = ev.Message.Usage.InputTokens
	}
	if ev.Usage.InputTokens > 0 {
		t.dst.InputTokens = ev.Usage.InputTokens
	}
	if ev.Usage.OutputTokens > 0 {
		t.dst.OutputTokens = ev.Usage.OutputTokens
	}
}
