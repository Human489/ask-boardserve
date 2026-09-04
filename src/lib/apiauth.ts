import { NextResponse } from 'next/server'
import { bearerCredential, isAuthorised } from '@/lib/auth'
import { getConfig } from '@/lib/config'
import { SESSION_COOKIE, isValidSession } from '@/lib/session'
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

/**
 * Reads the signed-in cookie from a request and checks it.
 *
 * Split rather than matched. A regex built inside a template literal ate its
 * own escape — `\s` in a template is just `s`, so the pattern looked for the
 * letter rather than whitespace and could only find the cookie when it happened
 * to be first in the header. Browsers separate cookies with "; ", so that is
 * most of the time. Splitting has no escapes to lose.
 */
async function hasSessionCookie(req: Request): Promise<boolean> {
  const header = req.headers.get('cookie')
  if (!header) return false
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue
    return isValidSession(
      decodeURIComponent(part.slice(separator + 1).trim()),
      getConfig().appPasscode,
    )
  }
  return false
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
  // Either credential is accepted. The cookie is what a browser sends, and is
  // the only thing that can protect a page; the bearer header is what the smoke
  // suite and any script use, and keeps the API usable without a browser.
  if (isAuthorised(bearerCredential(req))) return null
  if (await hasSessionCookie(req)) return null
  // Charged only on failure, so a signed-in reader is never throttled by
  // someone else's wrong guesses beyond the shared address.
  const throttled = await throttleFailedAuth(req)
  if (throttled) return throttled
  return NextResponse.json(
    { ok: false, error: 'That passcode was not recognised.' },
    { status: 401 },
  )
}
