import test from 'node:test'
import assert from 'node:assert/strict'

import { resetConfigCache } from '../src/lib/config'
import { loadDataset } from '../src/lib/dataset/loader'
import { isRefusal, type Dataset } from '../src/lib/types'

// Retrieval and the hybrid tools, run end to end with no network.
//
// Everything in this file used to be untestable offline, so it was either not
// tested at all or "tested" behind an early return. The tenure contract in
// particular sat behind
//
//     if (isRefusal(result)) { assert.match(result.reason, /.../); return }
//
// which, with no credentials in the environment, was taken on EVERY run: the
// tool always refused, so the attribution of the limit to a paper, the
// provenance and the check that the listed directors are genuinely at or past
// the limit never executed once. The regex even accepted a tool that refused
// unconditionally. It also made a real HTTP request during `npm test`, so the
// suite meant different things on different machines.
//
// The fix is to run the real code path against a stubbed transport. Nothing in
// src is mocked: searchPapers, findTermLimit, the grounding judge and the
// figure verifier all run for real. Only `fetch` is replaced, so the two
// services the code talks to — the embedding/Vectorize REST API and the model
// — answer deterministically.

// Credentials have to look present, or the code refuses before it computes.
process.env.CF_ACCOUNT_ID = 'test-account'
process.env.CF_API_TOKEN = 'test-token'
process.env.CF_VECTORIZE_INDEX = 'test-index'
process.env.CF_AI_GATEWAY_ID = 'test-gateway'
resetConfigCache()

const realFetch = globalThis.fetch

interface Stub {
  /** One vector per input text. Contents are irrelevant: nothing scores them here. */
  embed?: () => number[][]
  /** The matches Vectorize returns, already carrying their metadata. */
  matches?: () => { id: string; score: number; metadata: Record<string, unknown> }[]
  /** The grounding judge's reply. */
  judge?: () => { answered: boolean; text: string; cite: number[] }
  /** Set to make the transport itself fail, as an unreachable service would. */
  fail?: boolean
}

/** Records what the stub was asked for, so a test can assert a call happened. */
const calls: string[] = []

function installFetch(stub: Stub): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (stub.fail) throw new Error('network is unavailable in this test')

    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    if (url.includes('/ai/run/@cf/baai/')) return ok({ data: (stub.embed ?? (() => [[0]]))() })
    if (url.includes('/vectorize/')) return ok({ matches: (stub.matches ?? (() => []))() })
    if (url.includes('/ai/run/')) {
      assert.ok(stub.judge, `the grounding judge was called unexpectedly: ${url}`)
      return ok({ response: stub.judge!() })
    }
    throw new Error(`unexpected request in a test: ${url}`)
  }) as typeof fetch
}

function restoreFetch(): void {
  globalThis.fetch = realFetch
  calls.length = 0
}

/** A Vectorize match carrying a passage, in the shape search.ts reads. */
function match(
  organisation: string,
  score: number,
  text: string,
  paperId: string,
  paperTitle: string,
  section: string,
) {
  return {
    id: `${paperId}#${section}`,
    score,
    metadata: { text, paperId, paperTitle, section, corpusFloor: 0.5, datasetId: organisation },
  }
}

// --------------------------------------------------------------- the fixture
//
// A synthetic organisation, so the wording of the paper and every tenure figure
// under test is exact and owes nothing to the real dataset. An eight-year limit
// is used deliberately: nine is the conventional figure and would pass a tool
// that had quietly assumed it.

const TERM_LIMIT_PROSE =
  'Trustees may serve a maximum term of eight years. The board reviews this annually.'

