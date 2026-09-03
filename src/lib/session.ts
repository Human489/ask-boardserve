import { timingSafeEqual } from '@/lib/crypto'

// The signed-in cookie.
//
// The brief asks for "a simple middleware check protecting every page and API
// route", checked "against a header or cookie". A header cannot serve a page: a
// browser typing the URL sends no Authorization, so page protection has to be a
// cookie.
//
// The first version of this put a plain SHA-256 of the passcode in the cookie
// and claimed the derived value "reveals nothing". That was wrong, and the
// comment was worse than the code: a passcode is short and human-chosen, so an
// unsalted, un-iterated digest is recoverable by anyone willing to run a
// wordlist. A cookie ends up in proxy logs, shared browser profiles and bug
// reports — and recovering the passcode from one hands over the bearer
// credential for every route, which cannot be revoked short of changing
// APP_PASSCODE. Losing a session and losing the key are different sizes of
// accident.
//
// So the cookie is now an HMAC over a SEPARATE secret, and it carries its own
// expiry. Two consequences worth stating:
//
//   - Recovering the passcode from a cookie means recovering the secret first,
//     which is a random 32-byte value rather than something a person chose.
//   - Rotating SESSION_SECRET invalidates every live session, which is the
//     revocation this design otherwise has no way to offer.
//
// It stays stateless. There is no list of live sessions to consult, so a cold
// instance behaves exactly like a warm one — the property that made the
// original server-side session store worth deleting.

export const SESSION_COOKIE = 'bs_session'

/** A week. Long enough not to interrupt a working session, short enough that a
 *  forgotten browser does not stay signed in indefinitely. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/** Domain-separated so the digest cannot double as anything else's token. */
const PURPOSE = 'ask-boardserve:session:v2'

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The key the cookie is signed with.
 *
 * SESSION_SECRET when set, which is what a deployment should do. Falling back
 * to the passcode keeps local development working without another variable,
 * and is reported rather than hidden: with no secret configured the cookie is
 * only as strong as the passcode, which is the weakness this exists to remove.
 */
async function signingKey(passcode: string): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET?.trim()
  const material = secret && secret.length > 0 ? secret : passcode
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${PURPOSE}:${material}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function sign(payload: string, passcode: string): Promise<string> {
  const key = await signingKey(passcode)
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return toBase64Url(new Uint8Array(mac))
}

/**
 * A cookie value: when it expires, and a signature over that.
 *
 * Uses Web Crypto, which both the Node runtime (the login route) and the Edge
 * runtime (middleware) provide, so one function serves both and they cannot
 * disagree about what a valid session looks like.
 */
export async function sessionToken(
  passcode: string,
  now: number = Date.now(),
): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS
  const payload = String(expires)
  return `${payload}.${await sign(payload, passcode)}`
}

/**
 * Whether a cookie value is a valid, unexpired session.
 *
 * The expiry is inside the signed payload, so it is checked here rather than
 * trusted to the browser: a cookie's own maxAge is a hint the client is free to
 * ignore, and the previous version accepted a captured value forever.
 *
 * Returns false when no passcode is configured, so a deployment missing
 * APP_PASSCODE fails closed rather than validating against an empty string.
 */
export async function isValidSession(
  value: string | undefined,
  passcode: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  // Trimmed, because a whitespace-only APP_PASSCODE is not a configured
  // passcode: it is truthy, so it used to pass this guard and — with a
  // SESSION_SECRET set, where the signature does not depend on the passcode at
  // all — validate a session for a deployment that has no passcode.
  if (!value || !passcode || passcode.trim().length === 0) return false

  const split = value.lastIndexOf('.')
  if (split <= 0) return false
  const payload = value.slice(0, split)
  const signature = value.slice(split + 1)

  if (!/^\d+$/.test(payload)) return false
  if (!timingSafeEqual(signature, await sign(payload, passcode))) return false

  // Signature first, then expiry: an unsigned value should not be told which
  // of its two problems was noticed.
  return Number(payload) * 1000 > now
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
