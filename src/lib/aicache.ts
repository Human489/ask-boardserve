import { kvAvailable, kvPut, kvRead } from '@/lib/kv'

// A cache in front of the model calls.
//
// The brief requires it: "the system must cache AI results". Without it an
// identical question spends credits twice, which matters on an account whose
// token is shared and whose budget is finite — the same reason the app is
// behind a passcode at all.
//
// Three properties it has to have, and one it must not:
//
//   KEYED ON EVERYTHING THAT CHANGES THE ANSWER. The model id is part of the
//   key, so switching models does not serve answers from the previous one. That
//   is not hypothetical here: the model changed once already, and a cache
//   without it would have kept routing questions with the old one's decisions.
//
//   NEVER CACHES A FAILURE. A null result means the call did not work, and
//   remembering that would turn one outage into an hour of them.
//
//   WRITES WITHOUT BLOCKING. A KV write costs ~330ms, measured. Waiting for it
//   would make the first asking of a question slower to make the second faster,
//   which is the wrong trade on the path a person is watching. A lost write is
//   a cache miss, not an error.
//
//   AND IT MUST NOT CACHE ANYTHING DERIVED FROM THE DATASET. Only the model
//   calls are cached — routing decisions, embeddings, the grounding judgement.
//   Every figure is still computed by a tool on every request. A cached figure
//   would be a figure nobody recomputed, which is the one thing this product
//   does not do.

/**
 * Set AI_CACHE=off to bypass the cache entirely.
 *
 * The smoke suite needs this. It asserts that all twelve spec questions were
 * routed by the model, which is how a broken AI Gateway is caught — but a
 * cached route reports 'model' too, quite correctly, so after one run the
 * assertion could be satisfied from cache with the gateway dead. A check that
 * cannot fail is worse than no check, and this project has shipped that mistake
 * before.
 */
function cacheDisabled(): boolean {
  return (process.env.AI_CACHE ?? '').toLowerCase() === 'off'
}

/** Long enough to cover a demo or a working session, short enough to expire. */
export const CACHE_TTL_SECONDS = 60 * 60

/** Embeddings of a fixed string never change; only the model does. */
export const EMBED_TTL_SECONDS = 24 * 60 * 60

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** A stable, short key for arbitrary input. */
async function digest(material: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  // Half the digest is ample for a cache key and keeps the key readable.
  return toHex(new Uint8Array(hash)).slice(0, 32)
}

/**
 * Returns a cached result for `material`, or produces and stores one.
 *
 * `produce` returning null is treated as a failure and is neither cached nor
 * retried here — the caller decides what a failure means.
 */
export async function cached<T>(
  namespace: string,
  material: string,
  ttlSeconds: number,
  produce: () => Promise<T | null>,
): Promise<T | null> {
  if (!kvAvailable() || cacheDisabled()) return produce()

  const key = `aicache:v1:${namespace}:${await digest(material)}`

  const read = await kvRead(key)
  if (read.ok && !read.missing) {
    try {
      return JSON.parse(read.value) as T
    } catch {
      // A corrupt entry is a miss, not a failure. Fall through and recompute.
    }
  }

  const produced = await produce()
  if (produced === null || produced === undefined) return produced
  void kvPut(key, JSON.stringify(produced), ttlSeconds)
  return produced
}
