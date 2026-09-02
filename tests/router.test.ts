import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOLS } from '../src/lib/analytics/registry'
import { resetConfigCache } from '../src/lib/config'
import { checkRateLimit, resetRateLimits } from '../src/lib/ratelimit'
import { fallbackRoute } from '../src/lib/router'

// Only the fallback classifier is tested. The model path is non-deterministic
// and needs credentials; the fallback is what must hold when it is unavailable.

// The twelve structured questions from docs/question-set.md, Q1-Q12.
// Expectations name the TOOL, not a subject area. An earlier version asserted
// only that the question reached the first tool whose name matched the subject
// stem, which every question did regardless of whether the routing was right.
const STRUCTURED: { q: string; tool: string }[] = [
  { q: 'Who is below our attendance threshold, and on which committees?', tool: 'attendance_below_threshold' },
  {
    q: "Were there meetings, or a period, where attendance was materially below the year's norm — and is any apparent movement bigger than one meeting's noise?",
    tool: 'attendance_by_meeting',
  },
  {
    q: 'Which committees have the lowest attendance, and is the ranking robust given how few times each met?',
    tool: 'attendance_by_committee',
  },
  {
    q: 'Which directors have missed the most meetings they were eligible to attend, and how many of those were without any advance notice?',
    tool: 'meetings_missed',
  },
  { q: 'What actions are overdue, and who owns them?', tool: 'overdue_actions' },
  { q: 'Which overdue actions have been outstanding the longest?', tool: 'longest_overdue' },
  { q: 'Which committee is carrying the most unresolved work?', tool: 'unresolved_by_committee' },
  {
    q: 'How is outstanding work distributed, and is it concentrated in any one owner, or on the board rather than the executive?',
    tool: 'actions_distribution',
  },
  { q: 'What has been deferred more than once?', tool: 'deferred_more_than_once' },
  {
    q: 'Which skills have the fewest directors at 4 or above, how many are at 2 or below, and how concentrated is our coverage?',
    tool: 'skills_gaps',
  },
  {
    q: 'Which directors provide the strongest coverage for the areas where the board has gaps?',
    tool: 'gap_coverage',
  },
  { q: 'Which committees have the greatest skills gaps?', tool: 'committee_skills_gaps' },
]

// R1-R5.
const REFUSALS = [
  'How long are our packs, and are they going out with enough notice?',
  'What did we decide in the last three meetings, and what happened?',
  'How many directors are qualified accountants?',
  "What was the board's average IQ?",
]

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

test('the 21st request in a window is denied with a sane Retry-After', () => {
  process.env.RATE_LIMIT_PER_MINUTE = '20'
  resetConfigCache()
  resetRateLimits()

  const t0 = 1_700_000_000_000
  for (let i = 0; i < 20; i++) {
    const r = checkRateLimit('1.2.3.4', t0 + i * 10)
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`)
    assert.equal(r.remaining, 19 - i)
  }

  const denied = checkRateLimit('1.2.3.4', t0 + 500)
  assert.equal(denied.allowed, false)
  assert.equal(denied.remaining, 0)
  assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60)

  // A different IP has its own window.
  assert.equal(checkRateLimit('5.6.7.8', t0 + 500).allowed, true)

  // The window rolls over.
  assert.equal(checkRateLimit('1.2.3.4', t0 + 60_001).allowed, true)
})
