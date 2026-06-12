'use strict';

import {
  startStreamTimer,
  recordFirstToken,
  recordChunk,
  finalizeMetrics,
  computeTPS,
  type StreamTimings,
  type StreamMetrics,
} from '../stream-metrics';

describe('startStreamTimer', () => {
  test('sets startTime to current time', () => {
    const before = Date.now();
    const timings = startStreamTimer();
    const after = Date.now();
    expect(timings.startTime).toBeGreaterThanOrEqual(before);
    expect(timings.startTime).toBeLessThanOrEqual(after);
  });

  test('initializes all fields correctly', () => {
    const timings = startStreamTimer();
    expect(timings.firstTokenTime).toBe(0);
    expect(timings.lastChunkTime).toBe(0);
    expect(timings.lastChunkTimes).toEqual([]);
  });
});

describe('recordFirstToken', () => {
  test('stamps firstTokenTime on first call', () => {
    const timings = startStreamTimer();
    const before = Date.now();
    recordFirstToken(timings);
    const after = Date.now();
    expect(timings.firstTokenTime).toBeGreaterThanOrEqual(before);
    expect(timings.firstTokenTime).toBeLessThanOrEqual(after);
  });

  test('stamps firstTokenTime exactly once (subsequent calls are no-ops)', () => {
    const timings = startStreamTimer();
    recordFirstToken(timings);
    const stamped = timings.firstTokenTime;
    // Second call should not change the stamped value
    recordFirstToken(timings);
    expect(timings.firstTokenTime).toBe(stamped);
  });
});

describe('recordChunk', () => {
  test('updates lastChunkTime and grows lastChunkTimes', () => {
    const timings = startStreamTimer();
    const before = Date.now();
    recordChunk(timings);
    const after = Date.now();
    expect(timings.lastChunkTime).toBeGreaterThanOrEqual(before);
    expect(timings.lastChunkTime).toBeLessThanOrEqual(after);
    expect(timings.lastChunkTimes.length).toBe(1);
  });

  test('accumulates multiple chunks', () => {
    const timings = startStreamTimer();
    recordChunk(timings);
    recordChunk(timings);
    recordChunk(timings);
    expect(timings.lastChunkTimes.length).toBe(3);
  });

  test('capped at 500 entries (discards oldest)', () => {
    const timings = startStreamTimer();
    // Push 501 chunks
    for (let i = 0; i < 501; i++) {
      recordChunk(timings);
    }
    expect(timings.lastChunkTimes.length).toBe(500);
    // Verify we can still record more without growing
    recordChunk(timings);
    expect(timings.lastChunkTimes.length).toBe(500);
  });

  test('lastChunkTimes contains the most recent entries after cap', () => {
    const timings = startStreamTimer();
    const timestamps: number[] = [];
    for (let i = 0; i < 510; i++) {
      recordChunk(timings);
      timestamps.push(timings.lastChunkTime);
    }
    // After 510 pushes, should have 500 entries (last 500)
    expect(timings.lastChunkTimes.length).toBe(500);
    // The first entry should be the 11th push (index 10 in timestamps, 0-indexed)
    expect(timings.lastChunkTimes[0]).toBe(timestamps[10]);
    // The last entry should be the 510th push
    expect(timings.lastChunkTimes[499]).toBe(timestamps[509]);
  });
});

describe('finalizeMetrics', () => {
  test('computes correct TTFT, TPS, and duration', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now + 200,   // 200ms TTFT
      lastChunkTime: now + 1200,   // 1200ms total duration
      lastChunkTimes: [],
    };
    // Simulate chunks at various times
    for (let i = 1; i <= 10; i++) {
      timings.lastChunkTimes.push(now + 200 + i * 100);
    }

    const metrics = finalizeMetrics(timings, 500);
    expect(metrics.ttftMs).toBe(200);
    expect(metrics.totalDurationMs).toBe(1200);
    expect(metrics.chunkCount).toBe(10);
    expect(metrics.totalTokens).toBe(500);
    // TPS = 500 / (1200/1000) = 500 / 1.2 = 416.67
    expect(metrics.tps).toBeCloseTo(416.67, 0);
  });

  test('with 0 tokens returns 0 TPS', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now + 100,
      lastChunkTime: now + 500,
      lastChunkTimes: [now + 100, now + 300, now + 500],
    };
    const metrics = finalizeMetrics(timings, 0);
    expect(metrics.tps).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.ttftMs).toBe(100);
  });

  test('with <1ms duration does not divide by zero', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now,         // same timestamp (sub-ms)
      lastChunkTime: now,
      lastChunkTimes: [now],
    };
    const metrics = finalizeMetrics(timings, 100);
    // Duration is 0, computeTPS uses 100ms minimum
    expect(metrics.totalDurationMs).toBe(0);
    // TPS = 0 when durationMs <= 0
    expect(metrics.tps).toBe(0);
  });

  test('no first token results in ttftMs = 0', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: 0,           // never set
      lastChunkTime: now + 500,
      lastChunkTimes: [now + 100, now + 300, now + 500],
    };
    const metrics = finalizeMetrics(timings, 50);
    expect(metrics.ttftMs).toBe(0);
    expect(metrics.tps).toBeGreaterThan(0);
  });

  test('no chunks results in zero inter-chunk metrics', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now + 100,
      lastChunkTime: now + 100,
      lastChunkTimes: [],
    };
    const metrics = finalizeMetrics(timings, 100);
    expect(metrics.chunkCount).toBe(0);
    expect(metrics.maxInterChunkMs).toBe(0);
    expect(metrics.avgInterChunkMs).toBe(0);
    expect(metrics.p95InterChunkMs).toBe(0);
  });

  test('single chunk results in zero inter-chunk metrics', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now + 100,
      lastChunkTime: now + 100,
      lastChunkTimes: [now + 100],
    };
    const metrics = finalizeMetrics(timings, 100);
    expect(metrics.chunkCount).toBe(1);
    expect(metrics.maxInterChunkMs).toBe(0);
    expect(metrics.avgInterChunkMs).toBe(0);
  });

  test('computes max, avg, and p95 inter-chunk latencies', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now + 50,
      lastChunkTime: now + 600,
      lastChunkTimes: [
        now + 50,    // chunk 1
        now + 150,   // chunk 2 (gap 100)
        now + 200,   // chunk 3 (gap 50)
        now + 500,   // chunk 4 (gap 300)
        now + 600,   // chunk 5 (gap 100)
      ],
    };
    const metrics = finalizeMetrics(timings, 200);
    // Gaps: 100, 50, 300, 100
    expect(metrics.maxInterChunkMs).toBe(300);
    expect(metrics.avgInterChunkMs).toBe(137.5); // (100+50+300+100)/4
    // Sorted gaps: 50, 100, 100, 300
    // p95 index = ceil(4*0.95) - 1 = ceil(3.8) - 1 = 4 - 1 = 3
    // sorted[3] = 300
    expect(metrics.p95InterChunkMs).toBe(300);
  });
});

