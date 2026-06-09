'use strict';

// Streaming performance metrics: time-to-first-token (TTFT), tokens-per-second
// (TPS), and inter-chunk latency.  Collection is always-on but overhead is
// negligible (a few Date.now() calls and array pushes per stream).

export interface StreamMetrics {
  ttftMs: number;            // time-to-first-token in ms
  totalDurationMs: number;   // total stream duration (first token to last chunk)
  chunkCount: number;        // number of data chunks received
  totalTokens: number;       // estimated output tokens from chunks
  tps: number;               // tokens per second (totalTokens / totalDurationSeconds)
  maxInterChunkMs: number;   // longest gap between chunks
  avgInterChunkMs: number;   // average gap between chunks
  p95InterChunkMs: number;   // 95th percentile inter-chunk latency
}

export interface StreamTimings {
  startTime: number;          // Date.now() when stream started
  firstTokenTime: number;     // Date.now() when first data chunk arrived (0 = not yet)
  lastChunkTime: number;      // Date.now() when last data chunk arrived
  lastChunkTimes: number[];   // timestamp of each chunk (for percentile calculation)
}

// Creates a new timings object with startTime set to now.
export function startStreamTimer(): StreamTimings {
  return {
    startTime: Date.now(),
    firstTokenTime: 0,
    lastChunkTime: 0,
    lastChunkTimes: [],
  };
}

// Records the first-token timestamp.  Safe to call multiple times -- only the
// first call takes effect (subsequent calls are no-ops).
export function recordFirstToken(timings: StreamTimings): void {
  if (timings.firstTokenTime === 0) {
    timings.firstTokenTime = Date.now();
  }
}

// Records a chunk arrival timestamp.  Pushes to lastChunkTimes, capping the
// array at 500 entries (discard oldest) to prevent unbounded memory growth
// on very long streams.
export function recordChunk(timings: StreamTimings): void {
  const now = Date.now();
  timings.lastChunkTime = now;
  timings.lastChunkTimes.push(now);
  if (timings.lastChunkTimes.length > 500) {
    timings.lastChunkTimes.shift();
  }
}

// Computes final metrics from timings.  Returns a fully populated StreamMetrics
// object.  Handles edge cases: no first token (ttftMs = 0), no chunks (inter-
// chunk metrics = 0), zero tokens (tps = 0), very short duration (min 100ms).
export function finalizeMetrics(timings: StreamTimings, estimatedTokens: number): StreamMetrics {
  const ttftMs = timings.firstTokenTime > 0
    ? timings.firstTokenTime - timings.startTime
    : 0;
  const totalDurationMs = timings.lastChunkTime > 0
    ? timings.lastChunkTime - timings.startTime
    : 0;
  const chunkCount = timings.lastChunkTimes.length;

  // Compute inter-chunk latencies from consecutive timestamps
  let maxInterChunkMs = 0;
  let sumInterChunkMs = 0;
  const gaps: number[] = [];
  for (let i = 1; i < timings.lastChunkTimes.length; i++) {
    const gap = timings.lastChunkTimes[i] - timings.lastChunkTimes[i - 1];
    gaps.push(gap);
    sumInterChunkMs += gap;
    if (gap > maxInterChunkMs) maxInterChunkMs = gap;
  }

  const avgInterChunkMs = gaps.length > 0
    ? Math.round((sumInterChunkMs / gaps.length) * 100) / 100
    : 0;

  // Sort gaps and pick the 95th percentile
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const p95InterChunkMs = sortedGaps.length > 0
    ? sortedGaps[Math.min(Math.ceil(sortedGaps.length * 0.95) - 1, sortedGaps.length - 1)]
    : 0;

  const tps = computeTPS(estimatedTokens, totalDurationMs);

  return {
    ttftMs,
    totalDurationMs,
    chunkCount,
    totalTokens: estimatedTokens,
    tps,
    maxInterChunkMs,
    avgInterChunkMs,
    p95InterChunkMs,
  };
}

// Computes tokens per second from total token count and wall-clock duration.
// Returns 0 when totalTokens <= 0 or durationMs <= 0.  Uses a minimum
// duration of 10ms to prevent division-by-zero on very short responses.
export function computeTPS(totalTokens: number, durationMs: number): number {
  if (totalTokens <= 0) return 0;
  if (durationMs <= 0) return 0;
  const effectiveDuration = Math.max(durationMs, 10);
  return Math.round((totalTokens / (effectiveDuration / 1000)) * 100) / 100;
}
