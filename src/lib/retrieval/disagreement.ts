import { chunkPapers } from '@/lib/retrieval/chunk'
import type { Dataset } from '@/lib/types'

// Where a board paper's numbers disagree with the underlying data.
//
// The papers restate figures from the skills audit in prose, and some of those
// restatements are wrong. One says six trustees score 4 or 5 on strategy; the
// audit says four. Another gives four at 4-or-above and four at 2-or-below for
// governance; the audit says three and three.
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
  if (/^half$/i.test(token)) return boardSize / 2
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
const STRONG_CLAIM =
  /\b(\w+)\s+(?:trustees?|directors?|members?)\s+scores?\s+4\s+or\s+5\b|\b(\w+)\s+(?:of\s+)?the\s+(?:board|trustees?)\s+scores?\s+4\s+or\s+(?:5|above)\b/i
const WEAK_CLAIM =
  /\b(\w+)\s+(?:trustees?|directors?|members?)\s+scores?\s+2\s+or\s+below\b|\b(\w+)\s+(?:of\s+)?the\s+(?:board|trustees?)\s+scores?\s+2\s+or\s+below\b|\b(\w+)\s+scores?\s+2\s+or\s+below\b/i

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
      // A skill named in this sentence, or in the one before it — papers often
      // name the area then make the claim in the next breath. No further back
      // than that: attribution stops being safe.
      const context = `${lines[i - 1] ?? ''} ${sentence}`.toLowerCase()
      const skill = dataset.skillNames.find((s) => context.includes(s.toLowerCase()))
      if (!skill) return

      const actual = computed(dataset, skill)

      for (const [pattern, measure, dataSays] of [
        [STRONG_CLAIM, `at ${STRONG} or above`, actual.strong],
        [WEAK_CLAIM, `at ${WEAK} or below`, actual.weak],
      ] as const) {
        const token = firstCapture(sentence.match(pattern))
        if (token === null) continue
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
