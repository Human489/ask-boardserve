import { getConfig } from '@/lib/config'
import { timingSafeEqual } from '@/lib/crypto'

// Passcode checking, with no server-side state at all.
//
// An earlier version issued a session token and kept the live tokens in a Map.
// That bought nothing. Nothing is persisted client-side either way, so the
// credential sits in React state either way, and it travels on every request
// either way — a token was simply a second credential standing in for the
// first.
//
// What it cost was statelessness. A token is only valid on the instance that
// minted it, so the first request after a cold start returned 401 in
// development, and on a serverless platform it would fail whenever a request
// landed on a different instance. Comparing the passcode directly removes the
// store, the expiry, and the need to move any of it to KV before deploying.
//
// The trade-off, stated plainly: there is no way to revoke access short of
// changing APP_PASSCODE, and no session expiry. For a single shared passcode
// guarding a demo that is the right shape. A per-user login would not be.

/** Reads the credential from an Authorization header. */
export function bearerCredential(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/)
  return match ? match[1].trim() : null
}

/** True when the supplied value matches the configured passcode. */
export function isAuthorised(supplied: string | null | undefined): boolean {
  const expected = getConfig().appPasscode
  if (!expected) return false
  if (!supplied) return false
  return timingSafeEqual(supplied, expected)
}
