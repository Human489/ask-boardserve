import { NextResponse } from 'next/server'
import { clientIp, rejectUnauthorised } from '@/lib/apiauth'
import {
  MAX_CONVERSATIONS,
  MAX_TURNS,
  listConversations,
  removeConversation,
  saveConversation,
  summarise,
  type StoredTurn,
} from '@/lib/conversations'
import { activeDatasetId, resolveDataset } from '@/lib/datasets'
import { checkRateLimit } from '@/lib/ratelimit'

// Conversation history. Scoped to the active dataset, like the dashboard.
//
// UNLIKE THE DASHBOARD, THIS ROUTE STORES WHAT THE CLIENT SENDS. Pinning
// deliberately recomputes server-side so a pinned figure has the same
// provenance as one on screen, and a client-supplied `result` is discarded.
// That is not available here: a transcript is a record of answers the reader
// already received, and re-running them would produce a different record —
// a retried question, a refusal that has since been fixed, an answer from a
// dataset that has since been swapped.
//
// So the trust boundary is different, and worth being explicit about: what is
// stored here is the CLIENT'S ACCOUNT of what it was shown. It is replayed
// into that reader's own transcript and nowhere else. It never becomes a
// figure on the dashboard, it is never fed to a tool, and the routing context
// drawn from it is only ever question text and headlines. A caller who forges
// a transcript is lying to their own screen.
//
// The size caps below are what stop that being a way to fill KV.

// KV is read through fetch, and the dataset resolution below touches the
// filesystem, so this cannot run on the edge.
export const runtime = 'nodejs'

/** One question, and the reader is capped at this in the composer too. */
const MAX_QUESTION_CHARS = 500

/**
 * A stored turn carries a whole AnswerResult, and the entire conversation list
 * travels in one KV value on every read. Unbounded, one caller could pad a
 * single turn until the value exceeded KV's limit and every later write failed
 * — for every conversation on that dataset, not just theirs.
 */
const MAX_TURN_CHARS = 24_000
const MAX_ID_CHARS = 64

async function throttled(req: Request): Promise<NextResponse | null> {
  const limit = await checkRateLimit(clientIp(req))
  if (limit.allowed) return null
  return NextResponse.json(
    {
      ok: false,
      error: `Too many requests in a short time. Please wait ${limit.retryAfterSeconds} seconds and try again.`,
      retryAfterSeconds: limit.retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
  )
}

/**
 * Which dataset's history this is. Mirrors the dashboard's resolution exactly,
 * because the two have to agree about what a dataset "has".
 */
async function conversationScope(): Promise<
  { ok: true; datasetId: string } | { ok: false; status: number; error: string }
> {
  const active = await activeDatasetId()
  if (!active.ok) {
    return { ok: false, status: 502, error: 'Your conversations could not be read just now. Try again in a moment.' }
  }
  if (active.value) return { ok: true, datasetId: active.value }
  const resolved = await resolveDataset()
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.reason === 'none' ? 409 : 502,
      error:
        resolved.reason === 'none'
          ? 'No dataset is loaded, so there are no conversations yet.'
          : 'Your conversations could not be read just now. Try again in a moment.',
    }
  }
  return { ok: true, datasetId: resolved.id }
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status })
}

function logDetail(where: string, e: unknown): void {
  console.error(`[api/conversations] ${where}:`, e instanceof Error ? (e.stack ?? e.message) : e)
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/**
 * Validates the client's account of one turn.
 *
 * A turn without a headline is not a turn the reader saw — the card cannot
 * render without one — so it is rejected rather than stored as something that
 * would come back as a blank answer.
 */
function readTurn(value: unknown): StoredTurn | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>

  const id = str(t.id, MAX_ID_CHARS)
  const question = str(t.question, MAX_QUESTION_CHARS)
  if (!id || !question) return null

  const result = t.result
  if (!result || typeof result !== 'object') return null
  if (typeof (result as { headline?: unknown }).headline !== 'string') return null

  // Measured after validation, on the actual thing that will be stored.
  if (JSON.stringify(result).length > MAX_TURN_CHARS) return null

  const turn: StoredTurn = { id, question, result: result as StoredTurn['result'] }

  if (t.routedBy === 'model' || t.routedBy === 'fallback') turn.routedBy = t.routedBy

  // Carried so an answer restored from history can still be pinned; the pin
  // route re-runs the tool itself, so a forged value here buys nothing beyond
  // a pin that fails to compute.
  const routedTo = t.routedTo
  if (routedTo && typeof routedTo === 'object') {
    const r = routedTo as Record<string, unknown>
    const tool = str(r.tool, MAX_ID_CHARS)
    if (tool && r.args && typeof r.args === 'object') {
      turn.routedTo = { tool, args: r.args as Record<string, unknown> }
    }
  }

  return turn
}

