'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.METADATA_IPS = void 0;
exports.validateUrl = validateUrl;
// SSRF protection: URL validation that blocks requests to private/internal
// IP ranges, cloud metadata endpoints, and non-HTTP schemes.
//
// validateUrl(urlStr, options) resolves the hostname and checks every
// resolved IP against blocked ranges. This provides DNS rebinding defense
// by validating at resolution time rather than at connection time.
const node_dns_1 = __importDefault(require("node:dns"));
// --- Blocked IP sets ---
// Cloud metadata endpoints (well-known Instance Metadata Service IPs)
exports.METADATA_IPS = new Set([
    '169.254.169.254',
    '169.254.169.253',
    '100.100.100.200',
    'fd00:ec2::254',
]);
// Private IPv4 CIDR range boundaries as [startInt, endInt] (inclusive).
// Converted to integer for efficient range checks.
const PRIVATE_V4_RANGES = [
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
];
// IPv6 blocked ranges as [startBigInt, endBigInt]
const PRIVATE_V6_RANGES = [
    // ::1/128 -- loopback
    [BigInt(1), BigInt(1)],
    // fc00::/7 -- Unique Local Addresses (ULA)
    [BigInt('0xfc000000000000000000000000000000'), BigInt('0xfdffffffffffffffffffffffffffffff')],
    // fe80::/10 -- link-local unicast
    [BigInt('0xfe800000000000000000000000000000'), BigInt('0xfebfffffffffffffffffffffffffffffff')],
    // ::ffff:0:0/96 -- IPv4-mapped IPv6 (handled by normalization, but include as safety net)
    [ipv6MappedPrefix(), ipv6MappedPrefix() + BigInt('0xffffffff')],
];
function ipv6MappedPrefix() {
    return BigInt('0x0000ffffffffffffffffffff00000000');
}
// --- Helpers ---
// Convert dotted-quad IPv4 string to an unsigned 32-bit integer.
function ipToInt(ip) {
    const parts = ip.split('.');
    return ((+parts[0] << 24) | (+parts[1] << 16) | (+parts[2] << 8) | +parts[3]) >>> 0;
}
// Normalize an IPv6 address string to its canonical form.
// Handles ::ffff:x.x.x.x (IPv4-mapped IPv6) by extracting the embedded IPv4.
// Returns { ip: normalizedIPv6, mappedV4: ipv4String|null }
function normalizeIPv6(addr) {
    // Normalize the address: lowercase and remove brackets
    let a = addr.toLowerCase().replace(/^\[|\]$/g, '');
    // Check for IPv4-mapped IPv6: ::ffff:x.x.x.x
    // Also handles ::ffff:0:x.x.x.x variants
    const v4mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) {
        return { ip: expandIPv6(a), mappedV4: v4mapped[1] };
    }
    // Check for IPv4-compatible IPv6: ::x.x.x.x
    const v4compat = a.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (v4compat) {
        return { ip: expandIPv6(a), mappedV4: v4compat[1] };
    }
    // Check for embedded IPv4 at end: xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:d.d.d.d
    const embedded = a.match(/^([0-9a-f:]+):(\d+\.\d+\.\d+\.\d+)$/);
    if (embedded) {
        const v4Hex = ipToInt(embedded[2]).toString(16);
        a = embedded[1] + ':' + v4Hex.slice(0, 4) + ':' + v4Hex.slice(4);
        return { ip: expandIPv6(a), mappedV4: null };
    }
    return { ip: expandIPv6(a), mappedV4: null };
}
// Expand an IPv6 address to full 8-group hex notation (no colons).
function expandIPv6(addr) {
    let a = addr.toLowerCase();
    // Expand ::
    if (a.includes('::')) {
        const parts = a.split('::');
        const left = parts[0] ? parts[0].split(':') : [];
        const right = parts[1] ? parts[1].split(':') : [];
        const missing = 8 - left.length - right.length;
        a = left.concat(new Array(missing).fill('0'), right).join(':');
    }
    // Pad each group to 4 hex digits and concatenate
    return a.split(':').map(g => g.padStart(4, '0')).join('');
}
// Convert expanded (full colon-form) IPv6 to a BigInt.
function ipv6ToBigInt(expanded) {
    const hex = expanded.replace(/:/g, '');
    return BigInt('0x' + hex);
}
// Check if an IPv4 string falls within any private range.
function isPrivateV4(ip) {
    const intVal = ipToInt(ip);
    for (const [start, end] of PRIVATE_V4_RANGES) {
        if (intVal >= start && intVal <= end)
            return true;
    }
    return false;
}
// Check if an expanded IPv6 string falls within any private range.
function isPrivateV6(expanded) {
    const intVal = ipv6ToBigInt(expanded);
    for (const [start, end] of PRIVATE_V6_RANGES) {
        if (intVal >= start && intVal <= end)
            return true;
    }
    return false;
}
// --- Public API ---
/**
 * Validate a URL string against SSRF threats.
 */
