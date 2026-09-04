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

// ---------------------------------------------------------------------------
// Two holes found by audit. Both let an invented figure through while the
// answer carried a caveat telling the reader its figures had been checked.

test('a percentage the model calculated is caught', () => {
  // The gap: only numbers with 4+ digits, a decimal or a magnitude suffix were
  // checked, so a two-digit percentage was never looked at — and a percentage
  // is exactly what a model computes from two numbers it was shown.
  const passages = [
    passage('Board attendance was 96% in March and 82% in July.'),
  ]
  const check = verifyAgainstPassages(
    'Attendance fell by 14 per cent between the two meetings.',
    passages,
    passages,
  )
  assert.equal(check.ok, false)
  assert.ok(
    check.unsupported.some((f) => f.includes('14')),
    `expected 14 to be unsupported, got ${JSON.stringify(check.unsupported)}`,
  )
})

test('a small money figure that appears nowhere is caught', () => {
  const passages = [passage('The transport budget is £4,200 for the year.')]
  const check = verifyAgainstPassages('The shortfall is £12.', passages, passages)
  assert.equal(check.ok, false)
})

test('a figure is not supported by being a digit-substring of a larger one', () => {
  // The gap: matching was `includes()` against the concatenated passages, so
  // 12000 verified against 112000 — a different number, about a different
  // thing, in the same corpus.
  const passages = [passage('The agency nursing budget is £112,000 for the year.')]
  const check = verifyAgainstPassages('The overspend is £12,000.', passages, passages)
  assert.equal(check.ok, false)
  assert.ok(
    check.unsupported.some((f) => f.includes('12,000')),
    `expected £12,000 to be unsupported, got ${JSON.stringify(check.unsupported)}`,
  )
})

test('a percentage written differently from the passage still passes', () => {
  // The widened check must not reject sound answers: a paper writes 14%, an
  // answer may write "14 per cent", and those are the same claim.
  const passages = [passage('Deferred actions rose to 14% of the log.')]
  const check = verifyAgainstPassages(
    'Deferred actions reached 14 per cent of the log.',
    passages,
    passages,
  )
  assert.equal(check.ok, true, JSON.stringify(check.unsupported))
})

test('a magnitude suffix is part of the claim', () => {
  // £4.61m and 4.61 are different assertions; the suffix cannot be dropped
  // when comparing.
  const passages = [passage('The ratio moved to 4.61 over the period.')]
  const check = verifyAgainstPassages('Income was £4.61m.', passages, passages)
  assert.equal(check.ok, false)
})

test('bare small integers are still not treated as claims', () => {
  // The reason for the original threshold, which the widening had to preserve:
  // "the 3 papers" is not a finding, and demanding it appear verbatim would
  // reject sound answers.
  const passages = [passage('The Board considered the finance and service reports.')]
  const check = verifyAgainstPassages(
    'The 2 reports were considered together, in section 3.',
    passages,
    passages,
  )
  assert.equal(check.ok, true, JSON.stringify(check.unsupported))
})

// ---------------------------------------------------------------------------
// A figure's identity is how much, of what, and which way. Dropping any part of
// that let an invented number verify against an unrelated one; dropping the
// SCALE made sound answers fail, which is the over-strictness that killed an
// earlier check here. Both directions are pinned.

