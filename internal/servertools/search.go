package servertools

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Poiar/defiant-claude/internal/envutil"
)

// SearchResult is one web search hit.
type SearchResult struct {
	Title   string
	URL     string
	Snippet string
}

// searchClient talks to search backends (trusted endpoints, not SSRF-gated).
var searchClient = &http.Client{Timeout: 8 * time.Second}

// braveSearchURL is the Brave Search API endpoint (var so tests can override).
var braveSearchURL = "https://api.search.brave.com/res/v1/web/search"

// Search runs a web search and returns a formatted text summary. Order:
// self-hosted SearXNG (opt-in) → keyless ring (parallel fan-out + merge) →
// Brave (if a key is set) → DuckDuckGo instant-answer.
func Search(query string) (string, error) {
	if results := searchSearXNG(query); len(results) > 0 {
		return formatResults(results), nil
	}
	// Keyless ring (Exa/Parallel/Keenable/Wikipedia public free tiers) is the
	// default no-key search — parallel fan-out, merged + consensus-ranked.
	if keylessEnabled() {
		if results := keylessFanout(query, 5); len(results) > 0 {
			return formatResults(results), nil
		}
	}
	// Brave is a paid-key fallback (2000 free calls/mo) — only used when the
	// free paths return nothing, to preserve the quota.
	if results := searchBrave(query); len(results) > 0 {
		return formatResults(results), nil
	}
	if text := searchDDGInstant(query); text != "" {
		return text, nil
	}
	return fmt.Sprintf("No results found for query: %q", query), nil
}

// searchSearXNG queries the user's self-hosted SearXNG instance, and only when
// DEFIANT_CLAUDE_SEARXNG_URL is set — public instances are flaky and add
// latency, so SearXNG is opt-in rather than a default first stage.
func searchSearXNG(query string) []SearchResult {
	p := strings.TrimSpace(envutil.Get("DEFIANT_CLAUDE_SEARXNG_URL"))
	if p == "" {
		return nil
	}
	return searxngOne(p, query)
}

// searxngOne queries one SearXNG instance. The prefix may be either a full
// ".../search?format=json&q=" URL (the documented convention) or a bare base
// URL, in which case the query path is appended.
func searxngOne(prefix, query string) []SearchResult {
	u := prefix
	if !strings.Contains(prefix, "q=") {
		u = strings.TrimRight(prefix, "/") + "/search?format=json&q="
	}
	u += url.QueryEscape(query)
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
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	var out []SearchResult
	for _, r := range parsed.Results {
		if r.URL == "" || r.Title == "" {
			continue
		}
		out = append(out, SearchResult{Title: truncate(r.Title, 200), URL: r.URL, Snippet: truncate(r.Content, 500)})
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func searchDDGInstant(query string) string {
	u := "https://api.duckduckgo.com/?q=" + url.QueryEscape(query) + "&format=json&no_html=1&no_redirect=1"
	resp, err := searchClient.Get(u)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 500_000))
	if err != nil {
		return ""
	}
	var parsed struct {
		AbstractText  string `json:"AbstractText"`
		AbstractURL   string `json:"AbstractURL"`
		Answer        string `json:"Answer"`
		RelatedTopics []struct {
			Text     string `json:"Text"`
			FirstURL string `json:"FirstURL"`
		} `json:"RelatedTopics"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	var lines []string
	if parsed.AbstractText != "" {
		lines = append(lines, parsed.AbstractText)
	}
	if parsed.AbstractURL != "" {
		lines = append(lines, "Source: "+parsed.AbstractURL)
	}
	if parsed.Answer != "" {
		lines = append(lines, "Answer: "+parsed.Answer)
	}
	for _, t := range parsed.RelatedTopics {
		if len(lines) >= 12 {
			break
		}
		if t.Text != "" {
			lines = append(lines, "- "+t.Text)
		}
		if t.FirstURL != "" {
			lines = append(lines, "  "+t.FirstURL)
		}
	}
	return strings.Join(lines, "\n")
}

// searchBrave queries the Brave Search API (requires DEFIANT_CLAUDE_BRAVE_API_KEY,
// 2000 free calls/month). Returns nil when no key is set or the request fails.
func searchBrave(query string) []SearchResult {
	apiKey := strings.TrimSpace(envutil.Get("DEFIANT_CLAUDE_BRAVE_API_KEY"))
	if apiKey == "" {
		return nil
	}
	u := braveSearchURL + "?q=" + url.QueryEscape(query)
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Subscription-Token", apiKey)
	req.Header.Set("User-Agent", "defiant-claude-proxy/1.0")

	resp, err := searchClient.Do(req)
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
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	var out []SearchResult
	for _, r := range parsed.Web.Results {
		if r.URL == "" || r.Title == "" {
			continue
		}
		out = append(out, SearchResult{Title: truncate(r.Title, 200), URL: r.URL, Snippet: truncate(r.Description, 500)})
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func formatResults(results []SearchResult) string {
	var b strings.Builder
	for i, r := range results {
		fmt.Fprintf(&b, "%d. %s\n   %s\n", i+1, r.Title, r.URL)
		if r.Snippet != "" {
			fmt.Fprintf(&b, "   %s\n", r.Snippet)
		}
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
