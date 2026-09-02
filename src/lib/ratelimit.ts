import { getConfig } from '@/lib/config'
import { kvAvailable, kvGet, kvPut } from '@/lib/kv'

// Fixed-window rate limiter, shared across instances through KV.
//
// In memory alone this was decorative on a serverless platform: each instance
// kept its own count, so twenty per minute per instance meant no real limit at
// all, and nothing about it looked broken.
//
// Two layers now, because neither is sufficient alone:
//
//   MEMORY  instant, exact for this instance, invisible to the others. It
//           catches a burst from one caller before KV has heard about it.
//   KV      shared, but eventually consistent and with no atomic increment, so
//           it lags and undercounts under concurrency.
//
// Reading KV costs about 80ms and writing about 330ms, measured. The read is
// worth waiting for; the write is not, so it is sent without blocking the
// request. The cost of that choice is that two requests arriving together can
// both see the older count — the limit is approximate, deliberately, and
// approximate-and-shared beats exact-and-per-instance.
//
// If KV is unreachable the limiter falls open rather than shut. Refusing every
// question because a counter cannot be read is worse than briefly not counting.

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

function evict(now: number): void {
  if (now - lastEviction < EVICT_EVERY_MS) return
  lastEviction = now
  for (const [key, w] of windows) {
    if (now - w.windowStart > WINDOW_MS * 2) windows.delete(key)
  }
}

/** Windows are named for the minute they cover, so an old one expires by TTL. */
function windowKey(key: string, now: number): string {
  return `ratelimit:${key}:${Math.floor(now / WINDOW_MS)}`
}

function localWindow(key: string, now: number): Window {
  const existing = windows.get(key)
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    const fresh = { windowStart: now, count: 0 }
    windows.set(key, fresh)
    return fresh
  }
  return existing
}

function secondsLeft(now: number): number {
  return Math.max(1, Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000))
}

/**
 * `now` is injectable purely so tests can drive the clock. Rate limiting is the
 * one place a real clock is correct: it affects service, not any answer.
 */
export async function checkRateLimit(
  ip: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const limit = getConfig().rateLimitPerMinute
  evict(now)

  const key = ip || 'unknown'
  const local = localWindow(key, now)

  // Fast path: this instance alone has already seen too many. No KV round trip
  // is needed to know the answer.
  if (local.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: secondsLeft(now) }
  }

  local.count += 1

  if (!kvAvailable()) {
    return {
      allowed: true,
      remaining: Math.max(0, limit - local.count),
      retryAfterSeconds: 0,
    }
  }

  const kvKey = windowKey(key, now)
  const raw = await kvGet(kvKey)
  const shared = raw === null ? 0 : Number.parseInt(raw, 10) || 0
  const total = Math.max(shared + 1, local.count)

  // Written without awaiting: a 330ms write on the request path would be felt,
  // and a counter that is momentarily behind is the accepted trade.
  void kvPut(kvKey, String(total), Math.ceil(WINDOW_MS / 1000) * 2)

  if (total > limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: secondsLeft(now) }
  }
  return { allowed: true, remaining: Math.max(0, limit - total), retryAfterSeconds: 0 }
}

/** Test seam. Clears only the local layer; KV entries expire on their own. */
export function resetRateLimits(): void {
  windows.clear()
  lastEviction = 0
}
