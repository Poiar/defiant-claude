package wire

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"
)

// NewOpenAIStreamReader wraps an OpenAI chat.completion SSE stream and emits
// Anthropic Messages SSE, translating chunk-by-chunk.
func NewOpenAIStreamReader(src io.Reader, model string) io.Reader {
	return &openAIStream{
		src:       bufio.NewReader(src),
		model:     model,
		messageID: "msg_" + randomHex(16),
		toolMap:   map[int]int{},
		lastTool:  -1,
	}
}

// Usage returns the token usage seen so far in the stream.
func (s *openAIStream) Usage() Usage {
	return s.usage
}

// mapFinishReason maps an OpenAI finish_reason to an Anthropic stop_reason.
func mapFinishReason(r string) string {
	switch r {
	case "stop":
		return "end_turn"
	case "tool_calls", "function_call":
		return "tool_use"
	case "length":
		return "max_tokens"
	case "content_filter":
		return "content_filter"
	default:
		return "end_turn"
	}
}

type openAIStream struct {
	src       *bufio.Reader
	model     string
	started   bool
	finished  bool
	blockIdx  int
	current   string // "", "thinking", "text", "tool_use"
	messageID string
	output    int
	usage     Usage
	toolMap   map[int]int // openai tool_call index → anthropic block index
	lastTool  int
	out       []byte
	done      bool
}

func (s *openAIStream) Read(p []byte) (int, error) {
	for {
		if len(s.out) > 0 {
			n := copy(p, s.out)
			s.out = s.out[n:]
			return n, nil
		}
		if s.done {
			return 0, io.EOF
		}
		event, err := s.readEvent()
		if err == io.EOF {
			s.out = s.finishStream("end_turn")
			s.done = true
			continue
		}
		if err != nil {
			return 0, err
		}
		s.out = s.processEvent(event)
	}
}

// readEvent reads one SSE event's concatenated data payload.
func (s *openAIStream) readEvent() (string, error) {
	var data []string
	for {
		line, err := s.src.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "data:") {
				data = append(data, strings.TrimSpace(strings.TrimPrefix(trimmed, "data:")))
			}
			if trimmed == "" && len(data) > 0 {
				return strings.Join(data, "\n"), nil
			}
		}
		if err != nil {
			if len(data) > 0 {
				return strings.Join(data, "\n"), nil
			}
			return "", err
		}
	}
}

// --- event emission ---

func emit(eventType string, data map[string]any) []byte {
	b, _ := json.Marshal(data)
	return []byte("event: " + eventType + "\ndata: " + string(b) + "\n\n")
}

func (s *openAIStream) emitMessageStart() []byte {
	s.started = true
	return emit("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id":            s.messageID,
			"type":          "message",
			"role":          "assistant",
			"content":       []any{},
			"model":         s.model,
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage": map[string]any{
				"input_tokens":  0,
				"output_tokens": 0,
			},
		},
	})
}

func (s *openAIStream) openBlock(blockType string, contentBlock map[string]any) []byte {
	idx := s.blockIdx
	s.blockIdx++
	s.current = blockType
	return emit("content_block_start", map[string]any{
		"type":          "content_block_start",
		"index":         idx,
		"content_block": contentBlock,
	})
}

func (s *openAIStream) closeBlock() []byte {
	if s.current == "" {
		return nil
	}
	idx := s.blockIdx - 1
	blockType := s.current
	s.current = ""
	var out []byte
	if blockType == "thinking" {
		out = append(out, emit("content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": idx,
			"delta": map[string]any{"type": "signature_delta", "signature": ""},
		})...)
	}
	out = append(out, emit("content_block_stop", map[string]any{
		"type":  "content_block_stop",
		"index": idx,
	})...)
	return out
}

func (s *openAIStream) appendBlock(deltaType string, delta map[string]any) []byte {
	idx := s.blockIdx - 1
	merged := map[string]any{"type": deltaType}
	for k, v := range delta {
		merged[k] = v
	}
	return emit("content_block_delta", map[string]any{
		"type":  "content_block_delta",
		"index": idx,
		"delta": merged,
	})
}

// finishStream closes the current block and emits message_delta + message_stop.
// Idempotent: returns nil on a second call.
func (s *openAIStream) finishStream(reason string) []byte {
	if s.finished {
		return nil
	}
	s.finished = true
	var out []byte
	out = append(out, s.closeBlock()...)
	out = append(out, emit("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": reason, "stop_sequence": nil},
		"usage": map[string]any{"output_tokens": s.output},
	})...)
	out = append(out, emit("message_stop", map[string]any{"type": "message_stop"})...)
	return out
}

// --- chunk types ---

