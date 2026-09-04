import type {
  BoardAction,
  DataPoint,
  Dataset,
  ToolDefinition,
  ToolResult,
} from '@/lib/types'
import { choice, daysBetween, list, matchOne, num, pct, strOr } from '@/lib/dataset/loader'

// Action-log tools.
//
// The governing rule here: `status` is hand-typed by the secretariat and is not
// always right. Overdue is DERIVED from the dates (due_date < as_at and not
// complete) and reported alongside the recorded count, with the disagreement
// described from the actual numbers — it can run in either direction.

const SOURCES = ['actions.json']

/** due_date < as_at AND not complete. The honest definition. */
function isDerivedOverdue(a: BoardAction, asAt: string): boolean {
  return a.due_date < asAt && a.status !== 'complete'
}

function isUnresolved(a: BoardAction): boolean {
  return a.status !== 'complete'
}

/**
 * `owner` is a JOB TITLE, not a director. The only join available is against
 * the `role` column of the skills audit, and it usually misses. Returns the
 * director name only on an exact, case-insensitive role match.
 */
function resolveOwner(dataset: Dataset, owner: string): string | null {
  const want = owner.trim().toLowerCase()
  // find() would return the FIRST director holding the role, and roles are not
  // unique: six directors in this dataset hold "Trustee". An action owned by
  // "Trustee" would then be attributed to one named person out of six who
  // could equally own it — the same wrong-attribution bug that was fixed in
  // disagreement.ts, arrived at from a different direction.
  //
  // Ambiguity is unresolved, not a guess.
  const hits = dataset.skills.filter((s) => s.role.trim().toLowerCase() === want)
  return hits.length === 1 ? hits[0].director_name : null
}

/**
 * Returns null when there is nothing to qualify.
 *
 * With an empty result this produced `"owner" is a job title, not a director:
 * 0 of 0 distinct owners in this answer cannot be resolved ... so these bars
 * are roles, not people` — describing bars that do not exist, in an answer with
 * no owners in it.
 */
function ownerCaveat(dataset: Dataset, actions: BoardAction[]): string | null {
  const owners = [...new Set(actions.map((a) => a.owner))]
  if (owners.length === 0) return null

  const resolved: string[] = []
  const unresolved: string[] = []
  for (const owner of owners) {
    const name = resolveOwner(dataset, owner)
    if (name === null) unresolved.push(owner)
    else resolved.push(`${owner} is ${name}`)
  }

  // Says WHICH owners have a name and why the rest do not, because "N of M
  // cannot be resolved" prompted the obvious question and did not answer it:
  // the reason is that no director in the skills audit holds that role, which
  // is a fact about the data rather than a shortcoming of the join.
  const parts = [
    `"owner" is a job title, not a director.`,
    resolved.length > 0
      ? `${list(resolved)}.`
      : 'None of them matches a director in the skills audit.',
  ]
  if (unresolved.length > 0) {
    parts.push(
      `No director holds ${list(unresolved.map((o) => `"${o}"`))}, so ` +
        `${unresolved.length === 1 ? 'that owner is' : 'those owners are'} shown as ` +
        'the role recorded in the log and nothing more.',
    )
  }
  return parts.join(' ')
}

/** Drops a caveat that had nothing to say, so callers can spread it inline. */
function maybe(caveat: string | null): string[] {
  return caveat ? [caveat] : []
}

function groupKey(a: BoardAction, groupBy: string): string {
  if (groupBy === 'committee') return a.committee_or_board
  if (groupBy === 'owner_type') return a.owner_type
  return a.owner
}

// ------------------------------------------------------------ Q5

