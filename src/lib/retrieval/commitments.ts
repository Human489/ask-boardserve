import type { Passage } from '@/lib/retrieval/search'

// Forward-looking promises made in the board papers.
//
// The other half of "what is coming next quarter that we have not started
// preparing for". The action log answers the part with a due date; the papers
// hold promises that were made in prose and never became actions — a paper due
// to a committee, a plan to be brought back, a review reporting later. Those
// are exactly the things nobody is tracking, which is what the question is
// really asking about.
//
// Extracted by pattern and quoted verbatim, not summarised. A commitment
// paraphrased by a model is a commitment a reader cannot check, and the whole
// point of surfacing these is that someone will act on them.

/**
 * The shapes an English board paper uses to promise something later. No month
 * names or organisation vocabulary, so this travels to another corpus.
 */
const COMMITMENT = new RegExp(
  [
    String.raw`\bcomes? to the \w+`,
    String.raw`\bis due to\b`,
    String.raw`\bare due to\b`,
    String.raw`\bwill come to\b`,
    String.raw`\bwill be brought\b`,
    String.raw`\bwill report\b`,
    String.raw`\bproposes to bring\b`,
    String.raw`\bwill return to\b`,
    String.raw`\bplans to bring\b`,
    String.raw`\bwill be presented\b`,
  ].join('|'),
  'i',
)

/**
 * A promise already kept reads the same as one outstanding, so the tense is
 * checked: "that paper was received" is not something anyone still owes.
 */
const ALREADY_DONE = /\b(was|were|has been|have been|had been)\b/i

export interface Commitment {
  /** The sentence, verbatim, so a reader can find it in the paper. */
  sentence: string
  paperId: string
  paperTitle: string
  section: string
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25)
}

/**
 * What was found, and whether the search stopped early.
 *
 * The caller states the count as a fact — "the papers state N things as
 * coming" — and a bare capped array made that a lie on any corpus with more
 * than the cap. This one yields 4, so it was latent; a corpus with 9 would
 * have reported 6 as a count rather than as a sample.
 */
export interface CommitmentSearch {
  commitments: Commitment[]
  /** True when the cap was reached and there may be more. */
  capped: boolean
}

/**
 * English month names. Generic language, not organisation vocabulary, so this
 * travels to another corpus exactly as the commitment shapes above do.
 */
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/**
 * Whether a sentence promises something that has ALREADY HAPPENED.
 *
 * A paper written in March saying "a succession plan will come to the May
 * meeting" is not a thing still to come when read in September, but nothing
 * filtered on date and it was counted into "what is coming in the next 90
 * days". The commitment scan is a pattern match over prose with no year
 * attached, so this is a heuristic and is declared as one in the tool's
 * assumptions: a named month EARLIER in the calendar year than the as-at month
 * is treated as past, and a sentence naming no month is kept, because there is
 * nothing to judge it on.
 */
export function namesAPastMonth(sentence: string, asAt: string): boolean {
  const asAtMonth = Number(asAt.slice(5, 7)) - 1
  if (!Number.isInteger(asAtMonth) || asAtMonth < 0) return false

  // Split into words once, rather than building a regex per month.
  //
  // The first version built one with a template literal, where `\b` is the
  // BACKSPACE character rather than a word boundary — so the pattern was
  // literally <backspace>may<backspace> and matched nothing. The
  // control-character scan in tests/sources.test.ts cannot catch that: the
  // source holds a legitimate two-character escape, and it only becomes a
  // backspace when the template is evaluated.
  //
  // Comparing whole words needs no escape at all, which is the better fix.
  const words = new Set(sentence.toLowerCase().split(/[^a-z]+/).filter(Boolean))
  const named = MONTHS.map((m, i) => (words.has(m) ? i : -1)).filter((i) => i >= 0)
  if (named.length === 0) return false
  // Kept if ANY named month is still ahead: "reported in March and comes to
  // the Board in September" is a live commitment that happens to mention a
  // past month.
  return named.every((i) => i < asAtMonth)
}

export function findCommitments(
  passages: Passage[],
  limit = 6,
  asAt?: string,
): CommitmentSearch {
  const found: Commitment[] = []
  const seen = new Set<string>()

  for (const passage of passages) {
    for (const sentence of sentences(passage.text)) {
      if (!COMMITMENT.test(sentence)) continue
      if (ALREADY_DONE.test(sentence)) continue
      if (asAt && namesAPastMonth(sentence, asAt)) continue

      // Windows overlap, so the same sentence arrives more than once.
      const key = sentence.toLowerCase().slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)

      // A sentence that begins lower-case, or with a verb hanging off the end
      // of a previous clause, is a chunk-boundary fragment rather than a
      // promise. One was being quoted verbatim as a board commitment:
      // "asked to do Agree the two recruitment priorities, ... note that a
      // succession plan will come to the May meeting."
      if (!/^["'‘“(]?[A-Z0-9]/.test(sentence.trim())) continue

      found.push({
        sentence,
        paperId: passage.paperId,
        paperTitle: passage.paperTitle,
        section: passage.section,
      })
      if (found.length >= limit) return { commitments: found, capped: true }
    }
  }
  return { commitments: found, capped: false }
}
