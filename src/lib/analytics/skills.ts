import type { DataPoint, Dataset, ToolDefinition, ToolResult } from '@/lib/types'
import { allBodies, membersOf } from '@/lib/dataset/loader'

// Skills-audit tools.
//
// Every score here is SELF-ASSESSED, so a bare mean is a weak answer. Each tool
// reports the mean alongside the count at 4 or above and the count at 2 or
// below, because the spread is the governance signal, not the average.

const SOURCES = ['skills-audit.csv']
const STRONG = 4
const WEAK = 2

const SELF_ASSESSMENT_CAVEAT =
  'Scores are self-assessed on a 1-5 scale, not tested or verified, so they measure ' +
  'confidence as much as capability and are not comparable between individuals.'

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function list(items: string[]): string {
  if (items.length === 0) return 'none'
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

interface SkillStat {
  skill: string
  mean: number
  strong: number
  weak: number
  n: number
}

/** Per-skill mean and spread over a set of directors. Ordered weakest first. */
function skillStats(dataset: Dataset, names?: string[]): SkillStat[] {
  const rows = names
    ? dataset.skills.filter((s) => names.includes(s.director_name))
    : dataset.skills
  return dataset.skillNames
    .map((skill) => {
      const values = rows.map((r) => r.scores[skill] ?? 0)
      const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
      return {
        skill,
        mean: round2(mean),
        strong: values.filter((v) => v >= STRONG).length,
        weak: values.filter((v) => v <= WEAK).length,
        n: values.length,
      }
    })
    // Ties are broken by the order the skill columns appear in the CSV, which is
    // stable and stated in the assumptions rather than resolved silently.
    .sort((a, b) => a.mean - b.mean || dataset.skillNames.indexOf(a.skill) - dataset.skillNames.indexOf(b.skill))
}

// ------------------------------------------------------------ Q10

export const skillsGaps: ToolDefinition = {
  name: 'skills_gaps',
  description:
    'Board-wide skills coverage: per-skill mean plus how many directors score 4 or above ' +
    'and how many score 2 or below. Use for "where are our skills gaps" or "which skills ' +
    'are weakest".',
  parameters: {},
  required: [],
  run(dataset): ToolResult {
    const stats = skillStats(dataset)
    const weakest = stats[0]
    const strongest = stats[stats.length - 1]
    const tiedWeakest = stats.filter((s) => s.mean === weakest.mean)
    const thinnest = [...stats].sort(
      (a, b) => a.strong - b.strong || a.mean - b.mean,
    )[0]

    const points: DataPoint[] = stats.map((s) => ({
      label: s.skill,
      value: s.mean,
      value2: s.strong,
      highlight: s.mean === weakest.mean,
      detail: `mean ${s.mean.toFixed(2)} — ${s.strong} of ${s.n} at ${STRONG}+, ${s.weak} at ${WEAK} or below`,
    }))

    const tieClause =
      tiedWeakest.length > 1
        ? ` It ties with ${list(tiedWeakest.slice(1).map((s) => s.skill))} on the mean; CSV column order breaks the tie.`
        : ''

    const headline =
      `${weakest.skill} is the weakest area at a self-assessed mean of ${weakest.mean.toFixed(
        2,
      )}, with ${weakest.weak} of ${weakest.n} directors at ${WEAK} or below and only ${
        weakest.strong
      } at ${STRONG} or above, against ${strongest.skill} as the strongest at ${strongest.mean.toFixed(
        2,
      )}.` +
      tieClause +
      (thinnest.skill === weakest.skill
        ? ''
        : ` The thinnest coverage is elsewhere: only ${thinnest.strong} of ${thinnest.n} directors reach ${STRONG} in ${thinnest.skill}.`)

    return {
      tool: 'skills_gaps',
      headline,
      chart: {
        kind: 'bar',
        title: 'Self-assessed skills, weakest first',
        xLabel: 'Skill',
        yLabel: 'Mean score (1-5)',
        unit: 'score',
        points,
        seriesLabel: 'Board mean',
        series2Label: `Directors at ${STRONG}+`,
        reference: { value: 3, label: 'Working knowledge (3)' },
      },
      table: {
        columns: ['Skill', 'Mean', `Directors at ${STRONG}+`, `Directors at ${WEAK} or below`, 'Directors assessed'],
        rows: stats.map((s) => [s.skill, s.mean, s.strong, s.weak, s.n]),
      },
      assumptions: [
        `"Strong" is a self-assessed score of ${STRONG} or above; "gap" is ${WEAK} or below. The dataset defines neither.`,
        'Skills are ranked by mean; ties on the mean are broken by the order the columns appear in the audit file.',
      ],
      caveats: [
        SELF_ASSESSMENT_CAVEAT,
        `With ${dataset.skills.length} directors assessed, one director changing one score moves a skill mean by ${round2(
          1 / Math.max(dataset.skills.length, 1),
        )} points.`,
        'A mean hides concentration: a skill held strongly by one or two people is a dependency, not a strength.',
      ],
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: dataset.skills.length,
        derivation:
          `Each of the ${dataset.skillNames.length} skill columns in the audit file was averaged across ` +
          `${dataset.skills.length} directors, and the counts at ${STRONG}+ and ${WEAK}- taken alongside it.`,
      },
    }
  },
}

