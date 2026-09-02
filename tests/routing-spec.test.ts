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
  for (const question of [...STRUCTURED.map((s) => s[0]), ...DOCUMENT_QUESTIONS, ...HYBRID_QUESTIONS]) {
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
  'What is coming next quarter that we have not started preparing for?',
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

// Q13 and Q14 of the specification are document questions. They must reach the
// retrieval tool rather than be refused by keyword — whether the papers cover
// the subject is judged by the tool, with the passages in front of it.
// Spec Q15 is hybrid: the term limit is prose in a paper, the tenure is a CSV
// column, and neither source answers it alone. It used to refuse because no
// tool could combine them.
const HYBRID_QUESTIONS = [
  'Who times out in the next 12 months, and what does that do to the skills matrix?',
  'Are there any directors whose term limit affects committee skills coverage?',
  'Who has served more than nine years on the board?',
]

for (const question of HYBRID_QUESTIONS) {
  test(`hybrid question reaches the tenure tool: ${question.slice(0, 44)}`, () => {
    const route = fallbackRoute(question, TOOLS)
    assert.equal(route.kind, 'tool', 'a hybrid question must no longer be refused by keyword')
    if (route.kind !== 'tool') return
    assert.equal(route.name, 'tenure_and_skills_impact')
  })
}

const DOCUMENT_QUESTIONS = [
  'What do the board papers say about a particular risk, project or issue?',
  'What concerns or themes recur across recent board papers?',
  'What do the board papers say about our CQC readiness?',
]

for (const question of DOCUMENT_QUESTIONS) {
  test(`document question reaches retrieval: ${question.slice(0, 48)}`, () => {
    const route = fallbackRoute(question, TOOLS)
    assert.equal(route.kind, 'tool', 'a document question must not be refused by keyword')
    if (route.kind !== 'tool') return
    assert.equal(route.name, 'search_board_papers')
    // The tool needs the user's own wording, not a summary of it.
    assert.equal(route.args.question, question)
  })
}

test('the CQC question is no longer refused for the wrong reason', () => {
  // It used to pass because retrieval was unbuilt, so it would have kept passing
  // once retrieval landed while no longer testing anything. It now routes to the
  // papers, and the refusal has to come from reading them.
  const route = fallbackRoute('What do the board papers say about our CQC readiness?', TOOLS)
  assert.equal(route.kind, 'tool')
})

test('the offline classifier cannot spot a document question that names no document', () => {
  // A known limit, asserted so it is not mistaken for a regression. "Why did the
  // hospice close the Ashcombe unit?" is answered by paper-02, but nothing in the
  // wording says so — the giveaway would be "Ashcombe", and matching on an
  // organisation's own vocabulary is exactly the hard-coding that stops a second
  // dataset loading unchanged. The model path handles these; the keyword
  // fallback cannot — but it fails safe, refusing rather than answering from a
  // structured tool that shares a word with the question.
  const route = fallbackRoute('Why did the hospice close the Ashcombe unit?', TOOLS)
  assert.equal(route.kind, 'refusal', 'must refuse rather than reach an unrelated tool')
})
