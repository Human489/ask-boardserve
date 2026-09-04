import type { Passage } from '@/lib/retrieval/search'

// Deterministic fact-check over a generated answer.
//
// The prompt already forbids arithmetic and outside knowledge. It is not
// enough: an earlier version reported "an overspend of £132,000", a figure
// appearing nowhere in the papers, arrived at by subtracting two figures it had
// been given. It read as a helpful sentence and would have gone into a board
// pack.
//
// A prompt is a request. This is a check. Every number in an answer must appear
// in a passage the model was shown, or the answer does not go out.
//
// Deliberately narrow: it verifies NUMBERS, not prose. Whether a summary is
// faithful is a judgement; whether £132,000 appears in the source is a fact,
// and facts are what this project cannot afford to get wrong.
//
// Two holes were found by audit, both of which let an invented figure through
// while the answer carried a caveat saying its figures had been checked:
//
//   1. Only numbers with four or more digits, a decimal, or a magnitude suffix
//      were checked at all. So "attendance fell by 14 per cent" was never
//      looked at — and a computed percentage is precisely what a model invents
//      when it has been shown two numbers. Percentages and money are now
//      checked at any size, while bare small integers still are not, for the
//      reason recorded below.
//   2. Matching was a digit-substring test against the concatenated passages,
//      so "£12,000" verified against a passage reading "£112,000". Figures are
//      now compared as whole values, not as substrings.

export interface Verification {
  ok: boolean
  /** Citations that do not contain any figure the answer quotes. */
  unsupportedCitations: string[]
  /** Numbers in the answer that appear in no passage. */
  unsupported: string[]
}

/**
 * A number as it is claimed: how much, of what, and which way.
 *
 * Every part of that is identity. Dropping the unit made an invented percentage
 * verify against an unrelated count — "attendance fell by 3.1 per cent" passed
 * because a paper mentioned "an average of 3.1" — and dropping the sign made a
 * deficit verify against a surplus. Dropping the SCALE, meanwhile, made sound
 * answers fail: a corpus writing "£4.61 million" withheld an answer saying
 * "£4.61m", which is the over-strictness that killed an earlier check here.
 *
 * So: amounts are compared as numbers with their scale applied, and the unit
 * and sign travel with them.
 */
type Unit = 'money' | 'percent' | 'plain'

interface Figure {
  /** As written, for the error message. */
  raw: string
  /** The amount, scale applied: "£4.61m" and "£4,610,000" are both 4610000. */
  amount: number
  unit: Unit
  negative: boolean
  /** True when the number reads as a reference — "section 4.2" — not a figure. */
  reference: boolean
  /** Where it sat in the text, so a range can be spotted afterwards. */
  at: number
  /** Where it ended, likewise. */
  end: number
  /** Its own opener was a dash following a digit: it is a range's upper end. */
  rangeEnd: boolean
  /** The multiplier already applied, so a range can share it. */
  scale: number
}

/** Words and letters that scale a number, mapped to their multiplier. */
const SCALES: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  mn: 1_000_000,
  million: 1_000_000,
  bn: 1_000_000_000,
  billion: 1_000_000_000,
}

/**
 * Matches the forms a board paper uses: £4.61m, £4.61 million, 11.4,
 * 14 per cent, 96%, 2026, £412,000, £412k, -£4.61m, (4.61) million.
 */
const FIGURE_PATTERN =
  /(\(|-|minus\s+)?\s*(£|\$|€)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|mn?|million|bn|billion|%|per\s?cent)?/gi

/** A number introduced as a reference is not a claim about the data. */
const REFERENCE_BEFORE = /\b(section|paragraph|para|clause|appendix|table|figure|note|item|page|question)\s*$/i

function parseFigures(text: string): Figure[] {
  const out: Figure[] = []
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const [raw, opener, currency, digits, unitRaw] = match
    if (!digits) continue

    const unitText = (unitRaw ?? '').toLowerCase().replace(/\s+/g, '')
    const isPercent = unitText === '%' || unitText === 'percent'
    const scale = isPercent ? 1 : (SCALES[unitText] ?? 1)

    // A trailing separator is punctuation, never part of the number:
    // "£412,000." normalised to "412000." once matched nothing and rejected a
    // correct, sourced answer.
    const digitsOnly = digits.replace(/,/g, '').replace(/\.$/, '')
    const amount = Number(digitsOnly) * scale
    if (!Number.isFinite(amount)) continue

    const before = text.slice(0, match.index)
    // Whatever sits immediately before the matched figure, ignoring the
    // whitespace the pattern allows between the opener and the digits.
    const precededByDigit = /\d\s*$/.test(before)
    out.push({
      raw: raw.trim(),
      amount,
      unit: currency ? 'money' : isPercent ? 'percent' : 'plain',
      // A bracketed number is the accountant's negative; so is a leading minus
      // — UNLESS the minus is a range separator.
      //
      // "82-96%" and "£3-4m" and "2024-25" all put a hyphen between two
      // figures, and reading it as a sign produced a negative 96 that matched
      // nothing, so a correctly-sourced answer was withheld and its citation
      // flagged unsupported. Measured: a passage reading "Attendance ranged
      // from 82% to 96%" against an answer reading "ranged 82-96%" came back
      // ok:false, unsupported "-96%". That is a FALSE WITHHOLD, which is the
      // exact over-strictness that killed the previous version of this check.
      //
      // The mirror case matters more: a passage containing "82-96%" registered
      // a negative 96 and would have supported a fabricated "down 96 per
      // cent".
      //
      // A hyphen is a sign only when what precedes it is not a digit.
      negative: Boolean(opener) && !(opener === '-' && precededByDigit),
      reference: REFERENCE_BEFORE.test(before),
      at: match.index,
      end: match.index + raw.length,
      rangeEnd: opener === '-' && precededByDigit,
      scale,
    })
  }
  // In a range, the first number wears the second's unit.
  //
  // "82-96%" parsed as a bare 82 and a 96 per cent, and a bare small integer
  // is deliberately not treated as a claim — "the 3 papers" is not a finding.
  // So the 82 went unchecked entirely: an answer could widen a range downwards
  // and only its upper bound would be verified.
  //
  // The dash is not BETWEEN the two matches — the second match swallows it as
  // its own opener — so a range is spotted by the upper end carrying a dash
  // that followed a digit, not by the gap between them.
  for (let i = 0; i < out.length - 1; i++) {
    const lower = out[i]
    const upper = out[i + 1]
    if (!upper.rangeEnd) continue

    // "82-96%": the lower end wears the upper's unit, and is then a claim.
    // "£3-4m": the upper end wears the lower's currency, and the lower wears
    // the upper's scale — £3-4m is three to four MILLION pounds, and reading
    // the 3 as three pounds would fail a correct answer.
    const unit = lower.unit !== 'plain' ? lower.unit : upper.unit
    const scale = Math.max(lower.scale, upper.scale)
    out[i] = {
      ...lower,
      unit,
      amount: lower.scale === scale ? lower.amount : (lower.amount / lower.scale) * scale,
      scale,
    }
    out[i + 1] = { ...upper, unit }
  }

  return out
}

