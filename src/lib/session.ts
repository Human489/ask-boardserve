import { timingSafeEqual } from '@/lib/crypto'

// The signed-in cookie, and why it is not simply the passcode.
//
// The brief asks for "a simple middleware check protecting every page and API
// route", checked "against a header or cookie". A header cannot serve a page:
// a browser typing the URL sends no Authorization, so page protection has to be
// a cookie.
//
// The cookie holds a value DERIVED from the passcode, not the passcode. Putting
// the passcode itself in a cookie would mean a leaked or logged cookie hands
// over the credential for every other route as well — including the bearer
// header the smoke suite and the API still accept. A derived token grants the
// same access and reveals nothing, which is the difference between losing a
// session and losing the key.
//
// It stays stateless, which is the property that made the original session
// store worth removing: there is no list of live sessions to consult, so a cold
// instance behaves exactly like a warm one. The cost is the same as before —
// no revocation short of changing APP_PASSCODE, and no expiry beyond the
// cookie's own lifetime.

export const SESSION_COOKIE = 'bs_session'

/** A week. Long enough not to interrupt a working session, short enough that a
 *  forgotten browser does not stay signed in indefinitely. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/** Domain-separated so the digest cannot double as anything else's token. */
const PURPOSE = 'ask-boardserve:session:v1'

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The cookie value for a given passcode.
 *
 * Uses Web Crypto, which both the Node runtime (the login route) and the Edge
 * runtime (middleware) provide, so one function serves both and they cannot
 * disagree about what a valid session looks like.
 */
export async function sessionToken(passcode: string): Promise<string> {
  const data = new TextEncoder().encode(`${PURPOSE}:${passcode}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

/**
 * Whether a cookie value is a session for the configured passcode.
 *
 * Returns false when no passcode is configured, so a deployment missing
 * APP_PASSCODE fails closed rather than accepting the digest of an empty
 * string.
 */
export async function isValidSession(
  value: string | undefined,
  passcode: string | undefined,
): Promise<boolean> {
  if (!value || !passcode) return false
  return timingSafeEqual(value, await sessionToken(passcode))
}

/** Set-Cookie attributes. Shared so the set and the clear cannot diverge. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    // Not readable by script, so the app cannot put it in an Authorization
    // header — which is the point. The API accepts the cookie directly.
    sameSite: 'strict' as const,
    secure,
    path: '/',
  }
}