function syntheticDataset(prose = TERM_LIMIT_PROSE): Dataset {
  const scores = [
    // name, tenure, Widgetry, Basketry
    ['Ada Lorne', 8.2, 5, 1],
    ['Bo Trenholm', 7.5, 4, 2],
    ['Cass Rideout', 7.0, 2, 5],
    ['Dev Halloran', 2.0, 3, 4],
  ] as const

  return {
    organisation: 'Testshire Trust',
    asAt: '2026-08-31',
    attendance: {
      organisation: 'Testshire Trust',
      period: '',
      generated: '',
      notes: '',
      meetings: [],
      records: [],
      director_summary: [],
    },
    actions: {
      organisation: 'Testshire Trust',
      period: '',
      generated: '',
      as_at: '2026-08-31',
      notes: '',
      actions: [],
    },
    skillNames: ['Widgetry', 'Basketry'],
    skills: scores.map(([director_name, tenure_years, w, b], i) => ({
      director_id: `T0${i + 1}`,
      director_name,
      role: 'Trustee',
      tenure_years,
      scores: { Widgetry: w, Basketry: b },
    })),
    papers: [
      {
        id: 'paper-77',
        filename: 'paper-77.md',
        title: 'Governance review',
        body: `# Testshire Trust\n\n## Governance review\n\n### Terms of office\n\n${prose}`,
      },
    ],
  }
}

function limitMatches(dataset: Dataset, prose: string) {
  const paper = dataset.papers[0]
  return () => [match(dataset.organisation, 0.82, prose, paper.id, paper.title, 'Terms of office')]
}

// ------------------------------------------------- the hybrid tenure contract

test('the term limit is read from a paper, and every consequence is computed', async () => {
  const dataset = syntheticDataset()
  installFetch({ matches: limitMatches(dataset, TERM_LIMIT_PROSE) })
  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('tenure_and_skills_impact')!.run(dataset, { within_months: 12 })

    // No early return. A refusal here is a failure of the contract, not a
    // reason to stop checking it.
    assert.ok(
      !isRefusal(result),
      `expected a computed answer, got a refusal: ${isRefusal(result) ? result.reason : ''}`,
    )
    if (isRefusal(result)) return

    // The limit must be ATTRIBUTED, not assumed. An assumption that silently
    // supplied a conventional nine years would answer confidently from a number
    // nobody wrote down.
    const attribution = result.assumptions.find((a) => /read from/i.test(a))
    assert.ok(attribution, 'the answer must say where the limit came from')
    assert.match(attribution!, /Governance review/)
    assert.ok(
      attribution!.includes('maximum term of eight years'),
      `the sentence the limit was read from must be quoted: ${attribution}`,
    )
    // Eight, not the conventional nine: a tool defaulting to nine would pass a
    // test written against a nine-year paper.
    assert.match(attribution!, /8-year limit/)

    assert.ok(
      result.provenance.sources.includes('paper-77.md'),
      `the paper must be named as a source: ${result.provenance.sources.join(', ')}`,
    )
    assert.ok(result.provenance.sources.includes('skills-audit.csv'))
    assert.match(result.provenance.derivation, /paper-77/)

    // Whoever is listed must genuinely be at or past the limit, computed here
    // from the fixture rather than taken from the answer.
    const limit = Number(attribution!.match(/(\d+)-year limit/)![1])
    const expected = dataset.skills
      .filter((d) => (limit - d.tenure_years) * 12 <= 12)
      .map((d) => d.director_name)
      .sort()
    assert.deepEqual(expected, ['Ada Lorne', 'Bo Trenholm', 'Cass Rideout'])
    const listed = (result.table?.rows ?? []).map((r) => String(r[0])).sort()
    assert.deepEqual(listed, expected)

    // Cass is exactly on the boundary — twelve months left, asked for twelve —
    // and must be inside it, not rounded out.
    const cass = result.table!.rows.find((r) => r[0] === 'Cass Rideout')!
    assert.equal(cass[2], 12)
    assert.equal(cass[3], 'approaching')
    // Ada is past it, and that has to read differently.
    const ada = result.table!.rows.find((r) => r[0] === 'Ada Lorne')!
    assert.equal(ada[3], 'already past the limit')
    assert.match(result.headline, /already past it/)

    // The skills consequence is computed, not narrated. Only Dev remains, so
    // Widgetry loses both its strong directors and Basketry keeps one.
    const widgetry = result.chart!.points.find((p) => p.label === 'Widgetry')!
    assert.deepEqual([widgetry.value, widgetry.value2], [2, 0])
    const basketry = result.chart!.points.find((p) => p.label === 'Basketry')!
    assert.deepEqual([basketry.value, basketry.value2], [2, 1])
    assert.match(result.headline, /nobody at 4 or above in Widgetry/)
  } finally {
    restoreFetch()
  }
})

