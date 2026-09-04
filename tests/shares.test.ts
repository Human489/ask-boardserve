import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { isShare, isWellFormedToken, newToken, MAX_TTL_DAYS, DEFAULT_TTL_DAYS } from '../src/lib/shares'

// A share link is the one route in this app with no passcode in front of it,
// and what sits behind it is named directors' attendance. CLAUDE.md set five
// conditions before it was built — high entropy, expiry, revocation, noindex,
// no personal data in the URL — so these test the conditions, not the plumbing.
//
// The KV-backed paths are exercised end to end by the smoke suite against a
// running server, because this file runs with KV deliberately unconfigured.

test('a token carries 256 bits from the platform CSPRNG', () => {
  const token = newToken()
  // 32 bytes, base64url, unpadded.
  assert.ok(token.length >= 42 && token.length <= 44, `unexpected length ${token.length}`)
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'URL-safe with no padding')
  assert.ok(!token.includes('='), 'no padding to be stripped by a copy-paste')
})

test('tokens do not repeat and do not encode when they were made', () => {
  // A token derived from a clock or a dataset id would be guessable by anyone
  // who knew roughly when a link was created.
  const tokens = new Set<string>()
  for (let i = 0; i < 500; i++) tokens.add(newToken())
  assert.equal(tokens.size, 500, 'every token is distinct')

  // Nothing shared between two tokens made in the same millisecond beyond what
  // chance gives: no common prefix worth speaking of.
  const [a, b] = [newToken(), newToken()]
  let shared = 0
  while (shared < a.length && a[shared] === b[shared]) shared++
  assert.ok(shared <= 4, `tokens share a ${shared}-character prefix, so they are not random`)
})

test('a malformed token is rejected before it is ever used as a key', () => {
  assert.ok(isWellFormedToken(newToken()))

  for (const bad of [
    '',
    'short',
    '../../etc/passwd',
    'has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'slash/inside/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'a'.repeat(65),
    'plus+and/slash+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]) {
    assert.equal(isWellFormedToken(bad), false, `should reject: ${bad.slice(0, 24)}`)
  }
})

test('a share record has to look like one before it reaches a public page', () => {
  assert.equal(isShare(null), false)
  assert.equal(isShare('a string'), false)
  assert.equal(isShare({}), false)
  assert.equal(isShare({ createdAt: 'x', expiresAt: 'y', organisation: 'z' }), false, 'no pins')
  assert.ok(isShare({ createdAt: 'x', expiresAt: 'y', organisation: 'z', pins: [] }))
})

test('expiry is mandatory and capped, and the cap is short', () => {
  assert.ok(DEFAULT_TTL_DAYS > 0, 'there is always an expiry')
  assert.ok(DEFAULT_TTL_DAYS <= MAX_TTL_DAYS)
  // The data behind the link is named individuals' attendance. A link that
  // lived for a year would be an open door for a year.
  assert.ok(MAX_TTL_DAYS <= 30, `cap is too long: ${MAX_TTL_DAYS} days`)
})

test('the expiry is checked on read, not only left to the store', () => {
  // A KV TTL is a promise about eviction, not a guarantee about the moment a
  // value stops being readable — and this is the route with no passcode.
  const source = readFileSync('src/lib/shares.ts', 'utf8')
  const readFn = source.slice(source.indexOf('export async function readShare'))
  assert.match(readFn, /expired\(parsed, now\(\)\)/, 'readShare must check the expiry itself')

  const create = source.slice(source.indexOf('export async function createShare'))
  assert.match(create, /kvPut\(KEY\(token\), JSON\.stringify\(share\), seconds\)/, 'and set a TTL')
})

test('the token is the only thing in the URL path', () => {
  // No organisation, no dataset id, no director name. The route is
  // /share/[token] and the record is keyed by the token alone.
  const source = readFileSync('src/lib/shares.ts', 'utf8')
  assert.match(source, /const KEY = \(token: string\) => `share:v1:\$\{token\}`/)
  // The dataset id keys the OWNER's index, which is never in a public URL.
  assert.match(source, /const INDEX = \(datasetId: string\)/)
})

test('creating a link refuses without KV rather than appearing to work', () => {
  // The in-memory fallback pins use cannot serve this: each route handler is
  // its own module instance, so a share held in one route's memory is
  // invisible to the route that serves the page — the link would 404 for
  // everyone including the person who just made it.
  const source = readFileSync('src/lib/shares.ts', 'utf8')
  const create = source.slice(source.indexOf('export async function createShare'))
  assert.match(create, /if \(!kvAvailable\(\)\) return \{ ok: false, reason: 'needs-kv' \}/)
})

test('revoking deletes the record before it updates the index', () => {
  // If only one of the two can happen, the LINK must be the one that stops
  // working. An index entry pointing at a deleted record is untidy; a live
  // record missing from the index is a link nobody can find to revoke.
  const source = readFileSync('src/lib/shares.ts', 'utf8')
  const revoke = source.slice(source.indexOf('export async function revokeShare'))
  // Matched on the two calls separately, not on one exact string: the earlier
  // version required `kvPut(INDEX(datasetId)` to sit on one line, so wrapping
  // the arguments failed a test whose property still held. A brittle matcher
  // reporting a real ordering as broken teaches people to ignore it.
  const deleteAt = revoke.indexOf('kvDelete(KEY(token))')
  const indexAt = revoke.indexOf('INDEX(datasetId)')
  assert.ok(deleteAt > -1 && indexAt > -1, 'both writes happen')
  assert.ok(deleteAt < indexAt, 'the record is deleted first')
})
