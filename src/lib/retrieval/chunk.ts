import type { BoardPaper } from '@/lib/types'

// Chunking for the board papers.
//
// Sliding word windows over each paper, with the `###` heading in effect at a
// window's start carried alongside as metadata. Two measured reasons for that
// shape, both from sweeping configurations against the real corpus and scoring
// how well covered questions separated from uncovered ones:
//
//   80w / 20 overlap  -0.040   <- chosen
//   section-based     -0.092
//   200w / 50 overlap -0.105
//   whole paper       -0.145
//
// Smaller windows separate better because merging dilutes the specific detail
// that makes a real question score highly, while the generic governance
// language that attracts unanswerable questions survives at any size.
//
// Windows deliberately do NOT stop at headings, which measured worse (-0.071):
// ending every section leaves a short trailing stub, and short generic stubs
// are the chunks that unanswerable questions match against. The heading is
// recorded rather than respected, so a citation can still say "paper-02, The
// case for change" without the boundary hurting retrieval.
//
// Every configuration tested still had NEGATIVE separation, so no similarity
// threshold can decide whether a question is answerable. Chunking improves
// precision; it does not remove the need for the model to judge grounding.

const WINDOW_WORDS = 80
const OVERLAP_WORDS = 20
/** Vectorize caps metadata at 10KiB per vector; this stays well inside it. */
const MAX_STORED_CHARS = 3000
/** Below this a window is a heading fragment, not a passage. */
const MIN_WORDS = 5

export interface Chunk {
  /** Stable across re-ingests, so an unchanged paper overwrites rather than duplicates. */
  id: string
  text: string
  paperId: string
  paperTitle: string
  /** The `###` heading in effect where this window starts. Metadata, not embedded. */
  section: string
  chunkIndex: number
  words: number
}

/** The `##` line is the paper's real title; the `#` line is the organisation. */
function titleOf(paper: BoardPaper): string {
  const h2 = paper.body.match(/^##\s+(.+)$/m)
  if (h2) return h2[1].trim()
  const h1 = paper.body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : paper.title
}

interface Word {
  word: string
  section: string
}

/**
 * Flattens a paper to a word stream, remembering which section each word came
 * from.
 *
 * Heading words stay IN the embedded text. Stripping them was tried and
 * measured worse (-0.105 against -0.040): the headings are the most
 * subject-specific words in the paper — "Ashcombe", "Reserves", "Tenure" — so
 * removing them takes out exactly the signal that makes a real question match
 * its own section. The section is also recorded separately, for citation.
 */
function wordsWithSections(paper: BoardPaper): Word[] {
  const out: Word[] = []
  let section = 'Front matter'
  for (const line of paper.body.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+)$/)
    if (heading) section = heading[1].trim()
    for (const word of line.split(/\s+/).filter(Boolean)) out.push({ word, section })
  }
  return out
}

export function chunkPaper(paper: BoardPaper): Chunk[] {
  const paperTitle = titleOf(paper)
  const stream = wordsWithSections(paper)
  const step = Math.max(1, WINDOW_WORDS - OVERLAP_WORDS)

  const chunks: Chunk[] = []
  let index = 0
  for (let start = 0; start < stream.length; start += step) {
    const window = stream.slice(start, start + WINDOW_WORDS)
    if (window.length >= MIN_WORDS) {
      const text = window
        .map((w) => w.word)
        .join(' ')
        .slice(0, MAX_STORED_CHARS)
      // Windows cross headings by design, so the heading at the START of one is
      // often not the section it mostly covers: a window beginning in "Income"
      // and running into "Expenditure" was citing Income for an expenditure
      // figure, sending a reader to the wrong part of the paper. Label it with
      // the section holding most of its words.
      const spanned = new Map<string, number>()
      for (const w of window) spanned.set(w.section, (spanned.get(w.section) ?? 0) + 1)
      const section = [...spanned.entries()].sort((a, b) => b[1] - a[1])[0][0]

      chunks.push({
        id: `${paper.id}#${index}`,
        text,
        paperId: paper.id,
        paperTitle,
        section,
        chunkIndex: index,
        words: window.length,
      })
      index++
    }
    if (start + WINDOW_WORDS >= stream.length) break
  }
  return chunks
}

export function chunkPapers(papers: BoardPaper[]): Chunk[] {
  return papers.flatMap(chunkPaper)
}
