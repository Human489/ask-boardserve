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
 * as documentary but are not on their own: a question asking what the skills
 * audit says about a named skill was sent to the papers, which answered that
 * the papers do not cover it — implying the audit holds no such figure when it
 * holds exactly that. So these only excuse a question that names no structured
 * source.
 */
const ASKS_WHAT_A_SOURCE_SAYS = /\bwritten\b|\bsay(s)? about\b|\bwhat does the .* say\b/

/**
 * The structured files by name. These are schema names fixed by the dataset
 * README for every organisation, not one board's vocabulary.
 */
// Short forms included on purpose: a reader says "the audit" and "the log"
// far more often than "the skills audit" and "the actions log", and
// requiring the full name sent those questions to the papers.
const NAMES_STRUCTURED_SOURCE =
  /\bskills?[- ](?:audit|matrix|record(s)?)\b|\battendance (?:record|log|data|register)(s)?\b|\baction(s)?[- ]log\b|\bthe (?:audit|log|action log|attendance log|register)\b/

/**
 * A structured measure used as a unit of something the structured files do not
 * hold.
 *
 * "What did the Ashcombe unit cost per attendance?" names attendance, but as a
 * DENOMINATOR — the question is about cost, and no structured file holds a
 * single figure of money. Blocking it sent a genuine document question to a
 * refusal saying no tool computes it, when the papers are exactly where a cost
 * per attendance would be written.
 *
 * So a measure reads as a unit rather than a subject when "per" introduces it,
 * or when the question is plainly about money. Narrow on purpose: "how many
 * apologies per meeting" still belongs to the structured data, because the
 * thing being counted is itself structured.
 */
const MEASURE_AS_UNIT = /\bper\s+$/i
const ASKS_ABOUT_MONEY =
  /\bcost|\bspend|\bspent|\bbudget|\bprice|\bfunding|\bincome|\bexpenditure|\bdeficit|\bsurplus|£/i

/**
 * What the structured files MEASURE, as distinct from what they contain.
 *
 * The dataset-derived vocabulary covers names — skills, bodies, owners — but a
 * question can name the structured data without naming any of them: "who is
 * below the attendance threshold" and "what is overdue" are about the records
 * and mention nothing in them. Those questions were reaching the papers, which
 * answered that the passages do not cover it.
 *
 * These are the product's own measures, not any organisation's vocabulary, so
 * they carry no dataset with them.
 */
const STRUCTURED_SUBJECT =
  /\battendance\b|\battend(ed|ing)?\b|\boverdue\b|\bdeferred\b|\bthreshold\b|\beligib|\bapolog|\bunresolved\b|\bpast due\b|\bskill (?:score|gap)/

/** The structured measure this question is ABOUT, if any. */
function structuredSubject(q: string): string | null {
  const match = q.match(STRUCTURED_SUBJECT)
  if (!match) return null
  if (ASKS_ABOUT_MONEY.test(q)) return null
  if (MEASURE_AS_UNIT.test(q.slice(0, match.index))) return null
  return match[0].trim()
}

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

  const matched = structuredVocabulary(dataset).filter((term) => q.includes(term))

  // "What does X say about Y" is documentary only while nothing structured is
  // named — not merely while the FULL file name is absent.
  //
  // Requiring the exact phrase let "what does the audit say about <a skill>?"
  // and "what is written about <a skill>'s scores?" through to the papers,
  // which answered that the passages do not mention it — implying the audit
  // holds no such figure when it holds precisely that. The SUBJECT counts as
  // much as the source: a question naming a skill column, a body or an owner
  // has named the structured data whatever it calls the file.
  if (
    ASKS_WHAT_A_SOURCE_SAYS.test(q) &&
    !NAMES_STRUCTURED_SOURCE.test(q) &&
    structuredSubject(q) === null &&
    matched.length === 0
  ) {
    return { belongsToStructuredData: false, matched: [] }
  }

  if (NAMES_STRUCTURED_SOURCE.test(q)) {
    const source = q.match(NAMES_STRUCTURED_SOURCE)?.[0]?.trim()
    if (source && !matched.includes(source)) matched.unshift(source)
  }

  // Naming what the records MEASURE is naming the records. Without this,
  // "who is below the attendance threshold" matched no dataset term — it names
  // no skill, body or person — and so was treated as belonging to the papers,
  // which then reported that the passages do not cover it.
  const subject = structuredSubject(q)
  if (subject && !matched.includes(subject)) matched.push(subject)

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
