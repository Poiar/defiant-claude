package servertools

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStripHTML(t *testing.T) {
	in := `<html><head><script>alert('x')</script><style>p{color:red}</style></head><body><p>Hello &amp; welcome</p><div>to the <b>site</b></div></body></html>`
	out := stripHTML(in)
	if strings.Contains(out, "alert") || strings.Contains(out, "color:red") {
		t.Errorf("script/style content not stripped: %q", out)
	}
	if strings.Contains(out, "<") || strings.Contains(out, ">") {
		t.Errorf("tags not stripped: %q", out)
	}
	if !strings.Contains(out, "Hello & welcome") {
		t.Errorf("entity not decoded: %q", out)
	}
}

func TestFetchRejectsBlocked(t *testing.T) {
	if _, err := Fetch("http://127.0.0.1:9/"); err == nil {
		t.Fatal("loopback fetch should be rejected")
	}
	if _, err := Fetch("http://8.8.8.8/"); err == nil {
		t.Fatal("http (non-https) fetch should be rejected")
	}
	if _, err := Fetch("ftp://example.com/"); err == nil {
		t.Fatal("ftp fetch should be rejected")
	}
}

func TestSearchSearXNG(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "test query" {
			t.Errorf("query = %q", r.URL.Query().Get("q"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"title": "Result One", "url": "https://one.example", "content": "snippet one"},
				{"title": "Result Two", "url": "https://two.example", "content": "snippet two"},
			},
		})
	}))
	defer mock.Close()

	t.Setenv("DEFIANT_CLAUDE_SEARXNG_URL", mock.URL)
	res := searchSearXNG("test query")
	if len(res) != 2 || res[0].Title != "Result One" || res[0].URL != "https://one.example" {
		t.Fatalf("results = %+v", res)
	}
}

func TestFormatResults(t *testing.T) {
	out := formatResults([]SearchResult{{Title: "T", URL: "https://x", Snippet: "s"}})
	if !strings.Contains(out, "1. T") || !strings.Contains(out, "https://x") || !strings.Contains(out, "s") {
		t.Fatalf("format = %q", out)
	}
}
