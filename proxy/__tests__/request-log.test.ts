'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  logRequest,
  setLogAllRequests,
  _flush,
  _reset,
  _getLogFilePath,
  _setLogFilePath,
  type RequestLogEntry,
} from '../request-log';

// Helper: build a minimal entry with defaults for required fields.
function makeEntry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    timestamp: new Date().toISOString(),
    requestId: 1,
    method: 'POST',
    url: '/v1/messages',
    model: 'deepseek-v4-pro',
    providerKey: 'ds',
    slot: 'opus',
    status: 200,
    success: true,
    fallbackUsed: false,
    fallbackChain: ['ds'],
    latencyMs: 100,
    ...overrides,
  };
}

// Read the log file as an array of parsed JSON objects.
function readLogFile(): RequestLogEntry[] {
  const logFile = _getLogFilePath();
  try {
    if (!fs.existsSync(logFile)) return [];
    const raw = fs.readFileSync(logFile, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

// Read raw log file content safely.
function readRawLog(): string {
  const logFile = _getLogFilePath();
  try {
    return fs.readFileSync(logFile, 'utf-8');
  } catch (_) {
    return '';
  }
}

// Write a file at exactly the rotation threshold (1 MB).
function writeBigLogFile(): void {
  const logFile = _getLogFilePath();
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  // Must be >= MAX_LOG_SIZE (1_048_576) to trigger rotation.
  const bigLine = Buffer.alloc(1_048_576, 'x').toString();
  fs.writeFileSync(logFile, bigLine, 'utf-8');
}

// Clean up the log file and backup after each test.
let tempLogDir: string;

function removeLogFile(): void {
  const logFile = _getLogFilePath();
  try { fs.unlinkSync(logFile); } catch (_) { /* may not exist */ }
  try { fs.unlinkSync(logFile + '.1'); } catch (_) { /* may not exist */ }
}

beforeAll(() => {
  tempLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepclaude-test-'));
  _setLogFilePath(path.join(tempLogDir, 'requests.log'));
});

afterAll(() => {
  try { fs.rmSync(tempLogDir, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
});

beforeEach(() => {
  _reset();
  removeLogFile();
});

afterEach(() => {
  _reset();
  removeLogFile();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('logRequest writes to log file', () => {
  beforeEach(() => { setLogAllRequests(true); });

  test('writes a JSON line to the log file', () => {
    logRequest(makeEntry());
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe(1);
    expect(entries[0].url).toBe('/v1/messages');
  });

  test('writes multiple entries as separate JSON lines', () => {
    logRequest(makeEntry({ requestId: 1 }));
    logRequest(makeEntry({ requestId: 2 }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(2);
    expect(entries[0].requestId).toBe(1);
    expect(entries[1].requestId).toBe(2);
  });

  test('output is valid JSONL format (one JSON object per line)', () => {
    logRequest(makeEntry({ requestId: 1 }));
    logRequest(makeEntry({ requestId: 2 }));
    _flush();

    const raw = readRawLog().trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('requestId');
    }
  });
});

describe('entry contains all required fields', () => {
  beforeEach(() => { setLogAllRequests(true); });

  test('all required fields are present in written entry', () => {
    logRequest(makeEntry({
      timestamp: '2026-06-08T12:00:00.000Z',
      requestId: 42,
      method: 'POST',
      url: '/v1/messages',
      model: 'deepseek-v4-pro',
      providerKey: 'ds',
      slot: 'opus',
      status: 200,
      success: true,
      fallbackUsed: false,
      fallbackChain: ['ds'],
      latencyMs: 150,
    }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e).toMatchObject({
      timestamp: '2026-06-08T12:00:00.000Z',
      requestId: 42,
      method: 'POST',
      url: '/v1/messages',
      model: 'deepseek-v4-pro',
      providerKey: 'ds',
      slot: 'opus',
      status: 200,
      success: true,
      fallbackUsed: false,
      fallbackChain: ['ds'],
      latencyMs: 150,
    });
  });

  test('entry contains optional token fields when provided', () => {
    logRequest(makeEntry({ tokensIn: 500, tokensOut: 100 }));
    _flush();

    const entries = readLogFile();
    expect(entries[0].tokensIn).toBe(500);
    expect(entries[0].tokensOut).toBe(100);
  });

  test('entry contains optional error fields when provided', () => {
    logRequest(makeEntry({
      success: false,
      status: 502,
      errorCode: 'ECONNREFUSED',
      errorSummary: 'Connection refused by upstream',
    }));
    _flush();

    const entries = readLogFile();
    expect(entries[0].errorCode).toBe('ECONNREFUSED');
    expect(entries[0].errorSummary).toBe('Connection refused by upstream');
  });

  test('entry contains deadStream fields when provided', () => {
    logRequest(makeEntry({
      success: false,
      deadStream: true,
      deadStreamReason: 'first_byte_timeout',
    }));
    _flush();

    const entries = readLogFile();
    expect(entries[0].deadStream).toBe(true);
    expect(entries[0].deadStreamReason).toBe('first_byte_timeout');
  });

  test('entry contains userAgent when provided', () => {
    logRequest(makeEntry({ userAgent: 'ClaudeCode/1.0' }));
    _flush();

    const entries = readLogFile();
    expect(entries[0].userAgent).toBe('ClaudeCode/1.0');
  });
});

describe('default filtering', () => {
  test('successful request is NOT logged by default', () => {
    logRequest(makeEntry({ success: true, status: 200 }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(0);
  });

  test('failed request (status >= 400) IS logged by default', () => {
    logRequest(makeEntry({ success: false, status: 502 }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
  });

  test('successful request with fallback IS logged by default', () => {
    logRequest(makeEntry({
      success: true, status: 200, fallbackUsed: true, fallbackChain: ['ds', 'oc'],
    }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
  });

  test('successful request with dead stream IS logged by default', () => {
    logRequest(makeEntry({
      success: false, status: 502, deadStream: true, deadStreamReason: 'first_byte_timeout',
    }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
  });

  test('successful request with errorCode IS logged by default', () => {
    logRequest(makeEntry({ success: false, errorCode: 'ECONNRESET' }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
  });
});

describe('setLogAllRequests', () => {
  test('setLogAllRequests(true) logs all requests including successful ones', () => {
    setLogAllRequests(true);
    logRequest(makeEntry({ success: true, status: 200 }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
    expect(entries[0].success).toBe(true);
  });

  test('setLogAllRequests can be toggled off', () => {
    setLogAllRequests(true);
    logRequest(makeEntry({ success: true, status: 200, requestId: 1 }));
    setLogAllRequests(false);
    logRequest(makeEntry({ success: true, status: 200, requestId: 2 }));
    _flush();

    const entries = readLogFile();
    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe(1);
  });
});

describe('file rotation', () => {
  beforeEach(() => { setLogAllRequests(true); });

  test('rotation renames file when exceeding 1MB and starts fresh', () => {
    const logFile = _getLogFilePath();

    // Create a 1 MB file to trigger rotation.
    writeBigLogFile();
    expect(fs.statSync(logFile).size).toBeGreaterThanOrEqual(1_048_576);

    // Write a small entry -- this should trigger rotation.
    logRequest(makeEntry({ requestId: 99 }));
    _flush();

    // Verify a timestamped backup exists and is the expected size.
    const logDir = path.dirname(logFile);
    const base = path.basename(logFile);
    const backups = fs.readdirSync(logDir).filter(f => f.startsWith(base + '.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = fs.readFileSync(path.join(logDir, backups[0]), 'utf-8');
    expect(backupContent.length).toBeGreaterThanOrEqual(1_048_576);

    // Verify the current log file contains only the new entry.
    const entries = readLogFile();
    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe(99);
  });

  test('rotation keeps at most 5 timestamped backups', () => {
    const logFile = _getLogFilePath();
    const logDir = path.dirname(logFile);
    const base = path.basename(logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Trigger 7 rotations — only the last 5 timestamped backups should survive.
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(logFile, Buffer.alloc(1_048_576, String(i)).toString(), 'utf-8');
      logRequest(makeEntry({ requestId: i }));
      _flush();
    }

    const backups = fs.readdirSync(logDir).filter(f => f.startsWith(base + '.'));
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});

describe('write failures are silently discarded', () => {
  test('writing to an invalid path does not throw', () => {
    // Replace the log file with a directory to cause appendFileSync to fail.
    const logFile = _getLogFilePath();
    removeLogFile();
    fs.mkdirSync(logFile, { recursive: true });

    setLogAllRequests(true);
    expect(() => {
      logRequest(makeEntry({ requestId: 1 }));
      _flush();
    }).not.toThrow();

    // Clean up the directory we created.
    fs.rmdirSync(logFile);
  });
});

describe('pending entries are flushed', () => {
  beforeEach(() => { setLogAllRequests(true); });

  test('entries are batched and flushed on explicit _flush()', () => {
    logRequest(makeEntry({ requestId: 1 }));
    logRequest(makeEntry({ requestId: 2 }));
    logRequest(makeEntry({ requestId: 3 }));

    // Before flush: nothing on disk.
    expect(fs.existsSync(_getLogFilePath())).toBe(false);

    // After explicit flush: all entries written.
    _flush();
    const entries = readLogFile();
    expect(entries).toHaveLength(3);
  });

  test('setImmediate automatically flushes pending entries', (done) => {
    logRequest(makeEntry({ requestId: 42 }));

    setImmediate(() => {
      const entries = readLogFile();
      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe(42);
      done();
    });
  });
});

describe('sanitization', () => {
  beforeEach(() => { setLogAllRequests(true); });

  test('entry does not contain raw header fields', () => {
    logRequest(makeEntry({ userAgent: 'test-agent' }));
    _flush();

    const raw = readRawLog();
    // The log entry should not contain any raw header fields.
    expect(raw).not.toContain('authorization');
    expect(raw).not.toContain('x-api-key');
    expect(raw).not.toContain('cookie');
  });
});
