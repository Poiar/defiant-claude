package servertools

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
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
	wikipediaAPIURL   = "https://en.wikipedia.org/w/api.php"

	keylessClient = &http.Client{Timeout: 30 * time.Second}
)

// sessionID is a random per-process identifier for Parallel's rate limiting.
var sessionID = randomHex(16)

// keylessVendor is one keyless search backend in the failover ring.
type keylessVendor struct {
	name   string
	search func(query string, limit int) []SearchResult
}

// keylessRing is the parallel fan-out set (the Hermes "keyless ring", minus
// Firecrawl — kept latent below). Every vendor runs concurrently per search.
var keylessRing = []keylessVendor{
	{"exa", exaSearchKeyless},
	{"parallel", parallelSearchKeyless},
	{"keenable", keenableSearchKeyless},
	{"wikipedia", wikipediaSearch},
}

// firecrawlSearchKeyless is LATENT — deliberately not in keylessRing: its
// public keyless cloud (api.firecrawl.dev/v2/search) 403s on anonymous
// requests and requires an API key. To re-enable later, add
// {"firecrawl", firecrawlSearchKeyless} to keylessRing (and a sourceWeight
// entry if you want it weighted).

// keylessEnabled reports whether the keyless ring is active. Default on; set
// DEFIANT_CLAUDE_KEYLESS_SEARCH=0/off/false to disable.
func keylessEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(envutil.Get("DEFIANT_CLAUDE_KEYLESS_SEARCH")))
	return v != "0" && v != "false" && v != "off"
}

// keylessFanoutTimeout bounds the whole fan-out: a vendor's own client timeout
// is 30s, but a slow vendor must not stall the search past this.
const keylessFanoutTimeout = 12 * time.Second

// keylessFanout runs every ring vendor concurrently, then merges their results:
// dedupe by normalized URL, rank by cross-source consensus (more sources
// agreeing = higher, then per-source quality weight), and cap to limit. A
// vendor that fails or returns empty simply contributes nothing.
func keylessFanout(query string, limit int) []SearchResult {
	vendors := keylessRing
	type outcome struct {
		name    string
		results []SearchResult
	}
	ch := make(chan outcome, len(vendors))
	for _, v := range vendors {
		go func(v keylessVendor) {
			ch <- outcome{v.name, v.search(query, limit)}
		}(v)
	}
	collected := make(map[string][]SearchResult)
	deadline := time.After(keylessFanoutTimeout)
	for i := 0; i < len(vendors); i++ {
		select {
		case o := <-ch:
			if len(o.results) > 0 {
				collected[o.name] = o.results
			}
		case <-deadline:
			return mergeAndRank(collected, limit)
		}
	}
	return mergeAndRank(collected, limit)
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

// --- fan-out merge & rank ----------------------------------------------------

// trackingParams are query parameters that do not change page identity and are
// stripped before URL dedupe.
var trackingParams = map[string]bool{
	"utm_source": true, "utm_medium": true, "utm_campaign": true, "utm_term": true,
	"utm_content": true, "gclid": true, "fbclid": true, "mc_cid": true, "mc_eid": true,
	"igshid": true, "ref_src": true, "ref_url": true, "s_kwcid": true, "msclkid": true,
	"cmpid": true, "aff_id": true,
}

// normalizeURL canonicalizes a URL for dedupe: lowercase scheme+host, strip
// www., trailing slash, fragment, and tracking params.
func normalizeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return strings.ToLower(raw)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return strings.ToLower(raw)
	}
	host := strings.ToLower(u.Hostname())
	host = strings.TrimPrefix(host, "www.")
	path := strings.TrimRight(u.Path, "/")
	if path == "" {
		path = "/"
	}
	q := u.Query()
	for k := range q {
		if trackingParams[strings.ToLower(k)] {
			q.Del(k)
		}
	}
	if qs := q.Encode(); qs != "" {
		return scheme + "://" + host + path + "?" + qs
	}
	return scheme + "://" + host + path
}

// sourceWeight is the per-source quality weight used as the tiebreak within a
// consensus tier.
func sourceWeight(name string) float64 {
	switch name {
	case "exa", "parallel":
		return 3.0
	case "keenable":
		return 2.5
	case "wikipedia":
		return 2.0
	default:
		return 1.0
	}
}

// mergeAndRank merges per-source result sets into a single ranked list: dedupe
// by normalized URL, score by (number of agreeing sources, max source weight),
// keep the longest snippet, and cap to limit. Source order is deterministic
// (sorted names) so the kept URL/title for a deduped hit is stable.
func mergeAndRank(collected map[string][]SearchResult, limit int) []SearchResult {
	type hit struct {
		result  SearchResult
		sources map[string]bool
		weight  float64
	}
	byURL := make(map[string]*hit)
	names := make([]string, 0, len(collected))
	for name := range collected {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, src := range names {
		for _, r := range collected[src] {
			key := normalizeURL(r.URL)
			if key == "" {
				key = r.URL
			}
			h, ok := byURL[key]
			if !ok {
				byURL[key] = &hit{result: r, sources: map[string]bool{src: true}, weight: sourceWeight(src)}
				continue
			}
			h.sources[src] = true
			if w := sourceWeight(src); w > h.weight {
				h.weight = w
			}
			if h.result.Title == "" && r.Title != "" {
				h.result.Title = r.Title
			}
			if len(r.Snippet) > len(h.result.Snippet) {
				h.result.Snippet = r.Snippet
			}
		}
	}
	hits := make([]*hit, 0, len(byURL))
	for _, h := range byURL {
		hits = append(hits, h)
	}
	sort.Slice(hits, func(i, j int) bool {
		if len(hits[i].sources) != len(hits[j].sources) {
			return len(hits[i].sources) > len(hits[j].sources)
		}
		return hits[i].weight > hits[j].weight
	})
	out := make([]SearchResult, 0, limit)
	for i := 0; i < len(hits) && i < limit; i++ {
		out = append(out, hits[i].result)
	}
	return out
}

// wikipediaSearch uses the MediaWiki search API (no key) as an independent
// factual/encyclopedic source in the ring.
func wikipediaSearch(query string, limit int) []SearchResult {
	n := limit * 2
	if n < 1 {
		n = 1
	}
	if n > 10 {
		n = 10
	}
	u := wikipediaAPIURL + "?action=query&list=search&format=json&srlimit=" +
		strconv.Itoa(n) + "&srsearch=" + url.QueryEscape(query)
	resp, err := searchClient.Get(u)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 500_000))
	if err != nil {
		return nil
	}
	var parsed struct {
		Query struct {
			Search []struct {
				Title   string `json:"title"`
				Snippet string `json:"snippet"`
			} `json:"search"`
		} `json:"query"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	var out []SearchResult
	for _, s := range parsed.Query.Search {
		if s.Title == "" {
			continue
		}
		out = append(out, SearchResult{
			Title:   s.Title,
			URL:     "https://en.wikipedia.org/wiki/" + strings.ReplaceAll(s.Title, " ", "_"),
			Snippet: truncate(stripHTML(s.Snippet), 500),
		})
	}
	return out
}