/**
 * Whether an answer's figure is supported by one in a passage.
 *
 * The unit comparison is deliberately ONE-WAY. An answer may state a bare
 * number where the source gave a unit — dropping "%" understates rather than
 * invents. It may not do the reverse: attaching "%" or "£" to a number the
 * source left bare is the fabrication this check exists to catch, and it is
 * how "3.1" in a sentence about travel distance became "3.1 per cent" of
 * attendance.
 */
function supports(passage: Figure, claim: Figure): boolean {
  if (passage.amount !== claim.amount) return false
  if (passage.negative !== claim.negative) return false
  return claim.unit === passage.unit || claim.unit === 'plain'
}

/**
 * Whether a number is a claim about the data, or incidental prose.
 *
 * Ordinals and small counts are not claims about the figures, and demanding
 * they appear verbatim would reject sound answers — "the three papers" is not a
 * finding. So a bare small integer is still not checked, and neither is a
 * cross-reference: "section 4.2" is a decimal, and withholding an answer
 * because a section number is absent from the prose it points at is the
 * over-strictness that gets a check switched off.
 *
 * Money and percentages are claims at any size. "a 14 per cent fall" and "£12"
 * are assertions about the data whether or not they have four digits, and a
 * percentage is the single most likely thing for a model to compute from two
 * numbers it was shown.
 */
function isClaim(figure: Figure): boolean {
  if (figure.reference) return false
  if (figure.unit !== 'plain') return true
  if (!Number.isInteger(figure.amount)) return true
  return figure.amount >= 1000
}

/**
 * Checks an answer's figures, and its citations.
 *
 * `cited` is the subset of passages the model said it used. Figures are checked
 * against those FIRST, because checking against everything retrieved lets a
 * computed number through whenever it happens to coincide with an unrelated
 * figure elsewhere in the corpus. A reported legacy shortfall of £280,000 —
 * arrived at by subtraction — passed once because £280,000 is also the agency
 * nursing budget, sitting in a different passage about a different subject.
 *
 * Citations are checked too. An answer cited a section that did not contain the
 * figure it quoted, so a reader following the reference would not find it. A
 * citation nobody can follow is worse than none.
 *
 * What this does NOT check, stated plainly because the answer's caveat must not
 * overstate it: that a figure is attached to the right subject. "income was
 * £4.61m" in a passage supports "the deficit was £4.61m" in an answer. Presence
 * is a fact this can settle; attribution is a reading of prose, and the same
 * unsolved problem as prose faithfulness generally.
 */
export function verifyAgainstPassages(
  answer: string,
  passages: Passage[],
  cited: Passage[] = [],
): Verification {
  // Fall back to everything retrieved when the model cited nothing: an
  // uncited answer still deserves its figures checked.
  const scope = cited.length > 0 ? cited : passages

  // Compared as whole figures rather than as text, so a number can no longer
  // verify by being a digit-substring of a larger one.
  const inScope = scope.flatMap((passage) => parseFigures(passage.text))

  const figures = parseFigures(answer).filter(isClaim)
  const unsupported: string[] = []
  for (const figure of figures) {
    if (!inScope.some((source) => supports(source, figure))) unsupported.push(figure.raw)
  }

  // A cited passage should carry at least one of the figures the answer quotes.
  // Only meaningful when the answer quotes figures at all — a narrative answer
  // cites a section for what it says, not for a number in it.
  const unsupportedCitations: string[] = []
  if (figures.length > 0 && cited.length > 0) {
    for (const passage of cited) {
      const inPassage = parseFigures(passage.text)
      const carries = figures.some((claim) =>
        inPassage.some((source) => supports(source, claim)),
      )
      if (!carries) unsupportedCitations.push(`${passage.paperId} / ${passage.section}`)
    }
  }

  return {
    ok: unsupported.length === 0,
    unsupported: [...new Set(unsupported)],
    unsupportedCitations: [...new Set(unsupportedCitations)],
  }
}
