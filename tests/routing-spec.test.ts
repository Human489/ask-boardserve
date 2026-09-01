import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS } from '../src/lib/analytics/registry'
import { coerceArgsForTest, fallbackRoute, routeQuestion } from '../src/lib/router'

// The questions EXACTLY as they appear in the specification document.
//
// This file exists because the first version of the fallback classifier scored
// three broad subject categories and then took the first tool in the winning
// category, so only three of the twelve tools were reachable. It passed its own
// unit tests because those tests were written in paraphrases that had been
// tuned to the classifier. Routing tests must use the customer's wording, not
// wording chosen to suit the implementation.

const STRUCTURED: [string, string][] = [
  ['Who is below our attendance threshold, and on which committee?', 'attendance_below_threshold'],
  ['Which meetings had unusually low attendance, and when?', 'attendance_by_meeting'],
  ['Which committees have the lowest attendance?', 'attendance_by_committee'],
  [
    'Which directors have missed the most meetings they were eligible to attend?',
    'meetings_missed',
  ],
  ['What actions are overdue, and who owns them?', 'overdue_actions'],
  ['Which overdue actions have been outstanding the longest?', 'longest_overdue'],
  ['Which committee is carrying the most unresolved work?', 'unresolved_by_committee'],
  ['How are outstanding actions distributed across owners or committees?', 'actions_distribution'],
  ['What has been deferred more than once?', 'deferred_more_than_once'],
  ['Where are our biggest skill gaps?', 'skills_gaps'],
  [
    'Which directors provide the strongest coverage for the areas where the board has gaps?',
    'gap_coverage',
  ],
  ['Which committees have the greatest skills gaps?', 'committee_skills_gaps'],
]

const REFUSALS = [
  'How long are our packs, and are they going out with enough notice?',
  'What did we decide in the last 3 meetings, and what happened?',
  'What do the board papers say about our CQC readiness?',
  'How many directors are qualified accountants?',
  'What was the board’s average IQ?',
]

for (const [question, expected] of STRUCTURED) {
  test(`spec wording routes correctly: ${question}`, async () => {
    const route = await routeQuestion(question, TOOLS)
    assert.equal(route.kind, 'tool', `expected a tool, got a refusal for "${question}"`)
    assert.equal(route.kind === 'tool' && route.name, expected)
  })
}

for (const question of REFUSALS) {
  test(`spec wording refuses: ${question}`, async () => {
    const route = await routeQuestion(question, TOOLS)
    assert.equal(route.kind, 'refusal')
  })
}

test('every registered tool is reachable from at least one spec question', async () => {
  const reached = new Set<string>()
  for (const [question] of STRUCTURED) {
    const route = await routeQuestion(question, TOOLS)
    if (route.kind === 'tool') reached.add(route.name)
  }
  const unreachable = TOOLS.map((t) => t.name).filter((n) => !reached.has(n))
  assert.deepEqual(
    unreachable,
    [],
    `these tools cannot be reached by any spec question: ${unreachable.join(', ')}`,
  )
})

test('the IQ refusal does not borrow the qualifications explanation', async () => {
  const route = await routeQuestion('What was the board’s average IQ?', TOOLS)
  assert.equal(route.kind, 'refusal')
  if (route.kind !== 'refusal') return
  // A right refusal with a wrong reason is still a defect.
  assert.ok(
    !/qualification/i.test(route.reason),
    'IQ is not a qualifications question; the reason must not say it is',
  )
})

// Out-of-scope questions must REFUSE rather than reach a plausible-looking
// tool. An audit found the offline classifier answering both of these with a
// full headline, chart and provenance block about an unrelated subject — a
// confidently wrong answer, which is worse than a visible failure.
const MUST_REFUSE_OFFLINE = [
  'Who times out in the next 12 months, and what does that do to the skills matrix?',
  'Are there any directors whose term limit affects committee skills coverage?',
  'Who has served more than nine years on the board?',
  'What is coming next quarter that we have not started preparing for?',
  'What do the board papers say about a particular risk, project or issue?',
  'What concerns or themes recur across recent board papers?',
]

for (const question of MUST_REFUSE_OFFLINE) {
  test(`offline classifier refuses rather than misroutes: ${question.slice(0, 48)}`, () => {
    const route = fallbackRoute(question, TOOLS)
    assert.equal(
      route.kind,
      'refusal',
      `routed to ${route.kind === 'tool' ? route.name : '?'} instead of refusing`,
    )
  })
}

// The model emitted threshold: 0 on three runs in five of the same question,
// so the same question answered differently each time — once against 80% and
// once against a meaningless 0%, both presented with a full headline and
// provenance. Out-of-range numbers are now dropped so the tool's documented
// default applies.
test('out-of-range numeric arguments are dropped, not passed to the tool', () => {
  const tool = TOOLS.find((t) => t.name === 'attendance_below_threshold')!
  assert.equal(coerceArgsForTest(tool, { threshold: 0 }).threshold, undefined)
  assert.equal(coerceArgsForTest(tool, { threshold: -5 }).threshold, undefined)
  assert.equal(coerceArgsForTest(tool, { threshold: 1000 }).threshold, undefined)
  assert.equal(coerceArgsForTest(tool, { threshold: 75 }).threshold, 75)
  // Strings are still coerced, as the model often sends numbers as text.
  assert.equal(coerceArgsForTest(tool, { threshold: '75' }).threshold, 75)
})

test('every numeric tool parameter declares bounds', () => {
  for (const tool of TOOLS) {
    for (const [name, param] of Object.entries(tool.parameters)) {
      if (param.type !== 'number') continue
      assert.ok(
        param.min !== undefined && param.max !== undefined,
        `${tool.name}.${name} has no bounds, so the model can send a meaningless value`,
      )
    }
  }
})
