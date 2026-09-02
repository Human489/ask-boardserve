import { NextResponse } from 'next/server'
import { bearerCredential, isAuthorised } from '@/lib/auth'
import { checkRateLimit } from '@/lib/ratelimit'

// The credential check every route shares, and the budget that makes it
// expensive to guess at.
//
// /api/login rate-limited itself and said why: "a passcode endpoint without one
// is a brute-force oracle". The reasoning was right and the cover was not. The
// passcode is also accepted as a bearer token by /api/ask and /api/pins, and
// both checked it BEFORE consuming any budget — so a 401 from those cost the
// caller nothing, and an attacker simply never touched /api/login. There is no
// session and no revocation short of changing APP_PASSCODE, so an unmetered
// guessing endpoint is the weakest thing in the deployment.
//
// Failed attempts are counted under one key shared by every endpoint that
// accepts the passcode, which closes the bypass while keeping /api/login's
// original point: the budget is separate from the question allowance, so a
// mistyped passcode never eats the questions a signed-in reader can ask.

/**
 * Trusted as-is, which is correct on Vercel because the platform sets it.
 * Behind a proxy that passes a client-supplied value through, a caller can
 * rotate it for a fresh bucket — the consequence is bounded to rate limiting,
 * which is approximate by design.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

/** Charges one failed credential check against the shared guessing budget. */
export async function throttleFailedAuth(req: Request): Promise<NextResponse | null> {
  const limit = await checkRateLimit(`auth:${clientIp(req)}`)
  if (limit.allowed) return null
  return NextResponse.json(
    {
      ok: false,
      error: `Too many sign-in attempts. Please wait ${limit.retryAfterSeconds} seconds and try again.`,
      retryAfterSeconds: limit.retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
  )
}

/**
 * Returns a response when the request must be turned away, or null when the
 * caller is authorised. Every data-touching route calls this first.
 */
export async function rejectUnauthorised(req: Request): Promise<NextResponse | null> {
  if (isAuthorised(bearerCredential(req))) return null
  // Charged only on failure, so a signed-in reader is never throttled by
  // someone else's wrong guesses beyond the shared address.
  const throttled = await throttleFailedAuth(req)
  if (throttled) return throttled
  return NextResponse.json(
    { ok: false, error: 'That passcode was not accepted. Enter it again to continue.' },
    { status: 401 },
  )
}
