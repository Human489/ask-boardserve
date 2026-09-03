import { chunkPapers } from '@/lib/retrieval/chunk'
import type { Dataset } from '@/lib/types'

// Where a board paper's numbers disagree with the underlying data.
//
// The papers restate figures from the skills audit in prose, and some of those
// restatements are wrong: a paper gives a count at 4-or-above for a skill that
// the audit contradicts. Which skills, and by how much, is a property of the
// dataset rather than of this code, so no example is named here — naming one
// would tie the module to a single organisation's audit.
//
// The obvious behaviour is to prefer the computed figure and say nothing. That
// is the wrong product. A secretary reading a paper that says six, and a tool
// that says four, needs to know the paper is wrong — that discrepancy is a
// governance finding in itself, and it is exactly the kind of thing nobody has
// time to check by hand.
//
// So both values are reported, with where each came from, and the reader
// decides. Detection is deterministic: a claim is only raised when the sentence
// states a count AND names a skill the audit has a column for. Anything
// ambiguous is left alone, because a false accusation against a paper is worse
// than a missed one.

const WORD_NUMBERS: Record<string, number> = {
  no: 0,
  none: 0,
  one: 1,
  two: 2,
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

const STRONG = 4
const WEAK = 2

export interface Disagreement {
  skill: string
  /** "at 4 or above" or "at 2 or below". */
  measure: string
  paperSays: number
  dataSays: number
  /** The paper's own sentence, verbatim. */
  sentence: string
  paperId: string
  paperTitle: string
  section: string
}

function toCount(token: string, boardSize: number): number | null {
  // "Half the Board" on an odd board is not a count of directors, and reporting
  // that a paper says 7.5 accuses it of writing something no paper wrote. An
  // unresolvable fraction is left alone, like any other ambiguous claim.
  if (/^half$/i.test(token)) return boardSize % 2 === 0 ? boardSize / 2 : null
  const digits = Number.parseInt(token, 10)
  if (Number.isFinite(digits)) return digits
  return WORD_NUMBERS[token.toLowerCase()] ?? null
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Counts of directors at or above / at or below a score, from the audit. */
function computed(dataset: Dataset, skill: string) {
  const scores = dataset.skills.map((d) => d.scores[skill])
  return {
    strong: scores.filter((n) => n >= STRONG).length,
    weak: scores.filter((n) => n <= WEAK).length,
  }
}

/**
 * Claims of the form "six trustees score 4 or 5" and "half the Board scores 2
 * or below". Both halves are required: a number and the threshold it applies
 * to, so a sentence merely mentioning a skill is never treated as a claim.
 */
/**
 * The count is the word that OPENS the claim, never whichever word happens to
 * sit nearest the threshold.
 *
 * "Three of the twelve trustees score 2 or below" captured "twelve", so the
 * caveat told the reader the paper had said 12 where it had said three — the
 * false accusation this module exists to avoid. The "of the N" group now
 * swallows the board size, leaving the leading count as the capture.
 */
const OF_THE_WHOLE = '(?:\\s+(?:of|out of)\\s+(?:the\\s+)?(?:\\w+\\s+)?)?'
const PEOPLE = '(?:trustees?|directors?|members?|board)'

/**
 * Words that make a count a bound rather than an assertion.
 *
 * "Fewer than eight trustees score 4 or above" was read as the paper claiming
 * eight, and reported as a governance finding against a sentence that is
 * perfectly true. The comment above says a false accusation is worse than a
 * missed one; this is how one was produced. A hedged sentence is now left
 * alone, because there is no exact claim in it to disagree with.
 */
const HEDGES = [
  'fewer than',
  'less than',
  'no more than',
  'not more than',
  'at most',
  'up to',
  'more than',
  'at least',
  'over',
  'around',
  'about',
  'roughly',
  'approximately',
  'nearly',
  'almost',
  'some',
  'several',
]

function isHedged(sentence: string, token: string): boolean {
  const lower = sentence.toLowerCase()
  const at = lower.indexOf(token.toLowerCase())
  if (at === -1) return false
  // Only the words immediately before the count matter: a hedge elsewhere in a
  // long sentence says nothing about this number.
  const before = lower.slice(Math.max(0, at - 24), at)
  return HEDGES.some((hedge) => before.trimEnd().endsWith(hedge))
}

const STRONG_CLAIM = new RegExp(
  `\\b(\\w+)${OF_THE_WHOLE}\\s*(?:the\\s+)?${PEOPLE}\\s+scores?\\s+4\\s+or\\s+(?:5|above)\\b`,
  'i',
)
const WEAK_CLAIM = new RegExp(
  `\\b(\\w+)${OF_THE_WHOLE}\\s*(?:the\\s+)?${PEOPLE}\\s+scores?\\s+2\\s+or\\s+below\\b`,
  'i',
)

function firstCapture(match: RegExpMatchArray | null): string | null {
  if (!match) return null
  // Alternations each carry their own capture group; take whichever matched.
  return match.slice(1).find((g) => typeof g === 'string') ?? null
}

export function findDisagreements(dataset: Dataset): Disagreement[] {
  const boardSize = dataset.skills.length
  const out: Disagreement[] = []
  const seen = new Set<string>()

  for (const chunk of chunkPapers(dataset.papers)) {
    const lines = sentences(chunk.text)
    lines.forEach((sentence, i) => {
      // The skill the claim NAMES, not the first one that happens to appear.
      //
      // This used to search the sentence and the one before it and take
      // whichever skill came first in the audit's column order. A paper that
      // praised one area and then made a count about a DIFFERENT one in the
      // next sentence was therefore reported as mis-stating the first — about
      // which it had said nothing wrong.
      //
      // The claim's own sentence wins. Two skills in it, and the sentence is
      // ambiguous about which the count belongs to, so it is left alone: a
      // missed disagreement costs a caveat, a misattributed one accuses a paper
      // of an error it did not make.
      const named = (text: string) =>
        dataset.skillNames.filter((s) => text.toLowerCase().includes(s.toLowerCase()))
      const inSentence = named(sentence)
      const inPrevious = inSentence.length === 0 ? named(lines[i - 1] ?? '') : []
      const candidates = inSentence.length > 0 ? inSentence : inPrevious
      if (candidates.length !== 1) return
      const skill = candidates[0]

      const actual = computed(dataset, skill)

      for (const [pattern, measure, dataSays] of [
        [STRONG_CLAIM, `at ${STRONG} or above`, actual.strong],
        [WEAK_CLAIM, `at ${WEAK} or below`, actual.weak],
      ] as const) {
        const token = firstCapture(sentence.match(pattern))
        if (token === null) continue
        if (isHedged(sentence, token)) continue
        const paperSays = toCount(token, boardSize)
        if (paperSays === null || paperSays === dataSays) continue

        const key = `${skill}|${measure}|${paperSays}`
        if (seen.has(key)) continue
        seen.add(key)

        out.push({
          skill,
          measure,
          paperSays,
          dataSays,
          sentence,
          paperId: chunk.paperId,
          paperTitle: chunk.paperTitle,
          section: chunk.section,
        })
      }
    })
  }
  return out
}

/** Disagreements touching a particular skill, for a tool answering about it. */
export function disagreementsFor(dataset: Dataset, skills: string[]): Disagreement[] {
  const wanted = new Set(skills.map((s) => s.toLowerCase()))
  return findDisagreements(dataset).filter((d) => wanted.has(d.skill.toLowerCase()))
}
