package resilience

import (
	"sync"
	"time"
)

// CanaryPhase is the gradual-rollout state machine: COLD -> WARMING -> ACTIVE.
type CanaryPhase int

const (
	CanaryCold CanaryPhase = iota
	CanaryWarming
	CanaryActive
)

// CanaryConfig describes a gradual rollout of one model slot to a new provider.
type CanaryConfig struct {
	Enabled            bool
	TargetProvider     string
	TargetModel        string
	WarmupPercent      int
	PromoteAfter       int
	PromoteAfterActive int
	RollbackErrorRate  float64
}

type canaryState struct {
	phase                CanaryPhase
	consecutiveSuccesses int
	recentRequests       int
	recentErrors         int
	lastUpdated          time.Time
}

type canaryEntry struct {
	config CanaryConfig
	state  canaryState
}

// Canary tracks per-slot rollout state in memory.
type Canary struct {
	mu      sync.Mutex
	entries map[string]*canaryEntry
	now     func() time.Time
}

func NewCanary() *Canary {
	return &Canary{entries: make(map[string]*canaryEntry), now: time.Now}
}

func (c *Canary) getOrCreate(slot string, config CanaryConfig) *canaryEntry {
	if !config.Enabled {
		return nil
	}
	e := c.entries[slot]
	if e == nil {
		e = &canaryEntry{config: config, state: canaryState{phase: CanaryCold, lastUpdated: c.now()}}
		c.entries[slot] = e
	}
	return e
}

// ShouldUse decides whether a request should route to the canary provider.
// The second return reports whether the request is being tracked (for a
// later RecordResult call).
func (c *Canary) ShouldUse(slot, body string, config CanaryConfig) (use bool, tracking bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.getOrCreate(slot, config)
	if e == nil {
		return false, false
	}
	s := &e.state
	switch s.phase {
	case CanaryCold:
		return false, true
	case CanaryActive:
		return true, true
	}
	pct := config.WarmupPercent
	if pct <= 0 {
		return false, true
	}
	if pct >= 100 {
		return true, true
	}
	return int(bodyHash(slot+":"+body)%100) < pct, true
}

// RecordResult folds a canary outcome into the state machine, possibly
// promoting (COLD->WARMING->ACTIVE) or rolling back (WARMING->COLD).
func (c *Canary) RecordResult(slot string, success bool, config CanaryConfig) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.getOrCreate(slot, config)
	if e == nil {
		return
	}
	s := &e.state
	s.lastUpdated = c.now()
	s.recentRequests++
	if success {
		s.consecutiveSuccesses++
	} else {
		s.recentErrors++
		s.consecutiveSuccesses = 0
	}

	if s.phase == CanaryCold && s.consecutiveSuccesses >= config.PromoteAfter {
		s.phase = CanaryWarming
		s.recentRequests = 0
		s.recentErrors = 0
		return
	}
	if s.phase == CanaryWarming {
		if s.consecutiveSuccesses >= config.PromoteAfterActive {
			s.phase = CanaryActive
		} else if s.recentRequests >= 5 &&
			float64(s.recentErrors)/float64(s.recentRequests) > config.RollbackErrorRate {
			s.phase = CanaryCold
			s.consecutiveSuccesses = 0
			s.recentRequests = 0
			s.recentErrors = 0
		}
	}
}

// bodyHash mirrors the TS deterministic 32-bit hash (djb2 variant) so the
// same body maps to the same percentage bucket across implementations.
func bodyHash(input string) uint32 {
	hash := int32(0)
	for i := 0; i < len(input); i++ {
		hash = (hash << 5) - hash + int32(input[i])
	}
	if hash < 0 {
		return uint32(-hash)
	}
	return uint32(hash)
}