test('a different limit in the paper moves who is listed', async () => {
  // The same fixture with a three-year limit: everyone reaches it inside the
  // year. If the tool had a limit of its own, this would not change.
  const prose = 'Trustees may serve a maximum term of three years.'
  const dataset = syntheticDataset(prose)
  installFetch({ matches: limitMatches(dataset, prose) })
  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('tenure_and_skills_impact')!.run(dataset, { within_months: 12 })
    assert.ok(!isRefusal(result))
    if (isRefusal(result)) return
    assert.deepEqual(
      (result.table?.rows ?? []).map((r) => String(r[0])).sort(),
      ['Ada Lorne', 'Bo Trenholm', 'Cass Rideout', 'Dev Halloran'],
    )
    assert.match(result.headline, /3-year limit/)
  } finally {
    restoreFetch()
  }
})

// The refusal paths, asserted on their own terms rather than as an escape
// hatch from the test above. Each has to refuse for its OWN reason: a tool that
// refused unconditionally would satisfy either message alone.

test('the tenure tool refuses, and says so precisely, when the papers cannot be reached', async () => {
  const dataset = syntheticDataset()
  installFetch({ fail: true })
  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('tenure_and_skills_impact')!.run(dataset, {})
    assert.ok(isRefusal(result), 'an unreachable service must refuse, not crash or guess')
    if (!isRefusal(result)) return
    assert.match(result.reason, /could not be reached/i)
    // The other refusal's wording would be a lie here: the papers may well
    // state a limit; nobody could look.
    assert.ok(
      !/no board paper states a limit/i.test(result.reason),
      `an outage must not be reported as an absence: ${result.reason}`,
    )
    assert.ok(result.alternative, 'a refusal says what the data can still offer')
  } finally {
    restoreFetch()
  }
})

test('the tenure tool refuses, differently, when the papers state no limit', async () => {
  const prose = 'The board met four times and reviewed the risk register.'
  const dataset = syntheticDataset(prose)
  installFetch({ matches: limitMatches(dataset, prose) })
  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('tenure_and_skills_impact')!.run(dataset, {})
    assert.ok(isRefusal(result))
    if (!isRefusal(result)) return
    assert.match(result.reason, /no board paper states a limit/i)
    assert.ok(
      !/could not be reached/i.test(result.reason),
      `an absence must not be reported as an outage: ${result.reason}`,
    )
  } finally {
    restoreFetch()
  }
})

test('the two refusals do not share a reason', async () => {
  // The old assertion was /could not be reached|no term limit/i, which one
  // unconditional refusal would satisfy for both cases.
  const { getTool } = await import('../src/lib/analytics/registry')
  const tool = getTool('tenure_and_skills_impact')!

  installFetch({ fail: true })
  const outage = await tool.run(syntheticDataset(), {})
  restoreFetch()

  const prose = 'The board met four times.'
  const quiet = syntheticDataset(prose)
  installFetch({ matches: limitMatches(quiet, prose) })
  const absent = await tool.run(quiet, {})
  restoreFetch()

  assert.ok(isRefusal(outage) && isRefusal(absent))
  if (!isRefusal(outage) || !isRefusal(absent)) return
  assert.notEqual(outage.reason, absent.reason)
  assert.notEqual(outage.headline, absent.headline)
})

// ------------------------------------------------------------------- R3
//
// "A topic the action log records but no board paper covers." Until now this
// was exercised only by the smoke suite, which needs a running server, real
// credentials and a live model — so it never ran in CI or on a machine without
// a .env.local.

