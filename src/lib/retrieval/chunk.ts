import type { BoardPaper } from '@/lib/types'

// Chunking for the board papers.
//
// The skeleton this is derived from splits on a fixed word count, which suits a
// corpus of arbitrary PDFs. These papers are structured: one `#` for the
// organisation, one `##` for the paper title, and `###` for each section —
// Recommendation, Background, The case for change, Risks, and so on. Splitting
// on those headings rather than on word count means a chunk never straddles two
// subjects, and a citation can name the section rather than a chunk number,
// which is what makes a retrieved answer checkable.
//
// The headings are read from the file, not assumed: a paper with no `###`
// headings falls back to word-count splitting.

/** Above this, a section is split further. Roughly a long paragraph pair. */
const MAX_WORDS = 220
/** Carried between splits of an over-long section so a sentence is not orphaned. */
const OVERLAP_WORDS = 30
/** Vectorize caps metadata at 10KiB per vector; this stays well inside it. */
const MAX_STORED_CHARS = 3000

export interface Chunk {
  /** Stable across re-ingests, so an unchanged paper overwrites rather than duplicates. */
  id: string
  text: string
  paperId: string
  paperTitle: string
  section: string
  chunkIndex: number
  words: number
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

/** The `##` line is the paper's real title; the `#` line is the organisation. */
function titleOf(paper: BoardPaper): string {
  const h2 = paper.body.match(/^##\s+(.+)$/m)
  if (h2) return h2[1].trim()
  const h1 = paper.body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : paper.title
}

interface Section {
  heading: string
  body: string
}

function sectionsOf(paper: BoardPaper): Section[] {
  const lines = paper.body.split(/\r?\n/)
  const sections: Section[] = []
  let heading = 'Front matter'
  let buffer: string[] = []

  const flush = () => {
    const body = buffer.join('\n').trim()
    if (body) sections.push({ heading, body })
    buffer = []
  }

  for (const line of lines) {
    const m = line.match(/^###\s+(.+)$/)
    if (m) {
      flush()
      heading = m[1].trim()
    } else if (/^#{1,2}\s+/.test(line)) {
      // The organisation and title lines are captured as metadata already.
      continue
    } else {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

/** Splits an over-long section into overlapping windows. */
function windowed(text: string): string[] {
  const all = words(text)
  if (all.length <= MAX_WORDS) return [text]
  const out: string[] = []
  const step = MAX_WORDS - OVERLAP_WORDS
  for (let start = 0; start < all.length; start += step) {
    out.push(all.slice(start, start + MAX_WORDS).join(' '))
    if (start + MAX_WORDS >= all.length) break
  }
  return out
}

export function chunkPaper(paper: BoardPaper): Chunk[] {
  const paperTitle = titleOf(paper)
  const sections = sectionsOf(paper)
  // No `###` headings: fall back to plain windowing over the whole document.
  const source: Section[] =
    sections.length > 0 ? sections : [{ heading: 'Document', body: paper.body }]

  const chunks: Chunk[] = []
  let index = 0
  for (const section of source) {
    for (const piece of windowed(section.body)) {
      const text = piece.trim().slice(0, MAX_STORED_CHARS)
      if (words(text).length < 5) continue // headings with no body under them
      chunks.push({
        id: `${paper.id}#${index}`,
        text,
        paperId: paper.id,
        paperTitle,
        section: section.heading,
        chunkIndex: index,
        words: words(text).length,
      })
      index++
    }
  }
  return chunks
}

export function chunkPapers(papers: BoardPaper[]): Chunk[] {
  return papers.flatMap(chunkPaper)
}
