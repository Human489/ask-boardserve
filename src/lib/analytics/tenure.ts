import { searchPapers } from '@/lib/retrieval/search'
import { findTermLimit } from '@/lib/retrieval/termlimit'
import type { AnswerResult, DataPoint, Dataset, ToolDefinition } from '@/lib/types'
import { list, num } from '@/lib/dataset/loader'

// The hybrid tool: who reaches the end of their term, and what the board loses.
//
// Hybrid because neither source answers it. The skills audit records how long
// each director has served; nothing anywhere records how long they MAY serve.
// That limit is prose in a board paper. So the limit is retrieved and every
// consequence of it is computed — the split matters, and the answer says which
// half came from where.
//
// If no paper states a limit, this refuses. Assuming a conventional nine years
// would produce a confident answer resting on a number nobody wrote down.

const STRONG = 4
const MONTHS_PER_YEAR = 12

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** "within 1 months" reads as a bug even when the figure is right. */
function months(n: number): string {
  return `${n} month${n === 1 ? '' : 's'}`
}

interface Leaving {
  name: string
  tenure: number
  monthsRemaining: number
  /** Unrounded, for the window test and ordering only. */
  exactMonths: number
  alreadyOver: boolean
}

/** Directors at STRONG or above in a skill, before and after some leave. */
function strongCount(dataset: Dataset, skill: string, excluding: Set<string>): number {
  return dataset.skills.filter(
    (d) => !excluding.has(d.director_name) && d.scores[skill] >= STRONG,
  ).length
}

function mean(dataset: Dataset, skill: string, excluding: Set<string>): number {
  const rows = dataset.skills.filter((d) => !excluding.has(d.director_name))
  if (rows.length === 0) return 0
  return round1(rows.reduce((a, d) => a + d.scores[skill], 0) / rows.length)
}

