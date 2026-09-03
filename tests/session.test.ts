import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  isValidSession,
  sessionCookieOptions,
  sessionToken,
} from '../src/lib/session'

// There were no tests for this module, nor for middleware, nor for the cache.
// That is not an accident of coverage: the worst regression of the day — a
// middleware 401 that skipped the passcode-guessing budget — passed a green
// suite because the bypass lived in a layer nothing exercised.

process.env.SESSION_SECRET = 'test-secret-that-is-not-the-passcode'
const PASSCODE = 'a-human-chosen-passcode'
const NOW = 1_800_000_000_000

test('a session is valid when issued and invalid once expired', async () => {
  const token = await sessionToken(PASSCODE, NOW)
  assert.equal(await isValidSession(token, PASSCODE, NOW), true)
  assert.equal(await isValidSession(token, PASSCODE, NOW + 60_000), true)

  // The expiry is inside the signed payload, so it is enforced here rather
  // than trusted to the browser — a cookie's maxAge is a hint the client is
  // free to ignore, and the first version accepted a captured value forever.
  const past = NOW + (SESSION_MAX_AGE_SECONDS + 1) * 1000
  assert.equal(await isValidSession(token, PASSCODE, past), false)
})

test('the cookie does not contain the passcode', async () => {
  // A cookie ends up in proxy logs, shared profiles and bug reports. Recovering
  // the passcode from one would hand over the bearer credential for every
  // route, and it cannot be revoked short of changing APP_PASSCODE.
  const token = await sessionToken(PASSCODE, NOW)
  assert.ok(!token.includes(PASSCODE))
})

test('a tampered expiry is refused', async () => {
  const token = await sessionToken(PASSCODE, NOW)
  const signature = token.slice(token.lastIndexOf('.') + 1)
  const forged = `${Math.floor(NOW / 1000) + 10 * SESSION_MAX_AGE_SECONDS}.${signature}`
  assert.equal(await isValidSession(forged, PASSCODE, NOW), false)
})

test('junk and empty values are refused', async () => {
  for (const value of ['', 'nonsense', 'abc.def', '.', '123.', 'x.y.z', undefined]) {
    assert.equal(await isValidSession(value, PASSCODE, NOW), false, `accepted ${String(value)}`)
  }
})

test('a deployment with no passcode fails closed', async () => {
  const token = await sessionToken(PASSCODE, NOW)
  for (const passcode of [undefined, '', '   ']) {
    assert.equal(
      await isValidSession(token, passcode, NOW),
      false,
      'a missing passcode must not validate against an empty string',
    )
  }
})

test('rotating the secret signs every session out', async () => {
  // The only revocation this stateless design offers, so it has to work.
  const token = await sessionToken(PASSCODE, NOW)
  const original = process.env.SESSION_SECRET
  try {
    process.env.SESSION_SECRET = 'a-different-secret'
    assert.equal(await isValidSession(token, PASSCODE, NOW), false)
  } finally {
    // `process.env.X = undefined` sets the STRING "undefined", which is truthy
    // — so this leaked a configured-looking secret into every test below and
    // was why the next one could assert the wrong thing and pass.
    if (original === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = original
  }
})

test('a token signed under one passcode does not validate under another', async () => {
  // This test's NAME was right and its assertion was the opposite: it asserted
  // that a cookie DOES validate under a different passcode, with a comment
  // explaining that as intended. It passed only because the test above restored
  // SESSION_SECRET to the string "undefined", leaving a secret configured — and
  // with a secret the signing key ignored the passcode entirely.
  //
  // So changing APP_PASSCODE revoked nothing, which is the one revocation an
  // operator knows about, and two files documented the opposite. The key now
  // binds both, and this asserts what its name always claimed.
  const token = await sessionToken(PASSCODE, NOW)
  assert.equal(await isValidSession(token, 'a-different-passcode', NOW), false)
  assert.equal(await isValidSession(token, PASSCODE, NOW), true, 'and still valid under its own')
})

test('the cookie is httpOnly, same-site and scoped to the app', () => {
  const options = sessionCookieOptions(true)
  assert.equal(options.httpOnly, true, 'script must not be able to read it')
  assert.equal(options.sameSite, 'strict', 'CSRF rests on this')
  assert.equal(options.secure, true)
  assert.equal(options.path, '/')
  assert.equal(sessionCookieOptions(false).secure, false, 'local development is not https')
  assert.equal(SESSION_COOKIE, 'bs_session')
})

test('rotating the passcode invalidates a live cookie, even with a secret set', async () => {
  // The revocation an operator will actually reach for. The signing key used
  // the SESSION_SECRET instead of the passcode when one was set, so changing
  // APP_PASSCODE did nothing to a browser already signed in — for the
  // remaining week of the cookie's life. Both files documenting this said the
  // opposite.
  const previous = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'a-configured-secret'
  try {
    const token = await sessionToken('the-old-passcode')
    assert.equal(await isValidSession(token, 'the-old-passcode'), true, 'valid before rotation')
    assert.equal(
      await isValidSession(token, 'the-new-passcode'),
      false,
      'rotating APP_PASSCODE must invalidate a cookie signed under the old one',
    )
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = previous
  }
})

test('rotating the secret still invalidates a cookie too', async () => {
  const previous = process.env.SESSION_SECRET
  try {
    process.env.SESSION_SECRET = 'secret-one'
    const token = await sessionToken('same-passcode')
    process.env.SESSION_SECRET = 'secret-two'
    assert.equal(await isValidSession(token, 'same-passcode'), false, 'either key revokes')
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = previous
  }
})
