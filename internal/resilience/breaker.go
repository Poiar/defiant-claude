// Package resilience implements the adaptive-routing layer: per-provider
// circuit breakers, request stats, canary rollouts, and session momentum.
package resilience

import (
	"sync"
	"time"
)

const (
	defaultCooldown = 60 * time.Second
	maxCooldown     = 5 * time.Minute
	maxProbes       = 5

	// failureRateThreshold is the non-429 failure ratio that opens a breaker.
	failureRateThreshold = 0.34
	// minRequestsToJudge is the floor before failure rate is evaluated.
	minRequestsToJudge = 5
)

// BreakerState is the circuit breaker state machine.
type BreakerState int

const (
	StateClosed BreakerState = iota
	StateOpen
	StateHalfOpen
)

func (s BreakerState) String() string {
	switch s {
	case StateOpen:
		return "OPEN"
	case StateHalfOpen:
		return "HALF_OPEN"
	default:
		return "CLOSED"
	}
}

type breakerEntry struct {
	state                    BreakerState
	openedAt                 time.Time
	cooldown                 time.Duration
	probeCount               int
	consecutiveProbeFailures int
}

// ProviderStat tracks cumulative per-provider request outcomes.
type ProviderStat struct {
	Requests     int64
	Successes    int64
	Fails        int64
	TotalMs      int64
	LastRequest  time.Time
	InputTokens  int64
	OutputTokens int64
	SpendUSD     float64
}

// Breakers holds circuit-breaker + per-provider stats state.
type Breakers struct {
	mu      sync.Mutex
	entries map[string]*breakerEntry
	stats   map[string]*ProviderStat
	now     func() time.Time
}

func NewBreakers() *Breakers {
	return &Breakers{
		entries: make(map[string]*breakerEntry),
		stats:   make(map[string]*ProviderStat),
		now:     time.Now,
	}
}

// RecordStat increments counters and opens the breaker when the non-429
// failure rate crosses the threshold with enough requests to judge.
// 429 (rate-limited) is NOT a failure: the provider is healthy but throttling.
func (b *Breakers) RecordStat(providerKey string, success bool, ms int64, statusCode int) {
	if providerKey == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.stats[providerKey]
	if s == nil {
		s = &ProviderStat{}
		b.stats[providerKey] = s
	}
	s.Requests++
	s.TotalMs += ms
	s.LastRequest = b.now()
	if success {
		s.Successes++
	} else if statusCode != 429 {
		s.Fails++
	}
	if !success && statusCode != 429 && s.Requests >= minRequestsToJudge &&
		float64(s.Fails)/float64(s.Requests) >= failureRateThreshold {
		b.open(providerKey)
	}
}

// RecordUsage accumulates token counts for a provider.
func (b *Breakers) RecordUsage(providerKey string, inputTokens, outputTokens int64) {
	if providerKey == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.stats[providerKey]
	if s == nil {
		s = &ProviderStat{}
		b.stats[providerKey] = s
	}
	s.InputTokens += inputTokens
	s.OutputTokens += outputTokens
}

// RecordCost accumulates USD spend for a provider.
func (b *Breakers) RecordCost(providerKey string, costUSD float64) {
	if providerKey == "" || costUSD <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.stats[providerKey]
	if s == nil {
		s = &ProviderStat{}
		b.stats[providerKey] = s
	}
	s.SpendUSD += costUSD
}

func (b *Breakers) open(providerKey string) {
	e := b.entries[providerKey]
	if e != nil && e.state != StateClosed {
		return
	}
	b.entries[providerKey] = &breakerEntry{
		state:    StateOpen,
		openedAt: b.now(),
		cooldown: defaultCooldown,
	}
}

// IsHealthy reports whether a provider should receive production traffic.
// OPEN and HALF_OPEN both block traffic (HALF_OPEN waits for its probe).
func (b *Breakers) IsHealthy(providerKey string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entries[providerKey]
	return e == nil || e.state == StateClosed
}

// State returns the breaker state (CLOSED when no entry exists).
func (b *Breakers) State(providerKey string) BreakerState {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entries[providerKey]
	if e == nil {
		return StateClosed
	}
	return e.state
}

// MaybeStartProbe advances OPEN -> HALF_OPEN once the cooldown elapses,
// reporting whether a probe request should be sent now.
func (b *Breakers) MaybeStartProbe(providerKey string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entries[providerKey]
	if e == nil || e.state != StateOpen {
		return false
	}
	if e.probeCount >= maxProbes {
		if b.now().Sub(e.openedAt) < maxCooldown {
			return false
		}
		e.probeCount = 0
		e.cooldown = defaultCooldown
	}
	if b.now().Sub(e.openedAt) < e.cooldown {
		return false
	}
	e.state = StateHalfOpen
	e.probeCount++
	return true
}

// RecordProbeResult closes the breaker on a successful probe or re-opens it
// with a doubled cooldown on failure.
func (b *Breakers) RecordProbeResult(providerKey string, success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entries[providerKey]
	if e == nil || e.state != StateHalfOpen {
		return
	}
	if success {
		delete(b.entries, providerKey)
		return
	}
	e.state = StateOpen
	e.openedAt = b.now()
	e.cooldown *= 2
	if e.cooldown > maxCooldown {
		e.cooldown = maxCooldown
	}
	e.consecutiveProbeFailures++
}

// Snapshot returns a copy of per-provider stats plus breaker states.
func (b *Breakers) Snapshot() map[string]ProviderStat {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]ProviderStat, len(b.stats))
	for k, v := range b.stats {
		out[k] = *v
	}
	return out
}
