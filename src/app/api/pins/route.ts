import { NextResponse } from 'next/server'
import { ANALYTICS_TOOLS, getTool } from '@/lib/analytics/registry'
import { clientIp, rejectUnauthorised } from '@/lib/apiauth'
import { activeDatasetId, resolveDataset } from '@/lib/datasets'
import { addPin, listPins, MAX_PINS, removePin, replacePin, type Pin } from '@/lib/pins'
import { checkRateLimit } from '@/lib/ratelimit'
import { coerceArgs } from '@/lib/router'
import { isRefusal } from '@/lib/types'

// The dataset is read from the filesystem, so this cannot run on the edge.
export const runtime = 'nodejs'

const MAX_QUESTION_CHARS = 500

/**
 * Arguments are stored verbatim inside the pin, and the whole pin list travels
 * in a single KV value on every dashboard read. Unbounded, a caller could pad
 * one pin until the value exceeded KV's limit and every later write failed.
 * Tools read their arguments through coercing helpers, so nothing legitimate
 * needs more room than this.
 */
const MAX_ARGS_CHARS = 2_000

/**
 * Every method is throttled, not just the expensive ones. POST and PATCH each
 * run a tool — which for the paper-retrieval tool means a vector query and two
 * model calls — so an unthrottled pin endpoint is a cheaper way to spend the
 * Cloudflare account than the question endpoint it sits beside.
 */
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
 * Which dataset's pins this request concerns.
 *
 * Resolved the same way the answer path resolves its dataset, so the dashboard
 * always shows pins belonging to the dataset the app is currently answering
 * from — never a mixture, and never another organisation's figures.
 */
async function pinScope(): Promise<
  { ok: true; datasetId: string } | { ok: false; status: number; error: string }
> {
  const active = await activeDatasetId()
  if (!active.ok) {
    return { ok: false, status: 502, error: 'The dashboard could not be read just now. Try again in a moment.' }
  }
  if (active.value) return { ok: true, datasetId: active.value }
  const resolved = await resolveDataset()
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.reason === 'none' ? 409 : 502,
      error:
        resolved.reason === 'none'
          ? 'No dataset is loaded, so there is no dashboard yet.'
          : 'The dashboard could not be read just now. Try again in a moment.',
    }
  }
  return { ok: true, datasetId: resolved.id }
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status })
}

function logDetail(where: string, e: unknown): void {
  console.error(`[api/pins] ${where}:`, e instanceof Error ? e.stack ?? e.message : e)
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Runs a named tool and returns its result, or an error message.
 *
 * This is the whole reason a pin is not simply the result the client already
 * had on screen. A client-supplied snapshot would put a figure on the dashboard
 * that no tool computed, which is the one thing this product does not do. So
 * pinning re-runs the analysis here, and refreshing runs it again.
 */
/**
 * Which analyses may be pinned.
 *
 * Everything except paper retrieval. Its safety on the question path comes from
 * guards that live in the router — the scope check that keeps structured
 * questions out of the papers, and the clock-anchoring refusal — and pinning
 * posts a tool name directly, reaching the tool without passing any of them.
 * Replicating that chain here would duplicate it and let the two drift.
 *
 * It is also the wrong shape for a pin: its prose is written by a model, so a
 * Refresh could return different wording for the same sources, and a card that
 * rewords itself is not a frozen figure.
 *
 * The two hybrids stay pinnable. They read a term limit out of a paper by
 * pattern rather than by model, and every figure they publish is computed.
 */
const PINNABLE = new Set([
  ...ANALYTICS_TOOLS.map((t) => t.name),
  'tenure_and_skills_impact',
  'upcoming_unprepared',
])

async function compute(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; pin: Omit<Pin, 'id' | 'question' | 'routedBy' | 'pinnedAt'> } | { ok: false; status: number; error: string }> {
  const definition = getTool(tool)
  if (!definition) {
    return { ok: false, status: 400, error: 'That analysis is not available.' }
  }
  if (!PINNABLE.has(definition.name)) {
    return {
      ok: false,
      status: 400,
      error: 'Answers drawn from the board papers cannot be pinned to the dashboard.',
    }
  }

  const resolved = await resolveDataset()
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.reason === 'none' ? 409 : 502,
      error:
        resolved.reason === 'none'
          ? 'No dataset is loaded, so there are no figures to pin.'
          : 'The dataset could not be read, so the figures could not be computed.',
    }
  }
  const dataset = resolved.dataset

  try {
    // The same coercion the router applies to model-supplied arguments: drop
    // anything undeclared, reject values outside a declared range rather than
    // clamping them. Without this, `{within_months: 100000}` pins a card
    // headlined with a 100000-month term-limit horizon.
    const result = await definition.run(dataset, coerceArgs(definition, args))
    // A refusal has no figures and no chart, so there is nothing to pin. It is
    // still a correct answer — it just is not a dashboard card.
    if (isRefusal(result)) {
      return {
        ok: false,
        status: 400,
        error: 'That answer has no figures to pin — the data cannot answer the question.',
      }
    }
    return { ok: true, pin: { tool, args, result, datasetAsAt: result.provenance.asAt } }
  } catch (e) {
    logDetail(`tool ${tool}`, e)
    return {
      ok: false,
      status: 500,
      error: 'The analysis could not be completed, so nothing was pinned.',
    }
  }
}

type ArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

function parseArgs(raw: unknown): ArgsResult {
  if (raw === undefined || raw === null) return { ok: true, args: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'The analysis arguments were not an object.' }
  }
  let encoded: string
  try {
    encoded = JSON.stringify(raw)
  } catch {
    return { ok: false, error: 'The analysis arguments could not be read.' }
  }
  if (encoded.length > MAX_ARGS_CHARS) {
    return { ok: false, error: 'The analysis arguments are too large to pin.' }
  }
  return { ok: true, args: raw as Record<string, unknown> }
}

export async function GET(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied

  const limited = await throttled(req)
  if (limited) return limited
  const scope = await pinScope()
  if (!scope.ok) return fail(scope.status, scope.error)
  const { pins, durable, reachable } = await listPins(scope.datasetId)
  // Reporting an outage as an empty dashboard would tell the reader their pins
  // are gone. Say the store could not be read instead.
  if (!reachable) {
    return fail(502, 'The dashboard could not be read just now. Try again in a moment.')
  }
  return NextResponse.json({ ok: true, pins, durable, max: MAX_PINS })
}

/** Pin an analysis. Body: { question, tool, args }. */
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
    return fail(400, 'The request body was not valid JSON.')
  }

  const { question, tool, args, routedBy } = (body ?? {}) as {
    question?: unknown
    tool?: unknown
    args?: unknown
    routedBy?: unknown
  }
  if (typeof question !== 'string' || question.trim() === '') {
    return fail(400, 'A pin needs the question it answers.')
  }
  if (typeof tool !== 'string' || tool.trim() === '') {
    return fail(400, 'A pin needs the analysis that produced it.')
  }
  const parsedArgs = parseArgs(args)
  if (!parsedArgs.ok) return fail(400, parsedArgs.error)

  // Capacity and duplication are checked BEFORE the analysis runs. Computing
  // first meant a request that ends in a 409 had already paid for a tool run,
  // which for the paper tool is two model calls spent to store nothing.
  const scope = await pinScope()
  if (!scope.ok) return fail(scope.status, scope.error)
  const current = await listPins(scope.datasetId)
  if (!current.reachable) {
    return fail(502, 'The dashboard could not be read, so nothing was pinned. Try again.')
  }
  if (
    current.pins.some(
      (p) => p.tool === tool && JSON.stringify(p.args) === JSON.stringify(parsedArgs.args),
    )
  ) {
    return fail(409, 'That analysis is already on the dashboard.')
  }
  if (current.pins.length >= MAX_PINS) {
    return fail(409, `The dashboard holds ${MAX_PINS} charts. Remove one before pinning another.`)
  }

  const computed = await compute(tool, parsedArgs.args)
  if (!computed.ok) return fail(computed.status, computed.error)

  const outcome = await addPin(scope.datasetId, {
    id: newId(),
    question: question.trim().slice(0, MAX_QUESTION_CHARS),
    // How the question originally reached this tool. A pin is re-run by tool
    // and arguments, so no routing happens again — this is recorded history,
    // and it is what lets the card keep saying the figures came via the
    // keyword fallback if they did.
    routedBy: routedBy === 'fallback' ? 'fallback' : 'model',
    pinnedAt: new Date().toISOString(),
    ...computed.pin,
  })

  if (!outcome.ok) {
    if (outcome.reason === 'duplicate') {
      return fail(409, 'That analysis is already on the dashboard.')
    }
    if (outcome.reason === 'full') {
      return fail(
        409,
        `The dashboard holds ${MAX_PINS} charts. Remove one before pinning another.`,
      )
    }
    return fail(502, 'The dashboard could not be saved. Nothing was changed — try again.')
  }

  return NextResponse.json({ ok: true, pins: outcome.pins, durable: outcome.durable })
}

