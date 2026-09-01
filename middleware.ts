import { NextResponse, type NextRequest } from 'next/server'

// Passcode gate. Runs on the edge runtime, so it uses Web Crypto rather than
// node:crypto. The cookie holds an HMAC of the passcode, not the passcode.

export const AUTH_COOKIE = 'bs_auth'

const PUBLIC_PREFIXES = ['/login', '/api/login', '/_next', '/favicon.ico']

let warned = false

export async function signPasscode(passcode: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passcode),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('ask-boardserve'))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant time in the length-equal case; length is not a secret here. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next()
  }

  const passcode = process.env.APP_PASSCODE?.trim()
  if (!passcode) {
    if (!warned) {
      warned = true
      console.warn(
        '\n*** APP_PASSCODE is not set. Every route is UNPROTECTED. ***\n' +
          '*** Fine for local development; never deploy like this.  ***\n',
      )
    }
    return NextResponse.next()
  }

  const expected = await signPasscode(passcode)
  const presented = req.cookies.get(AUTH_COOKIE)?.value ?? ''
  if (timingSafeEqual(presented, expected)) return NextResponse.next()

  const login = req.nextUrl.clone()
  login.pathname = '/login'
  login.search = ''
  login.searchParams.set('next', `${pathname}${search}`)
  return NextResponse.redirect(login)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
