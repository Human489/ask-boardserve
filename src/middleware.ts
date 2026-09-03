import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, isValidSession } from '@/lib/session'
import { timingSafeEqual } from '@/lib/crypto'

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
  // Everything except Next's own assets, the favicon, and the self-hosted
  // fonts. Listing what to skip rather than what to cover means a new route is
  // protected by default; the opposite mistake is the one that goes unnoticed.
  //
  // /fonts had to be added and the omission was not theoretical. A font
  // request from the gate screen carries no session, so it was rewritten to
  // the gate's own HTML — the browser received text/html where it asked for
  // woff2, both @font-face rules reported status "error", and the page fell
  // back to Georgia. Which still looks like a serif, so the screenshot looked
  // right and the build, the types and every unit test passed. It was caught
  // by reading document.fonts back off the running page.
  //
  // Excluding them costs nothing: a typeface is not board data, and it is the
  // gate — the one page guaranteed to be unauthenticated — that needs them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts/).*)'],
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
  // timingSafeEqual like every other comparison here; this is now the first
  // one every request meets, so it is the last place to leave a shortcut.
  if (supplied && timingSafeEqual(supplied, passcode)) return NextResponse.next()
  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value, passcode)) {
    return NextResponse.next()
  }

  // An API call is passed THROUGH to its handler rather than rejected here.
  //
  // Rejecting it looked safer and was the opposite. Every route charges a
  // failed credential check against a shared per-IP budget — that is what
  // stops the passcode being guessed at network speed, and it was added this
  // morning after exactly that hole was measured. A 401 issued here never
  // reaches that code, so it costs the guesser nothing: forty wrong bearer
  // tokens at /api/ask returned forty free 401s and never a 429. The handlers
  // check the same two credentials and charge for the failure, so letting them
  // answer is both safe and the only place the budget exists.
  //
  // Pages have no such budget to charge and nothing to hand a JSON error to,
  // so they are rewritten to the passcode screen. Rewriting rather than
  // redirecting keeps the URL the reader typed, so signing in returns them to
  // where they were trying to go.
  if (pathname.startsWith('/api/')) return NextResponse.next()
  return NextResponse.rewrite(new URL('/gate', req.url))
}
