import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyAgainstPassages } from '../src/lib/retrieval/verify'
import type { Passage } from '../src/lib/retrieval/search'

// The check exists because of a real answer: "an overspend of £132,000", a
// figure appearing in no paper, reached by subtracting two figures the model
// had been shown. The prompt already forbade arithmetic. A prompt is a request.

const passage = (text: string): Passage => ({
  score: 0.8,
  text,
  paperId: 'paper-01',
  paperTitle: 'Finance Report',
  section: 'Expenditure',
})

const FINANCE = [
  passage(
    'Pay costs were £3.86m, £94,000 above budget. The overspend is entirely in bank and ' +
      'agency nursing, which cost £412,000 in the quarter against a budget of £280,000. ' +
      'Substantive nursing vacancies stood at 11.4 whole time equivalents at 30 June, or ' +
      '14 per cent of the establishment.',
  ),
]

test('quoted figures pass', () => {
  const r = verifyAgainstPassages(
    'Agency nursing cost £412,000 against a budget of £280,000, and pay costs were £3.86m.',
    FINANCE,
  )
  assert.equal(r.ok, true, `unexpectedly rejected: ${r.unsupported.join(', ')}`)
})

test('a figure the model calculated is caught', () => {
  // 412,000 - 280,000. Plausible, useful, and not in the paper.
  const r = verifyAgainstPassages(
    'Agency nursing overspent by £132,000 in the quarter.',
    FINANCE,
  )
  assert.equal(r.ok, false)
  assert.ok(r.unsupported.some((u) => u.includes('132')), r.unsupported.join(', '))
})

test('a figure carried in from outside the passages is caught', () => {
  const r = verifyAgainstPassages('The budget for 2027/28 is £5.20m.', FINANCE)
  assert.equal(r.ok, false)
  assert.ok(r.unsupported.some((u) => u.includes('5.20')))
})

test('formatting differences do not cause a false rejection', () => {
  // £412,000 in the answer against 412,000 in the source, and vice versa.
  const r = verifyAgainstPassages('Agency nursing cost 412000 in the quarter.', FINANCE)
  assert.equal(r.ok, true, r.unsupported.join(', '))
})

test('small counts and ordinals are not treated as figures', () => {
  // "3 papers" or "2 of them" are statements about the answer, not claims about
  // the data, and demanding them verbatim would reject sound answers.
  const r = verifyAgainstPassages(
    'Two of the 3 papers mention nursing vacancies at 11.4 whole time equivalents.',
    FINANCE,
  )
  assert.equal(r.ok, true, r.unsupported.join(', '))
})

test('percentages stated in the passage pass', () => {
  const r = verifyAgainstPassages('Vacancies were 14 per cent of the establishment.', FINANCE)
  assert.equal(r.ok, true, r.unsupported.join(', '))
})

test('an answer with no figures at all passes', () => {
  const r = verifyAgainstPassages(
    'The overspend is entirely in bank and agency nursing.',
    FINANCE,
  )
  assert.equal(r.ok, true)
})
