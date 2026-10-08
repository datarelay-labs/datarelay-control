import { describe, expect, it } from 'vitest'
import { API_BASE_URL } from './api'

describe('Vitest API isolation', () => {
  it('does not send UI test tokens to a live localhost backend unless explicitly configured', () => {
    if (!import.meta.env.VITE_API_BASE_URL?.trim()) {
      expect(API_BASE_URL).toBe('http://127.0.0.1:0')
    }
  })
})
