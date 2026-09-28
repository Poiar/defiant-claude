// Package wire translates Anthropic Messages API requests and responses to
// and from other providers' wire formats (OpenAI chat completions, Gemini).
package wire

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Poiar/defiant-claude/internal/config"
)

// TranslateRequest converts an Anthropic Messages request body to the target
// provider's wire format. Anthropic-format providers get the body unchanged.
// thinking carries the per-model thinking config (from providers.json) used to
// inject reasoning settings for OpenAI-format providers.
func TranslateRequest(body []byte, format string, thinking map[string]config.Thinking) ([]byte, error) {
	switch format {
	case "anthropic", "":
		return body, nil
	case "openai":
		return anthropicToOpenAI(body, thinking)
	case "gemini":
		return nil, fmt.Errorf("gemini wire format not yet implemented")
	default:
		return nil, fmt.Errorf("unsupported wire format %q", format)
	}
}

// --- Anthropic request types (subset needed for translation) ---

type anthMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"` // string or []anthBlock
}

type anthBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	Source    *anthSource     `json:"source,omitempty"`
}

type anthSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type,omitempty"`
	URL       string `json:"url,omitempty"`
	Data      string `json:"data,omitempty"`
}

type anthTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema,omitempty"`
}

// --- OpenAI request types ---

