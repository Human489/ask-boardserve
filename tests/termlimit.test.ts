import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from '../src/lib/dataset/loader'
import { findTermLimit } from '../src/lib/retrieval/termlimit'
import type { Passage } from '../src/lib/retrieval/search'

// A term limit is read from prose and then used as an authority: the tenure
// tool reports who has served longer than it, quoting the sentence it came
// from. So a misreading does not look like a bug — it looks like a finding.
//
// The misreading found by audit: "Each trustee is appointed for a term of three
// years. Re-appointment is at the discretion of the Board." yielded 3, and
// every trustee past their third year was reported as timing out. The guard
// against exactly that already existed, but it only looked at the sentence the
// figure sat in, and the clause that makes three years a per-term length was in
// the next one.
//
// The opposite failure is just as bad and was also present: a bare match on
// "renewable" discarded "the nine year limit is not renewable", which states a
// lifetime cap in as many words. Withholding it leaves the tool refusing
// forever, which reads as the data being absent when it is not.
//
// Both directions are pinned here, because a fix for one is the natural way to
// break the other.

function passage(text: string): Passage {
  return { score: 0.9, text, paperId: 'paper-01', paperTitle: 'Governance', section: 'Tenure' }
}

function yearsIn(text: string): number | null {
  return findTermLimit([passage(text)])?.years ?? null
}

test('a renewable term is a term length, not a lifetime cap', () => {
  const ambiguous = [
    // The audit's case: the renewal clause is a sentence away.
    'Each trustee is appointed for a term of three years. Re-appointment is at the discretion of the Board.',
    'Trustees are appointed for a term of three years. A trustee may be re-appointed twice.',
    // Stated before the figure rather than after it.
    'Re-appointment is at the Board\u2019s discretion. Trustees serve a term of three years.',
    'Trustees may serve three terms of three years.',
    'Trustees serve a term of four years, renewable once.',
    'Trustees serve a term of three years, which may be renewed.',
  ]
  for (const text of ambiguous) {
    assert.equal(yearsIn(text), null, `should say nothing about: ${text}`)
  }
})

test('a plainly stated cap is still read', () => {
  // Including the ones that state the cap by ruling renewal out.
  assert.equal(yearsIn('The nine year limit is not renewable.'), 9)
  assert.equal(yearsIn('The nine year limit is non-renewable.'), 9)
  assert.equal(yearsIn('Trustees may serve a maximum of nine years in total.'), 9)
  assert.equal(yearsIn('Trustees may serve no more than twelve years.'), 12)
  assert.equal(yearsIn('The maximum term of nine years applies to all trustees.'), 9)
})

test('the sentence it was read from is carried, so a reader can check it', () => {
  const found = findTermLimit([passage('The nine year limit is not renewable.')])
  assert.ok(found)
  assert.match(found.sentence, /nine year limit/)
  assert.equal(found.paperId, 'paper-01')
})

test('the real corpus still yields its stated limit', () => {
  // Pinned, so a guard tightened against the ambiguous cases above cannot
  // quietly stop reading the limit this dataset actually states.
  const dataset = loadDataset()
  const found = findTermLimit(dataset.papers.map((paper) => passage(paper.body)))
  assert.ok(found, 'the corpus states a term limit and it must still be found')
  assert.equal(found.years, 9)
})
