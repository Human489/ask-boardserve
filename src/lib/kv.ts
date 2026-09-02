import { getConfig } from '@/lib/config'

// Cloudflare KV over the REST API.
//
// The app runs on Vercel, not on Workers, so there is no KV binding — every
// read and write is an HTTP call to Cloudflare. That has consequences the
// callers need to know about, so they are stated here rather than discovered:
//
//   - Every operation costs a network round trip, tens of milliseconds.
//   - KV is eventually consistent. A value written on one instance is not
//     instantly visible on another, so anything counting must tolerate being
//     slightly behind.
//   - There is no atomic increment. Read-modify-write races, and under
//     concurrency a counter undercounts rather than overcounts.
//
// None of that makes KV wrong here — it makes it a shared, approximate store
// rather than a precise one, which is the right shape for a rate limiter and
// the wrong shape for anything that must be exact.

const TIMEOUT_MS = 3_000

function base(): string | null {
  const cfg = getConfig()
  if (!cfg.cloudflareAccountId || !cfg.cloudflareApiToken || !cfg.kvNamespaceId) return null
  return (
    `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflareAccountId}` +
    `/storage/kv/namespaces/${cfg.kvNamespaceId}`
  )
}

/** True when KV is configured. Callers fall back to memory when it is not. */
export function kvAvailable(): boolean {
  return base() !== null
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${getConfig().cloudflareApiToken}` }
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } catch {
    // A KV outage must not take the app down with it. The caller decides what
    // to do with null; for the rate limiter, failing open is right, because
    // refusing every question because a counter is unreachable is worse than
    // briefly not counting.
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function kvGet(key: string): Promise<string | null> {
  const url = base()
  if (!url) return null
  return withTimeout(async (signal) => {
    const res = await fetch(`${url}/values/${encodeURIComponent(key)}`, {
      headers: authHeader(),
      signal,
      cache: 'no-store',
    })
    // A missing key is a 404 and is not an error.
    if (res.status === 404) return null
    if (!res.ok) return null
    return await res.text()
  })
}

/**
 * Writes a value. A TTL of null means no expiry.
 *
 * The rate limiter wants a TTL so its windows clean themselves up; a pinned
 * dashboard wants the opposite — a pin that quietly evaporated after a month
 * would be a worse failure than never having saved it.
 */
export async function kvPut(
  key: string,
  value: string,
  ttlSeconds: number | null,
): Promise<boolean> {
  const url = base()
  if (!url) return false
  // Cloudflare rejects a TTL below 60 seconds.
  const query =
    ttlSeconds === null ? '' : `?expiration_ttl=${Math.max(60, Math.round(ttlSeconds))}`
  const result = await withTimeout(async (signal) => {
    const body = new FormData()
    body.set('value', value)
    body.set('metadata', '{}')
    const res = await fetch(`${url}/values/${encodeURIComponent(key)}${query}`, {
      method: 'PUT',
      headers: authHeader(),
      body,
      signal,
    })
    return res.ok
  })
  return result === true
}

export async function kvDelete(key: string): Promise<boolean> {
  const url = base()
  if (!url) return false
  const result = await withTimeout(async (signal) => {
    const res = await fetch(`${url}/values/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: authHeader(),
      signal,
    })
    // Deleting a key that was never there is a success, not a failure.
    return res.ok || res.status === 404
  })
  return result === true
}