const IDENTITY: [label: string, passage: string, answer: string, ok: boolean][] = [
  // A model computing a percentage from numbers it was shown is the likeliest
  // fabrication, and it used to verify against any bare number with the digits.
  ['a percentage invented from a bare number', 'an average of 3.1 travel more than twelve miles', 'attendance per session fell by 3.1 per cent', false],
  ['money invented from a bare year', 'the 2026 plan was approved', 'the shortfall was £2,026', false],
  ['a percentage invented from an action number', 'action 82 remains open', 'attendance was 82%', false],
  ['a sign inversion', 'Income was £4.61m', 'The variance was -£4.61m', false],
  ['a digit-substring of a larger figure', 'the agency nursing budget is £112,000', 'the overspend is £12,000', false],

  // Sound answers that must not be withheld.
  ['a scale spelled out', 'Income was £4.61 million', 'Income was £4.61m', true],
  ['a k against a comma-grouped figure', 'Pay was £412,000 above budget', 'Pay was £412k above budget', true],
  ['a percentage written differently', 'Deferred actions rose to 14%', 'Deferred actions reached 14 per cent', true],
  ['a cross-reference, which is not a figure', 'The case for change is set out plainly.', 'Section 4.2 sets out the case.', true],
  ['a bare number where the source gave a unit', 'Attendance was 96%', 'Attendance was 96 that month', true],
]

for (const [label, text, answer, ok] of IDENTITY) {
  test(`figure identity: ${label}`, () => {
    const passages = [passage(text)]
    const check = verifyAgainstPassages(answer, passages, passages)
    assert.equal(
      check.ok,
      ok,
      ok
        ? `a sound answer was withheld: ${check.unsupported.join(', ')}`
        : `an unsupported figure passed: ${answer}`,
    )
  })
}

test('a bare number may lose its unit but never gain one', () => {
  // The asymmetry is the point. Dropping "%" understates; adding it invents.
  const passages = [passage('Attendance was 96%')]
  assert.equal(verifyAgainstPassages('Attendance was 96', passages, passages).ok, true)

  const bare = [passage('There were 96 apologies')]
  assert.equal(verifyAgainstPassages('Attendance was 96%', bare, bare).ok, false)
})

test('a hyphen between digits is a range, not a minus sign', () => {
  // A false withhold, which is the exact over-strictness that killed the
  // previous version of this check. The opener group matched the hyphen inside
  // a range, so "82-96%" registered a NEGATIVE 96 that matched nothing: a
  // correctly-sourced answer was suppressed and its citation flagged
  // unsupported.
  const ranged = [passage('Attendance ranged from 82% to 96% across the year.')]
  const result = verifyAgainstPassages('Attendance ranged 82-96%.', ranged, ranged)
  assert.equal(result.ok, true, `withheld a sourced answer: ${result.unsupported.join(', ')}`)
  assert.deepEqual(result.unsupportedCitations, [])
})

test('both ends of a range are checked, not just the one carrying the unit', () => {
  // The mirror of the bug above, and the more dangerous half. In "82-96%" the
  // 82 parsed as a bare integer, and a bare small integer is deliberately not
  // treated as a claim — "the 3 papers" is not a finding — so an answer could
  // widen a range downwards and only its upper bound was ever verified.
  const upperOnly = [passage('Attendance was 96% in the second half.')]
  const result = verifyAgainstPassages('Attendance ranged 82-96%.', upperOnly, upperOnly)
  assert.equal(result.ok, false, 'an invented lower bound must be caught')
})

test('a range in the passage supports a point inside it', () => {
  // "£3-4m" is three to four MILLION pounds. Reading the 3 as three pounds, or
  // the 4 as a unitless four million, would fail a correct answer.
  const band = [passage('The range was £3-4m last year.')]
  assert.equal(verifyAgainstPassages('Costs were £4m.', band, band).ok, true)
  assert.equal(verifyAgainstPassages('Costs were £3m.', band, band).ok, true)
  assert.equal(verifyAgainstPassages('Costs were £9m.', band, band).ok, false)
})

test('a real negative is still a negative', () => {
  // The fix must not swallow the sign it was written around.
  const rose = [passage('Income rose to £4.61m.')]
  assert.equal(verifyAgainstPassages('Income fell by -£4.61m.', rose, rose).ok, false)
  const bracketed = [passage('The deficit was (4.61) million.')]
  assert.equal(verifyAgainstPassages('The deficit was 4.61 million.', bracketed, bracketed).ok, false)
})
