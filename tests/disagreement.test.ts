import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from '../src/lib/dataset/loader'
import { disagreementsFor, findDisagreements } from '../src/lib/retrieval/disagreement'
import { getTool } from '../src/lib/analytics/registry'
import { findTermLimit } from '../src/lib/retrieval/termlimit'
import type { Passage } from '../src/lib/retrieval/search'
import { isRefusal, type Dataset } from '../src/lib/types'

// The papers restate figures from the skills audit in prose, and some are
// wrong. Preferring the computed number silently is the wrong product: a
// secretary reading one figure in a paper and another here needs to know they
// disagree, and that a paper is wrong is a governance finding in itself.

const dataset = loadDataset()

test('the papers contradicting the audit are found, with both values', () => {
  const found = findDisagreements(dataset)
  assert.ok(found.length > 0, 'this corpus contains known contradictions')

  for (const d of found) {
    // Every claim must be attributable to a real column, or it is a guess.
    assert.ok(dataset.skillNames.includes(d.skill), `${d.skill} is not a column`)
    assert.notEqual(d.paperSays, d.dataSays, 'agreement is not a disagreement')

    // The figure attributed to the data must be the figure in the data.
    const scores = dataset.skills.map((row) => row.scores[d.skill])
    const actual = d.measure.includes('above')
      ? scores.filter((n) => n >= 4).length
      : scores.filter((n) => n <= 2).length
    assert.equal(d.dataSays, actual, `${d.skill} ${d.measure}`)

    // The paper is quoted, so the accusation can be checked.
    assert.ok(d.sentence.length > 15)
    assert.ok(d.paperId.startsWith('paper-'))
  }
})

test('a skill with no contradiction raises none', () => {
  const all = findDisagreements(dataset)
  const contested = new Set(all.map((d) => d.skill))
  const clean = dataset.skillNames.find((s) => !contested.has(s))
  assert.ok(clean, 'expected at least one uncontested skill')
  assert.deepEqual(disagreementsFor(dataset, [clean!]), [])
})

test('skills_gaps reports the disagreement rather than quietly winning', () => {
  const contested = findDisagreements(dataset)[0]
  const result = getTool('skills_gaps')!.run(dataset, { skill: contested.skill })
  assert.ok(!(result instanceof Promise))
  const r = result as Exclude<typeof result, Promise<unknown>>
  assert.ok(!isRefusal(r))
  if (isRefusal(r)) return

  const flagged = r.caveats.filter((c) => /disagrees with the audit/i.test(c))
  assert.equal(flagged.length, 1, 'the conflict must be surfaced')
  // Both numbers, so the reader can judge.
  assert.ok(flagged[0].includes(String(contested.paperSays)), flagged[0])
  assert.ok(flagged[0].includes(String(contested.dataSays)), flagged[0])
  // And the paper named as a source, since it was consulted.
  assert.ok(r.provenance.sources.some((s) => s.startsWith('paper-')))
})

test('an uncontested skill produces no conflict caveat', () => {
  const contested = new Set(findDisagreements(dataset).map((d) => d.skill))
  const clean = dataset.skillNames.find((s) => !contested.has(s))!
  const result = getTool('skills_gaps')!.run(dataset, { skill: clean })
  const r = result as Exclude<typeof result, Promise<unknown>>
  if (isRefusal(r)) return
  assert.equal(r.caveats.filter((c) => /disagrees with the audit/i.test(c)).length, 0)
})

// ------------------------------------------------------- reading prose safely
//
// Both modules below read a fact out of a sentence by pattern. Neither can ask
// a model, because the number they return drives every figure on the screen.
// The failure that matters is not missing a claim; it is reading the wrong
// number out of a sentence and dressing it as a finding.

/** A dataset made of one invented paper, so the wording under test is exact. */
function datasetSaying(prose: string, scores: number[]): Dataset {
  return {
    skillNames: ['Widgetry'],
    skills: scores.map((n, i) => ({
      director_name: `Director ${i + 1}`,
      role: 'Trustee',
      tenure_years: 1,
      scores: { Widgetry: n },
    })),
    papers: [
      {
        id: 'paper-99',
        filename: 'paper-99.md',
        title: 'Test paper',
        body: `# Org\n\n## Test paper\n\n### Section\n\n${prose}`,
      },
    ],
  } as unknown as Dataset
}

test('the claimed count is the one the sentence opens with, not the nearest word', () => {
  // "Three of the twelve trustees" captured "twelve", so the caveat accused the
  // paper of saying 12 where it had said three. A false accusation against a
  // paper is worse than a missed one.
  const dataset = datasetSaying(
    'Widgetry remains weak. Three of the twelve trustees score 2 or below on Widgetry.',
    [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  )
  const found = findDisagreements(dataset)
  assert.equal(found.length, 1)
  assert.equal(found[0].paperSays, 3, `captured "${found[0].sentence}" as ${found[0].paperSays}`)
  assert.equal(found[0].dataSays, 0)
})

test('a claim the paper gets right raises nothing, however it is phrased', () => {
  const dataset = datasetSaying(
    'Three of the twelve trustees score 2 or below on Widgetry.',
    [1, 1, 1, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  )
  assert.deepEqual(findDisagreements(dataset), [])
})

test('"half the board" on an odd board accuses nobody of saying seven and a half', () => {
  const odd = datasetSaying('Half the Board scores 2 or below on Widgetry.', [5, 5, 5, 5, 5])
  assert.deepEqual(findDisagreements(odd), [], 'half of five directors is not a count')

  // An even board still resolves, because there the claim is a whole number.
  const even = datasetSaying('Half the Board scores 2 or below on Widgetry.', [5, 5, 5, 5])
  assert.equal(findDisagreements(even)[0]?.paperSays, 2)
})

function passage(text: string): Passage {
  return { score: 1, text, paperId: 'paper-99', paperTitle: 'Test paper', section: 'Section' }
}

test('a plain statement of a term limit is read', () => {
  for (const [prose, years] of [
    ['Trustees may serve a maximum term of nine years.', 9],
    ['The board operates a six-year term limit.', 6],
    ['Trustees may serve up to 12 years.', 12],
  ] as const) {
    const found = findTermLimit([passage(prose)])
    assert.equal(found?.years, years, prose)
  }
})

test('a sentence that counts terms as well as years extracts nothing', () => {
  // "Three terms of three years" is a nine-year lifetime stated in two numbers.
  // Reading the three would produce a fully-dressed wrong answer — a chart, a
  // table, and an assumption quoting this very sentence as its authority.
  // Multiplying them would be inventing a rule the paper did not state.
  for (const prose of [
    'Trustees may serve three terms of three years.',
    'A trustee may serve two consecutive terms of four years.',
    'Trustees are appointed for a maximum term of three years, renewable twice.',
    'The maximum term of three years may be renewed.',
  ]) {
    assert.equal(findTermLimit([passage(prose)]), null, prose)
  }
})
