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

/**
 * Takes the strongest passages, then adds one representative from any paper not
 * already present.
 *
 * Two failures shaped this. A plain top-k clusters: "what themes recur across
 * recent board papers" drew every passage from one paper and was refused,
 * correctly, because one paper cannot evidence a recurring theme. But capping
 * how many any one paper may contribute broke the opposite case — "why is the
 * hospice closing the Ashcombe unit" lost the paper-02 passages that answered
 * it and was refused too.
 *
 * So breadth is added rather than substituted. A specific question keeps all of
 * its best evidence and gains a couple of passages it can ignore; a cross-paper
 * question gets the spread it needs.
 */
function withBreadth<T extends { score: number; paperId: string }>(
  matches: T[],
  core: number,
  limit: number,
): T[] {
  const kept = matches.slice(0, core)
  const represented = new Set(kept.map((m) => m.paperId))
  for (const m of matches.slice(core)) {
    if (kept.length >= limit) break
    if (represented.has(m.paperId)) continue
    represented.add(m.paperId)
    kept.push(m)
  }
  return kept.sort((a, b) => b.score - a.score)
}

/**
 * Questions about the corpus as a whole rather than about a subject in it.
 *
 * "What themes recur across the papers" has no semantic anchor: no passage is
 * about recurring themes, so retrieval returns whatever sits nearest those
 * abstract words and the judge rightly says none of them states the answer.
 * The question is not answered by finding the closest passage; it is answered
 * by reading everything.
 *
 * These are English question shapes, not this organisation's vocabulary, so
 * they travel to another dataset unchanged.
 */
const CORPUS_WIDE =
  /\brecur|\bthemes?\b|\bin common\b|\bacross (the |all |recent )?(papers|documents|reports)\b|\boverall\b|\bpattern(s)?\b|\brunning through\b/

function isCorpusWide(question: string): boolean {
  return CORPUS_WIDE.test(question.toLowerCase())
}

export async function searchPapers(
  dataset: Dataset,
  question: string,
  topK = 6,
): Promise<SearchResult> {
  // A whole-corpus question reads the whole corpus. At a few thousand words
  // that costs less than pretending retrieval can find an answer that is not
  // in any single passage. If a corpus ever grows past what fits in context
  // this needs a map-reduce instead, and the guard below is where to notice.
  if (isCorpusWide(question)) {
    const budget = 24_000
    let used = 0
    const whole: Passage[] = []
    for (const paper of dataset.papers) {
      if (used + paper.body.length > budget) break
      used += paper.body.length
      whole.push({
        score: 1,
        text: paper.body,
        paperId: paper.id,
        paperTitle: paper.title,
        section: 'whole paper',
      })
    }
    if (whole.length === dataset.papers.length) {
      return {
        passages: whole,
        topScore: 1,
        floor: 0,
        offDomain: false,
        missingTerms: [],
        datasetMismatch: null,
      }
    }
    // Too large to read whole; fall through to retrieval rather than answering
    // a corpus-wide question from a partial corpus.
  }

  const [vector] = await embed([question])
  // Over-fetch so there is something to diversify from.
  const matches = await queryVectors(vector, Math.max(topK * 3, 15))

  // EVERY MATCH IS FILTERED TO THE ACTIVE ORGANISATION, not just sampled.
  //
  // This checked `matches[0]` alone and used the whole result set. One index
  // holds many organisations — `ingest-papers.mjs` upserts under ids
  // namespaced `<organisation>::<chunk>`, so ingesting a second dataset ADDS
  // to the first rather than replacing it — so as soon as two are indexed, a
  // question whose top hit was this organisation's could carry another
  // organisation's passages in positions 2..n. Those went to the model as
  // context, were cited to the reader, and passed verify.ts, because the
  // figures genuinely do appear in the paper they came from. Silent, and
  // through every guard.
  //
  // A vector with no datasetId predates the namespacing and is treated as
  // FOREIGN rather than assumed to be ours: the cost of dropping it is a
  // refusal, and the cost of keeping it is another board's paper.
  const isMine = (m: (typeof matches)[number]): boolean =>
    typeof m.metadata?.datasetId === 'string' && m.metadata.datasetId === dataset.organisation
  const mine = matches.filter(isMine)

  const topScore = mine[0]?.score ?? 0
  // The floor is computed per corpus at ingest, so it has to come from a
  // vector belonging to THIS corpus.
  const floorRaw = mine[0]?.metadata?.corpusFloor
  const floor = typeof floorRaw === 'number' ? floorRaw : FALLBACK_FLOOR

  // A mismatch is now "the index has something, and none of it is ours" —
  // which is the misconfiguration worth refusing over. Answering one board's
  // question from another's papers would be the worst possible failure for
  // board data, so it is surfaced rather than silently used.
  const foreign = matches.find((m) => !isMine(m))
  const foreignId = foreign?.metadata?.datasetId
  const datasetMismatch =
    mine.length === 0 && typeof foreignId === 'string' ? foreignId : null

  // Metadata comes back from the index as unknown values. String() on a
  // non-string yields "[object Object]", which would become a passage's text or
  // a citation's paper id — fed to the model, checked by verify.ts, and shown
  // to a reader as a source. A value that is not a string is treated as absent.
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback

  const aboveFloor = mine
    .filter((m) => m.score >= floor)
    .map((m) => ({ ...m, paperId: text(m.metadata?.paperId, 'unknown') }))
  const selected = withBreadth(aboveFloor, topK, topK + Math.max(dataset.papers.length - 1, 0))

  const passages: Passage[] = selected
    .map((m) => ({
      score: m.score,
      text: text(m.metadata?.text, ''),
      paperId: text(m.metadata?.paperId, 'unknown'),
      paperTitle: text(m.metadata?.paperTitle, 'Untitled paper'),
      section: text(m.metadata?.section, ''),
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
