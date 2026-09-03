import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOLS } from '../src/lib/analytics/registry'
import { resetConfigCache } from '../src/lib/config'
import { checkRateLimit, resetRateLimits } from '../src/lib/ratelimit'
import { fallbackRoute, guardPapersRouteForTest, routeQuestion } from '../src/lib/router'
import { loadDataset } from '../src/lib/dataset/loader'
import { SPEC_REFUSALS, SPEC_STRUCTURED } from './spec-questions'

// Only the fallback classifier is tested here. The model path is
// non-deterministic and needs credentials; the fallback is what must hold when
// it is unavailable. The same wordings go through routeQuestion — the function
// the API actually calls — in tests/routing-spec.test.ts.

// The twelve structured questions from docs/question-set.md, Q1-Q12, now kept
// in tests/spec-questions.ts so this file and routing-spec.test.ts cannot drift
// apart again: the verbatim wordings lived only here, while the file whose
// stated purpose was to hold them carried shortened rewrites.
//
// Expectations name the TOOL, not a subject area. An earlier version asserted
// only that the question reached the first tool whose name matched the subject
// stem, which every question did regardless of whether the routing was right.
const STRUCTURED = SPEC_STRUCTURED

// R1-R5.
const REFUSALS = SPEC_REFUSALS

for (const { q, tool } of STRUCTURED) {
  test(`routes to ${tool}: ${q.slice(0, 56)}`, () => {
    const r = fallbackRoute(q, TOOLS)
    assert.equal(r.kind, 'tool', `expected a tool route, got a refusal`)
    if (r.kind !== 'tool') return
    assert.equal(r.name, tool)
    assert.equal(r.routedBy, 'fallback')
  })
}

for (const q of REFUSALS) {
  test(`refuses: ${q.slice(0, 56)}`, () => {
    const r = fallbackRoute(q, TOOLS)
    assert.equal(r.kind, 'refusal')
    if (r.kind !== 'refusal') return
    assert.ok(r.reason.length > 20, 'a refusal must say why, specifically')
  })
}

// A refusal that claims a field is absent when the data holds it tells the
// reader the product cannot do something it can. Both of these refused on a
// bare keyword — "minutes" and "decided" — while the attendance rows record
// minutes joined late and the action log records the body that raised each
// action.
const MUST_NOT_CLAIM_NO_MINUTES = [
  'How many minutes late do directors join meetings?',
  'Which committee decided the most actions?',
  'What is the average minutes joined late?',
]

for (const q of MUST_NOT_CLAIM_NO_MINUTES) {
  test(`does not refuse as a minutes question: ${q.slice(0, 48)}`, () => {
    const r = fallbackRoute(q, TOOLS)
    if (r.kind !== 'refusal') return
    assert.ok(
      !/no minutes in this dataset|no record of what was decided/i.test(r.reason),
      `refused by claiming absent data: "${r.reason}"`,
    )
  })
}

// Genuine meeting-minutes questions must still refuse: there are no minutes.
for (const q of [
  'What do the minutes of the last board meeting say?',
  'Can we see the board minutes?',
  'What was resolved at the last meeting?',
]) {
  test(`still refuses a real minutes question: ${q.slice(0, 48)}`, () => {
    const r = fallbackRoute(q, TOOLS)
    assert.equal(r.kind, 'refusal')
    if (r.kind !== 'refusal') return
    assert.match(r.reason, /minutes/i)
  })
}

test('a refusal never says the records hold nothing on a subject they hold', () => {
  // The catch-all refusal fires more often now that one loose word cannot carry
  // a route, so its wording matters more: it must describe what no TOOL
  // computes, never what the data lacks.
  const r = fallbackRoute('Which month were the offices repainted?', TOOLS)
  assert.equal(r.kind, 'refusal')
  if (r.kind !== 'refusal') return
  assert.ok(
    !/nothing in the attendance records/i.test(r.reason),
    'this asserts an absence the router has not checked',
  )
})

