package proxy

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/Poiar/defiant-claude/internal/routing"
)

// Prompt tiers, matching the TS prompt-router classification.
const (
	tierHeavy   = "HEAVY"
	tierTool    = "TOOL"
	tierCode    = "CODE"
	tierChat    = "CHAT"
	tierTrivial = "TRIVIAL"
)

// classifyTier inspects the request body and returns its complexity tier:
// TOOL (has tool defs), HEAVY (>2 tool_use blocks or >32K est. tokens),
// CODE (code blocks), TRIVIAL (single short message), else CHAT.
func classifyTier(body []byte) string {
	var b struct {
		Tools    []json.RawMessage `json:"tools"`
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return tierChat
	}
	if len(b.Tools) > 0 {
		return tierTool
	}
	if len(b.Messages) == 0 {
		return tierChat
	}

	toolUse := 0
	codeBlocks := 0
	totalChars := 0
	singleShort := false
	for _, m := range b.Messages {
		if len(m.Content) == 0 {
			continue
		}
		var s string
		if json.Unmarshal(m.Content, &s) == nil {
			totalChars += len(s)
			if strings.Contains(s, "```") {
				codeBlocks++
			}
			if len(b.Messages) == 1 && len(s) < 50 {
				singleShort = true
			}
			continue
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(m.Content, &blocks) != nil {
			continue
		}
		for _, blk := range blocks {
			if blk.Type == "tool_use" {
				toolUse++
			}
			if blk.Text != "" {
				totalChars += len(blk.Text)
				if strings.Contains(blk.Text, "```") {
					codeBlocks++
				}
			}
		}
	}

	if toolUse > 2 {
		return tierHeavy
	}
	if totalChars/4 > 32000 {
		return tierHeavy
	}
	if codeBlocks > 0 {
		return tierCode
	}
	if singleShort {
		return tierTrivial
	}
	return tierChat
}

// capMaxTokensForTier caps max_tokens by tier to bound output cost. CODE and
// HEAVY (and unknown tiers) are uncapped.
func capMaxTokensForTier(maxTokens int, tier string) int {
	caps := map[string]int{tierTrivial: 1024, tierChat: 4096, tierTool: 8192}
	if cap, ok := caps[tier]; ok && maxTokens > cap {
		return cap
	}
	return maxTokens
}

// capMaxTokensInBody rewrites the "max_tokens" field to its tier cap,
// preserving all other fields. Returns the body unchanged when max_tokens is
// absent or already within the cap.
func capMaxTokensInBody(body []byte, tier string) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body, nil // not an object; leave unchanged
	}
	raw, ok := m["max_tokens"]
	if !ok {
		return body, nil
	}
	var mt int
	if err := json.Unmarshal(raw, &mt); err != nil {
		return body, nil
	}
	capped := capMaxTokensForTier(mt, tier)
	if capped == mt {
		return body, nil
	}
	quoted, err := json.Marshal(capped)
	if err != nil {
		return nil, err
	}
	m["max_tokens"] = quoted
	return json.Marshal(m)
}

// promptRoute is a tier → provider/model routing entry.
type promptRoute struct {
	tier     string
	provider string
	model    string
}

// defaultTierRoutes mirrors the TS default prompt-router: simple/mechanical
// requests go to cheap/free models (~3× cheaper on cache-miss); CODE stays on
// the primary provider for reasoning quality.
var defaultTierRoutes = []promptRoute{
	{tierTrivial, "oc", "big-pickle"},
	{tierTool, "ds", "deepseek-v4-flash"},
	{tierChat, "ds", "deepseek-v4-flash"},
	{tierHeavy, "ds", "deepseek-v4-flash"},
}

// defaultPromptRoutes maps each capability slot to the default tier routes.
var defaultPromptRoutes = map[string][]promptRoute{
	"opus":     defaultTierRoutes,
	"sonnet":   defaultTierRoutes,
	"haiku":    defaultTierRoutes,
	"subagent": defaultTierRoutes,
	"fable":    defaultTierRoutes,
}

// promptRouterEnabled reports whether tier-based routing is active. Defaults
// on (matching the TS); set DEFIANT_CLAUDE_PROMPT_ROUTER=0/off/false to disable.
func promptRouterEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("DEFIANT_CLAUDE_PROMPT_ROUTER")))
	return v != "0" && v != "false" && v != "off"
}

// resolvePromptRoute returns a cheaper target for the request's tier + slot,
// or (target, false) when no route applies (CODE tier, unknown slot, or the
// route's provider/model fails to resolve).
func resolvePromptRoute(resolver *routing.Resolver, target routing.Target, tier string) (routing.Target, bool) {
	routes, ok := defaultPromptRoutes[target.Slot]
	if !ok {
		return target, false
	}
	for _, r := range routes {
		if r.tier != tier {
			continue
		}
		t, err := resolver.Resolve(r.provider + ":" + r.model)
		if err != nil {
			return target, false
		}
		t.Slot = target.Slot // preserve slot so fallbacks still tier-match
		return t, true
	}
	return target, false
}
