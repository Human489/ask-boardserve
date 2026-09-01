import { NextResponse } from 'next/server'
import { getConfig } from '@/lib/config'
import { checkRateLimit } from '@/lib/ratelimit'
import { login } from '@/lib/session'

// Sessions live in a Node-side Map, so this cannot run on the edge.
export const runtime = 'nodejs'

const MAX_PASSCODE_CHARS = 200

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(req: Request) {
  // Rate limited under its own key. A passcode endpoint without one is a
  // brute-force oracle, and it must not share a budget with /api/ask or a
  // failed login would eat the user's question allowance.
  const limit = checkRateLimit(`login:${clientIp(req)}`)
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many sign-in attempts. Please wait ${limit.retryAfterSeconds} seconds and try again.`,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    )
  }

  if (!getConfig().appPasscode) {
    console.error('[api/login] APP_PASSCODE is not set; no one can sign in.')
    return NextResponse.json(
      {
        ok: false,
        error:
          'This deployment is not configured with a passcode, so sign-in is unavailable. Set APP_PASSCODE and restart.',
      },
      { status: 503 },
    )
  }

  let supplied = ''
  try {
    const body = (await req.json()) as { passcode?: unknown }
    supplied = typeof body.passcode === 'string' ? body.passcode.slice(0, MAX_PASSCODE_CHARS) : ''
  } catch {
    return NextResponse.json(
      { ok: false, error: 'The sign-in request could not be read.' },
      { status: 400 },
    )
  }

  const token = login(supplied)
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'That passcode was not recognised.' },
      { status: 401 },
    )
  }

  // The token goes in the response body, not a Set-Cookie header, so the
  // browser stores nothing and a refresh returns to the passcode screen.
  return NextResponse.json({ ok: true, token })
}
