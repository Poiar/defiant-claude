package proxy

import (
	"testing"
	"time"
)

func TestConcurrencyLimits(t *testing.T) {
	c := NewConcurrency(2, 1)
	r1, err := c.Acquire("sonnet", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := c.Acquire("sonnet", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Acquire("sonnet", 50*time.Millisecond); err == nil {
		t.Fatal("expected timeout on third acquire")
	}
	r1()
	r2()
	if _, err := c.Acquire("sonnet", time.Second); err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
}

func TestConcurrencySubagentIsolation(t *testing.T) {
	c := NewConcurrency(1, 1)
	if _, err := c.Acquire("sonnet", time.Second); err != nil {
		t.Fatal(err)
	}
	// Subagent pool is independent — must not be blocked by the default pool.
	if _, err := c.Acquire("subagent", time.Second); err != nil {
		t.Fatalf("subagent acquire blocked by default pool: %v", err)
	}
}
