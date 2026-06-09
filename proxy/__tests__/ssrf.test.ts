'use strict'

import { validateUrl, METADATA_IPS } from '../ssrf'
import dns from 'dns'

// Helper: DNS stub that maps hostnames to IPs.
const dnsStubs: Record<string, string[]> = {}

function stubDns(hostname: string, ips: string[]) {
  dnsStubs[hostname] = ips
}

function clearDnsStubs() {
  Object.keys(dnsStubs).forEach(k => delete dnsStubs[k])
}

beforeEach(() => {
  clearDnsStubs()
  jest.spyOn(dns.promises, 'resolve4').mockImplementation((hostname: string) => {
    if (hostname in dnsStubs) {
      const ips = dnsStubs[hostname]
      if (ips.length === 0) return Promise.reject(new Error('DNS lookup failed for ' + hostname))
      return Promise.resolve(ips)
    }
    return Promise.reject(new Error('DNS lookup failed for ' + hostname))
  })
  jest.spyOn(dns.promises, 'resolve6').mockImplementation(() => {
    return Promise.resolve([])
  })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('validateUrl', () => {

  // --- 1. Valid public HTTPS URL passes ---
  test('valid public HTTPS URL passes', async () => {
    stubDns('api.openai.com', ['104.18.22.67'])
    const result = await validateUrl('https://api.openai.com/v1/chat')
    expect(result.valid).toBe(true)
  })

  // --- 2. HTTP URL blocked when allowHttp=false ---
  test('HTTP URL blocked when allowHttp=false', async () => {
    stubDns('example.com', ['93.184.216.34'])
    const result = await validateUrl('http://example.com/api')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/HTTP URL blocked/)
  })

  // --- 3. Private IP (10.x) blocked ---
  test('private IP 10.x blocked', async () => {
    stubDns('internal.example.com', ['10.0.0.1'])
    const result = await validateUrl('https://internal.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IP/)
    expect(result.reason).toMatch(/10\.0\.0\.1/)
  })

  // --- 4. Private IP (192.168.x) blocked ---
  test('private IP 192.168.x blocked', async () => {
    stubDns('lan.example.com', ['192.168.1.100'])
    const result = await validateUrl('https://lan.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IP/)
    expect(result.reason).toMatch(/192\.168\.1\.100/)
  })

  // --- 5. Private IP (127.x) blocked ---
  test('loopback 127.x blocked', async () => {
    stubDns('localhost', ['127.0.0.1'])
    const result = await validateUrl('https://localhost/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IP/)
    expect(result.reason).toMatch(/127\.0\.0\.1/)
  })

  // --- 6. Private IP (172.16.x) blocked ---
  test('private IP 172.16.x blocked', async () => {
    stubDns('private.example.com', ['172.16.0.50'])
    const result = await validateUrl('https://private.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IP/)
    expect(result.reason).toMatch(/172\.16\.0\.50/)
  })

  // --- 7. Metadata IP 169.254.169.254 blocked ---
  test('metadata IP 169.254.169.254 blocked', async () => {
    stubDns('metadata.internal', ['169.254.169.254'])
    const result = await validateUrl('https://metadata.internal/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/metadata IP/)
  })

  // --- 8. Metadata IP 100.100.100.200 blocked ---
  test('metadata IP 100.100.100.200 blocked', async () => {
    stubDns('alibaba.meta', ['100.100.100.200'])
    const result = await validateUrl('https://alibaba.meta/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/metadata IP/)
  })

  // --- 9. IPv4-mapped IPv6 normalization ---
  test('IPv4-mapped IPv6 ::ffff:192.168.1.1 blocked', async () => {
    stubDns('evil.example.com', ['93.184.216.34'])
    jest.restoreAllMocks()
    jest.spyOn(dns.promises, 'resolve4').mockImplementation(() => {
      return Promise.resolve(['93.184.216.34'])
    })
    jest.spyOn(dns.promises, 'resolve6').mockImplementation(() => {
      return Promise.resolve(['::ffff:192.168.1.1'])
    })
    const result = await validateUrl('https://evil.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IP/)
    expect(result.reason).toMatch(/192\.168\.1\.1/)
  })

  // --- 10. file:// scheme blocked ---
  test('file:// scheme blocked', async () => {
    const result = await validateUrl('file:///etc/passwd')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/scheme/)
  })

  // --- 11. allowPrivate option bypasses private IP check ---
  test('allowPrivate option allows private IP', async () => {
    stubDns('internal.example.com', ['10.0.0.5'])
    const result = await validateUrl('https://internal.example.com/', { allowPrivate: true })
    expect(result.valid).toBe(true)
  })

  // --- 12. DNS resolution failure blocks (fail-closed) ---
  test('DNS resolution failure blocks when DNS is unavailable', async () => {
    stubDns('nonexistent.example.com', [])
    const result = await validateUrl('https://nonexistent.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/DNS resolution failed/)
  })

  // --- 13. DNS resolution failure blocks even with allowPrivate ---
  test('DNS resolution failure blocks when allowPrivate is true', async () => {
    stubDns('nonexistent.example.com', [])
    const result = await validateUrl('https://nonexistent.example.com/', { allowPrivate: true })
    expect(result.valid).toBe(false)
  })

  // --- 14. IPv6 loopback (::1) blocked ---
  test('IPv6 loopback blocked', async () => {
    stubDns('localhost6', ['127.0.0.1'])
    jest.restoreAllMocks()
    jest.spyOn(dns.promises, 'resolve4').mockImplementation(() => {
      return Promise.resolve(['93.184.216.34'])
    })
    jest.spyOn(dns.promises, 'resolve6').mockImplementation(() => {
      return Promise.resolve(['::1'])
    })
    const result = await validateUrl('https://ipv6loopback.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IPv6/)
  })

  // --- 15. Link-local IPv6 (fe80::) blocked ---
  test('link-local IPv6 fe80:: blocked', async () => {
    jest.restoreAllMocks()
    jest.spyOn(dns.promises, 'resolve4').mockImplementation(() => {
      return Promise.resolve(['93.184.216.34'])
    })
    jest.spyOn(dns.promises, 'resolve6').mockImplementation(() => {
      return Promise.resolve(['fe80::1'])
    })
    const result = await validateUrl('https://linklocal.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IPv6/)
  })

  // --- 16. Metadata IPv6 (fd00:ec2::254) blocked ---
  test('metadata IPv6 fd00:ec2::254 blocked', async () => {
    jest.restoreAllMocks()
    jest.spyOn(dns.promises, 'resolve4').mockImplementation(() => {
      return Promise.resolve(['93.184.216.34'])
    })
    jest.spyOn(dns.promises, 'resolve6').mockImplementation(() => {
      return Promise.resolve(['fd00:ec2::254'])
    })
    const result = await validateUrl('https://metadata6.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/metadata/)
  })

  // --- 17. gopher:// scheme blocked ---
  test('gopher:// scheme blocked', async () => {
    const result = await validateUrl('gopher://internal.example.com:70/1')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/scheme/)
  })

  // --- 18. ULA IPv6 (fc00::) blocked ---
  test('ULA IPv6 fc00:: blocked', async () => {
    jest.restoreAllMocks()
    jest.spyOn(dns.promises, 'resolve4').mockImplementation(() => {
      return Promise.resolve(['93.184.216.34'])
    })
    jest.spyOn(dns.promises, 'resolve6').mockImplementation(() => {
      return Promise.resolve(['fc00::1'])
    })
    const result = await validateUrl('https://ula.example.com/')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/private IPv6/)
  })
})

describe('METADATA_IPS', () => {
  test('contains all required metadata IPs', () => {
    expect(METADATA_IPS.has('169.254.169.254')).toBe(true)
    expect(METADATA_IPS.has('169.254.169.253')).toBe(true)
    expect(METADATA_IPS.has('100.100.100.200')).toBe(true)
    expect(METADATA_IPS.has('fd00:ec2::254')).toBe(true)
    expect(METADATA_IPS.size).toBe(4)
  })
})
