// Package envutil reads environment variables with a Windows registry
// (HKCU\Environment) fallback, so config stored as a User environment
// variable is still visible to processes launched from a stale shell or a
// detached context.
package envutil

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Get returns the value of a Windows User environment variable, checking the
// process env first and falling back to HKCU\Environment. On non-Windows it is
// just os.Getenv.
func Get(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	if runtime.GOOS != "windows" {
		return ""
	}
	out, err := exec.Command("reg", "query", `HKCU\Environment`, "/v", name).Output()
	if err != nil {
		return ""
	}
	return parseRegValue(string(out))
}

// Hydrate copies any of names present in the registry (but missing from the
// process env) into the process env, so downstream os.Getenv callers see them.
// Returns the names it hydrated.
func Hydrate(names []string) []string {
	var hydrated []string
	for _, n := range names {
		if os.Getenv(n) == "" {
			if v := Get(n); v != "" {
				os.Setenv(n, v)
				hydrated = append(hydrated, n)
			}
		}
	}
	return hydrated
}

// parseRegValue extracts the value from `reg query` output, e.g.:
//
//	HKEY_CURRENT_USER\Environment
//	    DEEPSEEK_API_KEY    REG_SZ    sk-...
func parseRegValue(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		for _, typ := range []string{"REG_SZ", "REG_EXPAND_SZ"} {
			if i := strings.Index(line, typ); i >= 0 {
				return strings.TrimSpace(line[i+len(typ):])
			}
		}
	}
	return ""
}
