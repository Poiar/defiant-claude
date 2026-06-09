'use strict';

// Concurrency slot limiter for upstream requests.
// Prevents bursty tool calls from overwhelming a provider by capping
// the number of simultaneous in-flight upstream requests.

interface SlotAcquireResult {
    promise: Promise<() => void>;
    cancel: () => void;
}

export interface SlotLimiterStatus {
    active: number;
    waiting: number;
    limit: number;
    utilization: number;
}

interface SlotLimiter {
    acquire: (timeoutMs?: number) => SlotAcquireResult;
    status: () => SlotLimiterStatus;
}

interface QueueEntry {
    resolve: () => void;
    reject: (err: Error) => void;
    cancelled: boolean;
}

export const DEFAULT_MAX_CONCURRENT = 25;
const DEFAULT_ACQUIRE_TIMEOUT = 30000;

// Per-slot concurrency pools. Subagent requests get a dedicated pool so they
// cannot starve main chat (sonnet/opus/haiku) slots. Each pool is independent.
export const DEFAULT_SUBAGENT_MAX = 8;

export interface SlotConcurrency {
    acquire: (slot: string | null, timeoutMs?: number) => SlotAcquireResult;
    status: () => { subagent: SlotLimiterStatus; default: SlotLimiterStatus };
}

export function createSlotConcurrency(
    defaultMax: number = DEFAULT_MAX_CONCURRENT,
    subagentMax: number = DEFAULT_SUBAGENT_MAX,
    maxQueue: number = DEFAULT_MAX_WAIT_QUEUE,
): SlotConcurrency {
    const subagent = createSlotLimiter(subagentMax, maxQueue);
    const default_ = createSlotLimiter(defaultMax, maxQueue);

    return {
        acquire(slot: string | null, timeoutMs?: number) {
            return slot === 'subagent' ? subagent.acquire(timeoutMs) : default_.acquire(timeoutMs);
        },
        status() {
            return { subagent: subagent.status(), default: default_.status() };
        },
    };
}

const DEFAULT_MAX_WAIT_QUEUE = 500;

export function createSlotLimiter(maxConcurrent?: number, maxQueue?: number): SlotLimiter {
    const limit = maxConcurrent || DEFAULT_MAX_CONCURRENT;
    const maxQueueLen = maxQueue ?? DEFAULT_MAX_WAIT_QUEUE;
    let active = 0;
    const waitQueue: QueueEntry[] = [];

    function pump(): void {
        while (waitQueue.length > 0 && active < limit) {
            const next = waitQueue.shift();
            if (next && next.cancelled) continue;
            if (next) {
                active++;
                next.resolve();
            }
        }
    }

    // Acquire a concurrency slot. Returns a Promise that resolves to a
    // release function. The promise rejects with a timeout error if no
    // slot becomes available within `timeoutMs` (default 30s).
    // The returned object also exposes `.cancel()` to abort waiting.
    function acquire(timeoutMs?: number): SlotAcquireResult {
        const to = (timeoutMs != null) ? timeoutMs : DEFAULT_ACQUIRE_TIMEOUT;

        if (active < limit) {
            active++;
            let released = false;
            return { promise: Promise.resolve(() => { if (!released) { released = true; active--; pump(); } }), cancel: () => { /* no-op */ } };
        }

        // Cap the wait queue to prevent unbounded memory growth
        if (waitQueue.length >= maxQueueLen) {
            const err = new Error('Slot queue full (' + maxQueueLen + ' entries)');
            return { promise: Promise.reject(err), cancel: () => {} };
        }

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const entry: QueueEntry = { resolve: () => { /* stub */ }, reject: () => { /* stub */ }, cancelled: false };
        const promise: Promise<() => void> = new Promise((resolve, reject) => {
            entry.resolve = () => {
                if (timer) clearTimeout(timer);
                let released = false;
                resolve(() => { if (!released) { released = true; active--; pump(); } });
            };
            entry.reject = reject;
            entry.cancelled = false;
            waitQueue.push(entry);
            timer = setTimeout(() => {
                cancelled = true;
                entry.cancelled = true;
                reject(new Error('Slot acquire timeout after ' + to + 'ms'));
            }, to);
        });
        promise.catch(() => { /* Suppress unhandled rejection when cancelled */ });

        return {
            promise,
            cancel: () => {
                if (!cancelled) {
                    cancelled = true;
                    if (timer) clearTimeout(timer);
                    entry.cancelled = true;
                    entry.reject(new Error('Slot cancelled'));
                }
            },
        };
    }

    // Current snapshot for monitoring.
    function status(): SlotLimiterStatus {
        return {
            active,
            waiting: waitQueue.length,
            limit,
            utilization: active / limit,
        };
    }

    return { acquire, status };
}

