package proxy

import (
	"strings"
	"testing"
)

func TestClassifyTier(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"tools", `{"tools":[{"name":"x"}],"messages":[]}`, tierTool},
		{"trivial", `{"messages":[{"role":"user","content":"hi"}]}`, tierTrivial},
		{"code", `{"messages":[{"role":"user","content":"here is ` + "```" + `code` + "```" + `"}]}`, tierCode},
		{"chat", `{"messages":[{"role":"user","content":"hello there how are you doing today my friend, this is a normal conversation message"}]}`, tierChat},
		{"heavy", `{"messages":[{"role":"assistant","content":[{"type":"tool_use"},{"type":"tool_use"},{"type":"tool_use"}]}]}`, tierHeavy},
	}
	for _, c := range cases {
		if got := classifyTier([]byte(c.body)); got != c.want {
			t.Errorf("%s: classify = %s, want %s", c.name, got, c.want)
		}
	}
}

func TestCapMaxTokensInBody(t *testing.T) {
	out, err := capMaxTokensInBody([]byte(`{"model":"x","max_tokens":8000}`), tierTrivial)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"max_tokens":1024`) {
		t.Fatalf("trivial cap => %s", out)
	}

	out, _ = capMaxTokensInBody([]byte(`{"model":"x","max_tokens":8000}`), tierCode)
	if !strings.Contains(string(out), `"max_tokens":8000`) {
		t.Fatalf("code no-cap => %s", out)
	}

	out, _ = capMaxTokensInBody([]byte(`{"model":"x"}`), tierTrivial)
	if strings.Contains(string(out), "max_tokens") {
		t.Fatalf("no field => %s", out)
	}
}
