import type {
  AttendanceRecord,
  DataPoint,
  Dataset,
  ToolDefinition,
  ToolResult,
} from '@/lib/types'
import { allBodies, committeesOf, pct } from '@/lib/dataset/loader'

// Attendance tools.
//
// Two rules govern every number in this file:
//   1. Only `status === 'present'` is attendance. `apologies` means advance
//      notice was given, but the seat was still empty.
//   2. Every director's denominator is their OWN eligibility rows. Committee
//      rows exist only for that committee's members, so dividing by the total
//      meeting count overstates the absentees and understates the members.

const SOURCES = ['attendance.json']

function isPresent(r: AttendanceRecord): boolean {
  return r.status === 'present'
}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function choice<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

/** Records for one body, or all records when no body is given. */
function scope(dataset: Dataset, body?: string): AttendanceRecord[] {
  const rows = dataset.attendance.records
  return body ? rows.filter((r) => r.body === body) : rows
}

/** Resolves a caller-supplied body name against the bodies actually in the data. */
function resolveBody(dataset: Dataset, raw: unknown): string | undefined {
  const wanted = str(raw)
  if (!wanted) return undefined
  const found = allBodies(dataset).find((b) => b.toLowerCase() === wanted.toLowerCase())
  return found ?? wanted
}

interface DirectorRate {
  name: string
  eligible: number
  attended: number
  rate: number
}

function ratesByDirector(rows: AttendanceRecord[]): DirectorRate[] {
  const acc = new Map<string, { eligible: number; attended: number }>()
  for (const r of rows) {
    const cur = acc.get(r.director_name) ?? { eligible: 0, attended: 0 }
    cur.eligible += 1
    if (isPresent(r)) cur.attended += 1
    acc.set(r.director_name, cur)
  }
  return [...acc.entries()]
    .map(([name, v]) => ({
      name,
      eligible: v.eligible,
      attended: v.attended,
      rate: pct(v.attended, v.eligible),
    }))
    .sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name))
}

