'use strict';

import { encrypt, decrypt, deriveKey } from '../crypto';
import crypto from 'crypto';

const MASTER_KEY = 'this-is-a-test-master-key-that-is-at-least-32';

describe('crypto', () => {
    describe('encrypt', () => {
        test('produces prefixed format with 4 colon-separated base64 parts', () => {
            const result = encrypt('hello', MASTER_KEY);
            expect(result).toMatch(/^\$aes256gcm:/);
            const parts = result.slice('$aes256gcm:'.length).split(':');
            expect(parts).toHaveLength(4);
            for (const p of parts) {
                expect(() => Buffer.from(p, 'base64')).not.toThrow();
                expect(Buffer.from(p, 'base64').length).toBeGreaterThan(0);
            }
        });

        test('different plaintexts produce different ciphertexts', () => {
            const a = encrypt('hello', MASTER_KEY);
            const b = encrypt('world', MASTER_KEY);
            expect(a).not.toBe(b);
        });

        test('same plaintext produces different ciphertexts (random salt/IV)', () => {
            const a = encrypt('hello', MASTER_KEY);
            const b = encrypt('hello', MASTER_KEY);
            expect(a).not.toBe(b);
        });

        test('empty string encryption works', () => {
            const encrypted = encrypt('', MASTER_KEY);
            const decrypted = decrypt(encrypted, MASTER_KEY);
            expect(decrypted).toBe('');
        });

        test('unicode plaintext round-trips correctly', () => {
            const unicode = 'Hello, 世界! é ♥ \u{1F600}';
            const encrypted = encrypt(unicode, MASTER_KEY);
            const decrypted = decrypt(encrypted, MASTER_KEY);
            expect(decrypted).toBe(unicode);
        });
    });

    describe('decrypt', () => {
        test('reverses encrypt correctly (round-trip)', () => {
            const plaintext = 'sk-test-api-key-12345';
            const encrypted = encrypt(plaintext, MASTER_KEY);
            const decrypted = decrypt(encrypted, MASTER_KEY);
            expect(decrypted).toBe(plaintext);
        });

        test('throws on non-prefixed string', () => {
            expect(() => decrypt('hello-world', MASTER_KEY)).toThrow('Not an encrypted value');
        });

        test('throws with wrong master key', () => {
            const encrypted = encrypt('secret-value', MASTER_KEY);
            expect(() => decrypt(encrypted, 'a-different-master-key-that-is-also-32-chars!!')).toThrow();
        });
    });

    describe('deriveKey', () => {
        test('produces a 32-byte buffer', () => {
            const salt = Buffer.from('test-salt-1234567');
            const key = deriveKey(MASTER_KEY, salt);
            expect(Buffer.isBuffer(key)).toBe(true);
            expect(key).toHaveLength(32);
        });

        test('works with a short master key', () => {
            const salt = crypto.randomBytes(16);
            const key = deriveKey('short', salt);
            expect(Buffer.isBuffer(key)).toBe(true);
            expect(key).toHaveLength(32);
        });

        test('key derivation caching returns the same buffer reference', () => {
            const salt = Buffer.from('cache-test-salt-12345');
            const key1 = deriveKey(MASTER_KEY, salt);
            const key2 = deriveKey(MASTER_KEY, salt);
            expect(key1).toBe(key2);
        });

        test('different salts produce different keys', () => {
            const saltA = Buffer.from('aaaaaaaaaaaaaaaa');
            const saltB = Buffer.from('bbbbbbbbbbbbbbbb');
            const keyA = deriveKey(MASTER_KEY, saltA);
            const keyB = deriveKey(MASTER_KEY, saltB);
            expect(keyA.equals(keyB)).toBe(false);
        });
    });
});
