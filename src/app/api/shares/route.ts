import { NextResponse } from 'next/server'
import { clientIp, rejectUnauthorised } from '@/lib/apiauth'
import { activeDatasetId, resolveDataset } from '@/lib/datasets'
import { listPins } from '@/lib/pins'
import { checkRateLimit } from '@/lib/ratelimit'
import {
  DEFAULT_TTL_DAYS,
  MAX_SHARES,
  MAX_TTL_DAYS,
  createShare,
  isWellFormedToken,
  listShares,
  revokeShare,
} from '@/lib/shares'

// Managing share links. This route is behind the passcode like everything
// else; only the PAGE the token opens is public.

export const runtime = 'nodejs'

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

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status })
}

async function scope(): Promise<
  { ok: true; datasetId: string; organisation: string } | { ok: false; status: number; error: string }
> {
  const active = await activeDatasetId()
  if (!active.ok) {
    return { ok: false, status: 502, error: 'Your share links could not be read just now. Try again in a moment.' }
  }
  const resolved = await resolveDataset()
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.reason === 'none' ? 409 : 502,
      error:
        resolved.reason === 'none'
          ? 'No dataset is loaded, so there is nothing to share.'
          : 'Your share links could not be read just now. Try again in a moment.',
    }
  }
  return {
    ok: true,
    datasetId: active.value ?? resolved.id,
    organisation: resolved.dataset.organisation,
  }
}

export async function GET(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited

  const where = await scope()
  if (!where.ok) return fail(where.status, where.error)

  return NextResponse.json({
    ok: true,
    shares: await listShares(where.datasetId),
    max: MAX_SHARES,
    defaultDays: DEFAULT_TTL_DAYS,
    maxDays: MAX_TTL_DAYS,
  })
}

/** Create a link over the CURRENT pinned dashboard. Body: { days? }. */
export async function POST(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // A body is optional here; the default expiry applies.
  }
  const asked = (body as { days?: unknown } | null)?.days
  const days = typeof asked === 'number' && Number.isFinite(asked) ? asked : DEFAULT_TTL_DAYS

  const where = await scope()
  if (!where.ok) return fail(where.status, where.error)

  const { pins, reachable } = await listPins(where.datasetId)
  if (!reachable) {
    return fail(502, 'The dashboard could not be read, so no link was made. Try again.')
  }

  const outcome = await createShare(where.datasetId, where.organisation, pins, days)
  if (!outcome.ok) {
    if (outcome.reason === 'needs-kv') {
      return fail(
        409,
        'Sharing needs a storage namespace, and none is configured. Set CF_KV_NAMESPACE_ID to enable it.',
      )
    }
    if (outcome.reason === 'nothing-to-share') {
      return fail(409, 'There are no pinned charts to share yet.')
    }
    if (outcome.reason === 'too-many') {
      return fail(409, `You can have ${MAX_SHARES} links at once. Revoke one to make another.`)
    }
    return fail(502, 'That link could not be created. Try again.')
  }

  return NextResponse.json({
    ok: true,
    token: outcome.token,
    expiresAt: outcome.expiresAt,
    shares: outcome.shares,
  })
}

/** Revoke immediately. Body: { token }. */
export async function DELETE(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return fail(400, 'That request could not be read.')
  }
  const token = (body as { token?: unknown } | null)?.token
  if (typeof token !== 'string' || !isWellFormedToken(token)) {
    return fail(400, 'Which link should be revoked?')
  }

  const where = await scope()
  if (!where.ok) return fail(where.status, where.error)

  const outcome = await revokeShare(where.datasetId, token)
  if (!outcome.ok) {
    return fail(409, 'Sharing needs a storage namespace, and none is configured.')
  }
  return NextResponse.json({ ok: true, shares: outcome.shares })
}
