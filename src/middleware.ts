import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, isValidSession } from '@/lib/session'

// The gate the brief asks for: "a simple middleware check protecting every page
// and API route".
//
// Until now every API route checked the passcode per request, which is what
// stopped credits being spent, but the page itself was served to anyone and the
// gate was drawn client-side. No board data leaked — the data only ever comes
// from an API call — but the application and its whole JavaScript bundle were
// public, and "protecting every page" was not true.
//
// Two credentials are accepted, because they answer different needs. A browser
// typing the URL sends no Authorization header, so a page can only be protected
// by a cookie. A script, and the smoke suite, cannot hold a cookie jar as
// conveniently as a header, so the bearer token stays. Both are checked here
// and both are checked again in the route handlers: middleware is a gate, not a
// guarantee, and on a platform where a misconfigured matcher silently stops
// running it should never be the only thing standing there.

/** Reachable without a session, or nothing could ever obtain one. */
const PUBLIC_PATHS = new Set(['/gate', '/api/login'])

export const config = {
  // Everything except Next's own assets and the favicon. Listing what to skip
  // rather than what to cover means a new route is protected by default; the
  // opposite mistake is the one that goes unnoticed.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

function bearer(req: NextRequest): string | null {
  const match = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/)
  return match ? match[1].trim() : null
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  const passcode = process.env.APP_PASSCODE
  if (!passcode) {
    // Fail closed. A deployment without a passcode must not serve the app
    // unprotected, which is the same rule /api/login already applies.
    return new NextResponse('This deployment is not configured with a passcode.', {
      status: 503,
    })
  }

  const supplied = bearer(req)
  if (supplied && supplied === passcode) return NextResponse.next()
  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value, passcode)) {
    return NextResponse.next()
  }

  // An API call gets a status it can act on; a page gets the passcode screen.
  // Rewriting rather than redirecting keeps the URL the reader typed, so
  // signing in returns them to where they were trying to go.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { ok: false, error: 'That passcode was not accepted. Enter it again to continue.' },
      { status: 401 },
    )
  }
  return NextResponse.rewrite(new URL('/gate', req.url))
}
