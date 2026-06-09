'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_CONCURRENT = void 0;
exports.createSlotLimiter = createSlotLimiter;
exports.DEFAULT_MAX_CONCURRENT = 25;
const DEFAULT_ACQUIRE_TIMEOUT = 30000;
function createSlotLimiter(maxConcurrent) {
    const limit = maxConcurrent || exports.DEFAULT_MAX_CONCURRENT;
    let active = 0;
    const waitQueue = [];
    function pump() {
        while (waitQueue.length > 0 && active < limit) {
            const next = waitQueue.shift();
            if (next && next.cancelled)
                continue;
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
    function acquire(timeoutMs) {
        const to = (timeoutMs != null) ? timeoutMs : DEFAULT_ACQUIRE_TIMEOUT;
        if (active < limit) {
            active++;
            let released = false;
            return { promise: Promise.resolve(() => { if (!released) {
                    released = true;
                    active--;
                    pump();
                } }), cancel: () => { } };
        }
        let cancelled = false;
        let timer;
        const entry = { resolve: () => { }, reject: () => { }, cancelled: false };
        const promise = new Promise((resolve, reject) => {
            entry.resolve = () => {
                if (timer)
                    clearTimeout(timer);
                let released = false;
                resolve(() => { if (!released) {
                    released = true;
                    active--;
                    pump();
                } });
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
        promise.catch(() => { });
        return {
            promise,
            cancel: () => {
                if (!cancelled) {
                    cancelled = true;
                    if (timer)
                        clearTimeout(timer);
                    entry.cancelled = true;
                    entry.reject(new Error('Slot cancelled'));
                }
            },
        };
    }
    // Current snapshot for monitoring.
    function status() {
        return {
            active,
            waiting: waitQueue.length,
            limit,
            utilization: active / limit,
        };
    }
    return { acquire, status };
}