function list(items: string[]): string {
  if (items.length === 0) return 'none'
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ------------------------------------------------------------ Q1

export const attendanceBelowThreshold: ToolDefinition = {
  name: 'attendance_below_threshold',
  description:
    'Directors whose overall attendance falls below a threshold, with a per-body ' +
    'breakdown for each of them. Use for "who is below our attendance threshold" ' +
    'or "who is not turning up".',
  parameters: {
    threshold: {
      type: 'number',
      description:
        'Attendance percentage below which a director is flagged. Between 1 and 100. ' +
        'Omit it unless the question names a figure; the default is the one the answer discloses.',
      default: 80,
      min: 1,
      max: 100,
    },
    body: {
      type: 'string',
      description: 'Optional: restrict to one board or committee.',
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const threshold = num(args.threshold, 80)
    const body = resolveBody(dataset, args.body)
    const rows = scope(dataset, body)
    const rates = ratesByDirector(rows)

    // No threshold is defined anywhere in the dataset, so a threshold that
    // flags fewer than two directors would produce a degenerate chart. Fall
    // back to the bottom quartile, and say so in the assumptions.
    let flagged = rates.filter((d) => d.rate < threshold)
    let widened = false
    if (flagged.length < 2 && rates.length > 0) {
      const quartile = Math.max(2, Math.ceil(rates.length / 4))
      flagged = rates.slice(0, quartile)
      widened = true
    }

    // "No director is below the threshold" and "there are no directors here"
    // are opposite findings, and this returned the first for both. Asked about
    // a body that does not exist, it issued a clean bill of health — a reader
    // would have concluded attendance there was fine.
    if (rates.length === 0) {
      const known = allBodies(dataset)
      const unknownBody = body !== undefined && !known.some((b) => b === body)
      return {
        tool: 'attendance_below_threshold',
        headline: unknownBody
          ? `No body called "${body}" appears in the attendance records, so no attendance rate can be computed for it. The bodies present are ${list(known)}.`
          : `No attendance rows${body ? ` for ${body}` : ''} were found, so no director's rate can be computed.`,
        chart: null,
        table: null,
        assumptions: [
          'Body names were matched exactly as written in the attendance records; the dataset defines no aliases.',
        ],
        caveats: [
          'Nothing matched, so this is an absence of data rather than a finding about attendance.',
        ],
        provenance: {
          asAt: dataset.asAt,
          sources: SOURCES,
          rowsConsidered: rows.length,
          derivation: `No eligibility rows matched${body ? ` the body "${body}"` : ''}, so no rate was calculated.`,
        },
      }
    }

    const points: DataPoint[] = flagged.map((d) => ({
      label: d.name,
      value: d.rate,
      highlight: d.rate < threshold,
      detail: `${d.attended} of ${d.eligible} meetings attended`,
    }))

    // Per-body split for the flagged directors: the sharper story is usually
    // that a low overall rate is concentrated in one body.
    const splitRows: (string | number | null)[][] = []
    let sharpest: { name: string; low: string; lowRate: number; high: string; highRate: number } | null =
      null
    for (const d of flagged) {
      const bodies = body ? [body] : committeesOf(dataset, d.name)
      const perBody = bodies.map((b) => {
        const own = rows.filter((r) => r.director_name === d.name && r.body === b)
        return {
          body: b,
          eligible: own.length,
          attended: own.filter(isPresent).length,
          rate: pct(own.filter(isPresent).length, own.length),
        }
      })
      for (const pb of perBody) {
        splitRows.push([d.name, pb.body, pb.attended, pb.eligible, pb.rate])
      }
      if (perBody.length > 1) {
        const sorted = [...perBody].sort((a, b) => a.rate - b.rate)
        const spread = sorted[sorted.length - 1].rate - sorted[0].rate
        const bestSpread = sharpest ? sharpest.highRate - sharpest.lowRate : -1
        if (spread > bestSpread) {
          sharpest = {
            name: d.name,
            low: sorted[0].body,
            lowRate: sorted[0].rate,
            high: sorted[sorted.length - 1].body,
            highRate: sorted[sorted.length - 1].rate,
          }
        }
      }
    }

    const scopeLabel = body ? ` at ${body}` : ''
    let headline: string
    if (flagged.length === 0) {
      headline = `No director is below ${threshold}%${scopeLabel}; the lowest rate is ${
        rates.length ? `${rates[0].rate}% (${rates[0].name})` : 'not computable'
      }.`
    } else {
      const belowCount = rates.filter((d) => d.rate < threshold).length
      const lead =
        belowCount === 0
          ? `No director is below ${threshold}%${scopeLabel}, so the chart shows the bottom ${flagged.length} instead`
          : `${belowCount} director${belowCount === 1 ? ' is' : 's are'} below ${threshold}%${scopeLabel} — ${list(
              rates.filter((d) => d.rate < threshold).map((d) => `${d.name} ${d.rate}%`),
            )}`
      headline = sharpest
        ? `${lead}, and ${sharpest.name}'s is concentrated at ${sharpest.low} level — ${sharpest.lowRate}% there against ${sharpest.highRate}% at ${sharpest.high}.`
        : `${lead}.`
    }

    const caveats: string[] = [
      'Committee membership is inferred from eligibility rows, not from a membership roster field.',
    ]
    for (const d of flagged) {
      if (d.eligible < 5) {
        caveats.push(
          `${d.name} has only ${d.eligible} eligibility rows in scope; one more miss would move their rate by ${
            Math.round((100 / d.eligible) * 10) / 10
          } percentage points.`,
        )
      }
    }

    return {
      tool: 'attendance_below_threshold',
      headline,
      chart: {
        kind: 'bar',
        title: `Attendance below ${threshold}%${scopeLabel}`,
        xLabel: 'Director',
        yLabel: 'Attendance',
        unit: 'percent',
        points,
        seriesLabel: 'Present rate',
        reference: { value: threshold, label: `${threshold}% threshold` },
      },
      table: {
        columns: ['Director', 'Body', 'Present', 'Eligible', 'Present rate %'],
        rows: splitRows,
      },
      assumptions: [
        `No attendance threshold is stated anywhere in the dataset; ${threshold}% was used.`,
        'Apologies count as non-attendance: only a status of "present" counts towards the rate.',
        ...(widened
          ? [`Fewer than two directors fell below ${threshold}%, so the bottom quartile is shown instead.`]
          : []),
      ],
      caveats,
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: rows.length,
        derivation:
          'For each director, present rate = rows with status "present" divided by that ' +
          "director's own eligibility rows. Denominators differ by director because " +
          'committee rows exist only for that committee\'s members.',
      },
    }
  },
}

// ------------------------------------------------------------ Q2

export const attendanceByMeeting: ToolDefinition = {
  name: 'attendance_by_meeting',
  description:
    'Attendance rate for each meeting in date order, for spotting a period that ' +
    'sat materially below the year\'s norm. Use for "how has attendance moved over ' +
    'the year" or "were there meetings where attendance dropped".',
  parameters: {
    body: { type: 'string', description: 'Optional: restrict to one board or committee.' },
  },
  required: [],
  run(dataset, args): ToolResult {
    const body = resolveBody(dataset, args.body)
    const rows = scope(dataset, body)

    const meetings = dataset.attendance.meetings
      .filter((m) => (body ? m.body === body : true))
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.meeting_id.localeCompare(b.meeting_id))

    const overallRate = pct(rows.filter(isPresent).length, rows.length)

    const series = meetings.map((m) => {
      const own = rows.filter((r) => r.meeting_id === m.meeting_id)
      const attended = own.filter(isPresent).length
      return {
        meeting: m,
        eligible: own.length,
        attended,
        rate: pct(attended, own.length),
      }
    })

    // Meetings that actually had someone eligible. A meeting listed with no
    // eligibility rows has no attendance to measure, and including it dragged
    // the smallest-size figure to zero, which is what produced an "Infinity"
    // percentage-point swing in the caveat below.
    const sized = series.filter((m) => m.eligible > 0)

    // "One meeting's noise" is the swing caused by a single extra absence at
    // the typical meeting size. Any movement smaller than that is not a signal.
    const meanSize =
      series.length > 0 ? series.reduce((a, s) => a + s.eligible, 0) / series.length : 0
    const noise = meanSize > 0 ? Math.round((100 / meanSize) * 10) / 10 : 0

    const half = Math.floor(series.length / 2)
    const firstRows = series.slice(0, half)
    const secondRows = series.slice(half)
    const sum = (xs: typeof series, k: 'eligible' | 'attended') =>
      xs.reduce((a, s) => a + s[k], 0)
    const firstHalf = pct(sum(firstRows, 'attended'), sum(firstRows, 'eligible'))
    const secondHalf = pct(sum(secondRows, 'attended'), sum(secondRows, 'eligible'))
    const shift = Math.round((secondHalf - firstHalf) * 10) / 10

    const dips = series
      .filter((s) => s.rate < overallRate - noise)
      .sort((a, b) => a.rate - b.rate || a.meeting.date.localeCompare(b.meeting.date))

    const points: DataPoint[] = series.map((s) => ({
      label: `${s.meeting.date} ${s.meeting.body}`,
      value: s.rate,
      highlight: s.rate < overallRate - noise,
      detail: `${s.attended} of ${s.eligible} present at ${s.meeting.meeting_id}`,
    }))

    const trendClause =
      Math.abs(shift) < noise
        ? `the first half averages ${firstHalf}% against ${secondHalf}% in the second, a ${Math.abs(
            shift,
          )}-point move that is inside one meeting's noise of ${noise} points`
        : `attendance moves ${firstHalf}% to ${secondHalf}%, a ${Math.abs(shift)}-point ${
            shift < 0 ? 'decline' : 'improvement'
          } larger than one meeting's noise of ${noise} points`

    const dipClause =
      dips.length === 0
        ? 'and no single meeting sits materially below the year average'
        : `but ${dips.length} meeting${dips.length === 1 ? '' : 's'} sit${
            dips.length === 1 ? 's' : ''
          } materially below the ${overallRate}% year average, the lowest ${list(
            dips.slice(0, 3).map((d) => `${d.meeting.body} on ${d.meeting.date} at ${d.rate}%`),
          )}`

    // A nil result must not carry statistics computed from nothing.
    //
    // The headline was already special-cased for an empty series, but the
    // assumptions, caveats and the chart's reference line were not — so a body
    // with no meetings still announced a "0% year average", a noise threshold
    // "at the average attendance size of 0 seats", and a chart drawing a
    // reference line at zero. Those are not qualifications of a figure; they
    // are figures, and every one of them was invented by arithmetic over an
    // empty set.
    if (series.length === 0) {
      const known = allBodies(dataset)
      const unknownBody = body !== undefined && !known.some((b) => b === body)
      return {
        tool: 'attendance_by_meeting',
        headline: unknownBody
          ? `No body called "${body}" appears in the attendance records, so there is nothing to plot. The bodies present are ${list(known)}.`
          : `No meetings${body ? ` of ${body}` : ''} appear in the attendance records, so there is no attendance to plot. The bodies present are ${list(known)}.`,
        // No chart rather than an empty one: a line chart with no points and a
        // reference line at zero reads as a real measurement of zero.
        chart: null,
        table: null,
        assumptions: [
          `Body names were matched exactly as written in the attendance records; the dataset defines no aliases.`,
        ],
        caveats: [
          'Nothing matched, so nothing was computed — there is no figure here to qualify.',
        ],
        provenance: {
          asAt: dataset.asAt,
          sources: SOURCES,
          rowsConsidered: rows.length,
          derivation: `No meeting rows matched${body ? ` the body "${body}"` : ''}, so no rate was calculated.`,
        },
      }
    }

    return {
      tool: 'attendance_by_meeting',
      // With no matching meetings every derived figure is zero, and the normal
      // sentence then reads "attendance moves 0% to 0%, a 0-point improvement
      // larger than one meeting's noise of 0 points" — a non-event described
      // as a finding. Say what actually happened instead.
      headline:
        series.length === 0
          ? `No meetings${
              body ? ` of ${body}` : ''
            } appear in the attendance records, so there is no attendance to plot. The bodies present are ${list(
              allBodies(dataset),
            )}.`
          : `Across ${series.length} meetings${
              body ? ` of ${body}` : ''
            }, ${trendClause}, ${dipClause}.`,
      chart: {
        kind: 'line',
        title: `Attendance by meeting${body ? ` — ${body}` : ''}`,
        xLabel: 'Meeting (date order)',
        yLabel: 'Attendance',
        unit: 'percent',
        points,
        seriesLabel: 'Present rate',
        reference: { value: overallRate, label: `Year average ${overallRate}%` },
      },
      table: {
        columns: ['Meeting', 'Body', 'Date', 'Present', 'Eligible', 'Present rate %'],
        rows: series.map((s) => [
          s.meeting.meeting_id,
          s.meeting.body,
          s.meeting.date,
          s.attended,
          s.eligible,
          s.rate,
        ]),
      },
      assumptions: [
        'The halves compared are the first and second halves of the meeting sequence in date order; the dataset defines no reporting periods.',
        `"Materially below" means more than one meeting's noise (${noise} points at the average attendance size of ${
          Math.round(meanSize * 10) / 10
        } seats) below the ${overallRate}% year average.`,
        'Apologies count as non-attendance.',
      ],
      caveats: [
        // Only meetings that had eligibility rows can carry a swing. Dividing
        // by the smallest eligibility across every meeting produced "one
        // absence moves a point by up to Infinity percentage points" as soon as
        // one listed meeting had no rows at all.
        ...(sized.length > 0
          ? [
              `Each point is a single meeting of ${Math.min(
                ...sized.map((m) => m.eligible),
              )} to ${Math.max(
                ...sized.map((m) => m.eligible),
              )} seats, so one absence moves a point by up to ${
                Math.round((100 / Math.min(...sized.map((m) => m.eligible))) * 10) / 10
              } percentage points.`,
            ]
          : []),
        'Bodies meet on different cycles, so consecutive points are not evenly spaced in time.',
      ],
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: rows.length,
        derivation:
          'For each meeting, present rate = rows with status "present" for that meeting_id ' +
          'divided by all eligibility rows for that meeting_id, plotted in date order.',
      },
    }
  },
}

