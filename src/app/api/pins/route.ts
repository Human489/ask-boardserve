import { NextResponse } from 'next/server'
import { getTool } from '@/lib/analytics/registry'
import { bearerCredential, isAuthorised } from '@/lib/auth'
import { loadDataset } from '@/lib/dataset/loader'
import { addPin, listPins, MAX_PINS, removePin, replacePin, type Pin } from '@/lib/pins'
import { isRefusal } from '@/lib/types'

// The dataset is read from the filesystem, so this cannot run on the edge.
export const runtime = 'nodejs'

const MAX_QUESTION_CHARS = 500

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
async function compute(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; pin: Omit<Pin, 'id' | 'question' | 'routedBy' | 'pinnedAt'> } | { ok: false; status: number; error: string }> {
  const definition = getTool(tool)
  if (!definition) {
    return { ok: false, status: 400, error: 'That analysis is not available.' }
  }

  let dataset
  try {
    dataset = loadDataset()
  } catch (e) {
    logDetail('loadDataset', e)
    return {
      ok: false,
      status: 500,
      error: 'The dataset could not be read, so the figures could not be computed.',
    }
  }

  try {
    const result = await definition.run(dataset, args)
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

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

export async function GET(req: Request) {
  if (!isAuthorised(bearerCredential(req))) {
    return fail(401, 'That passcode was not accepted. Enter it again to continue.')
  }
  const { pins, durable } = await listPins()
  return NextResponse.json({ ok: true, pins, durable, max: MAX_PINS })
}

/** Pin an analysis. Body: { question, tool, args }. */
export async function POST(req: Request) {
  if (!isAuthorised(bearerCredential(req))) {
    return fail(401, 'That passcode was not accepted. Enter it again to continue.')
  }

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
  if (!parsedArgs) return fail(400, 'The analysis arguments were not an object.')

  const computed = await compute(tool, parsedArgs)
  if (!computed.ok) return fail(computed.status, computed.error)

  const outcome = await addPin({
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
  if (!isAuthorised(bearerCredential(req))) {
    return fail(401, 'That passcode was not accepted. Enter it again to continue.')
  }

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'The request body was not valid JSON.')
  }

  const { id } = (body ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || id === '') return fail(400, 'Which pin should be refreshed?')

  const { pins } = await listPins()
  const existing = pins.find((p) => p.id === id)
  if (!existing) return fail(404, 'That chart is no longer on the dashboard.')

  // Re-runs the tool and arguments recorded at pin time, never a re-route: the
  // same question sent through the router again could reach a different tool,
  // and a Refresh that changes what the card is measuring is not a refresh.
  const computed = await compute(existing.tool, existing.args)
  if (!computed.ok) return fail(computed.status, computed.error)

  const outcome = await replacePin(id, {
    ...existing,
    ...computed.pin,
    refreshedAt: new Date().toISOString(),
  })
  if (!outcome.ok) {
    if (outcome.reason === 'not-found') {
      return fail(404, 'That chart is no longer on the dashboard.')
    }
    return fail(502, 'The refreshed figures could not be saved. Try again.')
  }

  return NextResponse.json({ ok: true, pins: outcome.pins, durable: outcome.durable })
}

/** Unpin. Body: { id }. */
export async function DELETE(req: Request) {
  if (!isAuthorised(bearerCredential(req))) {
    return fail(401, 'That passcode was not accepted. Enter it again to continue.')
  }

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'The request body was not valid JSON.')
  }

  const { id } = (body ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || id === '') return fail(400, 'Which pin should be removed?')

  const outcome = await removePin(id)
  if (!outcome.ok) {
    if (outcome.reason === 'not-found') {
      // Already gone is the state the caller wanted, so this is not an error.
      const { pins, durable } = await listPins()
      return NextResponse.json({ ok: true, pins, durable })
    }
    return fail(502, 'The dashboard could not be saved. Nothing was changed — try again.')
  }

  return NextResponse.json({ ok: true, pins: outcome.pins, durable: outcome.durable })
}
