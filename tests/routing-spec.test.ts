import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS } from '../src/lib/analytics/registry'
import { coerceArgsForTest, fallbackRoute, routeQuestion } from '../src/lib/router'
import {
  SPEC_DOCUMENT,
  SPEC_HYBRID,
  SPEC_REFUSALS,
  SPEC_STRUCTURED,
  SPEC_UPCOMING,
} from './spec-questions'

// The questions EXACTLY as they appear in the specification document, routed
// through the real entry point.
//
// This file exists because the first version of the fallback classifier scored
// three broad subject categories and then took the first tool in the winning
// category, so only three of the twelve tools were reachable. It passed its own
// unit tests because those tests were written in paraphrases that had been
// tuned to the classifier. Routing tests must use the customer's wording, not
// wording chosen to suit the implementation.
//
// And it had drifted back into exactly that. Several entries here were shorter
// rewrites of the spec — "Which meetings had unusually low attendance, and
// when?" for a question that in fact asks whether a movement is bigger than one
// meeting's noise — while the verbatim wordings sat in tests/router.test.ts,
// which only ever calls fallbackRoute. The wording now lives once, in
// tests/spec-questions.ts, and is asserted here through routeQuestion (the
// function the API actually calls) and in router.test.ts through fallbackRoute
// (the path that must hold with no credentials).

const STRUCTURED: [string, string][] = SPEC_STRUCTURED.map((s) => [s.q, s.tool])
const REFUSALS = SPEC_REFUSALS

for (const [question, expected] of STRUCTURED) {
  test(`spec wording routes correctly: ${question.slice(0, 56)}`, async () => {
    const route = await routeQuestion(question, TOOLS)
    assert.equal(route.kind, 'tool', `expected a tool, got a refusal for "${question}"`)
    assert.equal(route.kind === 'tool' && route.name, expected)
  })
}

for (const question of REFUSALS) {
  test(`spec wording refuses: ${question.slice(0, 56)}`, async () => {
    const route = await routeQuestion(question, TOOLS)
    assert.equal(route.kind, 'refusal')
    if (route.kind !== 'refusal') return
    assert.ok(route.reason.length > 20, 'a refusal must say why, specifically')
  })
}

