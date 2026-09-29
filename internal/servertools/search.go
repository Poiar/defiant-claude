package servertools

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// SearchResult is one web search hit.
type SearchResult struct {
	Title   string
	URL     string
	Snippet string
}

// searchClient talks to search backends (trusted endpoints, not SSRF-gated).
var searchClient = &http.Client{Timeout: 8 * time.Second}

// Search runs a web search and returns a formatted text summary. It tries
// SearXNG (self-hosted DEFIANT_CLAUDE_SEARXNG_URL first, then public
// instances), then falls back to DuckDuckGo's instant-answer API.
func Search(query string) (string, error) {
	if results := searchSearXNG(query); len(results) > 0 {
		return formatResults(results), nil
	}
	if text := searchDDGInstant(query); text != "" {
		return text, nil
	}
	return fmt.Sprintf("No results found for query: %q", query), nil
}

func searchSearXNG(query string) []SearchResult {
	var bases []string
	if b := strings.TrimRight(os.Getenv("DEFIANT_CLAUDE_SEARXNG_URL"), "/"); b != "" {
		bases = append(bases, b)
	}
	bases = append(bases,
		"https://etsi.me",
		"https://search.sapti.me",
		"https://searx.tiekoetter.com",
	)
	for _, base := range bases {
		if res := searxngOne(base, query); len(res) > 0 {
			return res
		}
	}
	return nil
}

func searxngOne(base, query string) []SearchResult {
	u := base + "/search?format=json&q=" + url.QueryEscape(query)
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