// ------------------------------------------------------------ Q11

export const gapCoverage: ToolDefinition = {
  name: 'gap_coverage',
  description:
    'Which directors provide the strongest coverage of the board\'s weakest skill areas, ' +
    'ranked by their summed score across those areas. Use for "who covers our gaps".',
  parameters: {
    top_n_gaps: {
      type: 'number',
      description: 'How many of the weakest skills to score directors against.',
      default: 3,
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const topN = Math.max(1, Math.round(num(args.top_n_gaps, 3)))
    const stats = skillStats(dataset)
    const gaps = stats.slice(0, Math.min(topN, stats.length))
    const gapNames = gaps.map((g) => g.skill)

    // The cut-off can land inside a tie: state the tiebreak rather than hiding it.
    const cutoffMean = gaps[gaps.length - 1].mean
    const tiedAtCutoff = stats.filter((s) => s.mean === cutoffMean)

    const ranked = dataset.skills
      .map((d) => {
        const perGap = gapNames.map((g) => d.scores[g] ?? 0)
        return {
          name: d.director_name,
          role: d.role,
          total: perGap.reduce((a, b) => a + b, 0),
          perGap,
          strongIn: gapNames.filter((g) => (d.scores[g] ?? 0) >= STRONG),
        }
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

    const best = ranked[0]
    const worst = ranked[ranked.length - 1]
    const tiedBest = ranked.filter((r) => r.total === best.total)

    const points: DataPoint[] = ranked.map((r) => ({
      label: r.name,
      value: r.total,
      value2: r.strongIn.length,
      highlight: r.total === best.total,
      detail: `${gapNames
        .map((g, i) => `${g} ${r.perGap[i]}`)
        .join(', ')} — ${r.strongIn.length} of ${gapNames.length} at ${STRONG}+`,
    }))

    const leadClause =
      tiedBest.length > 1
        ? `${list(tiedBest.map((r) => r.name))} tie as the strongest cover for the board's weakest areas (${list(
            gapNames,
          )}) on ${best.total} of a possible ${gapNames.length * 5}`
        : `${best.name} is the strongest cover for the board's weakest areas (${list(
            gapNames,
          )}) with ${best.total} of a possible ${gapNames.length * 5}`

    const tieNote =
      tiedAtCutoff.length > 1
        ? ` The weakest ${gapNames.length} cut through a tie at a mean of ${cutoffMean.toFixed(2)} between ${list(
            tiedAtCutoff.map((s) => s.skill),
          )}; the audit file's column order picks ${gapNames[gapNames.length - 1]}, and choosing the other would change the ranking.`
        : ''

    const noStrong = ranked.filter((r) => r.strongIn.length === 0).length

    return {
      tool: 'gap_coverage',
      headline:
        `${leadClause}, against ${worst.name} at ${worst.total}; ${noStrong} of ${ranked.length} directors rate themselves ${STRONG} or above in none of these areas.` +
        tieNote,
      chart: {
        kind: 'bar',
        title: `Coverage of the ${gapNames.length} weakest skill areas`,
        xLabel: 'Director',
        yLabel: `Summed self-assessed score across ${gapNames.length} areas`,
        unit: 'score',
        points,
        seriesLabel: 'Summed score across the gap areas',
        series2Label: `Gap areas at ${STRONG}+`,
      },
      table: {
        columns: ['Director', 'Role', ...gapNames, 'Total', `Areas at ${STRONG}+`],
        rows: ranked.map((r) => [
          r.name,
          r.role,
          ...r.perGap,
          r.total,
          r.strongIn.length,
        ]),
      },
      assumptions: [
        `The ${gapNames.length} weakest skills by board mean were treated as the gap areas: ${list(gapNames)}.`,
        'Directors are ranked by the unweighted sum of their scores across those areas; the gaps are not weighted by severity.',
        ...(tiedAtCutoff.length > 1
          ? [
              `The gap list cut through a tie at a mean of ${cutoffMean.toFixed(2)}; it was broken by the order the columns appear in the audit file.`,
            ]
          : []),
      ],
      caveats: [
        SELF_ASSESSMENT_CAVEAT,
        `A summed score treats ${gapNames.length} areas as interchangeable; a director strong in one and absent in the others scores the same as one evenly spread.`,
        'Coverage is capability on paper, not availability: this says nothing about whether these directors attend or have capacity.',
      ],
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: dataset.skills.length,
        derivation:
          `The ${gapNames.length} lowest-mean skills were identified across ${dataset.skills.length} directors, ` +
          'then each director was scored on those columns only and the scores summed.',
      },
    }
  },
}

// ------------------------------------------------------------ Q12

export const committeeSkillsGaps: ToolDefinition = {
  name: 'committee_skills_gaps',
  description:
    'Skills coverage within each board or committee, using membership inferred from ' +
    'attendance eligibility. Use for "which committees have the greatest skills gaps".',
  parameters: {
    body: { type: 'string', description: 'Optional: restrict to one board or committee.' },
  },
  required: [],
  run(dataset, args): ToolResult {
    const wanted = str(args.body)
    const bodies = allBodies(dataset).filter((b) =>
      wanted ? b.toLowerCase() === wanted.toLowerCase() : true,
    )
    const knownDirectors = new Set(dataset.skills.map((s) => s.director_name))

    const perBody = bodies.map((body) => {
      const members = membersOf(dataset, body).filter((n) => knownDirectors.has(n))
      const stats = skillStats(dataset, members)
      const meetings = new Set(
        dataset.attendance.records.filter((r) => r.body === body).map((r) => r.meeting_id),
      ).size
      // Membership is inferred from eligibility rows. If a member does not have a
      // row for every meeting of the body, composition changed during the period
      // and the inferred roster is approximate. Computed, not assumed.
      const partial = members.filter(
        (n) =>
          dataset.attendance.records.filter(
            (r) => r.body === body && r.director_name === n,
          ).length !== meetings,
      )
      const overall =
        stats.length > 0 ? round2(stats.reduce((a, s) => a + s.mean, 0) / stats.length) : 0
      return { body, members, meetings, stats, partial, overall }
    })

    // Rank bodies by their mean across every skill. Ranking on the single weakest
    // skill instead would reward a body that is uniformly thin over one with a
    // single hole, which is the opposite of what a gap question asks.
    const ranked = [...perBody].sort(
      (a, b) => a.overall - b.overall || a.body.localeCompare(b.body),
    )
    const worst = ranked[0]

    // A body argument that matches nothing leaves ranked empty, and every line
    // below reads ranked[0]. Sibling attendance tools fall back to the raw
    // string and return a graceful nil result; this one crashed instead, and
    // the API turned that into "the analysis could not be completed" rather
    // than saying the committee was not found.
    if (!worst) {
      const known = allBodies(dataset)
      return {
        tool: 'committee_skills_gaps',
        headline: `No body matching "${String(args.body ?? '')}" appears in the attendance records, so its skills coverage cannot be assessed. The bodies present are ${list(
          known,
        )}.`,
        chart: null,
        table: null,
        assumptions: [
          'Bodies are those that appear in the attendance records; there is no separate list of committees in the dataset.',
        ],
        caveats: [
          'This is a nil return caused by an unmatched committee name, not a finding that the board has no skills gaps.',
        ],
        provenance: {
          asAt: dataset.asAt,
          sources: ['attendance.json', 'skills-audit.csv'],
          rowsConsidered: dataset.attendance.records.length,
          derivation: `Matched the requested body against the ${known.length} bodies present in the attendance records and found none.`,
        },
      }
    }

    const points: DataPoint[] = ranked.map((b) => ({
      label: b.body,
      value: b.overall,
      value2: b.stats[0]?.mean ?? 0,
      highlight: b.body === worst.body,
      detail: `weakest ${b.stats[0]?.skill ?? 'n/a'} at ${(b.stats[0]?.mean ?? 0).toFixed(2)} across ${
        b.members.length
      } inferred members; ${b.stats[0]?.strong ?? 0} of them at ${STRONG}+`,
    }))

    const worstTwo = worst.stats.slice(0, 2)
    const zeroStrong = worstTwo.filter((s) => s.strong === 0)

    const headline =
      `${worst.body} carries the widest skills gap, averaging ${worst.overall.toFixed(
        2,
      )} across every skill: ${list(
        worstTwo.map((s) => `${s.skill} at ${s.mean.toFixed(2)}`),
      )} across its ${worst.members.length} inferred members` +
      (zeroStrong.length > 0
        ? `, with no member at ${STRONG} or above in ${list(zeroStrong.map((s) => s.skill))}.`
        : `, though at least one member reaches ${STRONG} in each.`)

    const rows: (string | number | null)[][] = []
    for (const b of ranked) {
      for (const s of b.stats.slice(0, 3)) {
        rows.push([b.body, b.members.length, s.skill, s.mean, s.strong, s.weak])
      }
    }

    const caveats: string[] = [
      SELF_ASSESSMENT_CAVEAT,
      'There is no membership roster in the dataset: membership is inferred from which directors have eligibility rows for each body.',
    ]
    for (const b of ranked) {
      if (b.partial.length > 0) {
        caveats.push(
          `${b.body} met ${b.meetings} times but ${b.partial.length} inferred member${
            b.partial.length === 1 ? ' does' : 's do'
          } not have a row for every one of those meetings, so its composition probably changed during the period.`,
        )
      }
      if (b.members.length < 5) {
        caveats.push(
          `${b.body} has ${b.members.length} inferred members, so one director moves any skill mean by ${round2(
            1 / Math.max(b.members.length, 1),
          )} points.`,
        )
      }
    }
    const onMultiple = dataset.skills.filter(
      (d) =>
        perBody.filter((b) => b.members.includes(d.director_name)).length > 1,
    )
    if (onMultiple.length > 0) {
      caveats.push(
        `${onMultiple.length} director${
          onMultiple.length === 1 ? ' sits' : 's sit'
        } on more than one of these bodies and are counted in each.`,
      )
    }

    return {
      tool: 'committee_skills_gaps',
      headline,
      chart: {
        kind: 'bar',
        title: 'Skills coverage by body, weakest first',
        xLabel: 'Body',
        yLabel: 'Mean score (1-5)',
        unit: 'score',
        points,
        seriesLabel: 'Mean across all skills',
        series2Label: 'Weakest single skill',
        reference: { value: 3, label: 'Working knowledge (3)' },
      },
      table: {
        columns: [
          'Body',
          'Inferred members',
          'Skill',
          'Mean',
          `Members at ${STRONG}+`,
          `Members at ${WEAK} or below`,
        ],
        rows,
      },
      assumptions: [
        "A body's gap is ranked on its mean across all skills, with its single weakest skill shown alongside. Ranking on the weakest skill alone puts a different body first, so the choice of metric changes the answer.",
        `"Strong" is ${STRONG} or above and a "gap" is ${WEAK} or below; the dataset defines neither.`,
        'Only the three weakest skills per body are tabulated, to keep the table readable.',
      ],
      caveats,
      provenance: {
        asAt: dataset.asAt,
        sources: [...SOURCES, 'attendance.json'],
        rowsConsidered: dataset.skills.length * dataset.skillNames.length,
        derivation:
          `Membership of each of the ${bodies.length} bodies was inferred from distinct director names in that ` +
          "body's eligibility rows, then each skill column was averaged across those members only.",
      },
    }
  },
}

export const SKILLS_TOOLS: ToolDefinition[] = [skillsGaps, gapCoverage, committeeSkillsGaps]
