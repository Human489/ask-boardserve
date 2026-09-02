import { allBodies } from '@/lib/dataset/loader'
import type { Dataset } from '@/lib/types'

// Keeps structured questions out of the board papers.
//
// The papers tool had become a catch-all: "who has the weakest Estates and
// assets skill" was sent to the papers, which of course do not hold the skills
// audit, and came back as "the passages do not mention it" — a structured
// question answered by the wrong source, and a refusal implying the data does
// not exist.
//
// That was first addressed by telling the model not to do it. Instructions get
// ignored. This is the same lesson as the figure verifier: a prompt is a
// request, a check is a check.
//
// Nothing here is hard-coded. The vocabulary is read from the dataset that is
// loaded — skill columns from the CSV header, bodies and directors from the
// attendance records, risk and action references from the log — so it travels
// to another organisation unchanged.

/**
 * Field names from the schema, which the dataset README fixes for every
 * organisation. These are schema vocabulary, not one board's vocabulary, so
 * listing them does not tie the code to a dataset.
 */
const SCHEMA_FIELDS = [
  'tenure',
  'apologies',
  'attended remotely',
  'times deferred',
  'owner type',
  'due date',
  'skill score',
  'self-assessed',
]

/**
 * Whether a term is strong enough evidence on its own.
 *
 * This used to be a list of words to ignore — board, finance, audit, people —
 * but those were chosen by reading THIS organisation's committee names. Another
 * board would have different ones, and its own weak words would go uncaught, so
 * the list quietly tied the code to a dataset.
 *
 * Derived instead. A term counts when it is more than one word, or names a
 * skill column, or carries a digit (an action or risk reference), or is long
 * enough to be distinctive. A short single word like "board" or "risk" appears
 * in half the questions a secretary asks and proves nothing.
 */
function isStrongEvidence(term: string, columns: Set<string>): boolean {
  if (columns.has(term)) return true
  if (SCHEMA_FIELDS.includes(term)) return true
  if (term.includes(' ')) return true
  if (/\d/.test(term)) return true
  return term.length >= 9
}

/**
 * A question that explicitly asks about the documents is a papers question even
 * when it also names something structured: "what do the papers say about
 * digital and data" is legitimate, and blocking it would be the opposite
 * mistake.
 */
const ASKS_FOR_DOCUMENTS =
  /\bpaper(s)?\b|\bdocument(s)?\b|\breport says\b|\bwritten\b|\bminute(s)?\b|\bsay(s)? about\b|\bwhat does the .* say\b/

/** Terms belonging to the structured files, drawn from the loaded dataset. */
export function structuredVocabulary(dataset: Dataset): string[] {
  const terms = new Set<string>()

  // Skill columns are kept whatever they are called, including when the name is
  // an ordinary English word. Such a column would otherwise slip past as too
  // common to count, and a question that genuinely wants the papers escapes
  // earlier via ASKS_FOR_DOCUMENTS anyway.
  const columns = new Set(dataset.skillNames.map((s) => s.toLowerCase()))
  for (const skill of columns) terms.add(skill)
  for (const body of allBodies(dataset)) terms.add(body.toLowerCase())
  for (const row of dataset.skills) terms.add(row.director_name.toLowerCase())

  // The action and risk references this dataset actually uses, read from the
  // log rather than assumed — their format differs between organisations.
  for (const action of dataset.actions.actions) {
    terms.add(action.action_id.toLowerCase())
    if (action.linked_risk) terms.add(action.linked_risk.toLowerCase())
  }

  for (const field of SCHEMA_FIELDS) terms.add(field)

  return [...terms].filter((t) => t.length > 2 && isStrongEvidence(t, columns))
}

export interface ScopeCheck {
  /** True when the papers are the wrong source for this question. */
  belongsToStructuredData: boolean
  /** The terms that decided it, for the log and for the refusal wording. */
  matched: string[]
}

export function checkPapersScope(question: string, dataset: Dataset): ScopeCheck {
  const q = question.toLowerCase()

  if (ASKS_FOR_DOCUMENTS.test(q)) {
    return { belongsToStructuredData: false, matched: [] }
  }

  const matched = structuredVocabulary(dataset).filter((term) => q.includes(term))
  return { belongsToStructuredData: matched.length > 0, matched }
}

/**
 * Questions anchored to the reader's clock rather than to the data.
 *
 * The dataset is a snapshot with an as-at date. "What was attendance like at
 * yesterday's meeting" cannot be answered by it at any point in the future, and
 * the tools happily returned a full-year trend instead: a real chart, correct
 * figures, and a different question. Worse, the answer never mentioned that no
 * meeting took place yesterday, so the false premise passed unremarked.
 *
 * Only wording tied to the real-world present is caught. "Recent", "latest" and
 * "the last three meetings" are all answerable relative to the data itself and
 * are deliberately not here.
 */
const CLOCK_ANCHORED =
  /\byesterday\b|\btoday\b|\btomorrow\b|\bthis (week|month|morning|afternoon)\b|\blast night\b|\bnext (week|month|quarter|year)\b|\bright now\b|\bcurrently scheduled\b|\bso far this (week|month)\b/

export interface ClockCheck {
  anchored: boolean
  /** The phrase that decided it, for the refusal wording. */
  phrase: string | null
}

export function checkClockAnchored(question: string): ClockCheck {
  const match = question.toLowerCase().match(CLOCK_ANCHORED)
  return { anchored: match !== null, phrase: match ? match[0] : null }
}