export const overdueActions: ToolDefinition = {
  name: 'overdue_actions',
  description:
    'Overdue actions derived from due dates against the as-at date, compared with the ' +
    'count the log records as overdue, grouped by owner or committee. Use for "what is ' +
    'overdue and who owns it".',
  parameters: {
    group_by: {
      type: 'string',
      description: 'Group the bars by action owner or by the body that raised the action.',
      enum: ['owner', 'committee'],
      default: 'owner',
    },
    owner: {
      type: 'string',
      description:
        'Restrict to actions owned by this job title, for questions like "what is overdue ' +
        'for the finance lead". Use the wording the question uses; owners are roles, not ' +
        'people, and the roles differ per organisation. Omit for all owners.',
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const groupBy = choice(args.group_by, ['owner', 'committee'] as const, 'owner')
    const asAt = dataset.asAt

    // Without a filter the tool answered a question naming one owner with every
    // overdue action in the log: the right data at the wrong scope,
    // which reads as an answer and buries the one row that was asked for.
    const wantedOwner = strOr(args.owner, '')
    const knownOwners = [...new Set(dataset.actions.actions.map((a) => a.owner))].sort()
    const matchedOwner = wantedOwner ? matchOne(knownOwners, wantedOwner) : null

    if (wantedOwner && !matchedOwner) {
      return {
        tool: 'overdue_actions',
        headline: `No action in the log is owned by "${wantedOwner}". The owners on record are ${list(
          knownOwners,
        )}.`,
        chart: null,
        table: null,
        assumptions: [
          'Owners are matched against the job titles recorded in the action log, not against director names.',
        ],
        caveats: [
          'This is a nil return caused by an owner that does not appear in the log, not a finding that nothing is overdue.',
        ],
        provenance: {
          asAt,
          sources: ['actions.json'],
          rowsConsidered: dataset.actions.actions.length,
          derivation: `Compared "${wantedOwner}" against the ${knownOwners.length} owners recorded in the action log and found no match.`,
        },
      }
    }

    const all = matchedOwner
      ? dataset.actions.actions.filter((a) => a.owner === matchedOwner)
      : dataset.actions.actions

    const derived = all.filter((a) => isDerivedOverdue(a, asAt))
    const recorded = all.filter((a) => a.status === 'overdue')
    const derivedIds = new Set(derived.map((a) => a.action_id))
    const recordedIds = new Set(recorded.map((a) => a.action_id))
    const onlyDerived = derived.filter((a) => !recordedIds.has(a.action_id))
    const onlyRecorded = recorded.filter((a) => !derivedIds.has(a.action_id))

    const groups = new Map<string, { derived: number; recorded: number }>()
    for (const a of derived) {
      const k = groupKey(a, groupBy)
      const cur = groups.get(k) ?? { derived: 0, recorded: 0 }
      cur.derived += 1
      groups.set(k, cur)
    }
    for (const a of recorded) {
      const k = groupKey(a, groupBy)
      const cur = groups.get(k) ?? { derived: 0, recorded: 0 }
      cur.recorded += 1
      groups.set(k, cur)
    }

    const points: DataPoint[] = [...groups.entries()]
      .map(([label, v]) => ({
        label,
        value: v.derived,
        value2: v.recorded,
        highlight: v.derived > v.recorded,
        detail: `${v.derived} overdue by date, ${v.recorded} recorded as overdue in the log`,
      }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))

    // Generated from the comparison, never templated: the log can be short OR long.
    let disagreement: string
    if (derived.length === recorded.length && onlyDerived.length === 0) {
      disagreement = 'the log agrees exactly'
    } else {
      const parts: string[] = []
      if (onlyDerived.length > 0) {
        parts.push(
          `${onlyDerived.length} past their due date but still logged as ${list(
            [...new Set(onlyDerived.map((a) => `"${a.status}"`))],
          )} (${list(onlyDerived.map((a) => a.action_id))})`,
        )
      }
      if (onlyRecorded.length > 0) {
        parts.push(
          `${onlyRecorded.length} recorded as overdue but not past due by ${asAt} (${list(
            onlyRecorded.map((a) => a.action_id),
          )})`,
        )
      }
      disagreement = `the two disagree on ${list(parts)}`
    }

    const owners = [...new Set(derived.map((a) => a.owner))]
    const unresolvable = owners.filter((o) => resolveOwner(dataset, o) === null).length

    const topGroup = points[0]

    return {
      tool: 'overdue_actions',
      headline: matchedOwner
        ? `${derived.length} of ${matchedOwner}'s ${all.length} action${
            all.length === 1 ? '' : 's'
          } ${derived.length === 1 ? 'is' : 'are'} overdue against ${asAt}` +
          (derived.length > 0
            ? `: ${list(derived.map((a) => `${a.action_id}, ${a.description}`))}.`
            : `, so nothing of theirs is outstanding past its due date.`)
        : `${derived.length} action${derived.length === 1 ? ' is' : 's are'} overdue when derived from due dates against ${asAt}, ` +
          `against ${recorded.length} the log records as overdue, and ${disagreement}` +
          // A group can exist with a derived count of zero, because the groups
          // are also populated from the recorded-overdue set. Sorting by
          // derived count then put a zero at the top and the sentence named it
          // as "heaviest" — contradicting the chart beside it, which showed
          // another group with more.
          (topGroup && topGroup.value > 0
            ? `; the heaviest ${groupBy} is ${topGroup.label} with ${topGroup.value}.`
            : '.'),
      // Filtered to one owner, the chart is a single bar — padding, not a
      // finding. The listed actions are the answer.
      // Also no chart when nothing is overdue: an empty bar chart with labelled
      // axes reads as a measurement that came out at zero.
      chart: matchedOwner || points.length === 0 ? null : {
        kind: 'bar',
        title: `Overdue actions by ${groupBy}`,
        xLabel: groupBy === 'owner' ? 'Owner (job title)' : 'Body that raised it',
        yLabel: 'Actions',
        unit: 'count',
        points,
        seriesLabel: 'Derived from due dates',
        series2Label: 'Recorded as overdue in the log',
      },
      table: {
        columns: [
          'Action',
          'Description',
          'Owner (job title)',
          'Body',
          'Due',
          'Days past due',
          'Recorded status',
        ],
        rows: derived
          .slice()
          .sort((a, b) => a.due_date.localeCompare(b.due_date))
          .map((a) => [
            a.action_id,
            a.description,
            a.owner,
            a.committee_or_board,
            a.due_date,
            daysBetween(a.due_date, asAt),
            a.status,
          ]),
      },
      assumptions: [
        `Overdue is derived as due_date earlier than the as-at date of ${asAt} and status not "complete".`,
        'The recorded count is the raw status field as typed into the log, shown for comparison rather than used as the answer.',
      ],
      caveats: [
        // A nil result still needs qualifying, or it reads as a settled fact
        // needing none. What it needs is the derivation, because "nothing is
        // overdue" here means nothing is past its due date — which is not the
        // same as the log saying so.
        ...(derived.length === 0
          ? [
              `Overdue is derived from due dates against ${asAt}, not read from the log's status field, which records ${recorded.length} as overdue.`,
            ]
          : []),
        // Both of these describe bars that are OWNERS. Grouped by committee the
        // chart shows bodies, and the caveat still said "these bars are roles,
        // not people" — describing a chart the reader was not looking at.
        ...(groupBy === 'owner' ? maybe(ownerCaveat(dataset, derived)) : []),
        // Both of these describe a set that may be empty. With nothing overdue
        // they read "0 of the 0 owners ... cannot be matched" and "Only 0 rows
        // are in scope, so single actions dominate the shape of the chart" —
        // qualifying figures that do not exist, about a chart that is not drawn.
        ...(groupBy === 'owner' && owners.length > 0
          ? [
              `${unresolvable} of the ${owners.length} owners holding a derived-overdue action cannot be matched to a person, so no individual can be named from this data alone.`,
            ]
          : []),
        ...(derived.length > 0 && derived.length < 5
          ? [`Only ${derived.length} rows are in scope, so single actions dominate the shape of the chart.`]
          : []),
      ],
      provenance: {
        asAt,
        sources: SOURCES,
        rowsConsidered: all.length,
        derivation:
          `Of ${all.length} actions, ${derived.length} have a due date before ${asAt} and a status other than ` +
          `"complete"; separately, ${recorded.length} carry the literal status "overdue".`,
      },
    }
  },
}

// ------------------------------------------------------------ Q6

export const longestOverdue: ToolDefinition = {
  name: 'longest_overdue',
  description:
    'Overdue actions ranked by days past their due date, measured against the dataset ' +
    'as-at date. Use for "what has been outstanding the longest".',
  parameters: {
    limit: {
      type: 'number',
      description: 'How many actions to show. Ties at the cut-off are all included.',
      default: 10,
      min: 1,
      max: 40,
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const limit = Math.max(1, Math.round(num(args.limit, 10)))
    const asAt = dataset.asAt
    const all = dataset.actions.actions

    const ranked = all
      .filter((a) => isDerivedOverdue(a, asAt))
      .map((a) => ({ action: a, days: daysBetween(a.due_date, asAt) }))
      .sort(
        (x, y) => y.days - x.days || x.action.action_id.localeCompare(y.action.action_id),
      )

    // A tie at the cut-off is not a licence to pick arbitrarily. Everything level
    // with the last included row is shown too, and the headline says so.
    let shown = ranked
    let truncated = false
    if (ranked.length > limit) {
      const cutoff = ranked[limit - 1].days
      shown = ranked.filter((r) => r.days >= cutoff)
      truncated = true
    }
    const tieAtCut = truncated
      ? shown.filter((r) => r.days === shown[shown.length - 1].days)
      : []

    const points: DataPoint[] = shown.map((r) => ({
      label: r.action.action_id,
      value: r.days,
      highlight: r.action.times_deferred > 0,
      detail: `${r.action.description} — owner ${r.action.owner}, due ${r.action.due_date}, logged "${r.action.status}"`,
    }))

    let headline: string
    if (shown.length === 0) {
      headline = `Nothing is past its due date as at ${asAt}.`
    } else {
      const top = shown[0]
      // A tie at the TOP is named, not resolved by action id.
      //
      // The tie machinery below only looked at the cut-off, so two actions
      // level at the longest overdue produced "one action is the longest
      // outstanding" with the other sitting at the same height on the chart,
      // unmentioned — the sort's `localeCompare` fallback picking a winner by
      // its identifier.
      const tiedTop = shown.filter((r) => r.days === top.days)
      const topClause =
        tiedTop.length > 1
          ? `${tiedTop.length} actions are level as the longest outstanding at ${top.days} days past due as at ${asAt} — ${list(
              tiedTop.map((r) => `${r.action.action_id} (${r.action.owner})`),
            )}.`
          : `${top.action.action_id} is the longest outstanding at ${top.days} days past due as at ${asAt}` +
            `, owned by ${top.action.owner} and still logged "${top.action.status}".`
      const tieClause =
        tieAtCut.length > 1
          ? ` ${tieAtCut.length} actions tie on ${tieAtCut[0].days} days at the cut-off (${list(
              tieAtCut.map((r) => r.action.action_id),
            )}), so all of them are shown rather than one being picked arbitrarily.`
          : ''
      headline = `${topClause}${tieClause}`
    }

    return {
      tool: 'longest_overdue',
      headline,
      chart: shown.length === 0 ? null : {
        kind: 'bar',
        title: 'Days past due',
        xLabel: 'Action',
        yLabel: 'Days past due',
        unit: 'days',
        points,
        seriesLabel: 'Days past due',
      },
      table: {
        columns: [
          'Action',
          'Description',
          'Owner (job title)',
          'Body',
          'Due',
          'Days past due',
          'Deferrals',
          'Recorded status',
        ],
        rows: shown.map((r) => [
          r.action.action_id,
          r.action.description,
          r.action.owner,
          r.action.committee_or_board,
          r.action.due_date,
          r.days,
          r.action.times_deferred,
          r.action.status,
        ]),
      },
      assumptions: [
        `Days past due are measured against the dataset as-at date of ${asAt}, not the system clock, so these figures do not drift.`,
        `Overdue means due_date before ${asAt} and status not "complete", so items the log has not caught up with are included.`,
        `A limit of ${limit} was requested; ties at the cut-off are all shown.`,
      ],
      caveats: [
        ...maybe(ownerCaveat(dataset, shown.map((r) => r.action))),
        'Age past due says nothing about effort spent; a deferred due date resets the clock the log measures.',
      ],
      provenance: {
        asAt,
        sources: SOURCES,
        rowsConsidered: all.length,
        derivation:
          `${ranked.length} actions are past due as at ${asAt}; each bar is the whole-day gap ` +
          'between its due date and the as-at date.',
      },
    }
  },
}

// ------------------------------------------------------------ Q7

export const unresolvedByCommittee: ToolDefinition = {
  name: 'unresolved_by_committee',
  description:
    'Unresolved actions per body, as both a raw count and an unresolved rate against ' +
    'what that body raised. Use for "which committee is carrying the most unresolved work".',
  parameters: {},
  required: [],
  run(dataset): ToolResult {
    const all = dataset.actions.actions
    const totalUnresolved = all.filter(isUnresolved).length

    const bodies = [...new Set(all.map((a) => a.committee_or_board))].sort()
    const stats = bodies.map((b) => {
      const own = all.filter((a) => a.committee_or_board === b)
      const unresolved = own.filter(isUnresolved).length
      return {
        body: b,
        raised: own.length,
        unresolved,
        // Ranked on the exact ratio, displayed through the canonical pct().
        //
        // These were rounded to whole numbers and then SORTED on, and byRate[0]
        // decides both the headline and which bar is highlighted. Two bodies
        // whose rates round to the same integer were therefore tied, and the
        // tie was resolved alphabetically — so the body named as carrying the
        // highest rate could be the one that does not.
        ratio: own.length > 0 ? unresolved / own.length : 0,
        rate: pct(unresolved, own.length),
        shareOfAll: pct(unresolved, totalUnresolved),
      }
    })

    const byCount = [...stats].sort((a, b) => b.unresolved - a.unresolved || a.body.localeCompare(b.body))
    const byRate = [...stats].sort((a, b) => b.ratio - a.ratio || a.body.localeCompare(b.body))
    // The only tool with no nil path: an empty action log — which buildDataset
    // accepts, because a board with nothing outstanding is a real state — read
    // byCount[0].body and threw, so the answer became "the analysis could not
    // be completed" rather than "there is nothing outstanding".
    //
    // `stats` is built from BODIES, not from unresolved rows, so it is only
    // empty when the action log itself is. A board that has cleared everything
    // still has four bodies, each with zero outstanding — and that produced a
    // full superlative over nothing: "Board leads on both measures: 0
    // unresolved actions, 0% of all 0 unresolved items, and the highest
    // unresolved rate at 0%", above a chart of four zero-height bars. The
    // guard has to be on what was COUNTED, not on what was grouped.
    if (stats.length === 0 || totalUnresolved === 0) {
      return {
        tool: 'unresolved_by_committee',
        headline:
          totalUnresolved === 0
            ? 'No unresolved actions remain in the log, so no body carries any.'
            : 'No body in the action log has any unresolved actions against it.',
        chart: null,
        table: null,
        assumptions: ['Unresolved means any status other than "complete".'],
        caveats: [
          'Nothing was in scope, so this is an absence of outstanding work rather than a finding about how it is distributed.',
        ],
        provenance: {
          asAt: dataset.asAt,
          sources: SOURCES,
          rowsConsidered: all.length,
          derivation: 'No action rows were unresolved, so no per-body figure was calculated.',
        },
      }
    }

    const topCount = byCount[0]
    const topRate = byRate[0]

    const points: DataPoint[] = byCount.map((s) => ({
      label: s.body,
      value: s.unresolved,
      value2: s.rate,
      highlight: s.body === topCount.body || s.body === topRate.body,
      detail: `${s.unresolved} unresolved of ${s.raised} raised (${s.rate}% of its own work, ${s.shareOfAll}% of all unresolved items)`,
    }))

    const headline =
      topCount.body === topRate.body
        ? `${topCount.body} leads on both measures: ${topCount.unresolved} unresolved actions, ${topCount.shareOfAll}% of all ${totalUnresolved} unresolved items, and the highest unresolved rate at ${topCount.rate}% of the ${topCount.raised} it raised.`
        : `Count and rate disagree: ${topCount.body} carries the most unresolved actions at ${topCount.unresolved} of ${totalUnresolved} (${topCount.rate}% of the ${topCount.raised} it raised), but ${topRate.body} has the worst rate at ${topRate.rate}% — ${topRate.unresolved} of only ${topRate.raised} raised.`

    const caveats: string[] = [
      'Unresolved means any status other than "complete", which pools not started, in progress and overdue.',
    ]
    for (const s of stats) {
      if (s.raised < 5) {
        caveats.push(
          `${s.body} raised only ${s.raised} action${
            s.raised === 1 ? '' : 's'
          }, so one more completion would move its rate by ${
            Math.round((100 / Math.max(s.raised, 1)) * 10) / 10
          } percentage points.`,
        )
      }
    }

    return {
      tool: 'unresolved_by_committee',
      headline,
      chart: {
        kind: 'bar',
        title: 'Unresolved actions by body: count against rate',
        xLabel: 'Body that raised the action',
        yLabel: 'Unresolved actions',
        unit: 'count',
        points,
        seriesLabel: 'Unresolved actions (count)',
        series2Label: 'Unresolved rate, % of that body\'s own actions',
      },
      table: {
        columns: [
          'Body',
          'Raised',
          'Unresolved',
          'Unresolved rate % (of its own actions)',
          'Share % of all unresolved',
        ],
        rows: byCount.map((s) => [s.body, s.raised, s.unresolved, s.rate, s.shareOfAll]),
      },
      assumptions: [
        'Two denominators are reported because they answer different questions: the rate divides by what that body raised, the share divides by all unresolved work.',
        'Actions are attributed to the body that raised them, which is not necessarily the body now overseeing them.',
      ],
      caveats,
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: all.length,
        derivation:
          `Of ${all.length} actions, ${totalUnresolved} have a status other than "complete". ` +
          'Each body is shown both as a count and as a percentage of the actions it raised.',
      },
    }
  },
}

// ------------------------------------------------------------ Q8

export const actionsDistribution: ToolDefinition = {
  name: 'actions_distribution',
  description:
    'How unresolved work is distributed across owners, bodies or owner types, and whether ' +
    'it is concentrated. Use for "is outstanding work concentrated in one owner" or ' +
    '"is it on the board or the executive".',
  parameters: {
    group_by: {
      type: 'string',
      description: 'Dimension to distribute across.',
      enum: ['owner', 'committee', 'owner_type'],
      default: 'owner',
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const groupBy = choice(args.group_by, ['owner', 'committee', 'owner_type'] as const, 'owner')
    const asAt = dataset.asAt
    const all = dataset.actions.actions
    const unresolved = all.filter(isUnresolved)

    const groups = new Map<string, { total: number; overdue: number }>()
    for (const a of unresolved) {
      const k = groupKey(a, groupBy)
      const cur = groups.get(k) ?? { total: 0, overdue: 0 }
      cur.total += 1
      if (isDerivedOverdue(a, asAt)) cur.overdue += 1
      groups.set(k, cur)
    }

    const stats = [...groups.entries()]
      .map(([label, v]) => ({
        label,
        total: v.total,
        overdue: v.overdue,
        notYetDue: v.total - v.overdue,
        share: pct(v.total, unresolved.length),
      }))
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))

    const points: DataPoint[] = stats.map((s) => ({
      label: s.label,
      value: s.total,
      value2: s.overdue,
      highlight: s.total === (stats[0]?.total ?? 0),
      detail: `${s.total} unresolved (${s.share}% of all unresolved) — ${s.overdue} already past due, ${s.notYetDue} not yet due`,
    }))

    const top = stats[0]
    const tiedTop = stats.filter((s) => s.total === (top?.total ?? -1))

    // The board/executive split only exists when owner_type distinguishes them.
    const typeCounts = new Map<string, number>()
    for (const a of all) typeCounts.set(a.owner_type, (typeCounts.get(a.owner_type) ?? 0) + 1)
    const nonExec = [...typeCounts.entries()].filter(([t]) => t !== 'executive')
    const nonExecTotal = nonExec.reduce((acc, [, n]) => acc + n, 0)

    let headline: string
    if (stats.length === 0) {
      headline = 'No unresolved actions remain in the log.'
    } else if (tiedTop.length > 1) {
      headline = `Unresolved work is spread rather than concentrated: ${tiedTop.length} ${groupBy}s tie at the top with ${top.total} of ${unresolved.length} each (${list(
        tiedTop.map((s) => s.label),
      )}), and ${nonExecTotal} of all ${all.length} actions sit with someone other than an executive.`
    } else {
      headline = `${top.label} holds ${top.total} of the ${unresolved.length} unresolved actions — ${top.share}% of the outstanding work, ${top.overdue} of it already past due — while only ${nonExecTotal} of all ${all.length} actions are owned outside the executive.`
    }

    const caveats: string[] = [
      ...maybe(ownerCaveat(dataset, unresolved)),
      'Counts treat every action as equal weight; the log records priority but not effort or size.',
    ]
    // One sentence covering every thin group, rather than one caveat each.
    // This loop used to `break` after the first, so the largest small group was
    // qualified and every smaller one — the ones a single completion moves
    // furthest — was silently left unqualified.
    const thin = stats.filter((s) => s.total < 5)
    if (thin.length > 0) {
      const move =
        unresolved.length > 0 ? Math.round((100 / unresolved.length) * 10) / 10 : 0
      caveats.push(
        `${list(
          thin.map((s) => `${s.label} (${s.total})`),
        )} hold fewer than 5 unresolved rows each, so one completion moves any of their shares by about ${move} percentage points.`,
      )
    }

    return {
      tool: 'actions_distribution',
      headline,
      // No chart when there is nothing to plot. An empty chart with labelled
      // axes reads as a measurement that came out at zero.
      chart: stats.length === 0 ? null : {
        kind: 'bar',
        title: `Unresolved actions by ${groupBy.replace('_', ' ')}`,
        xLabel: groupBy === 'owner' ? 'Owner (job title)' : groupBy.replace('_', ' '),
        yLabel: 'Unresolved actions',
        unit: 'count',
        points,
        seriesLabel: 'Unresolved',
        series2Label: 'Of which already past due',
      },
      table: {
        columns: ['Group', 'Unresolved', 'Past due', 'Not yet due', 'Share % of unresolved'],
        rows: stats.map((s) => [s.label, s.total, s.overdue, s.notYetDue, s.share]),
      },
      assumptions: [
        'Unresolved means any status other than "complete".',
        // The values are read from the data; the SPLIT is not. Anything whose
        // owner_type is not literally "executive" is counted as non-executive,
        // so a dataset using different words would put every action on the
        // non-executive side while this sentence claimed the split came from
        // the data. Say what the code actually did.
        // Omitted when there are none: "Owner types present in this dataset
        // are none" is a sentence about a distinction that was never drawn.
        ...(typeCounts.size > 0
          ? [
              `Owner types present in this dataset are ${list([
                ...typeCounts.keys(),
              ])}. Anything not recorded as "executive" is counted as non-executive.`,
            ]
          : []),
      ],
      caveats,
      provenance: {
        asAt,
        sources: SOURCES,
        rowsConsidered: all.length,
        derivation:
          `${unresolved.length} of ${all.length} actions are not complete; each is attributed to its ${groupBy} ` +
          `and split by whether its due date has already passed ${asAt}.`,
      },
    }
  },
}

