import { NextResponse } from 'next/server'
import { getTool, TOOLS } from '@/lib/analytics/registry'
import { loadDataset } from '@/lib/dataset/loader'
import { checkRateLimit } from '@/lib/ratelimit'
import { routeQuestion, type HistoryTurn } from '@/lib/router'
import { bearerCredential, isAuthorised } from '@/lib/auth'
import type { AnswerResult } from '@/lib/types'

// The dataset is read from the filesystem, so this cannot run on the edge.
export const runtime = 'nodejs'

const MAX_QUESTION_CHARS = 500

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status })
}

/** Errors are logged in full server-side and never returned to the client. */
function logDetail(where: string, e: unknown): void {
  console.error(`[api/ask] ${where}:`, e instanceof Error ? e.stack ?? e.message : e)
}

function parseHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((t): HistoryTurn[] => {
    if (!t || typeof t !== 'object') return []
    const { role, content } = t as { role?: unknown; content?: unknown }
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return []
    return [{ role, content: content.slice(0, MAX_QUESTION_CHARS) }]
  })
}

export async function POST(req: Request) {
  // The real gate. Nothing is persisted client-side, so there is no cookie for
  // middleware to check — this route refusing without the passcode is what
  // actually keeps the board data private. Stateless, so it behaves the same on
  // a cold instance as a warm one.
  if (!isAuthorised(bearerCredential(req))) {
    return fail(401, 'That passcode was not accepted. Enter it again to continue.')
  }

  const limit = await checkRateLimit(clientIp(req))
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many questions in a short time. Please wait ${limit.retryAfterSeconds} seconds and ask again.`,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'The request body was not valid JSON. Send { "question": "..." }.')
  }

  const { question, history } = (body ?? {}) as { question?: unknown; history?: unknown }
  if (typeof question !== 'string' || question.trim() === '') {
    return fail(400, 'Please type a question before sending.')
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return fail(
      400,
      `That question is ${question.length} characters. Please shorten it to ${MAX_QUESTION_CHARS} or fewer.`,
    )
  }
  const asked = question.trim()

  let dataset
  try {
    dataset = loadDataset()
  } catch (e) {
    logDetail('loadDataset', e)
    return fail(
      500,
      'The dataset could not be read. Check that ./dataset exists and contains attendance.json, actions.json and skills-audit.csv, or set DATASET_PATH.',
    )
  }

  let route
  try {
    route = await routeQuestion(asked, TOOLS, parseHistory(history), dataset)
  } catch (e) {
    logDetail('routeQuestion', e)
    return fail(
      500,
      'The question could not be routed to a tool. Please try rephrasing it, or try again shortly.',
    )
  }

  if (route.kind === 'refusal') {
    const result: AnswerResult = {
      tool: 'refusal',
      headline: 'This question cannot be answered from the data available.',
      reason: route.reason,
      alternative: route.alternative,
    }
    return NextResponse.json({ ok: true, result, question: asked, routedBy: route.routedBy })
  }

  const tool = getTool(route.name)
  if (!tool) {
    logDetail('registry', `router chose unknown tool "${route.name}"`)
    return fail(
      500,
      'That question was routed to an analysis that is not available. Please try rephrasing it.',
    )
  }

  let result: AnswerResult
  try {
    result = await tool.run(dataset, route.args)
  } catch (e) {
    logDetail(`tool ${tool.name}`, e)
    return fail(
      500,
      'The analysis could not be completed for this question. Please try rephrasing it, or ask a narrower question.',
    )
  }

  // The tool and arguments travel back with the answer so the client can pin
  // it. Pinning re-runs them server-side; what the client holds is a label for
  // the analysis, not the figures.
  return NextResponse.json({
    ok: true,
    result,
    question: asked,
    routedBy: route.routedBy,
    routedTo: { tool: tool.name, args: route.args },
  })
}
