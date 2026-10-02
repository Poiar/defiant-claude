package servertools

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseMCPResponse(t *testing.T) {
	// Plain JSON success.
	text, err := parseMCPResponse(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}`)
	if err != nil || text != "hello" {
		t.Fatalf("plain: %q %v", text, err)
	}
	// JSON-RPC error.
	if _, err := parseMCPResponse(`{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"boom"}}`); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("rpc error: %v", err)
	}
	// isError.
	if _, err := parseMCPResponse(`{"result":{"isError":true,"content":[{"type":"text","text":"rate limit"}]}}`); err == nil || !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("isError: %v", err)
	}
	// SSE framing.
	text, err = parseMCPResponse("event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"sse\"}]}}\n\n")
	if err != nil || text != "sse" {
		t.Fatalf("sse: %q %v", text, err)
	}
	// No content → error.
	if _, err := parseMCPResponse(`{"result":{"content":[]}}`); err == nil {
		t.Fatal("empty content should error")
	}
}

func TestParseExaSearchText(t *testing.T) {
	text := "Title: First\nURL: https://a.example\nHighlights:\n- point one\n- point two\n\n---\nTitle: Second\nURL: https://b.example\nPublished: 2024\n"
	res := parseExaSearchText(text, 5)
	if len(res) != 2 {
		t.Fatalf("got %d results: %+v", len(res), res)
	}
	if res[0].Title != "First" || res[0].URL != "https://a.example" {
		t.Fatalf("res[0] = %+v", res[0])
	}
	if !strings.Contains(res[0].Snippet, "point one") {
		t.Fatalf("highlights missing: %q", res[0].Snippet)
	}
	if res[1].Title != "Second" || res[1].URL != "https://b.example" {
		t.Fatalf("res[1] = %+v", res[1])
	}
}

// mcpServer returns a mock MCP endpoint that asserts the tool name and returns
// the given text as the first content item.
func mcpServer(t *testing.T, wantTool, text string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Method != "tools/call" || req.Params.Name != wantTool {
			t.Errorf("got method=%q tool=%q", req.Method, req.Params.Name)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"content": []map[string]any{{"type": "text", "text": text}}},
		})
	}))
}

func TestExaSearchKeyless(t *testing.T) {
	srv := mcpServer(t, "web_search_exa", "Title: E\nURL: https://e.example\nHighlights:\nfoo\n")
	defer srv.Close()
	orig := exaMCPURL
	exaMCPURL = srv.URL
	defer func() { exaMCPURL = orig }()

	res := exaSearchKeyless("q", 5)
	if len(res) != 1 || res[0].Title != "E" || res[0].URL != "https://e.example" {
		t.Fatalf("res = %+v", res)
	}
}

func TestParallelSearchKeyless(t *testing.T) {
	srv := mcpServer(t, "web_search", `{"results":[{"url":"https://p.example","title":"P Title","excerpts":["e1","e2"]}]}`)
	defer srv.Close()
	orig := parallelMCPURL
	parallelMCPURL = srv.URL
	defer func() { parallelMCPURL = orig }()

	res := parallelSearchKeyless("q", 5)
	if len(res) != 1 || res[0].URL != "https://p.example" || res[0].Title != "P Title" || res[0].Snippet != "e1 e2" {
		t.Fatalf("res = %+v", res)
	}
}

func TestExtractFirecrawlHits(t *testing.T) {
	hits := extractFirecrawlHits([]byte(`{"success":true,"data":[{"url":"https://f.example","title":"F","description":"desc"}]}`))
	if len(hits) != 1 || hits[0].URL != "https://f.example" {
		t.Fatalf("list shape: %+v", hits)
	}
	hits = extractFirecrawlHits([]byte(`{"data":{"web":[{"url":"https://g.example","title":"G","description":"d2"}]}}`))
	if len(hits) != 1 || hits[0].URL != "https://g.example" {
		t.Fatalf("web shape: %+v", hits)
	}
	hits = extractFirecrawlHits([]byte(`{"web":[{"url":"https://h.example","title":"H"}]}`))
	if len(hits) != 1 || hits[0].URL != "https://h.example" {
		t.Fatalf("top web shape: %+v", hits)
	}
}

func TestFirecrawlSearchKeyless(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/search" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"url": "https://f.example", "title": "F", "description": "d"}},
		})
	}))
	defer srv.Close()
	orig := firecrawlCloudURL
	firecrawlCloudURL = srv.URL
	defer func() { firecrawlCloudURL = orig }()

	res := firecrawlSearchKeyless("q", 5)
	if len(res) != 1 || res[0].Title != "F" || res[0].URL != "https://f.example" {
		t.Fatalf("res = %+v", res)
	}
}

func TestKeenableSearchKeyless(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/search/public" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("X-Keenable-Title") == "" {
			t.Error("missing X-Keenable-Title")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{{"url": "https://k.example", "title": "K", "snippet": "s"}},
		})
	}))
	defer srv.Close()
	orig := keenableAPIURL
	keenableAPIURL = srv.URL
	defer func() { keenableAPIURL = orig }()

	res := keenableSearchKeyless("q", 5)
	if len(res) != 1 || res[0].Title != "K" || res[0].URL != "https://k.example" {
		t.Fatalf("res = %+v", res)
	}
}

func TestKeylessFanoutMerge(t *testing.T) {
	origRing := keylessRing
	keylessRing = []keylessVendor{
		{"a", func(string, int) []SearchResult {
			return []SearchResult{
				{Title: "Shared", URL: "https://example.com/shared", Snippet: "short"},
				{Title: "OnlyA", URL: "https://a.example/", Snippet: "a"},
			}
		}},
		{"b", func(string, int) []SearchResult {
			return []SearchResult{
				{Title: "Shared", URL: "https://www.example.com/shared?utm_source=x", Snippet: "much longer snippet from b"},
			}
		}},
		{"c", func(string, int) []SearchResult { return nil }},
	}
	defer func() { keylessRing = origRing }()

	res := keylessFanout("q", 5)
	if len(res) != 2 {
		t.Fatalf("got %d results: %+v", len(res), res)
	}
	// Shared URL (seen by both a and b) dedupes and ranks first on consensus.
	if res[0].URL != "https://example.com/shared" || res[0].Title != "Shared" {
		t.Fatalf("res[0] = %+v, want deduped shared hit", res[0])
	}
	// The consensus hit keeps the longest snippet (from b).
	if res[0].Snippet != "much longer snippet from b" {
		t.Fatalf("res[0].Snippet = %q", res[0].Snippet)
	}
	// Single-source result ranks after the consensus hit.
	if res[1].URL != "https://a.example/" || res[1].Title != "OnlyA" {
		t.Fatalf("res[1] = %+v", res[1])
	}
}

func TestFirecrawlLatent(t *testing.T) {
	for _, v := range keylessRing {
		if v.name == "firecrawl" {
			t.Fatal("firecrawl should be latent (not in the active ring)")
		}
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := map[string]string{
		"https://example.com":                    "https://example.com/",
		"https://www.example.com/":               "https://example.com/",
		"https://Example.COM/Path/":              "https://example.com/Path",
		"https://example.com/p?utm_source=x&q=1": "https://example.com/p?q=1",
		"https://example.com/p#fragment":         "https://example.com/p",
	}
	for in, want := range cases {
		if got := normalizeURL(in); got != want {
			t.Errorf("normalizeURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWikipediaSearch(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("srsearch") != "go lang" {
			t.Errorf("srsearch = %q", r.URL.Query().Get("srsearch"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"query": map[string]any{
				"search": []map[string]any{
					{"title": "Go (programming language)", "snippet": "Go is a <span class=\"searchmatch\">programming</span> language"},
				},
			},
		})
	}))
	defer mock.Close()
	orig := wikipediaAPIURL
	wikipediaAPIURL = mock.URL + "/w/api.php"
	defer func() { wikipediaAPIURL = orig }()

	res := wikipediaSearch("go lang", 5)
	if len(res) != 1 || res[0].Title != "Go (programming language)" {
		t.Fatalf("res = %+v", res)
	}
	if res[0].URL != "https://en.wikipedia.org/wiki/Go_(programming_language)" {
		t.Fatalf("url = %q", res[0].URL)
	}
	if strings.Contains(res[0].Snippet, "searchmatch") || strings.Contains(res[0].Snippet, "<") {
		t.Fatalf("snippet not stripped: %q", res[0].Snippet)
	}
}

func TestKeylessEnabledDefault(t *testing.T) {
	t.Setenv("DEFIANT_CLAUDE_KEYLESS_SEARCH", "")
	if !keylessEnabled() {
		t.Fatal("keyless should default to enabled")
	}
	t.Setenv("DEFIANT_CLAUDE_KEYLESS_SEARCH", "0")
	if keylessEnabled() {
		t.Fatal("keyless should disable on '0'")
	}
}
