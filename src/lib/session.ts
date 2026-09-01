import { timingSafeEqual } from '@/lib/crypto'
import { getConfig } from '@/lib/config'

// In-memory sessions, deliberately.
//
// Nothing is written to a cookie, localStorage or sessionStorage. The client
// holds its token in React state only, so a refresh loses it and the passcode
// screen comes back. That is the required behaviour for now, not an oversight.
//
// The consequence to understand: because there is no persisted credential, edge
// middleware has nothing to inspect, so page HTML cannot be gated there. The
// real control is that /api/ask refuses to answer without a valid token — the
// page shell is just an empty chat with no board data in it.
//
// SEAM: on Vercel this Map does not survive across serverless instances, so a
// token minted by one instance is unknown to the next. Move to KV
// (CF_KV_NAMESPACE_ID) at the same time as the rate limiter.

const TTL_MS = 30 * 60 * 1000
const SWEEP_EVERY_MS = 5 * 60 * 1000

const sessions = new Map<string, number>()
let lastSweep = 0

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return
  lastSweep = now
  for (const [token, expires] of sessions) {
    if (expires <= now) sessions.delete(token)
  }
}

function newToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Checks the passcode and, if it matches, mints a session token.
 * Returns null on a wrong passcode so the caller cannot tell the difference
 * between "wrong" and "not configured" from the return value alone.
 */
export function login(supplied: string): string | null {
  const expected = getConfig().appPasscode
  if (!expected) return null
  if (!timingSafeEqual(supplied, expected)) return null

  const now = Date.now()
  sweep(now)
  const token = newToken()
  sessions.set(token, now + TTL_MS)
  return token
}

export function isValidSession(token: string | null | undefined): boolean {
  if (!token) return false
  const now = Date.now()
  sweep(now)
  const expires = sessions.get(token)
  if (expires === undefined) return false
  if (expires <= now) {
    sessions.delete(token)
    return false
  }
  return true
}

/** Reads the bearer token from an Authorization header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+([A-Za-z0-9]+)$/)
  return match ? match[1] : null
}

/** Test seam. */
export function clearSessions(): void {
  sessions.clear()
}
