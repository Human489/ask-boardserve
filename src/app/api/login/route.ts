import { NextResponse } from 'next/server'
import { AUTH_COOKIE, signPasscode, timingSafeEqual } from '@/middleware'

export const runtime = 'nodejs'

/** Only same-origin relative paths, so ?next= cannot become an open redirect. */
function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

export async function POST(req: Request) {
  const passcode = process.env.APP_PASSCODE?.trim()

  const form = await req.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({ ok: false, error: 'The sign-in form could not be read.' }, { status: 400 })
  }
  const next = safeNext(form.get('next'))
  const supplied = String(form.get('passcode') ?? '')

  if (!passcode) {
    // No passcode configured: the gate is off, so let the user straight in.
    return NextResponse.redirect(new URL(next, req.url), 303)
  }

  const ok = timingSafeEqual(await signPasscode(supplied), await signPasscode(passcode))
  if (!ok) {
    const back = new URL('/login', req.url)
    back.searchParams.set('next', next)
    back.searchParams.set('error', '1')
    return NextResponse.redirect(back, 303)
  }

  const res = NextResponse.redirect(new URL(next, req.url), 303)
  res.cookies.set(AUTH_COOKIE, await signPasscode(passcode), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  return res
}