async function validateUrl(urlStr, options) {
    const opts = Object.assign({ allowPrivate: false, allowHttp: false }, options);
    // 1. Check scheme
    let parsed;
    try {
        parsed = new URL(urlStr);
    }
    catch (_) {
        return { valid: false, reason: 'Invalid URL: ' + urlStr };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { valid: false, reason: 'Blocked scheme: ' + parsed.protocol };
    }
    if (parsed.protocol === 'http:' && !opts.allowHttp) {
        return { valid: false, reason: 'HTTP URL blocked (set allowHttp to enable)' };
    }
    // 2. Resolve hostname to IPs (DNS rebinding defense)
    let addresses;
    try {
        const records = await node_dns_1.default.promises.resolve4(parsed.hostname);
        addresses = records;
    }
    catch (dnsErr) {
        // DNS resolution failure — can't verify the address, but blocking all
        // requests when DNS is unavailable is a self-DOS. Allow through.
        return { valid: true, reason: 'DNS resolution failed (allowed): ' + dnsErr.message };
    }
    // 3. Check each resolved IP
    for (const ip of addresses) {
        // Check metadata IPs first (fast exact match)
        if (exports.METADATA_IPS.has(ip)) {
            return { valid: false, reason: 'Blocked metadata IP: ' + ip };
        }
        // Check private ranges
        if (!opts.allowPrivate && isPrivateV4(ip)) {
            return { valid: false, reason: 'Blocked private IP: ' + ip };
        }
    }
    // 4. Also resolve AAAA records if available
    let v6Addresses = [];
    try {
        v6Addresses = await node_dns_1.default.promises.resolve6(parsed.hostname);
    }
    catch (_) {
        // No IPv6 records -- fine, proceed with IPv4 only
    }
    for (const ip of v6Addresses) {
        // Normalize IPv6 -- extract embedded IPv4 if present
        const { ip: expanded, mappedV4 } = normalizeIPv6(ip);
        // Check embedded IPv4
        if (mappedV4) {
            if (exports.METADATA_IPS.has(mappedV4)) {
                return { valid: false, reason: 'Blocked metadata IP via IPv4-mapped IPv6: ' + mappedV4 };
            }
            if (!opts.allowPrivate && isPrivateV4(mappedV4)) {
                return { valid: false, reason: 'Blocked private IP via IPv4-mapped IPv6: ' + mappedV4 };
            }
        }
        // Check metadata IPs (IPv6 form)
        if (exports.METADATA_IPS.has(ip)) {
            return { valid: false, reason: 'Blocked metadata IPv6: ' + ip };
        }
        // Check private IPv6 ranges
        if (!opts.allowPrivate && isPrivateV6(expanded)) {
            return { valid: false, reason: 'Blocked private IPv6: ' + ip };
        }
    }
    return { valid: true };
}
