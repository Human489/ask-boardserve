import test from 'node:test'
import assert from 'node:assert/strict'

import { timingSafeEqual } from '../src/lib/crypto'
import { bearerCredential, isAuthorised } from '../src/lib/auth'
import { resetConfigCache } from '../src/lib/config'

// The gate on every request, and until now the only thing guarding it was the
// smoke suite — which needs a running server, a real passcode and network. So
// on any machine without .env.local, nothing tested authentication at all.

function withPasscode<T>(passcode: string | undefined, fn: () => T): T {
  const before = process.env.APP_PASSCODE
  if (passcode === undefined) delete process.env.APP_PASSCODE
  else process.env.APP_PASSCODE = passcode
  resetConfigCache()
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.APP_PASSCODE
    else process.env.APP_PASSCODE = before
    resetConfigCache()
  }
}

// ------------------------------------------------------------ timingSafeEqual

test('timingSafeEqual accepts only an exact match', () => {
  assert.equal(timingSafeEqual('', ''), true)
  assert.equal(timingSafeEqual('hunter2', 'hunter2'), true)
  assert.equal(timingSafeEqual('hunter2', 'hunter3'), false)
  // A length mismatch is rejected before any character is compared.
  assert.equal(timingSafeEqual('hunter2', 'hunter22'), false)
  assert.equal(timingSafeEqual('hunter2', 'hunter'), false)
})

test('a difference anywhere is rejected, not just at the end', () => {
  // The accumulator is `diff |= a ^ b`. Written `diff = a ^ b` — one character
  // away — only the LAST comparison survives, so every passcode sharing its
  // final character with the real one would be accepted. Every position is
  // therefore checked explicitly; a test that only differed in the last
  // character would pass against that defect.
  const expected = 'correct-horse-battery'
  for (let i = 0; i < expected.length; i++) {
    const mutated =
      expected.slice(0, i) + (expected[i] === 'x' ? 'y' : 'x') + expected.slice(i + 1)
    assert.equal(mutated.length, expected.length)
    assert.equal(
      timingSafeEqual(mutated, expected),
      false,
      `a value differing only at index ${i} was accepted: "${mutated}"`,
    )
  }
})

test('the comparison is symmetric and does not stop at the first difference', () => {
  assert.equal(timingSafeEqual('abcd', 'zbcd'), false)
  assert.equal(timingSafeEqual('zbcd', 'abcd'), false)
  // Differing in every position but the last is the case a broken accumulator
  // gets wrong.
  assert.equal(timingSafeEqual('zzzd', 'abcd'), false)
})

// ---------------------------------------------------------------- isAuthorised

test('isAuthorised fails closed when no passcode is configured', () => {
  // The documented guarantee: an unset APP_PASSCODE must lock the app, never
  // open it. The dangerous version of this bug is silent — an empty expected
  // value compared against an empty supplied one is a match.
  withPasscode('', () => {
    assert.equal(isAuthorised(''), false, 'an empty passcode must not authorise an empty credential')
    assert.equal(isAuthorised('anything'), false)
    assert.equal(isAuthorised(null), false)
    assert.equal(isAuthorised(undefined), false)
  })
  withPasscode(undefined, () => {
    assert.equal(isAuthorised(''), false)
    assert.equal(isAuthorised('anything'), false)
  })
  // Whitespace only is the same as unset: config trims and treats it as empty.
  withPasscode('   ', () => {
    assert.equal(isAuthorised('   '), false)
    assert.equal(isAuthorised(''), false)
  })
})

test('isAuthorised accepts the configured passcode and nothing else', () => {
  withPasscode('open-sesame', () => {
    assert.equal(isAuthorised('open-sesame'), true)
    assert.equal(isAuthorised('Open-Sesame'), false, 'the comparison is case-sensitive')
    assert.equal(isAuthorised('open-sesame '), false, 'no trimming of the supplied value')
    assert.equal(isAuthorised('open-sesam'), false)
    assert.equal(isAuthorised(''), false)
    assert.equal(isAuthorised(null), false)
    assert.equal(isAuthorised(undefined), false)
  })
})

// -------------------------------------------------------------- the header

test('bearerCredential reads a Bearer token and rejects anything else', () => {
  const withHeader = (value: string | null) =>
    bearerCredential(
      new Request('http://x/api/ask', {
        headers: value === null ? {} : { authorization: value },
      }),
    )

  assert.equal(withHeader('Bearer secret'), 'secret')
  assert.equal(withHeader('Bearer   secret  '), 'secret', 'surrounding space is trimmed')
  assert.equal(withHeader(null), null)
  assert.equal(withHeader(''), null)
  assert.equal(withHeader('secret'), null, 'a bare value is not a Bearer credential')
  assert.equal(withHeader('Basic secret'), null)
})

test('a request with no credential is not authorised', () => {
  withPasscode('open-sesame', () => {
    const req = new Request('http://x/api/ask')
    assert.equal(isAuthorised(bearerCredential(req)), false)
  })
})
