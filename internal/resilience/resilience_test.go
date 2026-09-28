package resilience

import (
	"testing"
	"time"
)

func TestBreakerIgnores429(t *testing.T) {
	b := NewBreakers()
	for i := 0; i < 10; i++ {
		b.RecordStat("ds", false, 100, 429)
	}
	if !b.IsHealthy("ds") {
		t.Fatal("429 rate-limiting must not open the breaker")
	}
}

func TestBreakerOpensOnFailureRate(t *testing.T) {
	b := NewBreakers()
	for i := 0; i < 5; i++ {
		b.RecordStat("ds", false, 100, 500)
	}
	if b.IsHealthy("ds") {
		t.Fatal("expected breaker open after 5 non-429 failures")
	}
	if b.State("ds") != StateOpen {
		t.Fatalf("state = %v, want OPEN", b.State("ds"))
	}
}

func TestBreakerProbeRecovery(t *testing.T) {
	b := NewBreakers()
	for i := 0; i < 5; i++ {
		b.RecordStat("ds", false, 100, 500)
	}
	base := time.Now()
	b.now = func() time.Time { return base.Add(61 * time.Second) }
	if !b.MaybeStartProbe("ds") {
		t.Fatal("expected probe after cooldown")
	}
	if b.State("ds") != StateHalfOpen {
		t.Fatalf("state = %v, want HALF_OPEN", b.State("ds"))
	}
	// HALF_OPEN blocks production traffic.
	if b.IsHealthy("ds") {
		t.Fatal("HALF_OPEN must block production traffic")
	}
	b.RecordProbeResult("ds", true)
	if !b.IsHealthy("ds") {
		t.Fatal("expected breaker closed after successful probe")
	}
}

func TestBreakerProbeFailureDoublesCooldown(t *testing.T) {
	b := NewBreakers()
	for i := 0; i < 5; i++ {
		b.RecordStat("ds", false, 100, 500)
	}
	base := time.Now()
	b.now = func() time.Time { return base.Add(61 * time.Second) }
	b.MaybeStartProbe("ds")
	b.RecordProbeResult("ds", false)
	if b.State("ds") != StateOpen {
		t.Fatalf("state = %v, want OPEN after failed probe", b.State("ds"))
	}
	// Failed probe doubles cooldown: a second probe needs another 120s.
	b.MaybeStartProbe("ds")
	if b.State("ds") != StateOpen {
		t.Fatal("probe should not start before doubled cooldown elapses")
	}
}

func TestMomentumRecordAndGet(t *testing.T) {
	m := NewMomentum()
	for i := 0; i < 5; i++ {
		m.Record("sk1", "ds", "deepseek-v4-pro")
	}
	pref, conf, ok := m.Get("sk1")
	if !ok || pref != "ds" || conf != 1.0 {
		t.Fatalf("Get = (%q, %v, %v), want (ds, 1.0, true)", pref, conf, ok)
	}
	if _, _, ok := m.Get("unknown"); ok {
		t.Fatal("expected no momentum for unknown session")
	}
}

func TestMomentumRingBounded(t *testing.T) {
	m := NewMomentum()
	for i := 0; i < 3; i++ {
		m.Record("sk", "ds", "m")
	}
	for i := 0; i < 5; i++ {
		m.Record("sk", "oc", "m")
	}
	pref, _, _ := m.Get("sk")
	if pref != "oc" {
		t.Fatalf("preferred = %q, want oc (older ds decisions evicted)", pref)
	}
}

func TestCanaryColdToActive(t *testing.T) {
	c := NewCanary()
	cfg := CanaryConfig{Enabled: true, WarmupPercent: 50, PromoteAfter: 2, PromoteAfterActive: 3, RollbackErrorRate: 0.2}
	// COLD: never route to canary, but tracked.
	use, tracking := c.ShouldUse("slot", "body", cfg)
	if use || !tracking {
		t.Fatalf("COLD ShouldUse = (%v, %v), want (false, true)", use, tracking)
	}
	// Two successes promote COLD -> WARMING.
	c.RecordResult("slot", true, cfg)
	c.RecordResult("slot", true, cfg)
	// WARMING: hash-gated at 50%.
	if _, tracking := c.ShouldUse("slot", "body", cfg); !tracking {
		t.Fatal("expected tracking in WARMING")
	}
	// Three more successes promote WARMING -> ACTIVE.
	for i := 0; i < 3; i++ {
		c.RecordResult("slot", true, cfg)
	}
	use, _ = c.ShouldUse("slot", "body", cfg)
	if !use {
		t.Fatal("expected ACTIVE canary to always route")
	}
}

func TestCanaryRollback(t *testing.T) {
	c := NewCanary()
	cfg := CanaryConfig{Enabled: true, WarmupPercent: 50, PromoteAfter: 1, PromoteAfterActive: 50, RollbackErrorRate: 0.2}
	c.RecordResult("slot", true, cfg) // -> WARMING
	// 5 requests, 2 errors (40% > 20%) -> rollback to COLD.
	for i := 0; i < 3; i++ {
		c.RecordResult("slot", true, cfg)
	}
	c.RecordResult("slot", false, cfg)
	c.RecordResult("slot", false, cfg)
	use, _ := c.ShouldUse("slot", "body", cfg)
	if use {
		t.Fatal("expected rollback to COLD (no canary traffic)")
	}
}

func TestSessionKeyStableAndDistinct(t *testing.T) {
	a := []byte(`{"system":"sys","messages":[{"role":"user","content":"hello"}]}`)
	b := []byte(`{"system":"sys","messages":[{"role":"user","content":"hello"}]}`)
	ka, okA := SessionKey(a)
	kb, okB := SessionKey(b)
	if !okA || !okB || ka != kb {
		t.Fatalf("same body produced different keys: %q vs %q", ka, kb)
	}
	other := []byte(`{"messages":[{"role":"user","content":"different"}]}`)
	kc, _ := SessionKey(other)
	if kc == ka {
		t.Fatal("different bodies must produce different keys")
	}
}

func TestSessionKeyNoUserMessage(t *testing.T) {
	if _, ok := SessionKey([]byte(`{"messages":[{"role":"assistant","content":"x"}]}`)); ok {
		t.Fatal("expected no session key without a user message")
	}
}
