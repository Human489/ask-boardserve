import { kvAvailable, kvDelete, kvPut, kvRead } from '@/lib/kv'
import type { Pin } from '@/lib/pins'

// Read-only share links for a pinned dashboard.
//
// THIS IS AN UNAUTHENTICATED ROUTE TO NAMED DIRECTORS' ATTENDANCE. Everything
// else in this app sits behind the passcode; a share link is a deliberate hole
// in that, and the token IS the credential. CLAUDE.md set five conditions
// before this was built, and each is answered here:
//
//   HIGH-ENTROPY TOKEN  32 random bytes from the platform CSPRNG, base64url —
//                       256 bits. Not derived from the dataset, the pins or a
//                       clock, so knowing one token tells you nothing about
//                       another, and there is nothing to enumerate.
//   EXPIRY              Mandatory and capped. Written as a KV TTL so the store
//                       drops it even if nothing ever asks again, AND checked
//                       on read, because a TTL is a promise about eviction
//                       rather than about correctness.
//   REVOCATION          Delete by token, immediately, and listed so a reader
//                       can find the link they sent and pull it.
//   NOINDEX             Applied by the route that serves the page.
//   NO PERSONAL DATA IN THE URL  The path carries the token and nothing else:
//                       no organisation, no dataset id, no director.
//
// AND IT IS A SNAPSHOT, NOT A LIVE VIEW. The pins are copied at share time and
// the link never changes afterwards. A link that followed the live dashboard
// would silently widen: pin something sensitive next week and everyone who was
// ever sent the link can see it. What you shared is what they see.

/** What a share link exposes. Copied at creation, never re-read. */
export interface Share {
  /** The token itself is the key, so it is not stored inside the record. */
  createdAt: string
  expiresAt: string
  /** The organisation, so the shared page can name whose board this is. */
  organisation: string
  /** Frozen at share time. */
  pins: Pin[]
}

/** What the owner sees when managing their links. The token is included
 *  because they need it to re-copy the URL; it is theirs already. */
export interface ShareSummary {
  token: string
  createdAt: string
  expiresAt: string
  pinCount: number
}

const KEY = (token: string) => `share:v1:${token}`
/** The owner's index of live tokens, so links can be listed and revoked. */
const INDEX = (datasetId: string) => `shares:v1:${datasetId}`

/** Seven days. Long enough to be useful before a meeting, short enough that a
 *  forgotten link stops working on its own. */
export const DEFAULT_TTL_DAYS = 7
/** Nothing may outlive this, whatever a caller asks for. */
export const MAX_TTL_DAYS = 30
/** A dashboard worth sharing is small; this stops a link becoming an export. */
export const MAX_SHARES = 10

/**
 * 256 bits from the platform CSPRNG.
 *
 * Deliberately NOT `Math.random`, and deliberately not derived from anything —
 * a token built from the dataset id and a timestamp would be guessable by
 * anyone who knew roughly when a link was made.
 */
export function newToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Shape check, so a hand-edited value cannot reach a public page. */
export function isShare(value: unknown): value is Share {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<Share>
  return (
    typeof s.createdAt === 'string' &&
    typeof s.expiresAt === 'string' &&
    typeof s.organisation === 'string' &&
    Array.isArray(s.pins)
  )
}

/** A token as it may appear in a URL. Rejected early so a malformed one never
 *  reaches KV as a key. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(token)
}

function ttlSeconds(days: number): number {
  const clamped = Math.min(Math.max(days, 1), MAX_TTL_DAYS)
  return clamped * 24 * 60 * 60
}

export type CreateOutcome =
  | { ok: true; token: string; expiresAt: string; shares: ShareSummary[] }
  | { ok: false; reason: 'needs-kv' | 'nothing-to-share' | 'too-many' | 'write-failed' }

/**
 * Creates a link.
 *
 * REQUIRES KV, and refuses without it. The in-memory fallback that pins use
 * cannot serve this: each route handler is its own module instance, so a share
 * held in the memory of the route that created it is invisible to the route
 * that serves the public page. The link would 404 for everyone including the
 * person who just made it — which is the same fault an uploaded dataset had,
 * measured rather than assumed.
 */
