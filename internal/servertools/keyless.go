package servertools

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Poiar/defiant-claude/internal/envutil"
)

// Keyless search backends — public, anonymous free tiers (no API key), the
// same endpoints Hermes uses for its "keyless ring" (plugins/web/keyless_mcp.py).
var (
	exaMCPURL         = "https://mcp.exa.ai/mcp"
	parallelMCPURL    = "https://search.parallel.ai/mcp"
	firecrawlCloudURL = "https://api.firecrawl.dev"
	keenableAPIURL    = "https://api.keenable.ai"

	keylessClient = &http.Client{Timeout: 30 * time.Second}
)

// sessionID is a random per-process identifier for Parallel's rate limiting.
var sessionID = randomHex(16)

// keylessVendor is one keyless search backend in the failover ring.
type keylessVendor struct {
	name   string
	search func(query string, limit int) []SearchResult
}

// keylessRing is the failover order (matches Hermes's _KEYLESS_RING).
var keylessRing = []keylessVendor{
	{"exa", exaSearchKeyless},
	{"parallel", parallelSearchKeyless},
	{"firecrawl", firecrawlSearchKeyless},
	{"keenable", keenableSearchKeyless},
}

var ringMu sync.Mutex
var ringCursor int // round-robins across the ring per request

// keylessEnabled reports whether the keyless ring is active. Default on; set
// DEFIANT_CLAUDE_KEYLESS_SEARCH=0/off/false to disable.
func keylessEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(envutil.Get("DEFIANT_CLAUDE_KEYLESS_SEARCH")))
	return v != "0" && v != "false" && v != "off"
}

// keylessRingSearch runs the vendors round-robin, returning the first
// non-empty result set. Any failure (rate limit, transport, parse) just
// advances to the next vendor.
func keylessRingSearch(query string, limit int) []SearchResult {
	n := len(keylessRing)
	if n == 0 {
		return nil
	}
	ringMu.Lock()
	start := ringCursor % n
	ringCursor = (start + 1) % n
	ringMu.Unlock()
	order := append(append([]keylessVendor{}, keylessRing[start:]...), keylessRing[:start]...)
	for _, v := range order {
		if results := v.search(query, limit); len(results) > 0 {
			return results
		}
	}
	return nil
}

// --- MCP transport -----------------------------------------------------------

// mcpCall invokes an MCP tool via JSON-RPC and returns the first text content.
func mcpCall(url, tool string, args map[string]any) (string, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": tool, "arguments": args},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", "defiant-claude/1.0")

	resp, err := keylessClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	return parseMCPResponse(string(data))
}

// parseMCPResponse extracts the first text content item from a JSON-RPC
// tools/call response — plain JSON or SSE "data:" lines.
func parseMCPResponse(body string) (string, error) {
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "\n")

	var candidates []string
	if trimmed := strings.TrimSpace(body); strings.HasPrefix(trimmed, "{") {
		candidates = append(candidates, trimmed)
	}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if strings.HasPrefix(payload, "{") {
				candidates = append(candidates, payload)
			}
		}
	}

	for _, c := range candidates {
		var env struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
			Result *struct {
				IsError bool `json:"isError"`
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
		}
		if err := json.Unmarshal([]byte(c), &env); err != nil {
			continue
		}
		if env.Error != nil {
			return "", fmt.Errorf("%s", env.Error.Message)
		}
		if env.Result == nil {
			continue
		}
		var texts []string
		for _, ct := range env.Result.Content {
			if ct.Text != "" {
				texts = append(texts, ct.Text)
			}
		}
		if env.Result.IsError {
			return "", fmt.Errorf("%s", strings.Join(texts, " "))
		}
		if len(texts) > 0 {
			return texts[0], nil
		}
	}
	return "", fmt.Errorf("no text content in MCP response")
}

// --- Exa (mcp.exa.ai) --------------------------------------------------------

func exaSearchKeyless(query string, limit int) []SearchResult {
	text, err := mcpCall(exaMCPURL, "web_search_exa", map[string]any{"query": query, "numResults": limit})
	if err != nil {
		return nil
	}
	return parseExaSearchText(text, limit)
}

var exaLabels = []string{"Title:", "URL:", "Highlights:", "Published:", "Author:"}

