import { embed, queryVectors } from '@/lib/retrieval/vectorize'
import type { Dataset } from '@/lib/types'

// Searching the board papers.
//
// Two jobs, deliberately kept apart, because a similarity score can do one and
// structurally cannot do the other:
//
//   RANKING       which passages are closest to the question. Cosine is good at
//                 this — measured 8 of 8 on the right paper.
//   ANSWERABILITY whether those passages actually contain the answer. Cosine
//                 cannot do this. Measured on this corpus, "what was the
//                 board's average IQ" scores higher than five of eight
//                 genuinely answerable questions, because it IS about board
//                 composition. The embedding is right; the question being
//                 asked of it is wrong.
//
// So this module ranks and gathers evidence. It never decides that a question
// is answered — that judgement belongs to the caller, with the passages in
// front of it.

export interface Passage {
  score: number
  text: string
  paperId: string
  paperTitle: string
  section: string
}

export interface SearchResult {
  /** Passages above the corpus floor, best first. */
  passages: Passage[]
  /** Best score seen, whether or not it cleared the floor. */
  topScore: number
  /** The corpus's own derived floor, read back from the index. */
  floor: number
  /** True when nothing cleared the floor: the question is not about this corpus at all. */
  offDomain: boolean
  /**
   * Words in the question that appear nowhere in the retrieved passages.
   * Evidence for the caller, not a filter: "CQC" appearing nowhere is a strong
   * hint, but plenty of answerable questions also contain words the papers
   * never use.
   */
  missingTerms: string[]
  /** Set when the index holds another organisation's papers. */
  datasetMismatch: string | null
}

/** Fallback if the index predates the derived floor being stored. */
const FALLBACK_FLOOR = 0.55

const STOPWORDS = new Set(
  ('what when where which who whom whose why how is are was were do does did the a an of to in on ' +
    'for and or our we us it this that at as by with about from be been being have has had they ' +
    'them their there here say says said paper papers board tell me any')
    .split(' '),
)

function contentWords(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z]{3,}/g) ?? []
  return [...new Set(words)].filter((w) => !STOPWORDS.has(w))
}

export async function searchPapers(
  dataset: Dataset,
  question: string,
  topK = 5,
): Promise<SearchResult> {
  const [vector] = await embed([question])
  const matches = await queryVectors(vector, topK)

  const topScore = matches[0]?.score ?? 0
  const floorRaw = matches[0]?.metadata?.corpusFloor
  const floor = typeof floorRaw === 'number' ? floorRaw : FALLBACK_FLOOR

  // The index is per-dataset. If it holds another organisation's papers, that is
  // a misconfiguration, and answering from them would be the worst possible
  // failure for board data — so it is surfaced rather than silently used.
  const indexedDataset = matches[0]?.metadata?.datasetId
  const datasetMismatch =
    typeof indexedDataset === 'string' && indexedDataset !== dataset.organisation
      ? indexedDataset
      : null

  const passages: Passage[] = matches
    .filter((m) => m.score >= floor)
    .map((m) => ({
      score: m.score,
      text: String(m.metadata?.text ?? ''),
      paperId: String(m.metadata?.paperId ?? 'unknown'),
      paperTitle: String(m.metadata?.paperTitle ?? 'Untitled paper'),
      section: String(m.metadata?.section ?? ''),
    }))
    .filter((p) => p.text.length > 0)

  const haystack = passages
    .map((p) => `${p.text} ${p.paperTitle} ${p.section}`)
    .join(' ')
    .toLowerCase()
  const missingTerms = contentWords(question).filter((w) => !haystack.includes(w))

  return {
    passages,
    topScore,
    floor,
    offDomain: passages.length === 0,
    missingTerms,
    datasetMismatch,
  }
}