export async function createShare(
  datasetId: string,
  organisation: string,
  pins: Pin[],
  days: number = DEFAULT_TTL_DAYS,
  now: () => Date = () => new Date(),
): Promise<CreateOutcome> {
  if (!kvAvailable()) return { ok: false, reason: 'needs-kv' }
  if (pins.length === 0) return { ok: false, reason: 'nothing-to-share' }

  const existing = await listShares(datasetId, now)
  if (existing.length >= MAX_SHARES) return { ok: false, reason: 'too-many' }

  const at = now()
  const seconds = ttlSeconds(days)
  const expiresAt = new Date(at.getTime() + seconds * 1000).toISOString()
  const token = newToken()

  const share: Share = {
    createdAt: at.toISOString(),
    expiresAt,
    organisation,
    pins,
  }

  // The TTL is the store's own eviction, which is what stops a forgotten link
  // living for ever even if this app never runs again.
  if (!(await kvPut(KEY(token), JSON.stringify(share), seconds))) {
    return { ok: false, reason: 'write-failed' }
  }

  const summary: ShareSummary = {
    token,
    createdAt: share.createdAt,
    expiresAt,
    pinCount: pins.length,
  }
  const index = [summary, ...existing].slice(0, MAX_SHARES)
  // The index is best-effort: if it fails the link still works, and the worst
  // case is a live link the owner cannot see in order to revoke. Reported as a
  // write failure for that reason rather than swallowed.
  if (!(await kvPut(INDEX(datasetId), JSON.stringify(index), null))) {
    return { ok: false, reason: 'write-failed' }
  }

  return { ok: true, token, expiresAt, shares: index }
}

function expired(share: { expiresAt: string }, at: Date): boolean {
  const ends = Date.parse(share.expiresAt)
  return !Number.isFinite(ends) || ends <= at.getTime()
}

/** The owner's live links, with expired ones dropped from the view. */
export async function listShares(
  datasetId: string,
  now: () => Date = () => new Date(),
): Promise<ShareSummary[]> {
  if (!kvAvailable()) return []
  const read = await kvRead(INDEX(datasetId))
  if (!read.ok || read.missing) return []
  try {
    const parsed: unknown = JSON.parse(read.value)
    if (!Array.isArray(parsed)) return []
    const at = now()
    return parsed.filter(
      (entry): entry is ShareSummary =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as ShareSummary).token === 'string' &&
        typeof (entry as ShareSummary).expiresAt === 'string' &&
        !expired(entry as ShareSummary, at),
    )
  } catch {
    return []
  }
}

export type ReadOutcome =
  | { ok: true; share: Share }
  | { ok: false; reason: 'not-found' | 'expired' | 'unavailable' }

/**
 * Serves a token.
 *
 * The expiry is checked HERE as well as being a KV TTL. A TTL is a promise
 * about when a store will drop a value, not a guarantee about the moment it
 * stops being readable, and this is the one route in the app with no passcode
 * in front of it. Two checks, because one of them is someone else's.
 */
export async function readShare(
  token: string,
  now: () => Date = () => new Date(),
): Promise<ReadOutcome> {
  if (!isWellFormedToken(token)) return { ok: false, reason: 'not-found' }
  if (!kvAvailable()) return { ok: false, reason: 'unavailable' }

  const read = await kvRead(KEY(token))
  if (!read.ok) return { ok: false, reason: 'unavailable' }
  if (read.missing) return { ok: false, reason: 'not-found' }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.value)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!isShare(parsed)) return { ok: false, reason: 'not-found' }
  if (expired(parsed, now())) return { ok: false, reason: 'expired' }

  return { ok: true, share: parsed }
}

export type RevokeOutcome = { ok: true; shares: ShareSummary[] } | { ok: false; reason: 'needs-kv' }

/**
 * Revokes a link now.
 *
 * The record is deleted first and the index updated second: if only one of the
 * two can happen, the link must be the one that stops working. An index entry
 * pointing at a deleted record is untidy; a live record missing from the index
 * is a link nobody can find to revoke.
 */
export async function revokeShare(
  datasetId: string,
  token: string,
  now: () => Date = () => new Date(),
): Promise<RevokeOutcome> {
  if (!kvAvailable()) return { ok: false, reason: 'needs-kv' }
  if (isWellFormedToken(token)) await kvDelete(KEY(token))
  const remaining = (await listShares(datasetId, now)).filter((s) => s.token !== token)
  await kvPut(INDEX(datasetId), JSON.stringify(remaining), null)
  return { ok: true, shares: remaining }
}
