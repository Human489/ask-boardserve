import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// middleware.ts had no test, and that is where the day's worst regression
// lived: it began answering 401 itself, which skipped the per-IP budget that
// makes guessing the passcode expensive, so forty wrong bearer tokens returned
// forty free 401s. The suite was green throughout. These tests exist so the
// same bypass cannot return quietly.

const PASSCODE = 'a-test-passcode'
process.env.APP_PASSCODE = PASSCODE
process.env.SESSION_SECRET = 'a-test-session-secret'

import { middleware, config } from '../src/middleware'
import { SESSION_COOKIE, sessionToken } from '../src/lib/session'

const request = (path: string, init: { cookie?: string; bearer?: string } = {}) => {
  const headers = new Headers()
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
  return new NextRequest(new URL(`http://localhost:3000${path}`), { headers })
}

/** Where middleware sent the request: through, rewritten, or a status. */
async function outcome(path: string, init: Parameters<typeof request>[1] = {}) {
  const res = await middleware(request(path, init))
  const rewritten = res.headers.get('x-middleware-rewrite')
  if (rewritten) return `rewrite:${new URL(rewritten).pathname}`
  if (res.headers.get('x-middleware-next')) return 'next'
  return `status:${res.status}`
}

test('an API request without a credential is passed through, not rejected here', async () => {
  // THE regression. Rejecting it looked safer and was the opposite: the route
  // handlers are the only place that charges a failed check against the shared
  // guessing budget, so a 401 issued here costs the guesser nothing.
  assert.equal(await outcome('/api/ask'), 'next')
  assert.equal(await outcome('/api/ask', { bearer: 'wrong' }), 'next')
  assert.equal(await outcome('/api/pins'), 'next')
  assert.equal(await outcome('/api/datasets'), 'next')
  assert.equal(await outcome('/api/conversations'), 'next')
})

test('a page without a credential is rewritten to the gate', async () => {
  // Pages have no budget to charge and nothing to hand a JSON error to.
  assert.equal(await outcome('/'), 'rewrite:/gate')
  assert.equal(await outcome('/anything'), 'rewrite:/gate')
})

test('the gate and the login route are reachable without a credential', async () => {
  // Or nothing could ever obtain one.
  assert.equal(await outcome('/gate'), 'next')
  assert.equal(await outcome('/api/login'), 'next')
})

test('a valid session cookie is let through', async () => {
  const token = await sessionToken(PASSCODE)
  assert.equal(await outcome('/', { cookie: `${SESSION_COOKIE}=${token}` }), 'next')
  // Found even when it is not the first cookie in the header.
  assert.equal(
    await outcome('/', { cookie: `other=1; ${SESSION_COOKIE}=${token}` }),
    'next',
  )
})

test('a forged or expired cookie does not open a page', async () => {
  for (const cookie of [
    `${SESSION_COOKIE}=nonsense`,
    `${SESSION_COOKIE}=9999999999.forged`,
    `${SESSION_COOKIE}=`,
  ]) {
    assert.equal(await outcome('/', { cookie }), 'rewrite:/gate', cookie)
  }
})

test('the bearer token opens a page too, so a script is not forced to hold a cookie jar', async () => {
  assert.equal(await outcome('/', { bearer: PASSCODE }), 'next')
  assert.equal(await outcome('/', { bearer: 'wrong' }), 'rewrite:/gate')
})

test('a deployment with no passcode serves nothing', async () => {
  // Fails closed, the same rule /api/login applies.
  const original = process.env.APP_PASSCODE
  try {
    delete process.env.APP_PASSCODE
    assert.equal(await outcome('/'), 'status:503')
    assert.equal(await outcome('/api/ask'), 'status:503')
  } finally {
    process.env.APP_PASSCODE = original
  }
})

test('the matcher lists what to skip, so a new route is protected by default', () => {
  // The opposite mistake — listing what to cover — is the one that goes
  // unnoticed, because the symptom is a route nobody remembered to add.
  const [matcher] = config.matcher
  assert.match(matcher, /\?!/, 'the matcher must be a negative lookahead')
  for (const skipped of ['_next/static', '_next/image', 'favicon.ico']) {
    assert.ok(matcher.includes(skipped), `${skipped} should be excluded`)
  }
  // Anything that is not an asset must be inside it.
  const pattern = new RegExp(`^${matcher.replace(/^\/\(/, '(').replace(/\)$/, ')')}$`)
  for (const path of ['api/ask', 'gate', 'anything']) {
    assert.ok(pattern.test(path), `${path} should be matched`)
  }
})

test('the matcher excludes the self-hosted fonts', () => {
  // Not a style question. The fonts live under /public, so a request for one
  // from the GATE screen carries no session — and while the matcher covered
  // them, middleware rewrote that request to the gate's own HTML. The browser
  // got text/html where it asked for woff2, both @font-face rules reported
  // status "error", and the page silently fell back to Georgia.
  //
  // Which still renders as a serif, so a screenshot looked correct and the
  // build, the types and every unit test passed. It was found by reading
  // document.fonts back off the running page. This asserts on the matcher
  // pattern itself, because that is the thing that was wrong.
  const pattern = config.matcher[0]
  const re = new RegExp(`^${pattern}$`)

  assert.ok(!re.test('/fonts/instrument-serif-400.woff2'), 'fonts must bypass middleware')
  assert.ok(!re.test('/fonts/geist-mono.woff2'), 'fonts must bypass middleware')
  // The tab icon, caught exactly the way the fonts were: Next serves
  // src/app/icon.svg at /icon.svg, the gate is unauthenticated by definition,
  // so the browser asked for an icon and was handed the gate's HTML.
  assert.ok(!re.test('/icon.svg'), 'the app icon must bypass middleware')
  assert.ok(!re.test('/apple-icon'), 'the touch icon must bypass middleware')
  assert.ok(!re.test('/_next/static/chunks/main.js'), 'Next assets already bypassed')
  assert.ok(!re.test('/favicon.ico'), 'favicon already bypassed')

  // And the exclusion must not have opened anything else up.
  assert.ok(re.test('/'), 'the page itself is still gated')
  assert.ok(re.test('/api/ask'), 'the API is still matched so handlers can charge')
  // A new route is protected by default because the matcher lists what to
  // SKIP. Asserted rather than assumed: this is the property that makes
  // adding a route safe, and it is the one a mistyped matcher would lose.
  assert.ok(re.test('/api/conversations'), 'a newly added route is matched')
  assert.ok(re.test('/fontsecret'), 'a path merely starting with "fonts" is still gated')
})