describe('computeTPS', () => {
  test('calculates correct TPS', () => {
    // 500 tokens over 2 seconds = 250 TPS
    const tps = computeTPS(500, 2000);
    expect(tps).toBe(250);
  });

  test('returns 0 for 0 tokens', () => {
    const tps = computeTPS(0, 1000);
    expect(tps).toBe(0);
  });

  test('returns 0 for negative tokens', () => {
    const tps = computeTPS(-10, 1000);
    expect(tps).toBe(0);
  });

  test('uses 10ms minimum duration to prevent inflated TPS', () => {
    // 1000 tokens in 10ms (very fast) -> uses 10ms minimum
    const tps = computeTPS(1000, 10);
    // 1000 / (10/1000) = 1000/0.01 = 100000
    expect(tps).toBe(100000);
  });

  test('handles exact 10ms duration', () => {
    const tps = computeTPS(50, 10);
    // 50 / (10/1000) = 50/0.01 = 5000
    expect(tps).toBe(5000);
  });

  test('rounds to 2 decimal places', () => {
    const tps = computeTPS(100, 3000);
    // 100 / 3 = 33.333...
    expect(tps).toBe(33.33);
  });
});

describe('full lifecycle integration', () => {
  test('start -> first token -> chunks -> finalize', () => {
    const timings = startStreamTimer();
    const startTime = timings.startTime;

    // Simulate some delay before first token
    while (Date.now() - startTime < 50) {
      /* spin */
    }

    recordFirstToken(timings);
    const ttft = timings.firstTokenTime - timings.startTime;
    expect(ttft).toBeGreaterThanOrEqual(45);
    expect(timings.firstTokenTime).not.toBe(0);

    // Simulate multiple chunks arriving
    for (let i = 0; i < 5; i++) {
      while (Date.now() - timings.lastChunkTime < 30) {
        /* spin */
      }
      recordChunk(timings);
    }
    expect(timings.lastChunkTimes.length).toBe(5);
    expect(timings.lastChunkTime).toBeGreaterThan(timings.firstTokenTime);

    // Finalize with estimated tokens
    const metrics = finalizeMetrics(timings, 1000);
    expect(metrics.ttftMs).toBeGreaterThanOrEqual(45);
    expect(metrics.chunkCount).toBe(5);
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(150);
    expect(metrics.totalTokens).toBe(1000);
    expect(metrics.tps).toBeGreaterThan(0);
    expect(metrics.maxInterChunkMs).toBeGreaterThanOrEqual(25);
    expect(metrics.avgInterChunkMs).toBeGreaterThan(0);
    expect(metrics.p95InterChunkMs).toBeGreaterThan(0);
  });

  test('non-streaming equivalent (single shot)', () => {
    const now = Date.now();
    const timings: StreamTimings = {
      startTime: now,
      firstTokenTime: now + 300,   // TTFT = 300ms (same as total for non-streaming)
      lastChunkTime: now + 300,    // last chunk = same as first (single response)
      lastChunkTimes: [],          // no individual chunks recorded
    };

    const metrics = finalizeMetrics(timings, 0);
    // Non-streaming: chunkCount=0, TPS=0, inter-chunk=0
    expect(metrics.ttftMs).toBe(300);
    expect(metrics.totalDurationMs).toBe(300);
    expect(metrics.chunkCount).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.tps).toBe(0);
    expect(metrics.maxInterChunkMs).toBe(0);
    expect(metrics.avgInterChunkMs).toBe(0);
    expect(metrics.p95InterChunkMs).toBe(0);
  });
});

describe('StreamMetrics type shape', () => {
  test('has all required fields', () => {
    const metrics: StreamMetrics = {
      ttftMs: 100,
      totalDurationMs: 500,
      chunkCount: 10,
      totalTokens: 1000,
      tps: 2000,
      maxInterChunkMs: 150,
      avgInterChunkMs: 50.5,
      p95InterChunkMs: 120,
    };
    // Verify all fields are present and typed correctly
    expect(typeof metrics.ttftMs).toBe('number');
    expect(typeof metrics.totalDurationMs).toBe('number');
    expect(typeof metrics.chunkCount).toBe('number');
    expect(typeof metrics.totalTokens).toBe('number');
    expect(typeof metrics.tps).toBe('number');
    expect(typeof metrics.maxInterChunkMs).toBe('number');
    expect(typeof metrics.avgInterChunkMs).toBe('number');
    expect(typeof metrics.p95InterChunkMs).toBe('number');
  });
});
