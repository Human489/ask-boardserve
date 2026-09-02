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

export function findCommitments(passages: Passage[], limit = 6): Commitment[] {
  const found: Commitment[] = []
  const seen = new Set<string>()

  for (const passage of passages) {
    for (const sentence of sentences(passage.text)) {
      if (!COMMITMENT.test(sentence)) continue
      if (ALREADY_DONE.test(sentence)) continue

      // Windows overlap, so the same sentence arrives more than once.
      const key = sentence.toLowerCase().slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)

      found.push({
        sentence,
        paperId: passage.paperId,
        paperTitle: passage.paperTitle,
        section: passage.section,
      })
      if (found.length >= limit) return found
    }
  }
  return found
}