// parseExaSearchText parses Exa's "---"-separated "Title:/URL:/Highlights:" blocks.
func parseExaSearchText(text string, limit int) []SearchResult {
	var results []SearchResult
	for _, block := range strings.Split(text, "\n---\n") {
		var title, url string
		var highlights []string
		inHighlights := false
		for _, line := range strings.Split(block, "\n") {
			s := strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(s, "Title:"):
				title = strings.TrimSpace(s[len("Title:"):])
			case strings.HasPrefix(s, "URL:"):
				url = strings.TrimSpace(s[len("URL:"):])
			case inHighlights && s != "" && !hasAnyPrefix(s, exaLabels):
				highlights = append(highlights, s)
			}
			if hasAnyPrefix(s, exaLabels) {
				inHighlights = strings.HasPrefix(s, "Highlights:")
			}
		}
		if url != "" {
			results = append(results, SearchResult{Title: title, URL: url, Snippet: strings.Join(highlights, " ")})
			if limit > 0 && len(results) >= limit {
				break
			}
		}
	}
	return results
}

// --- Parallel (search.parallel.ai) ------------------------------------------

func parallelSearchKeyless(query string, limit int) []SearchResult {
	text, err := mcpCall(parallelMCPURL, "web_search", map[string]any{
		"objective":      query,
		"search_queries": []string{query},
		"session_id":     sessionID,
	})
	if err != nil {
		return nil
	}
	var data struct {
		Results []struct {
			URL      string   `json:"url"`
			Title    string   `json:"title"`
			Excerpts []string `json:"excerpts"`
		} `json:"results"`
	}
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		return nil
	}
	var results []SearchResult
	for _, r := range data.Results {
		results = append(results, SearchResult{URL: r.URL, Title: r.Title, Snippet: strings.Join(r.Excerpts, " ")})
		if limit > 0 && len(results) >= limit {
			break
		}
	}
	return results
}

// --- Firecrawl keyless (api.firecrawl.dev) ----------------------------------

func firecrawlSearchKeyless(query string, limit int) []SearchResult {
	body, _ := json.Marshal(map[string]any{"query": query, "limit": limit})
	req, err := http.NewRequest(http.MethodPost, firecrawlCloudURL+"/v2/search", bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := keylessClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil
	}
	return firecrawlHitsToResults(extractFirecrawlHits(data), limit)
}

type firecrawlHit struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Content     string `json:"content"`
}

// extractFirecrawlHits handles Firecrawl's varied response shapes (data as a
// list, data.web, data.results, or top-level web/results).
func extractFirecrawlHits(data []byte) []firecrawlHit {
	var root struct {
		Data    json.RawMessage `json:"data"`
		Web     []firecrawlHit  `json:"web"`
		Results []firecrawlHit  `json:"results"`
	}
	if json.Unmarshal(data, &root) != nil {
		return nil
	}
	var list []firecrawlHit
	if json.Unmarshal(root.Data, &list) == nil && len(list) > 0 {
		return list
	}
	var obj struct {
		Web     []firecrawlHit `json:"web"`
		Results []firecrawlHit `json:"results"`
	}
	if json.Unmarshal(root.Data, &obj) == nil {
		if len(obj.Web) > 0 {
			return obj.Web
		}
		if len(obj.Results) > 0 {
			return obj.Results
		}
	}
	if len(root.Web) > 0 {
		return root.Web
	}
	return root.Results
}

func firecrawlHitsToResults(hits []firecrawlHit, limit int) []SearchResult {
	var results []SearchResult
	for _, h := range hits {
		snippet := h.Description
		if snippet == "" {
			snippet = h.Content
		}
		results = append(results, SearchResult{URL: h.URL, Title: h.Title, Snippet: truncate(snippet, 500)})
		if limit > 0 && len(results) >= limit {
			break
		}
	}
	return results
}

// --- Keenable (api.keenable.ai) ---------------------------------------------

func keenableSearchKeyless(query string, limit int) []SearchResult {
	body, _ := json.Marshal(map[string]any{"query": query, "max_results": limit})
	req, err := http.NewRequest(http.MethodPost, keenableAPIURL+"/v1/search/public", bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Keenable-Title", "defiant-claude")
	resp, err := keylessClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil
	}
	var parsed struct {
		Results []struct {
			URL         string `json:"url"`
			Title       string `json:"title"`
			Snippet     string `json:"snippet"`
			Description string `json:"description"`
		} `json:"results"`
	}
	if json.Unmarshal(data, &parsed) != nil {
		return nil
	}
	var results []SearchResult
	for _, r := range parsed.Results {
		snippet := r.Snippet
		if snippet == "" {
			snippet = r.Description
		}
		results = append(results, SearchResult{URL: r.URL, Title: r.Title, Snippet: truncate(snippet, 500)})
		if limit > 0 && len(results) >= limit {
			break
		}
	}
	return results
}

// --- helpers ----------------------------------------------------------------

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(b)
}