/** The list, without transcripts. Opening the app must not download them all. */
export async function GET(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied

  const limited = await throttled(req)
  if (limited) return limited

  const scope = await conversationScope()
  if (!scope.ok) return fail(scope.status, scope.error)

  const store = await listConversations(scope.datasetId)
  if (!store.reachable) {
    return fail(502, 'Your conversations could not be read just now. Try again in a moment.')
  }

  const url = new URL(req.url)
  const wanted = url.searchParams.get('id')

  // One conversation with its turns, for opening it.
  if (wanted) {
    const found = store.conversations.find((c) => c.id === wanted)
    if (!found) return fail(404, 'That conversation is no longer saved.')
    return NextResponse.json({ ok: true, conversation: found, durable: store.durable })
  }

  return NextResponse.json({
    ok: true,
    conversations: summarise(store.conversations),
    durable: store.durable,
    max: MAX_CONVERSATIONS,
  })
}

/** Create or update one conversation. Body: { id, turns, title? }. */
export async function POST(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied

  const limited = await throttled(req)
  if (limited) return limited

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'That conversation could not be read.')
  }

  const { id, turns, title } = (body ?? {}) as {
    id?: unknown
    turns?: unknown
    title?: unknown
  }

  const conversationId = str(id, MAX_ID_CHARS)
  if (!conversationId) return fail(400, 'Which conversation should be saved?')
  if (!Array.isArray(turns)) return fail(400, 'That conversation had no transcript to save.')
  if (turns.length > MAX_TURNS) {
    return fail(413, `A conversation holds up to ${MAX_TURNS} questions. Start a new one to keep going.`)
  }

  // A pending or failed turn is transient and is dropped by the client before
  // it gets here; anything that does not validate is rejected rather than
  // stored as a turn that would come back blank.
  const readable: StoredTurn[] = []
  for (const raw of turns) {
    const turn = readTurn(raw)
    if (!turn) return fail(400, 'Part of that conversation could not be saved.')
    readable.push(turn)
  }

  const scope = await conversationScope()
  if (!scope.ok) return fail(scope.status, scope.error)

  // An empty transcript is not an error and not a record. The client posts on
  // every answer, so a conversation the reader opened and abandoned without
  // asking anything would otherwise appear in their history as a titleless
  // entry they never used. Report the list unchanged.
  if (readable.length === 0) {
    const store = await listConversations(scope.datasetId)
    if (!store.reachable) {
      return fail(502, 'Your conversations could not be read just now. Try again in a moment.')
    }
    return NextResponse.json({
      ok: true,
      conversations: summarise(store.conversations),
      durable: store.durable,
    })
  }

  const outcome = await saveConversation(scope.datasetId, {
    id: conversationId,
    title: typeof title === 'string' ? title.slice(0, 200) : undefined,
    turns: readable,
  })

  if (!outcome.ok) {
    if (outcome.reason === 'too-long') {
      return fail(413, `A conversation holds up to ${MAX_TURNS} questions. Start a new one to keep going.`)
    }
    if (outcome.reason === 'unreachable') {
      return fail(502, 'Your conversations could not be read, so nothing was saved. Try again.')
    }
    return fail(502, 'That conversation could not be saved. Try again.')
  }

  return NextResponse.json({
    ok: true,
    conversations: summarise(outcome.conversations),
    durable: outcome.durable,
  })
}

/** Forget one conversation. Body: { id }. */
export async function DELETE(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied

  const limited = await throttled(req)
  if (limited) return limited

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'That request could not be read.')
  }

  const id = str((body as { id?: unknown } | null)?.id, MAX_ID_CHARS)
  if (!id) return fail(400, 'Which conversation should be forgotten?')

  const scope = await conversationScope()
  if (!scope.ok) return fail(scope.status, scope.error)

  const outcome = await removeConversation(scope.datasetId, id)
  if (!outcome.ok) {
    if (outcome.reason === 'not-found') return fail(404, 'That conversation is no longer saved.')
    if (outcome.reason === 'unreachable') {
      return fail(502, 'Your conversations could not be read, so nothing was removed. Try again.')
    }
    return fail(502, 'That conversation could not be removed. Try again.')
  }

  return NextResponse.json({
    ok: true,
    conversations: summarise(outcome.conversations),
    durable: outcome.durable,
  })
}