test('every registered tool is reachable from at least one spec question', async () => {
  const reached = new Set<string>()
  for (const question of [...STRUCTURED.map((s) => s[0]), ...DOCUMENT_QUESTIONS, ...HYBRID_QUESTIONS, ...UPCOMING_QUESTIONS]) {
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
const MUST_REFUSE_OFFLINE: string[] = [
  // The tenure and forward-looking questions that once had to be refused by
  // keyword now have tools, and are asserted in HYBRID_QUESTIONS and
  // UPCOMING_QUESTIONS instead.
  //
  // These are the misroutes a single generic hint word used to produce. Each
  // scored exactly 1 on one bare word and cleared the refusal threshold, then
  // answered a different question with a full chart: "when" reached the
  // attendance-by-meeting trend, "longest" the oldest overdue action. Nothing
  // in the data speaks to either question, and refusing is the designed
  // behaviour.
  'When did the finance committee last meet?',
  'Which director has the longest commute?',
  'Which month were the offices repainted?',
  'Who is absent from the staff car park most often?',
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
  const tool = TOOLS.find((t) => t.name === 'attendance_vs_threshold')!
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
const HYBRID_QUESTIONS = SPEC_HYBRID

for (const question of HYBRID_QUESTIONS) {
  test(`hybrid question reaches the tenure tool: ${question.slice(0, 44)}`, () => {
    const route = fallbackRoute(question, TOOLS)
    assert.equal(route.kind, 'tool', 'a hybrid question must no longer be refused by keyword')
    if (route.kind !== 'tool') return
    assert.equal(route.name, 'tenure_and_skills_impact')
  })
}

// Spec Q16, the other hybrid: due dates from the action log, plus promises made
// in paper prose that never became actions.
const UPCOMING_QUESTIONS = SPEC_UPCOMING

for (const question of UPCOMING_QUESTIONS) {
  test(`hybrid question reaches the upcoming tool: ${question.slice(0, 44)}`, () => {
    const route = fallbackRoute(question, TOOLS)
    assert.equal(route.kind, 'tool')
    if (route.kind !== 'tool') return
    assert.equal(route.name, 'upcoming_unprepared')
  })
}

const DOCUMENT_QUESTIONS = SPEC_DOCUMENT

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

// Weakening single generic hints so "when" and "longest" could not carry a
// route on their own also silenced honest questions built on one word —
// "who was absent most often?" and "how many apologies were given?" started
// refusing. Refusing over misrouting is the right trade, but refusing a
// question the product exists to answer is not; both halves are pinned here so
// a future tightening cannot quietly take the second one with it.
const MUST_STILL_ROUTE: [string, string][] = [
  // "who was absent most often?" is deliberately absent from this list: see the
  // comment on the meetings_missed hints. It refuses offline, on purpose.
  ['who was absent from meetings most often?', 'meetings_missed'],
  ['how many apologies were given?', 'meetings_missed'],
  ['which month had the lowest attendance?', 'attendance_by_meeting'],
  ['is the work concentrated on one person?', 'actions_distribution'],
  ['how many meetings did each committee hold?', 'attendance_by_committee'],
]

for (const [question, expected] of MUST_STILL_ROUTE) {
  test(`a natural question still reaches a tool offline: "${question}"`, async () => {
    const routed = await routeQuestion(question, TOOLS)
    assert.notEqual(
      routed.kind,
      'refusal',
      `refused a question the product answers: ${
        routed.kind === 'refusal' ? routed.reason : ''
      }`,
    )
    if (routed.kind === 'tool') assert.equal(routed.name, expected)
  })
}

// A refusal must say what no TOOL computes, never that the data lacks
// something it holds — and it must not fire on a question that stands alone.
// Each of these was refused by the code as written, and each is answerable.
const WRONGLY_REFUSED: [string, string][] = [
  // "how long are our" was meant for board packs and caught this too.
  ['How long are our overdue actions outstanding?', 'overdue_actions'],
  // A bare "age" refused this; due dates and completion dates are recorded.
  ['What is the average age of an overdue action?', 'overdue_actions'],
  // The fragment guard used LENGTH as its discriminator, so a question that
  // names its own subject was told it had nothing to refine.
  ['What about overdue actions?', 'overdue_actions'],
  ['Just show me the skills gaps', 'skills_gaps'],
  ['How about the skills gaps?', 'skills_gaps'],
  // 'defer' was absent from the unambiguous set, so this scored half a point.
  ['What has been deferred?', 'deferred_actions'],
]

for (const [question, expected] of WRONGLY_REFUSED) {
  test(`answerable, so not refused: "${question}"`, async () => {
    const routed = await routeQuestion(question, TOOLS)
    assert.notEqual(
      routed.kind,
      'refusal',
      `refused a question a tool answers: ${routed.kind === 'refusal' ? routed.reason : ''}`,
    )
    if (routed.kind === 'tool') assert.equal(routed.name, expected)
  })
}

// The guards those fixes loosened must still hold.
const STILL_REFUSED = [
  'How long are our board packs?',
  'What are the directors paid?',
  'and at 90%?',
  'what about it?',
  'Who is absent from the staff car park most often?',
  'which director has the longest commute?',
]

for (const question of STILL_REFUSED) {
  test(`still refused: "${question}"`, async () => {
    const routed = await routeQuestion(question, TOOLS)
    assert.equal(routed.kind, 'refusal')
  })
}

// A subject the data does not measure must be refused whatever route was
// chosen — including by the model.
//
// The check existed and ran only inside the offline fallback, so the model
// path walked past it: "How diverse is the board?" was answered with a skills
// chart. There are no protected characteristics anywhere in the dataset, so
// answering a diversity question from self-assessed skill scores is a
// plausible wrong answer on the subject where being wrong in front of a board
// is worst.
const UNMEASURED_QUESTIONS = [
  'How diverse is the board?',
  'How diverse is our board in terms of background?',
  'What is the gender split of the board?',
  'What is the ethnic makeup of the trustees?',
  'Do we have any directors with a disability?',
  'What nationalities are represented on the board?',
  'What is the average age of our board?',
  'How much are we paying our directors?',
]

for (const question of UNMEASURED_QUESTIONS) {
  test(`refused as unmeasured: "${question.slice(0, 46)}"`, async () => {
    const routed = await routeQuestion(question, TOOLS)
    assert.equal(
      routed.kind,
      'refusal',
      `answered a question the data cannot measure: ${routed.kind === 'tool' ? routed.name : ''}`,
    )
  })
}

test('the unmeasured guard does not swallow a real skills question', async () => {
  // Over-refusing here would be its own failure: these are answerable.
  for (const question of [
    'Where are our biggest skill gaps?',
    'Which committees have the greatest skills gaps?',
    'Who is below our attendance threshold, and on which committees?',
  ]) {
    const routed = await routeQuestion(question, TOOLS)
    assert.notEqual(routed.kind, 'refusal', `wrongly refused: ${question}`)
  }
})