export const tenureAndSkillsImpact: ToolDefinition = {
  name: 'tenure_and_skills_impact',
  description:
    'Which directors reach the end of their permitted term within a given number of ' +
    'months, and what the board loses from the skills matrix when they go. Use for ' +
    '"who times out", "who is approaching the term limit", or "what happens to our ' +
    'skills when people leave". Combines the tenure recorded in the skills audit with ' +
    'the term limit stated in the board papers.',
  parameters: {
    within_months: {
      type: 'number',
      description: 'How far ahead to look. Twelve months unless the question says otherwise.',
      default: 12,
      min: 1,
      max: 120,
    },
  },
  required: [],

  async run(dataset, args): Promise<AnswerResult> {
    const within = Math.round(num(args.within_months, 12))

    // The limit is not a field. It has to be read out of a paper — and if the
    // papers cannot be reached, that is a refusal, not a crash. Half of this
    // answer lives in a service that can be down.
    let limit: ReturnType<typeof findTermLimit> = null
    try {
      const search = await searchPapers(dataset, 'trustee term limit maximum years served tenure')

      // THE INDEX IS PER-ORGANISATION, AND THIS TOOL WAS THE ONE THAT DID NOT
      // CHECK. `search.ts` calls answering from another organisation's papers
      // "the worst possible failure for board data" and surfaces it on
      // `datasetMismatch`; `retrieval/tool.ts` refuses on it. This read the
      // passages anyway — so with a second dataset active and the index still
      // holding the first one's papers, it would take THAT board's term limit,
      // apply it to THIS board's tenures, and produce a retirement schedule
      // that is entirely plausible and belongs to someone else.
      //
      // Found by external audit. It is the same shape as the guard that was
      // once applied to a test-only export and not to the two real exits: a
      // rule enforced at one of the places that needs it.
      if (search.datasetMismatch) {
        return {
          tool: 'refusal',
          headline: 'The board papers available do not belong to this organisation.',
          reason:
            `The term limit is stated only in the papers, and the paper index holds papers ` +
            `for ${search.datasetMismatch} rather than for ${dataset.organisation}. Applying ` +
            `another organisation's limit to these directors would produce a retirement ` +
            `schedule that looks right and is not.`,
          alternative:
            'The skills audit still records how long each director has served, which is the half held in the data.',
        }
      }

      limit = findTermLimit(search.passages)
    } catch (e) {
      console.error(`[tenure] could not search the papers: ${(e as Error).message}`)
      return {
        tool: 'refusal',
        headline: 'The board papers could not be searched for the term limit.',
        reason:
          'Half of this answer lives in the papers — the limit on how long a director may ' +
          'serve is stated there and nowhere else — and they could not be reached. Answering ' +
          'from tenure alone would mean inventing the limit to count towards.',
        alternative:
          'The skills audit can still show how long each director has served, which is the half held in the data.',
      }
    }

    if (!limit) {
      return {
        tool: 'refusal',
        headline: 'No term limit is recorded anywhere in this data.',
        reason:
          'The skills audit records how long each director has served, but nothing records ' +
          'how long they may serve, and no board paper states a limit. Without it, there is ' +
          'no date to count towards.',
        alternative:
          'The audit can still show how long each director has served, which is the half of this question the data does hold.',
      }
    }

    const leaving: Leaving[] = dataset.skills
      .map((d) => {
        const yearsLeft = limit.years - d.tenure_years
        return {
          name: d.director_name,
          tenure: d.tenure_years,
          monthsRemaining: round1(yearsLeft * MONTHS_PER_YEAR),
          // Unrounded, because the window is a CUTOFF. round1 pulled 12.04
          // months down to 12.0, so a director just outside a 12-month window
          // was reported as timing out inside it — a rounding artefact stated
          // as a governance fact about a named person.
          exactMonths: yearsLeft * MONTHS_PER_YEAR,
          alreadyOver: yearsLeft <= 0,
        }
      })
      .filter((d) => d.exactMonths <= within)
      .sort((a, b) => a.exactMonths - b.exactMonths)

    const going = new Set(leaving.map((d) => d.name))

    // What the departure costs, per skill, computed both ways.
    const impact = dataset.skillNames
      .map((skill) => ({
        skill,
        strongBefore: strongCount(dataset, skill, new Set()),
        strongAfter: strongCount(dataset, skill, going),
        meanBefore: mean(dataset, skill, new Set()),
        meanAfter: mean(dataset, skill, going),
      }))
      .map((row) => ({ ...row, lost: row.strongBefore - row.strongAfter }))
      .sort((a, b) => b.lost - a.lost || a.meanAfter - b.meanAfter)

    const hit = impact.filter((row) => row.lost > 0)
    const singlePointsOfFailure = impact.filter(
      (row) => row.strongAfter === 1 && row.strongBefore > 1,
    )
    const wipedOut = impact.filter((row) => row.strongAfter === 0 && row.strongBefore > 0)

    const overdue = leaving.filter((d) => d.alreadyOver)

    let headline: string
    if (leaving.length === 0) {
      headline =
        `No director reaches the ${limit.years}-year limit within ${months(within)}. ` +
        `The longest serving has ${round1(
          limit.years - Math.max(...dataset.skills.map((d) => d.tenure_years)),
        )} years left.`
    } else {
      const who = list(
        leaving.map(
          (d) =>
            `${d.name} (${d.tenure} years served, ${
              d.alreadyOver ? 'already past the limit' : `${d.monthsRemaining} months left`
            })`,
        ),
      )
      const consequence =
        wipedOut.length > 0
          ? ` The board would be left with nobody at ${STRONG} or above in ${list(
              wipedOut.map((r) => r.skill),
            )}.`
          : singlePointsOfFailure.length > 0
            ? ` ${list(
                singlePointsOfFailure.map((r) => r.skill),
              )} would fall to a single director at ${STRONG} or above.`
            : hit.length > 0
              ? ` The heaviest loss is ${hit[0].skill}, down from ${hit[0].strongBefore} to ${hit[0].strongAfter} directors at ${STRONG} or above.`
              : ' No skill loses a director scoring 4 or above.'

      headline =
        `${leaving.length} director${leaving.length === 1 ? '' : 's'} reach${
          leaving.length === 1 ? 'es' : ''
        } the ${limit.years}-year limit within ${months(within)} — ${who}.${consequence}` +
        (overdue.length > 0
          ? ` ${overdue.length === 1 ? 'One is' : `${overdue.length} are`} already past it.`
          : '')
    }

    const points: DataPoint[] = impact.map((row) => ({
      label: row.skill,
      value: row.strongBefore,
      value2: row.strongAfter,
      highlight: row.lost > 0,
      detail: `mean ${row.meanBefore} now, ${row.meanAfter} after; ${row.strongBefore} → ${row.strongAfter} directors at ${STRONG}+`,
    }))

    return {
      tool: 'tenure_and_skills_impact',
      headline,
      chart:
        leaving.length > 0
          ? {
              kind: 'bar',
              title: `Directors at ${STRONG} or above, before and after those leaving`,
              xLabel: 'Skill area',
              yLabel: 'Directors',
              unit: 'count',
              points,
              seriesLabel: 'Now',
              series2Label: `After ${months(within)}`,
            }
          : null,
      table: {
        columns: ['Director', 'Years served', 'Months to the limit', 'Status'],
        rows: leaving.map((d) => [
          d.name,
          d.tenure,
          d.monthsRemaining,
          d.alreadyOver ? 'already past the limit' : 'approaching',
        ]),
      },
      assumptions: [
        `The ${limit.years}-year limit is not a field in the data. It was read from ${limit.paperTitle}, which says: "${limit.sentence}"`,
        'Time remaining is tenure subtracted from that limit. No appointment dates are recorded, so this is an approximation, not a date.',
        `"Strong" is a self-assessed score of ${STRONG} or above.`,
      ],
      caveats: [
        'Tenure is a decimal with no start date behind it, so months remaining should be read as roughly, not exactly.',
        'Skills are self-assessed, so what the board loses is measured in confidence as much as capability.',
        'A term limit can be extended or waived. This assumes it is applied as the paper states it.',
        ...(leaving.length > 0 && leaving.length < 3
          ? [
              `With only ${leaving.length} director${
                leaving.length === 1 ? '' : 's'
              } leaving, one recruitment changes this picture entirely.`,
            ]
          : []),
      ],
      provenance: {
        asAt: dataset.asAt,
        sources: ['skills-audit.csv', `${limit.paperId}.md`],
        rowsConsidered: dataset.skills.length,
        derivation:
          `The term limit of ${limit.years} years was read from ${limit.paperId}, section ` +
          `${limit.section}. Every director's tenure was subtracted from it, and the skills ` +
          `matrix recomputed without those at or past the limit within ${months(within)}.`,
      },
    }
  },
}
