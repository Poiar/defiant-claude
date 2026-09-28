package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// writeFriendlyError sends an Anthropic-compatible "all providers exhausted"
// response (JSON or SSE) so agents surface a graceful message instead of a
// raw 502, matching the TS proxy's E012 fallback-exhausted shape.
func (s *Server) writeFriendlyError(w http.ResponseWriter, streaming bool, model string, attempted []string, lastStatus int) {
	tried := strings.Join(attempted, ", ")
	if tried == "" {
		tried = "all configured providers"
	}
	status := fmt.Sprintf("HTTP %d", lastStatus)
	if lastStatus == 0 {
		status = "connection failure"
	}
	msg := "All AI providers are currently unavailable (tried: " + tried +
		"). Last error: " + status +
		". Please check provider status or API key configuration."

	w.Header().Set("x-fallback-exhausted", "true")
	w.Header().Set("x-defiant-claude-error", "E012")
	w.Header().Set("x-attempted-providers", tried)

	if !streaming {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":    "msg_fallback_" + strconv.FormatInt(time.Now().UnixNano(), 36),
			"type":  "message",
			"role":  "assistant",
			"model": model,
			"content": []map[string]any{
				{"type": "text", "text": msg},
			},
			"stop_reason": "end_turn",
			"usage":       map[string]int{"input_tokens": 0, "output_tokens": 0},
		})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	msgID := "msg_exhausted_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	fmt.Fprintf(w, "event: message_start\ndata: %s\n\n", jsonOf(map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": msgID, "type": "message", "role": "assistant", "model": model,
			"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]int{"input_tokens": 0, "output_tokens": 0},
		},
	}))
	fmt.Fprintf(w, "event: error\ndata: %s\n\n", jsonOf(map[string]any{
		"type":  "error",
		"error": map[string]any{"type": "api_error", "message": msg},
	}))
	fmt.Fprintf(w, "event: message_stop\ndata: %s\n\n", jsonOf(map[string]any{"type": "message_stop"}))
	fmt.Fprintf(w, "data: [DONE]\n\n")
}

// jsonOf marshals a value that cannot fail (plain maps/strings/ints).
func jsonOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}