/** Refresh one pin: re-run its tool and replace the frozen snapshot in place. */
export async function PATCH(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied

  const limited = await throttled(req)
  if (limited) return limited

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'The request body was not valid JSON.')
  }

  const { id } = (body ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || id === '') return fail(400, 'Which pin should be refreshed?')

  const scope = await pinScope()
  if (!scope.ok) return fail(scope.status, scope.error)
  const { pins, reachable } = await listPins(scope.datasetId)
  if (!reachable) {
    return fail(502, 'The dashboard could not be read, so nothing was refreshed. Try again.')
  }
  const existing = pins.find((p) => p.id === id)
  if (!existing) return fail(404, 'That chart is no longer on the dashboard.')

  // Re-runs the tool and arguments recorded at pin time, never a re-route: the
  // same question sent through the router again could reach a different tool,
  // and a Refresh that changes what the card is measuring is not a refresh.
  const computed = await compute(existing.tool, existing.args)
  if (!computed.ok) return fail(computed.status, computed.error)

  const outcome = await replacePin(scope.datasetId, id, {
    ...existing,
    ...computed.pin,
    refreshedAt: new Date().toISOString(),
  })
  if (!outcome.ok) {
    if (outcome.reason === 'not-found') {
      return fail(404, 'That chart is no longer on the dashboard.')
    }
    if (outcome.reason === 'unreachable') {
      return fail(502, 'The dashboard could not be read, so nothing was refreshed. Try again.')
    }
    return fail(502, 'The refreshed figures could not be saved. Try again.')
  }

  return NextResponse.json({ ok: true, pins: outcome.pins, durable: outcome.durable })
}

/** Unpin. Body: { id }. */
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
    return fail(400, 'The request body was not valid JSON.')
  }

  const { id } = (body ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || id === '') return fail(400, 'Which pin should be removed?')

  const scope = await pinScope()
  if (!scope.ok) return fail(scope.status, scope.error)
  const outcome = await removePin(scope.datasetId, id)
  if (!outcome.ok) {
    if (outcome.reason === 'unreachable') {
      // Not the same as "already gone": we do not know what is there, so
      // reporting success would show an emptied dashboard that is intact.
      return fail(502, 'The dashboard could not be read, so nothing was removed. Try again.')
    }
    if (outcome.reason === 'not-found') {
      // Already gone is the state the caller wanted, so this is not an error.
      const { pins, durable } = await listPins(scope.datasetId)
      return NextResponse.json({ ok: true, pins, durable })
    }
    return fail(502, 'The dashboard could not be saved. Nothing was changed — try again.')
  }

  return NextResponse.json({ ok: true, pins: outcome.pins, durable: outcome.durable })
}
