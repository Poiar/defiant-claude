package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// LoadSlotOverrides reads ~/.defiant-claude/slot-overrides.json and returns
// {slot: "provider:model"} overrides. Underscore-prefixed metadata keys
// (_defaults, _configName) are ignored. A missing file yields nil, nil.
func LoadSlotOverrides(dir string) (map[string]string, error) {
	data, err := os.ReadFile(filepath.Join(dir, "slot-overrides.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	overrides := make(map[string]string, len(raw))
	for k, v := range raw {
		if strings.HasPrefix(k, "_") {
			continue
		}
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			overrides[k] = s
		}
	}
	return overrides, nil
}