type openAIMessage struct {
	Role       string           `json:"role"`
	Content    any              `json:"content,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
}

type openAIToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAITool struct {
	Type     string        `json:"type"`
	Function openAIToolDef `json:"function"`
}

type openAIToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type openAIRequest struct {
	Model         string          `json:"model"`
	Messages      []openAIMessage `json:"messages"`
	Stream        bool            `json:"stream"`
	MaxTokens     *int            `json:"max_tokens,omitempty"`
	Temperature   *float64        `json:"temperature,omitempty"`
	TopP          *float64        `json:"top_p,omitempty"`
	Stop          []string        `json:"stop,omitempty"`
	Tools         []openAITool    `json:"tools,omitempty"`
	Thinking      *openAIThinking `json:"thinking,omitempty"`
	StreamOptions *streamOptions  `json:"stream_options,omitempty"`
}

type openAIThinking struct {
	Type            string `json:"type"`
	ReasoningEffort string `json:"reasoning_effort"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

// anthropicToOpenAI translates an Anthropic Messages request to an OpenAI chat
// completions request.
func anthropicToOpenAI(body []byte, thinking map[string]config.Thinking) ([]byte, error) {
	var in struct {
		Model         string          `json:"model"`
		MaxTokens     *int            `json:"max_tokens"`
		Temperature   *float64        `json:"temperature"`
		TopP          *float64        `json:"top_p"`
		Stream        bool            `json:"stream"`
		System        json.RawMessage `json:"system"`
		Messages      []anthMessage   `json:"messages"`
		StopSequences []string        `json:"stop_sequences"`
		Tools         []anthTool      `json:"tools"`
		Thinking      *struct {
			BudgetTokens int64 `json:"budget_tokens"`
		} `json:"thinking"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, fmt.Errorf("parse anthropic request: %w", err)
	}

	out := openAIRequest{
		Model:       in.Model,
		Messages:    []openAIMessage{},
		Stream:      in.Stream,
		MaxTokens:   in.MaxTokens,
		Temperature: in.Temperature,
		TopP:        in.TopP,
		Stop:        in.StopSequences,
	}

	if sys := systemToString(in.System); sys != "" {
		out.Messages = append(out.Messages, openAIMessage{Role: "system", Content: sys})
	}
	for _, msg := range in.Messages {
		out.Messages = append(out.Messages, convertMessage(msg)...)
	}
	for _, t := range in.Tools {
		out.Tools = append(out.Tools, openAITool{
			Type: "function",
			Function: openAIToolDef{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.InputSchema,
			},
		})
	}
	if in.Stream {
		out.StreamOptions = &streamOptions{IncludeUsage: true}
	}

	// Inject thinking mode for OpenAI-format providers that support reasoning.
	if tc, ok := matchThinking(in.Model, thinking); ok && out.Thinking == nil {
		budget := tc.BudgetTokens
		if in.Thinking != nil && in.Thinking.BudgetTokens > 0 {
			budget = in.Thinking.BudgetTokens
		}
		if budget <= 0 {
			budget = 32000
		}
		effort := "high"
		if budget <= 4096 {
			effort = "low"
		} else if budget <= 16000 {
			effort = "medium"
		}
		out.Thinking = &openAIThinking{Type: tc.Type, ReasoningEffort: effort}
	}

	return json.Marshal(out)
}

// matchThinking finds the thinking config for a model, exact or by the last
// path segment (e.g. "or/deepseek-v4-pro" → "deepseek-v4-pro").
func matchThinking(model string, thinking map[string]config.Thinking) (config.Thinking, bool) {
	if len(thinking) == 0 {
		return config.Thinking{}, false
	}
	if tc, ok := thinking[model]; ok {
		return tc, true
	}
	if i := strings.LastIndex(model, "/"); i >= 0 {
		if tc, ok := thinking[model[i+1:]]; ok {
			return tc, true
		}
	}
	return config.Thinking{}, false
}

// systemToString extracts text from an Anthropic system prompt (string or
// array of text blocks).
func systemToString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []anthBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// convertMessage maps one Anthropic message to one or more OpenAI messages.
func convertMessage(msg anthMessage) []openAIMessage {
	var str string
	if err := json.Unmarshal(msg.Content, &str); err == nil {
		return []openAIMessage{{Role: msg.Role, Content: str}}
	}
	var blocks []anthBlock
	if err := json.Unmarshal(msg.Content, &blocks); err != nil {
		return []openAIMessage{{Role: msg.Role}}
	}

	switch msg.Role {
	case "user":
		return convertUserMessage(blocks)
	case "assistant":
		return convertAssistantMessage(blocks)
	default:
		var text []string
		for _, b := range blocks {
			if b.Type == "text" {
				text = append(text, b.Text)
			}
		}
		return []openAIMessage{{Role: msg.Role, Content: strings.Join(text, "\n")}}
	}
}

// convertUserMessage maps an Anthropic user message's content blocks. Tool
// results become OpenAI "tool" messages; text blocks become a "user" message.
func convertUserMessage(blocks []anthBlock) []openAIMessage {
	var out []openAIMessage
	var textParts []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				textParts = append(textParts, b.Text)
			}
		case "tool_result", "web_search_tool_result", "web_fetch_tool_result":
			if b.ToolUseID != "" {
				out = append(out, openAIMessage{
					Role:       "tool",
					ToolCallID: b.ToolUseID,
					Content:    stringifyContent(b.Content),
				})
			}
		}
	}
	if len(out) > 0 {
		if len(textParts) > 0 {
			out = append(out, openAIMessage{Role: "user", Content: strings.Join(textParts, "\n")})
		}
		return out
	}
	return []openAIMessage{{Role: "user", Content: strings.Join(textParts, "\n")}}
}

// convertAssistantMessage maps an Anthropic assistant message's content blocks
// (text + tool_use) to an OpenAI assistant message with tool_calls.
func convertAssistantMessage(blocks []anthBlock) []openAIMessage {
	var textParts []string
	var toolCalls []openAIToolCall
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				textParts = append(textParts, b.Text)
			}
		case "tool_use":
			toolCalls = append(toolCalls, openAIToolCall{
				ID:   b.ID,
				Type: "function",
				Function: openAIFunction{
					Name:      b.Name,
					Arguments: stringifyJSON(b.Input),
				},
			})
		}
	}
	m := openAIMessage{Role: "assistant"}
	if len(textParts) > 0 {
		m.Content = strings.Join(textParts, "\n")
	}
	if len(toolCalls) > 0 {
		m.ToolCalls = toolCalls
	}
	return []openAIMessage{m}
}

func stringifyContent(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}

func stringifyJSON(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "{}"
	}
	return string(raw)
}
