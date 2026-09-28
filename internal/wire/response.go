package wire

import (
	"encoding/json"
	"fmt"
	"strings"
)

// TranslateOpenAIResponse converts a non-streaming OpenAI chat completion
// response body to an Anthropic Messages response.
func TranslateOpenAIResponse(body []byte, model string) ([]byte, error) {
	var in struct {
		ID      string `json:"id"`
		Choices []struct {
			Message struct {
				Content          any              `json:"content"`
				ReasoningContent string           `json:"reasoning_content"`
				ToolCalls        []openAIToolCall `json:"tool_calls"`
			} `json:"message"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int  `json:"prompt_tokens"`
			CompletionTokens int  `json:"completion_tokens"`
			PromptCacheHit   *int `json:"prompt_cache_hit_tokens"`
			PromptCacheMiss  *int `json:"prompt_cache_miss_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, fmt.Errorf("parse openai response: %w", err)
	}

	content := []map[string]any{}
	var msgContent any
	var msgToolCalls []openAIToolCall
	var msgReasoning string
	var finishReason string
	if len(in.Choices) > 0 {
		msgContent = in.Choices[0].Message.Content
		msgToolCalls = in.Choices[0].Message.ToolCalls
		msgReasoning = in.Choices[0].Message.ReasoningContent
		if in.Choices[0].FinishReason != nil {
			finishReason = *in.Choices[0].FinishReason
		}
	}

	if msgReasoning != "" {
		content = append(content, map[string]any{
			"type": "thinking", "thinking": msgReasoning, "signature": "",
		})
	}

	if msgContent != nil {
		text := contentToString(msgContent)
		// Skip empty text block for pure tool-call responses.
		if text != "" || len(msgToolCalls) == 0 {
			content = append(content, map[string]any{"type": "text", "text": text})
		}
	}

	webSearch, webFetch := 0, 0
	for _, tc := range msgToolCalls {
		var input any = map[string]any{}
		if tc.Function.Arguments != "" {
			if err := json.Unmarshal([]byte(tc.Function.Arguments), &input); err != nil {
				input = map[string]any{}
			}
		}
		content = append(content, map[string]any{
			"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input,
		})
		if tc.Function.Name == "web_search" {
			webSearch++
		} else if tc.Function.Name == "web_fetch" {
			webFetch++
		}
	}

	usage := map[string]any{"input_tokens": 0, "output_tokens": 0}
	if in.Usage != nil {
		usage["input_tokens"] = in.Usage.PromptTokens
		usage["output_tokens"] = in.Usage.CompletionTokens
		if in.Usage.PromptCacheHit != nil {
			usage["cache_read_input_tokens"] = *in.Usage.PromptCacheHit
			miss := 0
			if in.Usage.PromptCacheMiss != nil {
				miss = *in.Usage.PromptCacheMiss
			}
			usage["cache_creation_input_tokens"] = miss
		}
	}
	if webSearch > 0 || webFetch > 0 {
		usage["server_tool_use"] = map[string]any{
			"web_search_requests": webSearch,
			"web_fetch_requests":  webFetch,
		}
	}

	id := in.ID
	if id == "" {
		id = "msg_" + randomHex(16)
	}

	return json.Marshal(map[string]any{
		"id":            id,
		"type":          "message",
		"model":         model,
		"role":          "assistant",
		"content":       content,
		"stop_reason":   mapFinishReason(finishReason),
		"stop_sequence": nil,
		"usage":         usage,
	})
}

func contentToString(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, b := range v {
			if m, ok := b.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					parts = append(parts, t)
				}
			}
		}
		return strings.Join(parts, "\n")
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", v)
	}
}
