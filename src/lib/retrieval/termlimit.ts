import type { Passage } from '@/lib/retrieval/search'

// Extracting a stated term limit from the board papers.
//
// The limit is the reason "who times out in the next 12 months" is a hybrid
// question rather than a structured one: no field anywhere records it. It
// exists only as prose — "the nine year limit", "a maximum term of nine" — and
// has to be read out of a paper before any arithmetic can happen.
//
// Read by pattern rather than by asking a model, deliberately. A model
// extracting "9" would be a language model producing a number that then drives
// every date on the screen, which is the one thing this product does not do.
// A regex match can be shown to the reader with the sentence it came from, and
// checked.
//
// Nothing here is specific to one organisation: nine years is not assumed, only
// the English shapes a paper uses to state a limit.

const WORD_NUMBERS: Record<string, number> = {
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}

/**
 * Matches the ways a paper says how long someone may serve. Ordered loosely
 * from most explicit to least, and every one requires the word "term", "limit"
 * or "serve" nearby so an unrelated number of years is not mistaken for a rule.
 */
const PATTERNS: RegExp[] = [
  /maximum term of (\w+|\d+)/i,
  /(\w+|\d+)[- ]year (?:term )?limit/i,
  /limit of (\w+|\d+) years/i,
  /may serve (?:no more than |up to )?(\w+|\d+) years/i,
  /(\w+|\d+) years? maximum/i,
  /term(?:s)? of (\w+|\d+) years/i,
]

/**
 * A sentence that states a NUMBER OF TERMS as well as a term length, or leaves
 * the total open.
 *
 * "Trustees may serve three terms of three years" states a nine-year lifetime in
 * two numbers, and every pattern above would read the three and report a
 * three-year limit — dressed as a finding, with a chart, a table and an
 * assumption quoting the sentence as its authority. Multiplying the two instead
 * would be this file inventing a rule the paper did not state. Extracting
 * nothing refuses cleanly and says why; extracting the wrong number is the
 * plausible wrong answer this project exists to avoid.
 */
const COUNTS_TERMS =
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|another|further|consecutive|successive|renewable|additional)\s+(?:consecutive\s+|successive\s+|further\s+|additional\s+)*terms\b|\b(?:may|can|could)\s+be\s+(?:renewed|extended|re-?appointed)\b|\brenewable\b|\brenewed once\b/i

export interface TermLimit {
  /** Years a director may serve, as stated in a paper. */
  years: number
  /** The sentence it was read from, so the reader can check it. */
  sentence: string
  paperId: string
  paperTitle: string
  section: string
}

function toNumber(token: string): number | null {
  const digits = Number.parseInt(token, 10)
  if (Number.isFinite(digits) && digits > 0 && digits <= 25) return digits
  const word = WORD_NUMBERS[token.toLowerCase()]
  return word ?? null
}

function sentenceAround(text: string, index: number): string {
  const before = text.lastIndexOf('.', index)
  const after = text.indexOf('.', index)
  return text
    .slice(before === -1 ? 0 : before + 1, after === -1 ? text.length : after + 1)
    .trim()
}

/**
 * Finds a term limit in the retrieved passages, or null when no paper states
 * one. Null is a real answer: without the limit the question cannot be
 * answered, and inventing a conventional nine years would be exactly the
 * plausible-wrong-answer this project exists to avoid.
 */
export function findTermLimit(passages: Passage[]): TermLimit | null {
  for (const passage of passages) {
    for (const pattern of PATTERNS) {
      const match = passage.text.match(pattern)
      if (!match) continue
      const years = toNumber(match[1])
      if (years === null) continue
      const sentence = sentenceAround(passage.text, match.index ?? 0)
      // Ambiguity is a reason to say nothing, not to pick a reading.
      if (COUNTS_TERMS.test(sentence)) continue
      return {
        years,
        sentence,
        paperId: passage.paperId,
        paperTitle: passage.paperTitle,
        section: passage.section,
      }
    }
  }
  return null
}
