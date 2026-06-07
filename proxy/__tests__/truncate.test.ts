'use strict'

import { truncateForLog, truncateForStorage, MAX_LOG_CHARS, MAX_STORAGE_CHARS } from '../truncate'

describe('truncateForLog', () => {
  it('passes short strings through unchanged', () => {
    const result = truncateForLog('hello world')
    expect(result).toBe('hello world')
  })

  it('truncates long strings with ellipsis', () => {
    const input = 'x'.repeat(1000)
    const result = truncateForLog(input)
    expect(result.length).toBe(MAX_LOG_CHARS + 1)
    expect(result).toMatch(/…$/)
    expect(result.startsWith('x'.repeat(MAX_LOG_CHARS))).toBe(true)
  })

  it('passes exact maxLen strings through unchanged (no ellipsis)', () => {
    const input = 'x'.repeat(MAX_LOG_CHARS)
    const result = truncateForLog(input)
    expect(result).toBe(input)
    expect(result.length).toBe(MAX_LOG_CHARS)
  })

  it('respects a custom maxLen', () => {
    const input = 'x'.repeat(100)
    const result = truncateForLog(input, 50)
    expect(result.length).toBe(51)
    expect(result).toMatch(/…$/)
    expect(result.startsWith('x'.repeat(50))).toBe(true)
  })

  it('returns null as-is', () => {
    expect(truncateForLog(null)).toBeNull()
  })

  it('returns undefined as-is', () => {
    expect(truncateForLog(undefined)).toBeUndefined()
  })

  it('converts numbers to string', () => {
    const result = truncateForLog(42)
    expect(result).toBe('42')
  })

  it('JSON-stringifies objects and truncates', () => {
    const obj = { msg: 'x'.repeat(600) }
    const result = truncateForLog(obj)
    expect(result.length).toBeLessThanOrEqual(MAX_LOG_CHARS + 1)
    expect(result).toMatch(/…$/)
    expect(result).toContain('"msg"')
  })

  it('returns empty string as-is', () => {
    expect(truncateForLog('')).toBe('')
  })

  it('truncates AFTER scrubbing secrets, not before', () => {
    const prefix = 'x'.repeat(490)
    const apiKey = 'sk-ant-01234567890123456789012345678901234567890'
    const input = prefix + apiKey
    const result = truncateForLog(input)
    expect(result).toContain('[redacted]')
    expect(result).not.toContain('sk-ant-')
    expect(result.length).toBe(MAX_LOG_CHARS)
    expect(result).not.toMatch(/…$/)
  })

  it('truncates at storage limit when using truncateForStorage', () => {
    const input = 'x'.repeat(2500)
    const result = truncateForStorage(input)
    expect(result.length).toBe(MAX_STORAGE_CHARS + 1)
    expect(result).toMatch(/…$/)
    expect(result.startsWith('x'.repeat(MAX_STORAGE_CHARS))).toBe(true)
  })

  it('passes short string through truncateForStorage unchanged', () => {
    const input = 'short string'
    const result = truncateForStorage(input)
    expect(result).toBe(input)
  })
})