test('board paper questions route to retrieval, which decides for itself', () => {
  // Previously refused outright because retrieval did not exist. It now routes,
  // and whether the papers actually cover the subject is judged by the tool with
  // the passages in front of it — a decision no keyword or score can make.
  const r = fallbackRoute('What do the board papers say about the Ashcombe day therapy unit?', TOOLS)
  assert.equal(r.kind, 'tool')
  if (r.kind !== 'tool') return
  assert.equal(r.name, 'search_board_papers')
  assert.equal(r.args.question, 'What do the board papers say about the Ashcombe day therapy unit?')
})

test('every required argument is filled from the tool schema', () => {
  for (const { q } of STRUCTURED) {
    const r = fallbackRoute(q, TOOLS)
    if (r.kind !== 'tool') continue
    const tool = TOOLS.find((t) => t.name === r.name)!
    for (const req of tool.required) {
      assert.notEqual(r.args[req], undefined, `${tool.name} missing required arg "${req}"`)
    }
  }
})

test('the 21st request in a window is denied with a sane Retry-After', async () => {
  process.env.RATE_LIMIT_PER_MINUTE = '20'
  resetConfigCache()
  resetRateLimits()

  // KV is deliberately not configured here, so this exercises the local layer
  // on its own: exact, instant, and the only layer a test can assert precisely.
  // The shared layer is eventually consistent by nature and is verified against
  // the real service instead.
  const t0 = 1_700_000_000_000
  for (let i = 0; i < 20; i++) {
    const r = await checkRateLimit('1.2.3.4', t0 + i * 10)
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`)
    assert.equal(r.remaining, 19 - i)
  }

  const denied = await checkRateLimit('1.2.3.4', t0 + 500)
  assert.equal(denied.allowed, false)
  assert.equal(denied.remaining, 0)
  assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60)

  // A different IP has its own window.
  assert.equal((await checkRateLimit('5.6.7.8', t0 + 500)).allowed, true)

  // The window rolls over.
  assert.equal((await checkRateLimit('1.2.3.4', t0 + 60_001)).allowed, true)
})

// The papers scope guard used to check the user's question while the tool ran
// the model's rewritten one. coerceArgs accepts any string for that argument,
// so a reformulation walked straight past the check.
const dataset = loadDataset()

test('the guard scopes the question the tool will actually receive', () => {
  const skill = dataset.skillNames[0]
  const routed = guardPapersRouteForTest(
    {
      kind: 'tool',
      name: 'search_board_papers',
      // A rewrite that names structured data, from a question that did not.
      args: { question: `${skill} scores by director` },
      routedBy: 'model',
    },
    'Tell me about our weakest area.',
    TOOLS,
    dataset,
  )
  assert.ok(
    routed.kind !== 'tool' || routed.args.question !== `${skill} scores by director`,
    'the rewritten structured question reached the papers unchecked',
  )
})

test('a rewrite never overrules the reader: the papers are asked what was asked', () => {
  // Where only the rewrite looks structured, the rewrite is the problem. The
  // question goes to the papers in the reader's own words rather than being
  // refused over a word the model chose.
  const question = 'What do the board papers say about our estate?'
  const routed = guardPapersRouteForTest(
    {
      kind: 'tool',
      name: 'search_board_papers',
      args: { question: `${dataset.skillNames[0]} scores` },
      routedBy: 'model',
    },
    question,
    TOOLS,
    dataset,
  )
  assert.equal(routed.kind, 'tool')
  if (routed.kind !== 'tool') return
  assert.equal(routed.name, 'search_board_papers')
  assert.equal(routed.args.question, question)
})

test('a refusal written by a check is not attributed to the model or the classifier', async () => {
  // The UI cannot otherwise tell "the model refused" from "a deterministic
  // check refused", and they are different signals.
  const clock = await routeQuestion("What was attendance like at yesterday's meeting?", TOOLS, [], dataset)
  assert.equal(clock.kind, 'refusal')
  if (clock.kind !== 'refusal') return
  assert.equal(clock.routedBy, 'guard')

  const guarded = guardPapersRouteForTest(
    {
      kind: 'tool',
      name: 'search_board_papers',
      args: { question: `What is ${dataset.skills[0].director_name}'s tenure?` },
      routedBy: 'model',
    },
    `What is ${dataset.skills[0].director_name}'s tenure?`,
    TOOLS,
    dataset,
  )
  if (guarded.kind === 'refusal') assert.equal(guarded.routedBy, 'guard')
})
