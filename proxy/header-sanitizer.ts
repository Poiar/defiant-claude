'use strict';

interface SanitizeResult {
  headers: Record<string, string>;
  dropped: number;
}

export const MAX_HEADERS = 50;
export const MAX_VALUE_LEN = 1024;
export const MAX_TOTAL_BYTES = 8192;

export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'proxy-authenticate',
]);

export const NOISE_HEADERS = new Set([
  'host',
  'connection',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'content-length',
  'accept-encoding',
]);

export function sanitizeHeaders(
  headers: Record<string, string | string[]> | null | undefined,
): SanitizeResult {
  if (!headers) return { headers: {}, dropped: 0 };

  const clean: Record<string, string> = {};
  let dropped = 0;
  let totalBytes = 0;
  let count = 0;

  const entries = Object.entries(headers);
  for (let i = 0; i < entries.length; i++) {
    const [name, rawValue] = entries[i];
    const lower = name.toLowerCase();

    if (SENSITIVE_HEADERS.has(lower)) {
      dropped++;
      continue;
    }

    if (NOISE_HEADERS.has(lower)) {
      dropped++;
      continue;
    }

    if (count >= MAX_HEADERS) {
      dropped++;
      continue;
    }

    let strValue: string = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    strValue = strValue.replace(/[\x00-\x1f\x7f]/g, '');

    if (strValue.length > MAX_VALUE_LEN) {
      // Use Array.from to correctly handle multi-byte UTF-8 characters
      // instead of splitting surrogate pairs mid-character.
      strValue = Array.from(strValue).slice(0, MAX_VALUE_LEN).join('');
      dropped++;
    }

    const bytes = Buffer.byteLength(strValue, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      dropped += entries.length - i;
      break;
    }

    totalBytes += bytes;
    clean[lower] = strValue;
    count++;
  }

  return { headers: clean, dropped };
}

/**
 * Strip effort-2025-11-24 from the anthropic-beta header when the target
 * model or provider doesn't support it. Haiku models return 400 "model does
 * not support effort" and non-Anthropic providers don't implement Anthropic
 * beta headers at all.
 *
 * When effort-2025-11-24 is the ONLY value, the header is deleted entirely
 * rather than being set to an empty string, which also causes a 400.
 *
 * @returns true if the header was modified, false otherwise.
 */
export function stripEffortBetaHeader(
  headers: Record<string, string | string[] | undefined>,
  upstreamModel: string,
  isNativeProvider: boolean,
): boolean {
  if (!upstreamModel.includes('haiku') && isNativeProvider) return false;
  const beta = headers['anthropic-beta'];
  if (typeof beta === 'string') {
    const filtered = beta
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== 'effort-2025-11-24' && s.length > 0);
    if (filtered.length === 0) {
      delete headers['anthropic-beta'];
    } else {
      headers['anthropic-beta'] = filtered.join(',');
    }
    return true;
  } else if (Array.isArray(beta)) {
    const filtered = beta.filter((s) => s !== 'effort-2025-11-24');
    if (filtered.length === 0) {
      delete headers['anthropic-beta'];
    } else {
      headers['anthropic-beta'] = filtered;
    }
    return true;
  }
  return false;
}
