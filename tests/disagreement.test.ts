import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from '../src/lib/dataset/loader'
import { disagreementsFor, findDisagreements } from '../src/lib/retrieval/disagreement'
import { getTool } from '../src/lib/analytics/registry'
import { isRefusal } from '../src/lib/types'

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
