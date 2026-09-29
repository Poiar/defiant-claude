package servertools

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// envWithRegistry reads a Windows User environment variable, checking the
// process env first, then falling back to HKCU\Environment (for launches from
// a stale shell or a detached process where the registry value isn't
// inherited). On non-Windows it is just os.Getenv.
func envWithRegistry(name string) string {
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

// parseRegValue extracts the value from `reg query` output, e.g.:
//
//	HKEY_CURRENT_USER\Environment
//	    DEFIANT_CLAUDE_SEARXNG_URL    REG_SZ    http://localhost:8888/search?format=json&q=
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
