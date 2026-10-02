package servertools

import (
	"net/url"
	"sort"
	"strings"
	"time"
)

// Fan-out orchestration and result merging: run every ring vendor
// concurrently, then dedupe and consensus-rank their results.

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
