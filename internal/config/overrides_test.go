package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadSlotOverrides(t *testing.T) {
	dir := t.TempDir()
	content := `{"opus":"ds:deepseek-v4-pro","sonnet":"ds:deepseek-v4-pro","haiku":"oc:big-pickle","_defaults":{"opus":"ds:deepseek-v4-pro"},"_configName":"ds+oc"}`
	if err := os.WriteFile(filepath.Join(dir, "slot-overrides.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	o, err := LoadSlotOverrides(dir)
	if err != nil {
		t.Fatal(err)
	}
	if o["sonnet"] != "ds:deepseek-v4-pro" {
		t.Errorf("sonnet override = %q", o["sonnet"])
	}
	if o["haiku"] != "oc:big-pickle" {
		t.Errorf("haiku override = %q", o["haiku"])
	}
	if _, ok := o["_defaults"]; ok {
		t.Error("_defaults metadata key should be ignored")
	}
	if _, ok := o["_configName"]; ok {
		t.Error("_configName metadata key should be ignored")
	}
}

func TestLoadSlotOverridesMissing(t *testing.T) {
	o, err := LoadSlotOverrides(t.TempDir())
	if err != nil || o != nil {
		t.Fatalf("missing file should yield (nil, nil), got (%v, %v)", o, err)
	}
}
