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
 * Meeting minutes, as opposed to a duration in minutes.
 *
 * A bare "minutes" caught "how many minutes late do directors join meetings?",
 * which is a field the attendance rows hold. Exported because the router refuses
 * minutes questions and must draw the same line: one definition, so the two
 * cannot drift apart.
 */
export const MEETING_MINUTES =
  /\bminutes of (?:the |any |that |last |previous )*(?:meeting|board|committee)|\b(?:the|any|board|committee|meeting|draft|approved|signed) minutes\b|\bin the minutes\b/i

/**
 * A question that explicitly names the documents is a papers question even when
 * it also names something structured: "what do the papers say about digital and
 * data" is legitimate, and blocking it would be the opposite mistake.
 */
const NAMES_DOCUMENTS = new RegExp(
  /\bpaper(s)?\b|\bdocument(s)?\b|\breport says\b/.source + '|' + MEETING_MINUTES.source,
  'i',
)

/**
 * Phrasings that ask what a source SAYS without naming which source. They read
 * as documentary but are not on their own: "what does the skills audit say about
 * digital and data" was sent to the papers, which answered that the papers do
 * not cover it — implying the audit holds no such figure when it holds exactly
 * that. So these only excuse a question that names no structured source.
 */
const ASKS_WHAT_A_SOURCE_SAYS = /\bwritten\b|\bsay(s)? about\b|\bwhat does the .* say\b/

/**
 * The structured files by name. These are schema names fixed by the dataset
 * README for every organisation, not one board's vocabulary.
 */
const NAMES_STRUCTURED_SOURCE =
  /\bskills?[- ](?:audit|matrix|record(s)?)\b|\battendance (?:record|log|data|register)(s)?\b|\baction(s)?[- ]log\b/

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

  // Naming the papers wins outright: the reader has said which source they want.
  if (NAMES_DOCUMENTS.test(q)) {
    return { belongsToStructuredData: false, matched: [] }
  }

  // "What does X say about Y" is documentary only while X is not one of the
  // structured files. Naming one of those is the opposite instruction.
  if (ASKS_WHAT_A_SOURCE_SAYS.test(q) && !NAMES_STRUCTURED_SOURCE.test(q)) {
    return { belongsToStructuredData: false, matched: [] }
  }

  const matched = structuredVocabulary(dataset).filter((term) => q.includes(term))
  if (NAMES_STRUCTURED_SOURCE.test(q)) {
    const source = q.match(NAMES_STRUCTURED_SOURCE)?.[0]?.trim()
    if (source && !matched.includes(source)) matched.unshift(source)
  }
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
 * Only the reader's PAST and PRESENT are caught. Forward-looking wording —
 * "next quarter", "what is due soon" — is deliberately not here: due dates run
 * past the as-at date, so a question about what is coming can be answered from
 * them, and the tool that does it states that it counts from the as-at date
 * rather than from today. "Recent", "latest" and "the last three meetings" are
 * likewise answerable relative to the data itself.
 */
const CLOCK_ANCHORED =
  /\byesterday\b|\btoday\b|\bthis (week|morning|afternoon)\b|\blast night\b|\bright now\b|\bso far this (week|month)\b/

export interface ClockCheck {
  anchored: boolean
  /** The phrase that decided it, for the refusal wording. */
  phrase: string | null
}

export function checkClockAnchored(question: string): ClockCheck {
  const match = question.toLowerCase().match(CLOCK_ANCHORED)
  return { anchored: match !== null, phrase: match ? match[0] : null }
}
