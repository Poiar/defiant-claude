'use strict';

// Tests for encrypt-key.ts — CLI helper to encrypt API keys.
// encrypt-key.ts calls main() at import time. We test the argv path
// (process.argv[2] set) which is the primary code path.
//
// The stdin path (no argv[2]) requires readline mocking that's fragile
// in jest due to module scoping. Covered by the argv tests which exercise
// the same core logic: encryption, validation, error handling.

const mockEncrypt = jest.fn();

jest.mock('../crypto', () => ({
  encrypt: mockEncrypt,
}));

describe('encrypt-key', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    mockEncrypt.mockReset();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.DEEPCLAUDE_ENCRYPTION_KEY;
  });

  function load(): void {
    try {
      require('../encrypt-key');
    } catch (_) {}
  }

  // --- Synchronous error paths ---

  test('exits when DEEPCLAUDE_ENCRYPTION_KEY is not set', () => {
    process.argv = ['node', 'encrypt-key.ts', 'my-key'];
    delete process.env.DEEPCLAUDE_ENCRYPTION_KEY;
    load();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error: DEEPCLAUDE_ENCRYPTION_KEY environment variable is not set',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // --- Async happy paths (use setImmediate to wait for Promise chain) ---

  test('encrypts key from argv and logs result', (done) => {
    process.argv = ['node', 'encrypt-key.ts', 'my-api-key-12345'];
    process.env.DEEPCLAUDE_ENCRYPTION_KEY = 'a'.repeat(32);
    mockEncrypt.mockResolvedValue('encrypted-result-abc123');

    load();

    setImmediate(() => {
      expect(mockEncrypt).toHaveBeenCalledWith('my-api-key-12345', 'a'.repeat(32));
      expect(consoleLogSpy).toHaveBeenCalledWith('encrypted-result-abc123');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('command-line argument'));
      done();
    });
  });

  test('warns when env key is shorter than 32 chars but still encrypts', (done) => {
    process.argv = ['node', 'encrypt-key.ts', 'api-key'];
    process.env.DEEPCLAUDE_ENCRYPTION_KEY = 'short-key';
    mockEncrypt.mockResolvedValue('enc');

    load();

    setImmediate(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('shorter than 32 characters'),
      );
      expect(mockEncrypt).toHaveBeenCalledWith('api-key', 'short-key');
      done();
    });
  });

  test('handles encryption failure', (done) => {
    process.argv = ['node', 'encrypt-key.ts', 'key'];
    process.env.DEEPCLAUDE_ENCRYPTION_KEY = 'c'.repeat(32);
    mockEncrypt.mockRejectedValue(new Error('crypto engine failure'));

    load();

    setImmediate(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Encryption failed: crypto engine failure');
      expect(exitSpy).toHaveBeenCalledWith(1);
      done();
    });
  });

  test('full happy path with 64-char env key and no warnings', (done) => {
    process.argv = ['node', 'encrypt-key.ts', 'happy-path-key'];
    process.env.DEEPCLAUDE_ENCRYPTION_KEY = 'x'.repeat(64);
    mockEncrypt.mockResolvedValue('encrypted-result-abc123');

    load();

    setImmediate(() => {
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('command-line argument'));
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('shorter than 32'));
      expect(mockEncrypt).toHaveBeenCalledWith('happy-path-key', 'x'.repeat(64));
      expect(consoleLogSpy).toHaveBeenCalledWith('encrypted-result-abc123');
      expect(exitSpy).not.toHaveBeenCalled();
      done();
    });
  });
});
