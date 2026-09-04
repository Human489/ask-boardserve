import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// The cache sits in front of every model call, so what it must never do matters
// more than what it does: never serve one question's answer for another, never
// remember a failure, and never be the reason a broken gateway looks healthy.
delete process.env.CF_KV_NAMESPACE_ID
delete process.env.CF_ACCOUNT_ID
delete process.env.CF_API_TOKEN

import { cached, CACHE_TTL_SECONDS, EMBED_TTL_SECONDS } from '../src/lib/aicache'

test('with no KV configured the producer runs every time', async () => {
  // The in-memory shortcut that pins use cannot serve this: each route handler
  // is its own module instance, so a cache held in one is invisible to another.
  // Rather than pretend, it simply does not cache.
  let calls = 0
  const produce = () => {
    calls++
    return Promise.resolve({ value: calls })
  }
  await cached('probe', 'same material', CACHE_TTL_SECONDS, produce)
  await cached('probe', 'same material', CACHE_TTL_SECONDS, produce)
  assert.equal(calls, 2)
})

test('AI_CACHE=off bypasses the cache before a key is even computed', async () => {
  // The smoke suite asserts all twelve spec questions were routed by the model,
  // which is how a dead gateway is caught — but a cached route reports 'model'
  // too, correctly. Without this switch that assertion could pass with the
  // gateway down, which is worse than having no assertion.
  const original = process.env.AI_CACHE
  try {
    process.env.AI_CACHE = 'off'
    let calls = 0
    const produce = () => {
      calls++
      return Promise.resolve('x')
    }
    await cached('probe', 'm', CACHE_TTL_SECONDS, produce)
    await cached('probe', 'm', CACHE_TTL_SECONDS, produce)
    assert.equal(calls, 2, 'the switch must bypass reads and writes both')
  } finally {
    process.env.AI_CACHE = original
  }
})

test('a failure is passed through and never remembered', async () => {
  // Remembering one outage would turn it into an hour of them.
  let calls = 0
  const failing = () => {
    calls++
    return Promise.resolve(null)
  }
  assert.equal(await cached('probe', 'fails', CACHE_TTL_SECONDS, failing), null)
  assert.equal(await cached('probe', 'fails', CACHE_TTL_SECONDS, failing), null)
  assert.equal(calls, 2)
})

test('the producer decides the value; the cache only carries it', async () => {
  const value = { tool: 'attendance_by_director', args: { threshold: 80 } }
  const got = await cached('route', 'material', CACHE_TTL_SECONDS, () => Promise.resolve(value))
  assert.deepEqual(got, value)
})

test('the embedding TTL is longer than the routing TTL', () => {
  // An embedding of a fixed string never changes; only the model can
  // invalidate it, and the model is part of the key.
  assert.ok(EMBED_TTL_SECONDS > CACHE_TTL_SECONDS)
  // Cloudflare rejects a TTL under 60 seconds.
  assert.ok(CACHE_TTL_SECONDS >= 60)
})

test('every input that changes an answer is inside the key material', async () => {
  // Not a test of the cache, but of its callers: the key is built by them, and
  // the model id is in it because the model changed once already this week. A
  // cache without it would have gone on serving the previous one's decisions.
  const router = readFileSync('src/lib/router.ts', 'utf8')
  const routeCall = router.slice(router.indexOf("cached<Route>("), router.indexOf("() => modelRoute"))
  // Matched on the property rather than the local name, so renaming a variable
  // does not silently turn this guard off.
  for (const part of ['.model', 'question', 'history']) {
    assert.ok(routeCall.includes(part), `routing cache key omits ${part}`)
  }

  const answer = readFileSync('src/lib/retrieval/answer.ts', 'utf8')
  const groundCall = answer.slice(answer.indexOf("cached<GroundedAnswer>("), answer.indexOf('() => judgeUncached'))
  // Keyed on the passage TEXT, so re-ingesting a changed paper invalidates the
  // entry by itself rather than serving a judgement about older prose.
  for (const part of ['.model', 'question', 'p.text']) {
    assert.ok(groundCall.includes(part), `grounding cache key omits ${part}`)
  }
})

test('routing never caches a refusal', () => {
  // The cache does not merely hide a flaky model, it FREEZES one. Routing is
  // not deterministic: a spec question's shortened wording was measured
  // routing correctly about two thirds of the time and refusing the rest, and
  // with the cache on whichever answer the FIRST caller happened to get was
  // then served to everyone for the full hour — six identical refusals in a
  // row, looking entirely settled, for a question the dataset answers.
  //
  // A cached GOOD route is harmless, because the model would have chosen it
  // again. A cached refusal is a wrong answer with a one-hour lease.
  //
  // Asserted on the source, like the key-material test above, because this
  // file runs with KV deliberately unconfigured — so `cached` short-circuits
  // to its producer and the storing branch cannot be exercised here at all.
  // The behaviour itself was verified against a running server.
  const source = readFileSync('src/lib/router.ts', 'utf8')
  const call = source.slice(source.indexOf('cached<Route>'))
  // Bounded by the STATEMENT THAT FOLLOWS the call, not by a character count.
  // It was the first 900 characters, and adding a comment plus a wrapper
  // around the producer pushed the predicate past that window — so the test
  // failed while the property it checks still held. A brittle matcher
  // reporting a real behaviour as broken teaches people to ignore it, which is
  // the second time that has happened in this suite.
  const endsAt = call.indexOf('if (routed)')
  const predicate = endsAt > -1 ? call.slice(0, endsAt) : call
  assert.match(
    predicate,
    /kind !== 'refusal'/,
    'the routing cache must be given a predicate that refuses to store a refusal',
  )
})

test('the cache only stores what its caller judges worth keeping', () => {
  // The mechanism behind the rule above: a predicate, defaulting to "keep
  // anything non-null" so every existing call site is unchanged.
  const source = readFileSync('src/lib/aicache.ts', 'utf8')
  assert.match(source, /worthKeeping/, 'the predicate parameter exists')
  assert.match(
    source,
    /if \(!worthKeeping\(produced\)\) return produced/,
    'and it gates the write rather than the return',
  )
  assert.match(
    source,
    /worthKeeping: \(value: T\) => boolean = \(\) => true/,
    'defaulting to keeping everything, so no existing caller changes behaviour',
  )
})
