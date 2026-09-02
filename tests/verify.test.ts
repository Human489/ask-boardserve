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

test('a figure ending a sentence is not rejected for its full stop', () => {
  // "£412,000." captured the full stop, normalised to "412000." and matched
  // nothing — rejecting a correct, properly sourced answer.
  const r = verifyAgainstPassages('The unit cost £412,000.', FINANCE)
  assert.equal(r.ok, true, r.unsupported.join(', '))
})

test('a figure followed by a comma is not rejected either', () => {
  const r = verifyAgainstPassages('Pay costs were £3.86m, above budget.', FINANCE)
  assert.equal(r.ok, true, r.unsupported.join(', '))
})

// Figures are checked against the CITED passages, not everything retrieved. A
// computed number otherwise slips through whenever it coincides with an
// unrelated figure elsewhere in the corpus.
const OTHER = passage(
  'Legacy income for the quarter was £610,000 against a budget of £890,000.',
)

test('a computed figure is caught even when it appears in an uncited passage', () => {
  // 890,000 - 610,000 = 280,000. That number IS in FINANCE, as the agency
  // nursing budget — a different subject entirely. Checking against everything
  // retrieved let it through.
  const answer = 'Legacy income fell short of budget by £280,000.'
  const loose = verifyAgainstPassages(answer, [...FINANCE, OTHER])
  assert.equal(loose.ok, true, 'checking against every passage lets this through')

  const scoped = verifyAgainstPassages(answer, [...FINANCE, OTHER], [OTHER])
  assert.equal(scoped.ok, false, 'checking against the cited passage catches it')
  assert.ok(scoped.unsupported.some((u) => u.includes('280')))
})

test('a citation carrying none of the quoted figures is flagged', () => {
  const answer = 'Legacy income was £610,000 against a budget of £890,000.'
  const r = verifyAgainstPassages(answer, [...FINANCE, OTHER], [OTHER, ...FINANCE])
  assert.equal(r.ok, true, 'the figures themselves are sound')
  assert.ok(
    r.unsupportedCitations.some((c) => c.includes('Expenditure')),
    `expected the expenditure citation flagged, got ${r.unsupportedCitations.join(', ')}`,
  )
})

test('a single citation is never flagged as unsupported', () => {
  // With one citation there is nothing to choose between, and flagging it would
  // strip the only reference the reader has.
  const r = verifyAgainstPassages('Agency nursing cost £412,000.', FINANCE, FINANCE)
  assert.deepEqual(r.unsupportedCitations, [])
})

test('a narrative answer with no figures flags no citations', () => {
  const r = verifyAgainstPassages(
    'The overspend is entirely in bank and agency nursing.',
    [...FINANCE, OTHER],
    [OTHER, ...FINANCE],
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.unsupportedCitations, [], 'a section can be cited for what it says')
})
