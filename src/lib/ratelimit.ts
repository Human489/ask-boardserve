import { getConfig } from '@/lib/config'

// Fixed-window limiter, in memory.
//
// SEAM FOR KV: the spec puts these counters in Cloudflare KV so the limit holds
// across instances. Everything KV-shaped is behind readWindow/writeWindow below;
// swapping them for KV reads/writes (and making checkRateLimit async) is the
// whole change. In memory it is per-instance only, which is honest for one node.

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

interface Window {
  windowStart: number
  count: number
}

const WINDOW_MS = 60_000
const EVICT_EVERY_MS = 5 * 60_000

const windows = new Map<string, Window>()
let lastEviction = 0

function readWindow(key: string): Window | undefined {
  return windows.get(key)
}

function writeWindow(key: string, w: Window): void {
  windows.set(key, w)
}

function evict(now: number): void {
  if (now - lastEviction < EVICT_EVERY_MS) return
  lastEviction = now
  for (const [key, w] of windows) {
    if (now - w.windowStart > WINDOW_MS * 2) windows.delete(key)
  }
}

/**
 * `now` is injectable purely so tests can drive the clock. Rate limiting is the
 * one place a real clock is correct: it affects service, not any answer.
 */
export function checkRateLimit(ip: string, now: number = Date.now()): RateLimitResult {
  const limit = getConfig().rateLimitPerMinute
  evict(now)

  const key = ip || 'unknown'
  const existing = readWindow(key)

  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    writeWindow(key, { windowStart: now, count: 1 })
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 }
  }

  const elapsed = now - existing.windowStart
  const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000))

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds }
  }

  existing.count += 1
  writeWindow(key, existing)
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 }
}

/** Test seam. */
export function resetRateLimits(): void {
  windows.clear()
  lastEviction = 0
}
