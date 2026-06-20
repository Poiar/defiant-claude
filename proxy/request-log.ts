'use strict';

// Structured request logging for the Defiant proxy.
// Writes JSON lines (JSONL) to ~/.defiant/requests.log with automatic
// rotation at 1MB. By default only failed requests are logged; call
// setLogAllRequests(true) to log every request.
//
// Entries are batched in a write queue and flushed asynchronously via
// setImmediate to avoid interleaving from concurrent async contexts.

import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Public types ---

export interface RequestLogEntry {
  timestamp: string;
  requestId: number;
  method: string;
  url: string;
  model: string;
  providerKey: string;
  slot: string;
  status: number;
  success: boolean;
  fallbackUsed: boolean;
  fallbackChain: string[];
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  errorCode?: string;
  errorSummary?: string;
  userAgent?: string;
  deadStream?: boolean;
  deadStreamReason?: string;
}

// --- Internal state ---

const LOG_FILE = path.join(os.homedir(), '.defiant', 'requests.log');
let LOG_FILE_OVERRIDE: string | null = null;
function getLogFilePath(): string {
  return LOG_FILE_OVERRIDE || LOG_FILE;
}
const MAX_LOG_SIZE = 1_048_576; // 1MB
const MAX_PENDING_ENTRIES = 10_000; // Prevent OOM on persistent disk failure

let logAllEnabled = false;
const pendingEntries: RequestLogEntry[] = [];
let flushScheduled = false;
let writeLock = false; // Prevent concurrent rotation + write races

// --- Scheduler ---

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    flush();
  });
}

function flush(): void {
  if (pendingEntries.length === 0) return;

  // Drain the queue so new entries can be queued even if the write fails.
  const entries = pendingEntries.splice(0, pendingEntries.length);

  if (writeLock) return; // Another flush is already writing
  writeLock = true;
  try {
    const logDir = path.dirname(getLogFilePath());
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Rotate if current log exceeds 1MB.
    rotateIfNeeded();

    // Write all batched entries as one atomic append.
    const lines = entries.map((e) => JSON.stringify(e) + '\n').join('');
    fs.appendFileSync(getLogFilePath(), lines, 'utf-8');
  } catch (_) {
    // Prepend entries back to preserve them on write failure (disk full,
    // permissions, etc.).  Never crash the proxy over a log write.
    // Cap to prevent unbounded memory growth during persistent failures.
    const available = MAX_PENDING_ENTRIES - pendingEntries.length;
    if (available > 0) {
      pendingEntries.unshift(...entries.slice(-available));
    }
  } finally {
    writeLock = false;
  }
}

const MAX_ROTATED_FILES = 5;

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(getLogFilePath());
    if (stat.size < MAX_LOG_SIZE) return;

    const logFile = getLogFilePath();
    // Use timestamped backup to avoid overwriting previous backups.
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const ts = Date.now();
    const backup = logFile + '.' + dateStr + '-' + ts;
    fs.renameSync(logFile, backup);

    // Keep at most MAX_ROTATED_FILES rotated files (remove oldest).
    const dir = path.dirname(logFile);
    const base = path.basename(logFile);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + '.'))
      .map((f) => path.join(dir, f))
      .sort()
      .reverse();
    while (files.length > MAX_ROTATED_FILES) {
      const oldFile = files.pop();
      if (oldFile) {
        try {
          fs.unlinkSync(oldFile);
        } catch (_) {
          /* best effort */
        }
      }
    }
  } catch (_) {
    // File may not exist yet (first write).
  }
}

// --- Public API ---

/**
 * Write a request log entry.  By default only failed requests (status >= 400,
 * dead stream, transport error, or fallback used) are written.  Call
 * setLogAllRequests(true) to include successful requests.
 */
export function logRequest(entry: RequestLogEntry): void {
  // Filter: skip successful, non-fallback requests when full logging is off.
  if (!logAllEnabled) {
    if (
      entry.success &&
      !entry.fallbackUsed &&
      entry.status < 400 &&
      !entry.errorCode &&
      !entry.deadStream
    ) {
      return;
    }
  }

  if (pendingEntries.length >= MAX_PENDING_ENTRIES) {
    // Drop oldest entry under memory pressure — safety over completeness.
    pendingEntries.shift();
  }
  pendingEntries.push(entry);
  scheduleFlush();
}

/** Enable or disable logging of all requests (not just failures). */
export function setLogAllRequests(enabled: boolean): void {
  logAllEnabled = enabled;
}

// --- Testing support ---

/** Force-flush all pending entries synchronously.  Used in tests. */
export function _flush(): void {
  if (flushScheduled) {
    flushScheduled = false;
    flush();
  }
}

/** Reset internal state between tests. */
export function _reset(): void {
  pendingEntries.length = 0;
  flushScheduled = false;
  logAllEnabled = false;
}

/** Return the resolved log file path (for test assertions). */
export function _getLogFilePath(): string {
  return getLogFilePath();
}

/** Override the log file path for tests. */
export function _setLogFilePath(p: string): void {
  LOG_FILE_OVERRIDE = p;
}