type openAIChunk struct {
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
	Choices []struct {
		Delta        openAIDelta `json:"delta"`
		FinishReason *string     `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int  `json:"prompt_tokens"`
		CompletionTokens int  `json:"completion_tokens"`
		PromptCacheHit   *int `json:"prompt_cache_hit_tokens"`
		PromptCacheMiss  *int `json:"prompt_cache_miss_tokens"`
	} `json:"usage"`
}

type openAIDelta struct {
	Role             string                `json:"role"`
	Content          *string               `json:"content"`
	ReasoningContent *string               `json:"reasoning_content"`
	ToolCalls        []openAIToolCallDelta `json:"tool_calls"`
}

type openAIToolCallDelta struct {
	Index    *int `json:"index"`
	ID       string
	Function *struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// processEvent translates one OpenAI chunk into Anthropic SSE events.
func (s *openAIStream) processEvent(payload string) []byte {
	if payload == "[DONE]" {
		var out []byte
		if !s.started {
			out = append(out, s.emitMessageStart()...)
		}
		out = append(out, s.finishStream("end_turn")...)
		return out
	}

	var parsed openAIChunk
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return nil
	}

	if parsed.Error != nil {
		msg := parsed.Error.Message
		if msg == "" {
			msg = "upstream error"
		}
		var out []byte
		out = append(out, emit("error", map[string]any{
			"type":  "error",
			"error": map[string]any{"type": "api_error", "message": msg},
		})...)
		if !s.started {
			out = append(out, s.emitMessageStart()...)
		}
		out = append(out, s.finishStream("end_turn")...)
		return out
	}

	if len(parsed.Choices) == 0 {
		return nil
	}
	delta := parsed.Choices[0].Delta

	var out []byte
	if !s.started {
		out = append(out, s.emitMessageStart()...)
	}
	if parsed.Usage != nil {
		s.output = parsed.Usage.CompletionTokens
		s.usage.InputTokens = int64(parsed.Usage.PromptTokens)
		s.usage.OutputTokens = int64(parsed.Usage.CompletionTokens)
		if parsed.Usage.PromptCacheHit != nil {
			s.usage.CacheReadTokens = int64(*parsed.Usage.PromptCacheHit)
		}
		if parsed.Usage.PromptCacheMiss != nil {
			s.usage.CacheWriteTokens = int64(*parsed.Usage.PromptCacheMiss)
		}
	}

	// reasoning_content → thinking block
	if delta.ReasoningContent != nil && *delta.ReasoningContent != "" {
		if s.current != "" && s.current != "thinking" {
			out = append(out, s.closeBlock()...)
		}
		if s.current != "thinking" {
			out = append(out, s.openBlock("thinking", map[string]any{
				"type": "thinking", "thinking": "", "signature": "",
			})...)
		}
		out = append(out, s.appendBlock("thinking_delta", map[string]any{
			"thinking": *delta.ReasoningContent,
		})...)
	}

	// content → text block
	if delta.Content != nil && *delta.Content != "" {
		if s.current != "" && s.current != "text" {
			out = append(out, s.closeBlock()...)
		}
		if s.current != "text" {
			out = append(out, s.openBlock("text", map[string]any{
				"type": "text", "text": "",
			})...)
		}
		out = append(out, s.appendBlock("text_delta", map[string]any{
			"text": *delta.Content,
		})...)
	}

	// tool_calls → tool_use block
	for _, tc := range delta.ToolCalls {
		if tc.Function != nil && tc.Function.Name != "" {
			if s.current != "" {
				out = append(out, s.closeBlock()...)
			}
			idx := s.blockIdx
			s.blockIdx++
			s.current = "tool_use"
			s.lastTool = idx
			if tc.Index != nil {
				s.toolMap[*tc.Index] = idx
			}
			out = append(out, emit("content_block_start", map[string]any{
				"type":  "content_block_start",
				"index": idx,
				"content_block": map[string]any{
					"type":  "tool_use",
					"id":    tc.ID,
					"name":  tc.Function.Name,
					"input": map[string]any{},
				},
			})...)
		}
		if tc.Function != nil && tc.Function.Arguments != "" {
			idx := s.lastTool
			if tc.Index != nil {
				if i, ok := s.toolMap[*tc.Index]; ok {
					idx = i
				}
			}
			if idx >= 0 {
				out = append(out, s.appendBlock("input_json_delta", map[string]any{
					"partial_json": tc.Function.Arguments,
				})...)
			}
		}
	}

	if parsed.Choices[0].FinishReason != nil {
		out = append(out, s.finishStream(mapFinishReason(*parsed.Choices[0].FinishReason))...)
	}

	return out
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(b)
}
