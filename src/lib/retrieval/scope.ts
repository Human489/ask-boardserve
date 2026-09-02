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

/** Words too common to be evidence of anything. */
const AMBIGUOUS = new Set(['board', 'strategy', 'risk', 'people', 'finance', 'audit'])

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

  // Skill columns are kept whatever they are called, even when the name is an
  // everyday word like "Strategy". A vague mention of strategy would otherwise
  // slip past, and a question that genuinely wants the papers escapes earlier
  // via ASKS_FOR_DOCUMENTS anyway.
  const columns = new Set(dataset.skillNames.map((s) => s.toLowerCase()))
  for (const skill of columns) terms.add(skill)
  for (const body of allBodies(dataset)) terms.add(body.toLowerCase())
  for (const row of dataset.skills) terms.add(row.director_name.toLowerCase())

  // Identifier shapes rather than the identifiers themselves: SAH-A014, R03.
  for (const action of dataset.actions.actions) {
    terms.add(action.action_id.toLowerCase())
    if (action.linked_risk) terms.add(action.linked_risk.toLowerCase())
  }

  // Field names a secretary might use directly.
  for (const field of [
    'tenure',
    'apologies',
    'attended remotely',
    'times deferred',
    'owner type',
    'due date',
    'skill score',
    'self-assessed',
  ]) {
    terms.add(field)
  }

  // The ambiguity filter applies to everything EXCEPT a skill column: "board"
  // is a body name and means nothing on its own, but a column called "Board
  // effectiveness" would be real vocabulary.
  return [...terms].filter((t) => t.length > 2 && (columns.has(t) || !AMBIGUOUS.has(t)))
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