// ------------------------------------------------------------ Q3

export const attendanceByCommittee: ToolDefinition = {
  name: 'attendance_by_committee',
  description:
    'Attendance rate for each board or committee, ranked, with a per-body small-sample ' +
    'caveat and how many times each met. Use for "which committees have the lowest ' +
    'attendance" and, with rank_by set to meetings, for "which committee meets most ' +
    'often" or "which is the busiest".',
  parameters: {
    rank_by: {
      type: 'string',
      description:
        'Order and lead on attendance rate, or on how many times each body met. Both are ' +
        'always shown; this decides which the answer is about.',
      enum: ['attendance', 'meetings'],
      default: 'attendance',
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    const rankBy = choice(args.rank_by, ['attendance', 'meetings'] as const, 'attendance')
    const rows = dataset.attendance.records
    const bodies = allBodies(dataset)

    // Bodies come from the meeting list, rates from the eligibility rows, and
    // pct(0, 0) is 0 — so a body with a meeting but no rows was ranked at "0%"
    // and announced as the lowest attender, beneath bodies with real figures.
    // A body nobody was recorded as eligible for has no rate to rank, so it is
    // named in a caveat instead of given a number it does not have.
    const withoutRows = bodies.filter((b) => !rows.some((r) => r.body === b))

    const stats = bodies
      .filter((b) => rows.some((r) => r.body === b))
      .map((b) => {
        const own = rows.filter((r) => r.body === b)
        const meetings = new Set(own.map((r) => r.meeting_id)).size
        const attended = own.filter(isPresent).length
        return {
          body: b,
          meetings,
          rows: own.length,
          attended,
          rate: pct(attended, own.length),
          // The actual percentage-point cost of one more miss, computed not asserted.
          swing: own.length > 0 ? Math.round((100 / own.length) * 10) / 10 : 0,
        }
      })
      .sort((a, b) =>
        rankBy === 'meetings'
          ? b.meetings - a.meetings || a.body.localeCompare(b.body)
          : a.rate - b.rate || a.body.localeCompare(b.body),
      )

    // Every sentence below describes the ATTENDANCE ordering, so it is derived
    // from a rate-sorted view rather than from the display order. With
    // rank_by=meetings the display is sorted by meeting count, and reading
    // stats[0] as "the lowest attender" produced a robustness caveat comparing
    // the two busiest bodies — a gap that could even come out negative, giving
    // "sits only -6.9 points below".
    const byRate = [...stats].sort(
      (a, b) => a.rate - b.rate || a.body.localeCompare(b.body),
    )
    const lowest = byRate[0]
    const highest = byRate[byRate.length - 1]
    const tiedLowest = byRate.filter((s) => s.rate === lowest.rate)

    const points: DataPoint[] = stats.map((s) => ({
      label: s.body,
      value: rankBy === 'meetings' ? s.meetings : s.rate,
      highlight:
        rankBy === 'meetings' ? s.meetings === stats[0].meetings : s.rate === lowest.rate,
      detail: `${s.attended} of ${s.rows} seats across ${s.meetings} meeting${
        s.meetings === 1 ? '' : 's'
      }`,
    }))

    const lowestClause =
      tiedLowest.length > 1
        ? `${list(tiedLowest.map((s) => s.body))} are tied lowest at ${lowest.rate}%`
        : `${lowest.body} is lowest at ${lowest.rate}%`

    // The ranking is only robust if the gap to the next body exceeds the swing
    // one more miss would cause at the lower-ranked body.
    const gap =
      byRate.length > 1 ? Math.round((byRate[1].rate - byRate[0].rate) * 10) / 10 : 0
    const robust = gap > lowest.swing
    // With one body there is nothing to rank against, and with every body
    // level there is no gap to be robust about. Both used to produce a
    // comparison with itself — "Board is lowest at 50%, against Board at 50%,
    // but the 0-point gap to the next body…" — a sentence describing a ranking
    // that does not exist.
    const comparable = byRate.length > 1 && gap > 0
    const robustClause = !comparable
      ? byRate.length > 1
        ? 'and every body is level, so there is no ranking to be robust about'
        : 'and it is the only body in scope, so nothing is ranked against it'
      : robust
        ? `and the ${gap}-point gap to ${byRate[1].body} is wider than the ${lowest.swing} points one more miss would move it`
        : `but the ${gap}-point gap to ${byRate[1].body} is narrower than the ${lowest.swing} points one more miss would move it, so the ranking is not robust`

    const caveats: string[] = [
      'Committee membership is inferred from eligibility rows, not from a membership roster field.',
    ]
    // Excluded from the ranking above rather than shown at 0%. Said out loud,
    // because a body missing from a ranking is a hole in the answer.
    if (withoutRows.length > 0) {
      const one = withoutRows.length === 1
      caveats.push(
        `${list(withoutRows)} ${one ? 'appears' : 'appear'} in the meeting list with no eligibility rows, so no attendance rate exists for ${
          one ? 'it' : 'them'
        } and ${one ? 'it is' : 'they are'} left out of the ranking rather than ranked at 0%.`,
      )
    }

    // Only when the chart is actually ranking on attendance. Ranked by meeting
    // count, a caveat about how robust the attendance ordering is describes an
    // ordering the reader cannot see.
    if (!robust && comparable && rankBy === 'attendance') {
      caveats.push(
        `The ranking is not robust: ${lowest.body} sits only ${gap} points below ${byRate[1].body}, ` +
          `but one more miss at ${lowest.body} would move it ${lowest.swing} points.`,
      )
    }
    for (const s of stats) {
      if (s.meetings < 3 || s.rows < 5) {
        caveats.push(
          `${s.body} met ${s.meetings} time${s.meetings === 1 ? '' : 's'} across ${
            s.rows
          } eligibility rows; one more miss would move its rate by ${s.swing} percentage points.`,
        )
      }
    }

    return {
      tool: 'attendance_by_committee',
      headline:
        rankBy === 'meetings'
          ? (() => {
              const busiest = stats[0]
              const tied = stats.filter((x) => x.meetings === busiest.meetings)
              const total = stats.reduce((n, x) => n + x.meetings, 0)
              const lead =
                tied.length > 1
                  ? `${list(tied.map((x) => x.body))} met most often, ${busiest.meetings} times each`
                  : `${busiest.body} met most often, ${busiest.meetings} times`
              return (
                `${lead}, out of ${total} meetings across ${stats.length} bodies — ` +
                `${list(
                  stats.slice(1).map((x) => `${x.body} ${x.meetings}`),
                )}. Meeting count is not workload: a body may meet often and carry little.`
              )
            })()
          : comparable
            ? `${lowestClause}, against ${highest.body} at ${highest.rate}%, ${robustClause}.`
            : `${lowestClause}, ${robustClause}.`,
      chart: {
        kind: 'bar',
        title: rankBy === 'meetings' ? 'Meetings held by body' : 'Attendance by body',
        xLabel: 'Body',
        yLabel: rankBy === 'meetings' ? 'Meetings held' : 'Attendance',
        unit: rankBy === 'meetings' ? 'count' : 'percent',
        points,
        seriesLabel: rankBy === 'meetings' ? 'Meetings' : 'Present rate',
      },
      table: {
        columns: ['Body', 'Meetings', 'Seats', 'Present', 'Present rate %', 'One-miss swing (pp)'],
        rows: stats.map((s) => [s.body, s.meetings, s.rows, s.attended, s.rate, s.swing]),
      },
      assumptions: [
        'Apologies count as non-attendance.',
        'Each body is rated on its own eligibility rows, so bodies with more members carry more weight per meeting.',
      ],
      caveats,
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: rows.length,
        derivation:
          'For each body, present rate = rows with status "present" divided by all ' +
          'eligibility rows for that body. The one-miss swing is 100 divided by that row count.',
      },
    }
  },
}

