'use strict';

// AES-256-GCM encryption/decryption for provider API keys.
// Uses scrypt for key derivation with caching by (masterSecret, salt) fingerprint.

import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PREFIX = '$aes256gcm:';

// Cache for derived keys. Maps a fingerprint of (masterSecret, salt) to the
// derived 32-byte key buffer. The fingerprint is the first 16 hex chars of
// SHA-256(masterSecret + salt), avoiding storing the raw master secret in
// the map key string.
const keyCache = new Map<string, Buffer>();

export function deriveKey(masterSecret: string, salt: Buffer): Buffer {
    // Build fingerprint from SHA-256(masterSecret + salt), first 16 hex chars
    const fp = crypto.createHash('sha256')
        .update(masterSecret)
        .update(salt)
        .digest('hex')
        .slice(0, 16);

    const cached = keyCache.get(fp);
    if (cached) return cached;

    const key = crypto.scryptSync(masterSecret, salt, SCRYPT_DKLEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    });

    keyCache.set(fp, key);
    return key;
}

export function encrypt(plaintext: string, masterSecret: string): string {
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const key = deriveKey(masterSecret, salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf-8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return PREFIX + [
        salt.toString('base64'),
        iv.toString('base64'),
        authTag.toString('base64'),
        ciphertext.toString('base64'),
    ].join(':');
}

export function decrypt(ciphertext: string, masterSecret: string): string {
    if (!ciphertext.startsWith(PREFIX)) {
        throw new Error('Not an encrypted value');
    }

    const encoded = ciphertext.slice(PREFIX.length);
    const parts = encoded.split(':');
    if (parts.length !== 4) {
        throw new Error('Invalid encrypted value format');
    }

    const [saltB64, ivB64, authTagB64, ciphertextB64] = parts;

    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(ciphertextB64, 'base64');

    const key = deriveKey(masterSecret, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const plaintext = decipher.update(encrypted);
    return plaintext + decipher.final('utf-8');
}

