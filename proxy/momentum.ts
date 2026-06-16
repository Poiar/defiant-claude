'use strict';

import fs from 'node:fs';
import path from 'node:path';

import { LruCache } from './lru-cache';

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const RING_SIZE = 5;

// Persist to ~/.deepclaude/momentum/ so successful provider history survives
// proxy restarts. This avoids cold-start probing costs and lets the new proxy
// immediately prefer previously-working providers.
const CACHE_DIR = path.join(
  process.env.DEEPCLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepclaude'),
  'momentum',
);

interface Decision {
  providerKey: string;
  model: string;
  at: number;
}

interface MomentumEntry {
  decisions: Decision[];
}

interface MomentumResult {
  preferredProvider: string;
  confidence: number;
}

const cache = new LruCache<MomentumEntry>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

// --- Disk persistence ---

function cacheFilePath(sk: string): string {
  return path.join(CACHE_DIR, `${sk}.json`);
}

const isTestEnv = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';

function writeToDisk(sk: string, entry: MomentumEntry): void {
  if (isTestEnv) return; // skip persistence in tests
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(
      cacheFilePath(sk),
      JSON.stringify({
        decisions: entry.decisions,
        storedAt: Date.now(),
      }),
      'utf-8',
    );
  } catch {
    /* non-fatal */
  }
}

function loadFromDisk(): void {
  if (isTestEnv) return; // no disk I/O in tests
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const cutoff = Date.now() - TTL_MS;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let _loaded = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sk = file.replace(/\.json$/, '');
      if (cache.get(sk)) continue;
      try {
        const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        if (data.storedAt && data.storedAt < cutoff) {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, file));
          } catch {
            /* ok */
          }
          continue;
        }
        if (data.decisions && Array.isArray(data.decisions)) {
          cache.set(sk, { decisions: data.decisions });
          _loaded++;
        }
      } catch {
        try {
          fs.unlinkSync(path.join(CACHE_DIR, file));
        } catch {
          /* ok */
        }
      }
    }
    // Momentum entries hydrated from disk silently
  } catch {
    /* non-fatal */
  }
}

loadFromDisk();

export { sessionKey } from './session-key';

export function record(sk: string | null, providerKey: string, model: string): void {
  if (!sk) return;
  let entry = cache.get(sk);
  if (!entry) {
    entry = { decisions: [] };
  }
  entry.decisions.push({ providerKey, model, at: Date.now() });
  if (entry.decisions.length > RING_SIZE) {
    entry.decisions = entry.decisions.slice(-RING_SIZE);
  }
  cache.set(sk, entry);
  writeToDisk(sk, entry);
}

export function getMomentum(sk: string | null): MomentumResult | null {
  if (!sk) return null;
  const entry = cache.get(sk);
  if (!entry || entry.decisions.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const d of entry.decisions) {
    counts[d.providerKey] = (counts[d.providerKey] || 0) + 1;
  }

  let preferredProvider: string | null = null;
  let maxCount = 0;
  for (const [provider, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      preferredProvider = provider;
    }
  }

  // Normalize as a ratio (0.0 -- 1.0) so the threshold isn't tied to RING_SIZE.
  return { preferredProvider: preferredProvider || '', confidence: maxCount / RING_SIZE };
}
