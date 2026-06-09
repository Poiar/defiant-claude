'use strict'

// SSRF protection: URL validation that blocks requests to private/internal
// IP ranges, cloud metadata endpoints, and non-HTTP schemes.
//
// validateUrl(urlStr, options) resolves the hostname and checks every
// resolved IP against blocked ranges. This provides DNS rebinding defense
// by validating at resolution time rather than at connection time.

import dns from 'node:dns'

interface ValidateUrlOptions {
  allowPrivate?: boolean;
  allowHttp?: boolean;
}
interface ValidateUrlResult {
  valid: boolean;
  reason?: string;
  /** Resolved IP addresses that were validated (present on success). */
  addresses?: string[];
}
interface NormalizedIPv6 {
  ip: string;
  mappedV4: string | null;
}
// --- Blocked IP sets ---

// Cloud metadata endpoints (well-known Instance Metadata Service IPs)
export const METADATA_IPS: Set<string> = new Set([
  '169.254.169.254',
  '169.254.169.253',
  '100.100.100.200',
  'fd00:ec2::254',
])

type IpRange = [number, number];
type IpV6Range = [bigint, bigint];

// Private IPv4 CIDR range boundaries as [startInt, endInt] (inclusive).
// Converted to integer for efficient range checks.
const PRIVATE_V4_RANGES: IpRange[] = [
  // 127.0.0.0/8 -- loopback
  [ipToInt('127.0.0.0'), ipToInt('127.255.255.255')],
  // 10.0.0.0/8 -- RFC 1918
  [ipToInt('10.0.0.0'), ipToInt('10.255.255.255')],
  // 172.16.0.0/12 -- RFC 1918
  [ipToInt('172.16.0.0'), ipToInt('172.31.255.255')],
  // 192.168.0.0/16 -- RFC 1918
  [ipToInt('192.168.0.0'), ipToInt('192.168.255.255')],
  // 169.254.0.0/16 -- link-local
  [ipToInt('169.254.0.0'), ipToInt('169.254.255.255')],
  // 100.64.0.0/10 -- Carrier-grade NAT (RFC 6598)
  [ipToInt('100.64.0.0'), ipToInt('100.127.255.255')],
  // 0.0.0.0/8 -- "This network" (RFC 1122)
  [ipToInt('0.0.0.0'), ipToInt('0.255.255.255')],
]

// IPv6 blocked ranges as [startBigInt, endBigInt]
const PRIVATE_V6_RANGES: IpV6Range[] = [
  // ::1/128 -- loopback
  [BigInt(1), BigInt(1)],
  // fc00::/7 -- Unique Local Addresses (ULA)
  [BigInt('0xfc000000000000000000000000000000'), BigInt('0xfdffffffffffffffffffffffffffffff')],
  // fe80::/10 -- link-local unicast
  [BigInt('0xfe800000000000000000000000000000'), BigInt('0xfebfffffffffffffffffffffffffffffff')],
  // ::ffff:0:0/96 -- IPv4-mapped IPv6 (handled by normalization, but include as safety net)
  [ipv6MappedPrefix(), ipv6MappedPrefix() + BigInt('0xffffffff')],
]

function ipv6MappedPrefix(): bigint {
  return BigInt('0x0000ffffffffffffffffffff00000000')
}
// --- Helpers ---

// Convert dotted-quad IPv4 string to an unsigned 32-bit integer.
function ipToInt(ip: string): number {
  const parts = ip.split('.')
  return ((+parts[0] << 24) | (+parts[1] << 16) | (+parts[2] << 8) | +parts[3]) >>> 0
}
// Normalize an IPv6 address string to its canonical form.
// Handles ::ffff:x.x.x.x (IPv4-mapped IPv6) by extracting the embedded IPv4.
// Returns { ip: normalizedIPv6, mappedV4: ipv4String|null }
function normalizeIPv6(addr: string): NormalizedIPv6 {
  // Normalize the address: lowercase and remove brackets
  let a = addr.toLowerCase().replace(/^\[|\]$/g, '')

  // Check for IPv4-mapped IPv6: ::ffff:x.x.x.x
  // Also handles ::ffff:0:x.x.x.x variants
  const v4mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4mapped) {
    return { ip: expandIPv6(a), mappedV4: v4mapped[1] }
  }
  // Check for IPv4-compatible IPv6: ::x.x.x.x
  const v4compat = a.match(/^::(\d+\.\d+\.\d+\.\d+)$/)
  if (v4compat) {
    return { ip: expandIPv6(a), mappedV4: v4compat[1] }
  }
  // Check for embedded IPv4 at end: xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:d.d.d.d
  const embedded = a.match(/^([0-9a-f:]+):(\d+\.\d+\.\d+\.\d+)$/)
  if (embedded) {
    const v4Hex = ipToInt(embedded[2]).toString(16)
    a = embedded[1] + ':' + v4Hex.slice(0, 4) + ':' + v4Hex.slice(4)
    return { ip: expandIPv6(a), mappedV4: null }
  }
  // Check for IPv4-mapped IPv6 in hex notation (::ffff:xxxx:xxxx bypasses dotted-quad regex above)
  const expanded = expandIPv6(a)
  // ::ffff:0:0/96 prefix = 80 zero bits + 16 bits of 0xffff = 24 hex chars
  if (expanded.startsWith('00000000000000000000ffff')) {
    const v4hex = expanded.slice(24) // last 32 bits (8 hex chars)
    const v4int = parseInt(v4hex, 16)
    const v4str = [(v4int >>> 24) & 0xff, (v4int >>> 16) & 0xff, (v4int >>> 8) & 0xff, v4int & 0xff].join('.')
    return { ip: expanded, mappedV4: v4str }
  }
  return { ip: expanded, mappedV4: null }
}
// Expand an IPv6 address to full 8-group hex notation (no colons).
function expandIPv6(addr: string): string {
  let a = addr.toLowerCase()

  // Expand ::
  if (a.includes('::')) {
    const parts = a.split('::')
    const left = parts[0] ? parts[0].split(':') : []
    const right = parts[1] ? parts[1].split(':') : []
    const missing = 8 - left.length - right.length
    a = left.concat(new Array(missing).fill('0'), right).join(':')
  }
  // Pad each group to 4 hex digits and concatenate
  return a.split(':').map(g => g.padStart(4, '0')).join('')
}
// Convert expanded (full colon-form) IPv6 to a BigInt.
function ipv6ToBigInt(expanded: string): bigint {
  const hex = expanded.replace(/:/g, '')
  return BigInt('0x' + hex)
}
// Check if an IPv4 string falls within any private range.
function isPrivateV4(ip: string): boolean {
  const intVal = ipToInt(ip)
  for (const [start, end] of PRIVATE_V4_RANGES) {
    if (intVal >= start && intVal <= end) return true
  }
  return false
}
// Check if an expanded IPv6 string falls within any private range.
function isPrivateV6(expanded: string): boolean {
  const intVal = ipv6ToBigInt(expanded)
  for (const [start, end] of PRIVATE_V6_RANGES) {
    if (intVal >= start && intVal <= end) return true
  }
  return false
}
// --- DNS cache (FIX 5: avoid failing open on transient DNS failures) ---

