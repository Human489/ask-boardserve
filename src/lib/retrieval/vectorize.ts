// Cloudflare Vectorize + embedding client.
//
// Derived from gai-rag-skeleton (Hamada Mahdi), scripts/cf.ts. The REST calls
// and — more importantly — the four traps encoded here are its work:
// NDJSON upserts, returnMetadata as the string "all", polling
// processedUpToMutation rather than sleeping, and the fact that cosine scores
// never approach zero so a threshold has to be measured rather than guessed.
//
// Adapted rather than copied: config comes from getConfig() instead of
// module-load environment reads (the original throws at import time, which
// would break the Next build), results are typed, and nothing logs to stdout.

import { cached, EMBED_TTL_SECONDS } from '@/lib/aicache'
import { getConfig } from '@/lib/config'

/** 768 dimensions. The index must be created with the same number or nothing works. */
export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'
export const EMBED_DIMENSIONS = 768

export interface VectorRecord {
  id: string
  values: number[]
  metadata: Record<string, string | number>
}

export interface Match {
  id: string
  score: number
  metadata?: Record<string, unknown>
}

interface CloudflareEnvelope<T> {
  success?: boolean
  result?: T
  errors?: { message?: string }[]
}

function base(): string {
  return `https://api.cloudflare.com/client/v4/accounts/${getConfig().cloudflareAccountId}`
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getConfig().cloudflareApiToken}`,
    // Every model call routes through the AI Gateway, as the brief requires.
    'cf-aig-gateway-id': getConfig().aiGatewayId,
  }
}

function indexName(): string {
  const name = getConfig().vectorizeIndex
  if (!name) {
    throw new Error(
      'CF_VECTORIZE_INDEX is not set, so the board papers cannot be searched. ' +
        'Set it to the name of a 768-dimension Vectorize index.',
    )
  }
  return name
}

async function unwrap<T>(res: Response, what: string): Promise<T> {
  const json = (await res.json().catch(() => null)) as CloudflareEnvelope<T> | null
  if (!res.ok || !json?.success) {
    const detail = json?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`
    throw new Error(`${what} failed: ${detail}`)
  }
  return json.result as T
}

/** Embed a batch of strings. Returns one vector per input, in the same order. */
/**
 * Embeds text, reusing a cached vector where the same string has been embedded
 * before with the same model.
 *
 * A question typed twice — which is exactly what happens in a demo, and what a
 * reader does when refining — embedded twice. The vector for a fixed string is
 * deterministic, so the only thing that can invalidate it is the model, which
 * is part of the key.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  // Cached per string rather than per batch, so a batch that shares one string
  // with an earlier batch still benefits.
  const vectors = await Promise.all(
    texts.map((text) =>
      cached<number[]>(
        'embed',
        `${EMBED_MODEL} :: ${text}`,
        EMBED_TTL_SECONDS,
        async () => (await embedUncached([text]))[0] ?? null,
      ),
    ),
  )
  // A single failure falls back to embedding the whole batch, rather than
  // returning a short array that the caller would silently mis-zip.
  if (vectors.some((v) => v === null)) return embedUncached(texts)
  return vectors as number[][]
}

async function embedUncached(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const res = await fetch(`${base()}/ai/run/${EMBED_MODEL}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts }),
  })
  const result = await unwrap<{ data: number[][] }>(res, 'Embedding')
  return result.data
}

/**
 * Upsert vectors. The body is NDJSON — one JSON object per line, no wrapping
 * array and no commas. A normal JSON array is rejected.
 */
export async function upsert(records: VectorRecord[]): Promise<{ mutationId: string }> {
  const ndjson = records.map((r) => JSON.stringify(r)).join('\n')
  const res = await fetch(`${base()}/vectorize/v2/indexes/${indexName()}/upsert`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-ndjson' },
    body: ndjson,
  })
  return unwrap<{ mutationId: string }>(res, 'Vectorize upsert')
}

export async function info(): Promise<{
  dimensions: number
  vectorCount: number
  processedUpToMutation: string | null
}> {
  const res = await fetch(`${base()}/vectorize/v2/indexes/${indexName()}/info`, {
    headers: authHeaders(),
  })
  return unwrap(res, 'Vectorize info')
}

/**
 * Vectorize is eventually consistent, and it does not become consistent all at
 * once. Between upserting and catching up there is a window where the index is
 * half-populated and will answer a question with the wrong document and a
 * confident-looking score — which looks exactly like a broken pipeline and is
 * not one. So poll processedUpToMutation rather than sleeping for a guess.
 */
export async function waitForMutation(
  mutationId: string,
  opts: { timeoutMs?: number; onTick?: (seconds: number, vectorCount: number) => void } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const i = await info()
    if (i.processedUpToMutation === mutationId) return true
    opts.onTick?.(Math.round((Date.now() - started) / 1000), i.vectorCount)
    await new Promise((r) => setTimeout(r, 5000))
  }
  return false
}

/**
 * Query the index. returnMetadata must be the string "all" — omit it and the
 * matches come back with ids and scores but no text, which is the one thing
 * the caller actually needs.
 */
export async function queryVectors(vector: number[], topK = 5): Promise<Match[]> {
  const res = await fetch(`${base()}/vectorize/v2/indexes/${indexName()}/query`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, topK, returnMetadata: 'all' }),
  })
  const result = await unwrap<{ matches: Match[] }>(res, 'Vectorize query')
  return result.matches ?? []
}
