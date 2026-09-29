package proxy

import (
	"fmt"
	"sync/atomic"
	"time"
)

// Concurrency limits simultaneous in-flight upstream requests, split into two
// independent pools so bursty subagent traffic cannot starve main chat slots.
type Concurrency struct {
	defaultPool  *slotPool
	subagentPool *slotPool
}

// NewConcurrency builds a limiter with defaultMax slots for main chat and
// subagentMax slots for subagent requests.
func NewConcurrency(defaultMax, subagentMax int) *Concurrency {
	return &Concurrency{
		defaultPool:  newSlotPool(defaultMax),
		subagentPool: newSlotPool(subagentMax),
	}
}

// Acquire waits up to timeout for a slot, returning a release function.
func (c *Concurrency) Acquire(slot string, timeout time.Duration) (release func(), err error) {
	if slot == "sub" || slot == "subagent" {
		return c.subagentPool.acquire(timeout)
	}
	return c.defaultPool.acquire(timeout)
}

// Status returns (defaultActive, defaultWaiting, subagentActive, subagentWaiting).
func (c *Concurrency) Status() (int64, int64, int64, int64) {
	a1, w1 := c.defaultPool.status()
	a2, w2 := c.subagentPool.status()
	return a1, w1, a2, w2
}

// slotPool is a channel-based counting semaphore with an acquire timeout and
// live active/waiting counters for monitoring.
type slotPool struct {
	ch      chan struct{}
	active  atomic.Int64
	waiting atomic.Int64
}

func newSlotPool(limit int) *slotPool {
	if limit < 1 {
		limit = 1
	}
	return &slotPool{ch: make(chan struct{}, limit)}
}

func (p *slotPool) acquire(timeout time.Duration) (release func(), err error) {
	p.waiting.Add(1)
	defer p.waiting.Add(-1)
	select {
	case p.ch <- struct{}{}:
		p.active.Add(1)
		return func() {
			<-p.ch
			p.active.Add(-1)
		}, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("concurrency slot acquire timeout after %v", timeout)
	}
}

func (p *slotPool) status() (active, waiting int64) {
	return p.active.Load(), p.waiting.Load()
}
