// The specification's questions, in the customer's own words.
//
// Not a test file (no `.test.ts`), so it is not run on its own — it is the one
// place the spec wording is written down, imported by both routing suites.
//
// It exists because those two suites had drifted apart. tests/router.test.ts
// carried the full Q1-Q12 wordings from docs/question-set.md; the file whose
// entire purpose was to hold the customer's wording verbatim,
// tests/routing-spec.test.ts, carried shortened rewrites of the same twelve —
// "Which meetings had unusually low attendance, and when?" for a question that
// actually asks whether a movement is bigger than one meeting's noise. That is
// the exact failure the header of routing-spec.test.ts warns about: the
// original routing tests were paraphrases tuned to the classifier and scored
// 12/12 while real accuracy on the spec's wording was 3/12. A suite cannot warn
// against paraphrases and be written in them.
//
// One list, imported by both, cannot drift again.

/** Q1-Q12, verbatim, each with the tool that must answer it. */
export const SPEC_STRUCTURED: { q: string; tool: string }[] = [
  {
    q: 'Who is below our attendance threshold, and on which committees?',
    tool: 'attendance_below_threshold',
  },
  {
    q: "Were there meetings, or a period, where attendance was materially below the year's norm — and is any apparent movement bigger than one meeting's noise?",
    tool: 'attendance_by_meeting',
  },
  {
    q: 'Which committees have the lowest attendance, and is the ranking robust given how few times each met?',
    tool: 'attendance_by_committee',
  },
  {
    q: 'Which directors have missed the most meetings they were eligible to attend, and how many of those were without any advance notice?',
    tool: 'meetings_missed',
  },
  { q: 'What actions are overdue, and who owns them?', tool: 'overdue_actions' },
  { q: 'Which overdue actions have been outstanding the longest?', tool: 'longest_overdue' },
  { q: 'Which committee is carrying the most unresolved work?', tool: 'unresolved_by_committee' },
  {
    q: 'How is outstanding work distributed, and is it concentrated in any one owner, or on the board rather than the executive?',
    tool: 'actions_distribution',
  },
  { q: 'What has been deferred more than once?', tool: 'deferred_actions' },
  {
    q: 'Which skills have the fewest directors at 4 or above, how many are at 2 or below, and how concentrated is our coverage?',
    tool: 'skills_gaps',
  },
  {
    q: 'Which directors provide the strongest coverage for the areas where the board has gaps?',
    tool: 'gap_coverage',
  },
  { q: 'Which committees have the greatest skills gaps?', tool: 'committee_skills_gaps' },
]

/**
 * R1-R5, the questions that must be refused rather than answered plausibly.
 *
 * Both spellings of R2 and R4 are kept: the spec is quoted with "3" in one
 * place and "three" in another, and with a curly apostrophe. A router that
 * refuses one and answers the other is broken, and only listing both catches it.
 */
export const SPEC_REFUSALS: string[] = [
  'How long are our packs, and are they going out with enough notice?',
  'What did we decide in the last three meetings, and what happened?',
  'What did we decide in the last 3 meetings, and what happened?',
  'How many directors are qualified accountants?',
  "What was the board's average IQ?",
  'What was the board’s average IQ?',
]

/** Q13-Q14: answered from the papers' prose, so they must reach retrieval. */
export const SPEC_DOCUMENT: string[] = [
  'What do the board papers say about a particular risk, project or issue?',
  'What concerns or themes recur across recent board papers?',
  'What do the board papers say about our CQC readiness?',
]

/** Q15: the term limit is prose, the tenure is a column, neither answers alone. */
export const SPEC_HYBRID: string[] = [
  'Who times out in the next 12 months, and what does that do to the skills matrix?',
  'Are there any directors whose term limit affects committee skills coverage?',
  'Who has served more than nine years on the board?',
]

/** Q16: due dates from the action log, plus promises made only in paper prose. */
export const SPEC_UPCOMING: string[] = [
  'What is coming next quarter that we have not started preparing for?',
  'What have we not started preparing for?',
]
