'use strict';

// Canary routing state machine for gradual provider rollouts.
// State machine: COLD -> WARMING -> ACTIVE (promoted on sustained health),
//                WARMING -> COLD (rolled back on error spikes).
// State is per-slot per-model, in-memory only (resets on proxy restart).

export type CanaryPhase = 'COLD' | 'WARMING' | 'ACTIVE';

export interface CanaryConfig {
  enabled: boolean;
  targetProvider: string;
  targetModel: string;
  warmupPercent: number;
  promoteAfter: number;
  promoteAfterActive: number;
  rollbackErrorRate: number;
}

export interface CanaryState {
  phase: CanaryPhase;
  consecutiveSuccesses: number;
  recentRequests: number;
  recentErrors: number;
  lastUpdated: number;
}

export interface CanaryEntry {
  config: CanaryConfig;
  state: CanaryState;
}

// Module-level state: per-slot canary entries
const entries = new Map<string, CanaryEntry>();

export function getOrCreateEntry(slot: string, config: CanaryConfig): CanaryEntry {
  let entry = entries.get(slot);
  if (!entry) {
    entry = {
      config,
      state: {
        phase: 'COLD',
        consecutiveSuccesses: 0,
        recentRequests: 0,
        recentErrors: 0,
        lastUpdated: Date.now(),
      },
    };
    entries.set(slot, entry);
  }
  return entry;
}

// Reset all canary state (for testing).
export function resetState(): void {
  entries.clear();
}

// Deterministic hash of request body + slot for consistent routing.
// Same request body always maps to the same provider.
export function bodyHash(body: string, slot: string): number {
  const input = slot + ':' + body;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash = hash | 0;
  }
  return Math.abs(hash);
}

// Decide whether this request should be routed to the canary provider.
// COLD:  never
// WARMING: based on hash percentage
// ACTIVE: always
export function shouldUseCanary(hash: number, state: CanaryState, config: CanaryConfig): boolean {
  if (!config.enabled) return false;
  if (state.phase === 'COLD') return false;
  if (state.phase === 'ACTIVE') return true;
  return (hash % 100) < config.warmupPercent;
}

// Check whether the canary should be rolled back due to error spikes.
// Only applies during WARMING phase. Requires at least 5 requests to judge.
export function shouldRollback(state: CanaryState, config: CanaryConfig): boolean {
  if (state.phase !== 'WARMING') return false;
  if (state.recentRequests < 5) return false;
  return (state.recentErrors / state.recentRequests) > config.rollbackErrorRate;
}

// Record the outcome of a canary request and potentially transition state.
// Mutates the state in-place.
export function recordCanaryResult(success: boolean, state: CanaryState, config: CanaryConfig): void {
  state.lastUpdated = Date.now();
  state.recentRequests++;

  if (success) {
    state.consecutiveSuccesses++;
  } else {
    state.recentErrors++;
    state.consecutiveSuccesses = 0;
  }

  // COLD -> WARMING: promote after N consecutive successes
  if (state.phase === 'COLD' && state.consecutiveSuccesses >= config.promoteAfter) {
    state.phase = 'WARMING';
    state.recentRequests = 0;
    state.recentErrors = 0;
    return;
  }

  // WARMING: check promotion or rollback
  if (state.phase === 'WARMING') {
    if (state.consecutiveSuccesses >= config.promoteAfterActive) {
      state.phase = 'ACTIVE';
    } else if (shouldRollback(state, config)) {
      state.phase = 'COLD';
      state.consecutiveSuccesses = 0;
      state.recentRequests = 0;
      state.recentErrors = 0;
    }
  }
}
