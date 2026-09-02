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
 * A number as it is claimed: its value, and its magnitude suffix if it has one.
 *
 * The suffix is part of the identity — £4.61m and 4.61 are different claims —
 * but a percent sign is not, because a paper may write "14%" where an answer
 * writes "14 per cent" and those are the same claim.
 */
interface Figure {
  /** As written, for the error message. */
  raw: string
  /** Digits and decimal point only, separators removed. */
  value: string
  /** 'm' | 'k' | 'bn', or '' when the number stands alone. */
  magnitude: string
  /** True when written as money or as a percentage. */
  qualified: boolean
}

/**
 * Matches the forms a board paper uses: £4.61m, 11.4, 14 per cent, 2026,
 * £412,000, 96%.
 */
const FIGURE_PATTERN =
  /(£|\$|€)?\s*(\d[\d,]*(?:\.\d+)?)\s*(m\b|k\b|bn\b|%|per cent|percent)?/gi

function parseFigures(text: string): Figure[] {
  const out: Figure[] = []
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const [raw, currency, digits, unit] = match
    if (!digits) continue
    const suffix = (unit ?? '').toLowerCase()
    const isPercent = suffix === '%' || suffix === 'per cent' || suffix === 'percent'
    out.push({
      raw: raw.trim(),
      // A trailing separator is punctuation, never part of the number:
      // "£412,000." normalised to "412000." once matched nothing and rejected a
      // correct, sourced answer.
      value: digits.replace(/,/g, '').replace(/\.$/, ''),
      magnitude: isPercent ? '' : suffix,
      qualified: Boolean(currency) || isPercent || Boolean(suffix),
    })
  }
  return out
}

/** Identity for comparison. Two figures match when value and magnitude match. */
function key(figure: Figure): string {
  return `${figure.value}|${figure.magnitude}`
}

/**
 * Whether a number is a claim about the data, or incidental prose.
 *
 * Ordinals, section numbers and small counts are not claims about the figures,
 * and demanding they appear verbatim would reject sound answers — "the three
 * papers" is not a finding. So a bare small integer is still not checked.
 *
 * But money and percentages are claims at any size. "a 14 per cent fall" and
 * "£12" are assertions about the data whether or not they have four digits,
 * and a percentage is the single most likely thing for a model to compute from
 * two numbers it was shown. Those are checked regardless of magnitude.
 */
function isClaim(figure: Figure): boolean {
  if (figure.qualified) return true
  if (figure.value.includes('.')) return true
  return figure.value.replace(/[^\d]/g, '').length >= 4
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

  // A set of whole values rather than one concatenated string, so a figure can
  // no longer verify by being a digit-substring of a larger one.
  const supported = new Set<string>()
  for (const passage of scope) {
    for (const figure of parseFigures(passage.text)) supported.add(key(figure))
  }

  const figures = parseFigures(answer).filter(isClaim)
  const unsupported: string[] = []
  for (const figure of figures) {
    if (!supported.has(key(figure))) unsupported.push(figure.raw)
  }

  // A cited passage should carry at least one of the figures the answer quotes.
  // Only meaningful when the answer quotes figures at all — a narrative answer
  // cites a section for what it says, not for a number in it.
  const unsupportedCitations: string[] = []
  if (figures.length > 0 && cited.length > 0) {
    for (const passage of cited) {
      const inPassage = new Set(parseFigures(passage.text).map(key))
      const carries = figures.some((f) => inPassage.has(key(f)))
      if (!carries) unsupportedCitations.push(`${passage.paperId} / ${passage.section}`)
    }
  }

  return {
    ok: unsupported.length === 0,
    unsupported: [...new Set(unsupported)],
    unsupportedCitations: [...new Set(unsupportedCitations)],
  }
}