// ------------------------------------------------------------ Q4

export const meetingsMissed: ToolDefinition = {
  name: 'meetings_missed',
  description:
    'Directors ranked by meetings missed, splitting apologies (advance notice) from ' +
    'absences (none), with the miss rate alongside the count. Use for "who has missed ' +
    'the most meetings". Takes a director name to answer questions about one person.',
  parameters: {
    director: {
      type: 'string',
      description:
        'Restrict to one director, for questions about a named person. Omit to rank everyone.',
    },
  },
  required: [],
  run(dataset, args): ToolResult {
    // Without this, a question naming one director was answered with a
    // full-year trend across every meeting: a real chart, correct figures, and
    // not the question that was asked.
    const wanted = str(args.director) ?? ''
    const knownDirectors = [
      ...new Set(dataset.attendance.records.map((r) => r.director_name)),
    ].sort()
    const matchedDirector = wanted
      ? knownDirectors.find(
          (n) =>
            n.toLowerCase() === wanted.toLowerCase() ||
            n.toLowerCase().includes(wanted.toLowerCase()),
        ) ?? null
      : null

    if (wanted && !matchedDirector) {
      return {
        tool: 'meetings_missed',
        headline: `No one named "${wanted}" appears in the attendance records. The directors on record are ${list(
          knownDirectors,
        )}.`,
        chart: null,
        table: null,
        assumptions: ['Names are matched against the attendance records, not against any roster.'],
        caveats: [
          'This is a nil return caused by an unmatched name, not a finding that nobody missed a meeting.',
        ],
        provenance: {
          asAt: dataset.asAt,
          sources: ['attendance.json'],
          rowsConsidered: dataset.attendance.records.length,
          derivation: `Compared "${wanted}" against the ${knownDirectors.length} directors in the attendance records and found no match.`,
        },
      }
    }

    const rows = matchedDirector
      ? dataset.attendance.records.filter((r) => r.director_name === matchedDirector)
      : dataset.attendance.records

    const acc = new Map<
      string,
      { eligible: number; apologies: number; absent: number }
    >()
    for (const r of rows) {
      const cur = acc.get(r.director_name) ?? { eligible: 0, apologies: 0, absent: 0 }
      cur.eligible += 1
      if (r.status === 'apologies') cur.apologies += 1
      if (r.status === 'absent') cur.absent += 1
      acc.set(r.director_name, cur)
    }

    const stats = [...acc.entries()]
      .map(([name, v]) => ({
        name,
        eligible: v.eligible,
        apologies: v.apologies,
        absent: v.absent,
        missed: v.apologies + v.absent,
        missRate: pct(v.apologies + v.absent, v.eligible),
      }))
      .filter((s) => s.missed > 0)
      .sort((a, b) => b.missed - a.missed || b.missRate - a.missRate || a.name.localeCompare(b.name))

    const totalAbsent = rows.filter((r) => r.status === 'absent').length
    const withAbsence = stats.filter((s) => s.absent > 0)
    const topCount = stats.length > 0 ? stats[0].missed : 0
    const tiedTop = stats.filter((s) => s.missed === topCount)
    const worstRate = [...stats].sort((a, b) => b.missRate - a.missRate)[0]

    const points: DataPoint[] = stats.map((s) => ({
      label: s.name,
      value: s.missed,
      value2: s.absent,
      highlight: s.absent > 0,
      detail: `${s.missed} of ${s.eligible} missed (${s.missRate}%) — ${s.apologies} with apologies, ${s.absent} without notice`,
    }))

    let headline: string
    // The single-director case is decided FIRST. A director with perfect
    // attendance produces no rows in `stats`, and the empty branch below then
    // says "every director attended every meeting" — true of that one person,
    // and read as a statement about the whole board.
    if (matchedDirector) {
      // A ranking sentence is nonsense here: "missed the most" has nothing to be
      // the most of, and "in the whole dataset" is untrue once the rows are one
      // director's. Counted from the filtered rows, not from `stats`, which
      // holds only directors who missed something.
      const eligible = rows.length
      const attended = rows.filter(isPresent).length
      const apologies = rows.filter((r) => r.status === 'apologies').length
      const absent = rows.filter((r) => r.status === 'absent').length
      const missed = eligible - attended
      headline =
        missed === 0
          ? `${matchedDirector} attended all ${eligible} meetings they were eligible for.`
          : `${matchedDirector} attended ${attended} of ${eligible} meetings they were eligible for, ` +
            `missing ${missed} — ${apologies} with advance notice and ${absent} without. ` +
            `Their denominator is ${eligible} because committee rows exist only for that committee's members.`
    } else if (stats.length === 0) {
      headline = 'Every director attended every meeting they were eligible for.'
    } else {
      const countClause =
        tiedTop.length > 1
          ? `${tiedTop.length} directors tie on ${topCount} missed meetings each — ${list(
              tiedTop.map((s) => s.name),
            )}`
          : `${stats[0].name} missed the most at ${topCount} of ${stats[0].eligible}`
      const rateClause =
        worstRate && (tiedTop.length > 1 || worstRate.name !== stats[0].name)
          ? `, and on rate the worst is ${worstRate.name} at ${worstRate.missRate}% (${worstRate.missed} of ${worstRate.eligible})`
          : ''
      const absentClause =
        totalAbsent === 0
          ? ', and every miss in the dataset came with advance notice'
          : `, but the sharper signal is that only ${totalAbsent} row${
              totalAbsent === 1 ? '' : 's'
            } in the whole dataset are absences without notice, held by ${list(
              withAbsence.map((s) => `${s.name} (${s.absent})`),
            )}`
      headline = `${countClause}${rateClause}${absentClause}.`
    }

    return {
      tool: 'meetings_missed',
      headline,
      // Also no chart when nobody missed anything: an empty bar chart titled
      // "Meetings missed" reads as a measurement, not as an absence of one.
      chart: matchedDirector || points.length === 0 ? null : {
        kind: 'bar',
        title: 'Meetings missed, and how many without notice',
        xLabel: 'Director',
        yLabel: 'Meetings missed',
        unit: 'count',
        points,
        seriesLabel: 'Missed (apologies + absent)',
        series2Label: 'Absent, no advance notice',
      },
      table: {
        columns: ['Director', 'Eligible', 'Missed', 'Apologies', 'Absent (no notice)', 'Miss rate %'],
        rows: stats.map((s) => [
          s.name,
          s.eligible,
          s.missed,
          s.apologies,
          s.absent,
          s.missRate,
        ]),
      },
      assumptions: [
        'A miss is any row that is not "present"; apologies and absences are both non-attendance.',
        'Rate is shown alongside count because directors have different numbers of eligibility rows.',
      ],
      caveats: [
        'Eligibility rows differ by director (committee rows exist only for that committee\'s members), so counts are not comparable without the rate.',
        'The dataset records no reason for an absence, so "no advance notice" is the only distinction available.',
      ],
      provenance: {
        asAt: dataset.asAt,
        sources: SOURCES,
        rowsConsidered: rows.length,
        derivation:
          'Missed = rows with status "apologies" or "absent", per director. The absent ' +
          'count is broken out separately because it means no advance notice was given.',
      },
    }
  },
}

export const ATTENDANCE_TOOLS: ToolDefinition[] = [
  attendanceBelowThreshold,
  attendanceByMeeting,
  attendanceByCommittee,
  meetingsMissed,
]
