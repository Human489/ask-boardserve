import { NextResponse } from 'next/server'
import { getConfig } from '@/lib/config'
import { throttleFailedAuth } from '@/lib/apiauth'
import { isAuthorised } from '@/lib/auth'

// Reads APP_PASSCODE, so it runs on the Node runtime.
export const runtime = 'nodejs'

const MAX_PASSCODE_CHARS = 200

export async function POST(req: Request) {

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

  if (!isAuthorised(supplied)) {
    // Charged on failure only, and under a budget shared with every other
    // endpoint that accepts the passcode. This route's own key was not enough:
    // /api/ask and /api/pins take the same credential as a bearer token, so
    // limiting only this one left the others unmetered. Keeping the budget
    // separate from the question allowance was the original and correct
    // reasoning, and it still holds — a wrong passcode does not cost a reader
    // any of their questions, and a correct one costs nothing at all.
    const throttled = await throttleFailedAuth(req)
    if (throttled) return throttled
    return NextResponse.json(
      { ok: false, error: 'That passcode was not recognised.' },
      { status: 401 },
    )
  }

  // Nothing is issued and nothing is stored. This endpoint exists only so the
  // passcode can be checked before the chat is shown, rather than the user
  // discovering it was wrong when their first question fails.
  return NextResponse.json({ ok: true })
}