interface DnsCacheEntry {
  addresses: string[];
  timestamp: number;
}
const dnsCache = new Map<string, DnsCacheEntry>()
const DNS_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const MAX_DNS_CACHE = 1000

function getCachedDns(hostname: string): string[] | null {
  const entry = dnsCache.get(hostname)
  if (entry && (Date.now() - entry.timestamp) < DNS_CACHE_TTL_MS) {
    return entry.addresses
  }
  return null
}
function setCachedDns(hostname: string, addresses: string[]): void {
  dnsCache.set(hostname, { addresses, timestamp: Date.now() })
  // Evict oldest entry if cache exceeds the max size (simple FIFO eviction).
  if (dnsCache.size > MAX_DNS_CACHE) {
    const first = dnsCache.keys().next().value
    if (first) dnsCache.delete(first)
  }
}
// --- Public API ---

/**
 * Validate a URL string against SSRF threats.
 */
export async function validateUrl(urlStr: string, options?: ValidateUrlOptions): Promise<ValidateUrlResult> {
  const opts = Object.assign({ allowPrivate: false, allowHttp: false }, options)

  // 1. Check scheme
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch (_) {
    return { valid: false, reason: 'Invalid URL: ' + urlStr }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Blocked scheme: ' + parsed.protocol }
  }
  if (parsed.protocol === 'http:' && !opts.allowHttp) {
    return { valid: false, reason: 'HTTP URL blocked (set allowHttp to enable)' }
  }
  // 2. Resolve hostname to IPs (DNS rebinding defense)
  let addresses: string[]
  try {
    const records = await dns.promises.resolve4(parsed.hostname)
    addresses = records
    // Cache successful resolution for fail-open defense
    setCachedDns(parsed.hostname, records)
  } catch (dnsErr) {
    // DNS resolution failure — check cache before failing open
    const cached = getCachedDns(parsed.hostname)
    if (cached) {
      // Use last-known-good addresses (still validated against blocked ranges below)
      addresses = cached
    } else {
      // No cache available — fail closed. If DNS is genuinely down for a
      // provider, the proxy should not route to it. This prevents DNS rebinding
      // attacks that exploit transient resolution failures.
      return { valid: false, reason: 'DNS resolution failed for ' + parsed.hostname + ': ' + (dnsErr as Error).message }
    }
  }
  // 3. Check each resolved IP
  for (const ip of addresses) {
    // Check metadata IPs first (fast exact match)
    if (METADATA_IPS.has(ip)) {
      return { valid: false, reason: 'Blocked metadata IP: ' + ip }
    }
    // Check private ranges
    if (!opts.allowPrivate && isPrivateV4(ip)) {
      return { valid: false, reason: 'Blocked private IP: ' + ip }
    }
  }
  // 4. Also resolve AAAA records if available
  let v6Addresses: string[] = []
  try {
    v6Addresses = await dns.promises.resolve6(parsed.hostname)
  } catch (_) {
    // No IPv6 records -- fine, proceed with IPv4 only
  }
  for (const ip of v6Addresses) {
    // Normalize IPv6 -- extract embedded IPv4 if present
    const { ip: expanded, mappedV4 } = normalizeIPv6(ip)

    // Check embedded IPv4
    if (mappedV4) {
      if (METADATA_IPS.has(mappedV4)) {
        return { valid: false, reason: 'Blocked metadata IP via IPv4-mapped IPv6: ' + mappedV4 }
      }
      if (!opts.allowPrivate && isPrivateV4(mappedV4)) {
        return { valid: false, reason: 'Blocked private IP via IPv4-mapped IPv6: ' + mappedV4 }
      }
    }
    // Check metadata IPs (IPv6 form)
    if (METADATA_IPS.has(ip)) {
      return { valid: false, reason: 'Blocked metadata IPv6: ' + ip }
    }
    // Check private IPv6 ranges
    if (!opts.allowPrivate && isPrivateV6(expanded)) {
      return { valid: false, reason: 'Blocked private IPv6: ' + ip }
    }
  }
  return { valid: true, addresses: [...addresses, ...v6Addresses] }
}