test('R3: a subject the action log holds but the papers do not is refused, without claiming the data lacks it', async () => {
  const real = loadDataset()

  // The fixture is derived from the data rather than asserted about it: find a
  // word that appears in the action log and in no paper. If the corpus ever
  // grows to cover everything, this test says so instead of quietly passing.
  const paperText = real.papers.map((p) => p.body).join(' ').toLowerCase()
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'been', 'will', 'into', 'each',
    'board', 'committee', 'review', 'report',
  ])
  const subject = real.actions.actions
    .flatMap((a) => a.description.match(/[A-Za-z]{5,}/g) ?? [])
    .map((w) => w.toLowerCase())
    .find((w) => !stop.has(w) && !paperText.includes(w))
  assert.ok(subject, 'expected a subject the action log records and no paper mentions')

  const question = `What do the board papers say about ${subject}?`

  const { chunkPapers } = await import('../src/lib/retrieval/chunk')
  const chunks = chunkPapers(real.papers).slice(0, 6)
  installFetch({
    matches: () =>
      chunks.map((c, i) =>
        match(real.organisation, 0.7 - i * 0.01, c.text, c.paperId, c.paperTitle, c.section),
      ),
    // The judge reads the passages and correctly says the subject is not there.
    judge: () => ({
      answered: false,
      text: `The passages cover the finance report and the estate, and say nothing about ${subject}.`,
      cite: [],
    }),
  })

  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('search_board_papers')!.run(real, { question })

    assert.ok(isRefusal(result), 'the papers do not answer this, so the tool must refuse')
    if (!isRefusal(result)) return

    // The judge's own words are the reason, not a template.
    assert.ok(result.reason.includes(subject!), result.reason)

    // The invariant that matters: a refusal must not claim the DATA lacks the
    // subject when the action log holds it. It must point there instead.
    assert.ok(result.alternative, 'R3 must offer the action log, not a shrug')
    assert.match(result.alternative!, /action log/i)
    assert.ok(
      !/nothing in this dataset|no record of/i.test(result.alternative!),
      `claimed an absence the tool has not checked: ${result.alternative}`,
    )

    // And the subject really is in the action log, or the refusal would be
    // right for the wrong reason.
    assert.ok(
      real.actions.actions.some((a) => a.description.toLowerCase().includes(subject!)),
      'the fixture subject must genuinely appear in the action log',
    )

    // The judge was actually consulted: an off-domain shortcut refusal would
    // pass every assertion above without reading anything.
    assert.ok(
      calls.some((u) => u.includes('/ai/run/') && !u.includes('/ai/run/@cf/baai/')),
      'the grounding judge must have been asked before refusing',
    )
  } finally {
    restoreFetch()
  }
})

test('R3 does not refuse when the papers DO answer', async () => {
  // The counterweight: the refusal above must come from the judge reading the
  // passages, not from the tool refusing whatever it is handed.
  const real = loadDataset()
  const { chunkPapers } = await import('../src/lib/retrieval/chunk')
  const chunks = chunkPapers(real.papers).slice(0, 4)
  installFetch({
    matches: () =>
      chunks.map((c, i) =>
        match(real.organisation, 0.8 - i * 0.01, c.text, c.paperId, c.paperTitle, c.section),
      ),
    // No figures, so nothing for verify.ts to withhold; the point here is only
    // that an answered judgement is reported as an answer.
    judge: () => ({
      answered: true,
      text: 'The papers set out the position and the recommendation the board was asked to approve.',
      cite: [1],
    }),
  })
  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('search_board_papers')!.run(real, {
      question: 'What were the board papers recommending?',
    })
    assert.ok(!isRefusal(result), `expected an answer: ${isRefusal(result) ? result.reason : ''}`)
    if (isRefusal(result)) return
    assert.ok(result.provenance.sources.length > 0)
    assert.ok(result.table!.rows.length > 0, 'an answered question cites its sections')
  } finally {
    restoreFetch()
  }
})

test('a paper index holding another organisation is refused, not answered from', async () => {
  const real = loadDataset()
  installFetch({
    matches: () => [match('Some Other Trust', 0.9, 'Whatever it says.', 'paper-01', 'P', 'S')],
  })
  try {
    const { getTool } = await import('../src/lib/analytics/registry')
    const result = await getTool('search_board_papers')!.run(real, {
      question: 'What do the board papers say about the estate?',
    })
    assert.ok(isRefusal(result))
    if (!isRefusal(result)) return
    assert.match(result.reason, /Some Other Trust/)
  } finally {
    restoreFetch()
  }
})