// ------------------------------------------------------------ Q9

export const deferredMoreThanOnce: ToolDefinition = {
  // Renamed from `deferred_more_than_once`, which named one DEFAULT rather
  // than what the tool does: it has always been a band query with the lower
  // bound exposed. Safe to rename because nothing resolves a stored tool name
  // against this registry — `pins.ts` only checks it is a string, and a pinned
  // card renders its frozen result — so no saved card is orphaned.
  name: 'deferred_actions',
  description:
    'Actions whose due date has been formally moved, filtered by how many times. ' +
    'Use for "what keeps slipping", "what has been deferred repeatedly", and for an ' +
    'EXACT or BANDED count: set min_deferrals and max_deferrals to the same number ' +
    'for "deferred exactly twice", or a range for "deferred two or three times". ' +
    'Leave max_deferrals unset for "N or more".',
  parameters: {
    min_deferrals: {
      type: 'number',
      description: 'Fewest recorded deferrals to include. 1 means "deferred at all".',
      default: 2,
      min: 1,
      max: 20,
    },
    // WITHOUT THIS, "deferred exactly twice" WAS ANSWERED AS "two or more".
    // On this dataset those are the same set, because nothing has slipped
    // three times — so the answer looked right and was reasoning wrongly. On a
    // dataset where something had, it would have included it and read
    // perfectly plausibly. Every numeric parameter in this tool set was a
    // minimum or a limit; none could express "exactly" or "at most".
    max_deferrals: {
      type: 'number',
      description:
        'Most recorded deferrals to include. Set equal to min_deferrals for an exact ' +
        'count. Omit for no upper bound.',
      min: 1,
      max: 20,
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const min = Math.max(1, Math.round(num(args.min_deferrals, 2)))
    // Absent rather than defaulted: "no upper bound" is a different thing from
    // any particular number, and clamping an absent value to 20 would make the
    // headline claim a band the reader never asked for.
    const rawMax = args.max_deferrals
    const max =
      rawMax === undefined || rawMax === null
        ? null
        : Math.max(min, Math.min(20, Math.round(num(rawMax, min))))
    const exact = max !== null && max === min

    /** The band, in the words the headline and the assumption both use. */
    const band = exact
      ? `exactly ${min} time${min === 1 ? '' : 's'}`
      : max !== null
        ? `between ${min} and ${max} times`
        : `${min} or more times`

    const asAt = dataset.asAt
    const all = dataset.actions.actions

    const hits = all
      .filter((a) => a.times_deferred >= min && (max === null || a.times_deferred <= max))
      .sort(
        (a, b) => b.times_deferred - a.times_deferred || a.action_id.localeCompare(b.action_id),
      )

    const maxDeferrals = all.reduce((m, a) => Math.max(m, a.times_deferred), 0)
    const stillOpen = hits.filter(isUnresolved).length

    let headline: string
    if (hits.length === 0) {
      headline = `Nothing has been deferred ${band}; the most any action has slipped is ${maxDeferrals}.`
    } else if (hits.length === 1) {
      const a = hits[0]
      headline = `One action has been deferred ${a.times_deferred} times — ${a.action_id}, ${a.description} — owned by ${a.owner} and still logged "${a.status}".`
    } else {
      headline = `${hits.length} actions have been deferred ${band} (${list(
        hits.map((a) => `${a.action_id} at ${a.times_deferred}`),
      )}), ${stillOpen} of them still unresolved, and nothing in the log has slipped more than ${maxDeferrals} times.`
    }

    // Two rows is a list, not a chart. Charting it would be padding.
    const chartWorthwhile = hits.length >= 5

    return {
      tool: 'deferred_actions',
      headline,
      chart: chartWorthwhile
        ? {
            kind: 'bar',
            title: `Actions deferred ${band}`,
            xLabel: 'Action',
            yLabel: 'Deferrals',
            unit: 'count',
            points: hits.map((a) => ({
              label: a.action_id,
              value: a.times_deferred,
              highlight: isUnresolved(a),
              detail: `${a.description} — owner ${a.owner}, due ${a.due_date}, logged "${a.status}"`,
            })),
            seriesLabel: 'Times deferred',
          }
        : null,
      table: {
        columns: [
          'Action',
          'Description',
          'Owner (job title)',
          'Body',
          'Deferrals',
          'Due',
          'Status',
          'Linked risk',
        ],
        rows: hits.map((a) => [
          a.action_id,
          a.description,
          a.owner,
          a.committee_or_board,
          a.times_deferred,
          a.due_date,
          a.status,
          a.linked_risk,
        ]),
      },
      assumptions: [
        // States the band actually applied, not the phrase the reader used. A
        // wrong assumption sentence is worse than none, and this is the line
        // that tells them whether "exactly" was honoured.
        `Counted as a recorded deferral count of ${band}.`,
        'The log records how often a due date moved, but not who agreed to move it or why.',
      ],
      caveats: [
        // An empty result still needs its caveat. Without this the answer
        // renders with no "worth knowing" block at all, which reads as though
        // the figure needed no qualification rather than as a nil return.
        ...(hits.length === 0
          ? [
              `A nil return is not the same as a clean record: all ${all.length} actions were checked, and ${
                all.filter((a) => a.times_deferred > 0).length
              } have had a due date moved at least once — just none ${band}.`,
            ]
          : []),
        ...(hits.length > 0 && hits.length < 5
          ? [
              `Only ${hits.length} action${
                hits.length === 1 ? '' : 's'
              } meet the threshold, which is a list rather than a distribution, so it is shown as a table.`,
            ]
          : []),
        ...(hits.length > 0 ? maybe(ownerCaveat(dataset, hits)) : []),
      ],
      provenance: {
        asAt,
        sources: SOURCES,
        rowsConsidered: all.length,
        derivation: `Of ${all.length} actions, ${hits.length} record times_deferred of ${min} or more.`,
      },
    }
  },
}

export const ACTION_TOOLS: ToolDefinition[] = [
  overdueActions,
  longestOverdue,
  unresolvedByCommittee,
  actionsDistribution,
  deferredMoreThanOnce,
]
