package envutil

import "testing"

func TestParseRegValue(t *testing.T) {
	out := "\nHKEY_CURRENT_USER\\Environment\n    DEEPSEEK_API_KEY    REG_SZ    sk-test-123\n"
	if got := parseRegValue(out); got != "sk-test-123" {
		t.Fatalf("got %q", got)
	}
	out2 := "\n    SOME_KEY    REG_EXPAND_SZ    C:\\some\\path\n"
	if got := parseRegValue(out2); got != `C:\some\path` {
		t.Fatalf("REG_EXPAND_SZ got %q", got)
	}
}

func TestGetEnvFirst(t *testing.T) {
	t.Setenv("ENVUTIL_TEST_VAR", "from-env")
	if got := Get("ENVUTIL_TEST_VAR"); got != "from-env" {
		t.Fatalf("got %q", got)
	}
	if got := Get("ENVUTIL_DEFINITELY_NOT_SET_XYZ"); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestHydrate(t *testing.T) {
	t.Setenv("ENVUTIL_HYDRATE_TEST", "present")
	if got := Hydrate([]string{"ENVUTIL_HYDRATE_TEST"}); len(got) != 0 {
		t.Fatalf("should not hydrate already-set var: %v", got)
	}
	if got := Hydrate([]string{"ENVUTIL_DEFINITELY_NOT_SET_XYZ"}); len(got) != 0 {
		t.Fatalf("should not hydrate absent var: %v", got)
	}
}
