import type {
  AttendanceRecord,
  DataPoint,
  Dataset,
  ToolDefinition,
  ToolResult,
} from '@/lib/types'
import { allBodies, choice, committeesOf, list, matchOne, num, pct, strOrUndefined } from '@/lib/dataset/loader'

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

/**
 * An optional date window over the attendance record.
 *
 * NO TOOL COULD EXPRESS A PERIOD. The only temporal arguments anywhere were
 * `within_months` and `within_days`, both forward-looking horizons, so
 * "attendance for just Q4" returned the whole year — the reader refined their
 * question and the chart did not change.
 *
 * The MODEL supplies explicit ISO dates rather than a named period, because
 * "Q4" is ambiguous over a record running September to August and the window
 * actually used has to be stated. Naming quarters in code would pick one
 * financial year silently; naming dates makes the choice visible in the
 * assumption, where a reader can disagree with it.
 */
interface DateWindow {
  from: string | null
  to: string | null
  /** The window in the words every sentence uses. */
  label: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function readWindow(args: Record<string, unknown>): DateWindow {
  const clean = (raw: unknown): string | null => {
    const value = strOrUndefined(raw)
    // Anything that is not a plain ISO date is treated as ABSENT rather than
    // coerced. A half-parsed date would silently shift the window and the
    // assumption would then describe a period the reader never asked for.
    return value && ISO_DATE.test(value.trim()) ? value.trim() : null
  }
  let from = clean(args.from_date)
  let to = clean(args.to_date)
  // Reversed bounds are an ordering slip, and an empty window would read as
  // "no meetings happened" — a finding rather than a mistake. ISO dates
  // compare correctly as strings, which is why this needs no Date parsing.
  if (from && to && from > to) [from, to] = [to, from]

  const label =
    from && to
      ? `between ${from} and ${to}`
      : from
        ? `from ${from} onwards`
        : to
          ? `up to ${to}`
          : 'across the whole record'
  return { from, to, label }
}

function inWindow(r: AttendanceRecord, w: DateWindow): boolean {
  if (w.from && r.date < w.from) return false
  if (w.to && r.date > w.to) return false
  return true
}

/** The date-window parameters, identical on every tool that takes them. */
const WINDOW_PARAMS = {
  from_date: {
    type: 'string' as const,
    description:
      'Optional: earliest meeting date to include, as YYYY-MM-DD. Use it for "just ' +
      'Q4", "since April", "the last six months" — work out the dates yourself and ' +
      'pass them; the answer states the window it used.',
  },
  to_date: {
    type: 'string' as const,
    description: 'Optional: latest meeting date to include, as YYYY-MM-DD.',
  },
}

/** Records for one body and one date window, or everything when neither is given. */
function scope(dataset: Dataset, body?: string, window?: DateWindow): AttendanceRecord[] {
  const rows = dataset.attendance.records
  const byBody = body ? rows.filter((r) => r.body === body) : rows
  return window && (window.from || window.to)
    ? byBody.filter((r) => inWindow(r, window))
    : byBody
}

/** Resolves a caller-supplied body name against the bodies actually in the data. */
function resolveBody(dataset: Dataset, raw: unknown): string | undefined {
  const wanted = strOrUndefined(raw)
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
      // The unrounded value, carried for ordering and comparison only.
      // pct() rounds to one decimal, and sorting on a ROUNDED figure makes two
      // genuinely different rates compare equal — the tie is then resolved
      // alphabetically and stated as a fact about a named person.
      // unresolved_by_committee already carries a `ratio` for exactly this;
      // the fix had not been carried across.
      ratio: v.eligible > 0 ? v.attended / v.eligible : 0,
    }))
    .sort((a, b) => a.ratio - b.ratio || a.name.localeCompare(b.name))
}

// ------------------------------------------------------------ Q1

export const attendanceBelowThreshold: ToolDefinition = {
  // Renamed from `attendance_below_threshold`, which named one DIRECTION.
  // "Who is above 90% attendance?" had nowhere correct to go and the model
  // sent it to `meetings_missed`, which answered confidently about the WORST
  // attenders — the opposite question, stated as a finding.
  name: 'attendance_vs_threshold',
  description:
    'Directors whose overall attendance sits below, above, or between attendance ' +
    'percentages, with a per-body breakdown for each of them. Use for "who is below ' +
    'our attendance threshold" and "who is not turning up" (direction "below", the ' +
    'default), for "who is above 90%" and "who has strong attendance" (direction ' +
    '"above"), and set upper_threshold as well for a band such as "between 70 and 80 ' +
    'per cent".',
  parameters: {
    threshold: {
      type: 'number',
      description:
        'The attendance percentage to compare against, 1 to 100. With direction ' +
        '"below" a director is flagged under it; with "above", over it; with ' +
        'upper_threshold set, this is the BOTTOM of the band. Omit it unless the ' +
        'question names a figure; the default is the one the answer discloses.',
      default: 80,
      min: 1,
      max: 100,
    },
    direction: {
      type: 'string',
      description:
        'Which side of the threshold to report: "below" (the default) or "above". ' +
        'Ignored when upper_threshold is set.',
      enum: ['below', 'above'],
      default: 'below',
    },
    upper_threshold: {
      type: 'number',
      description:
        'Top of a band, used with threshold as its bottom, for "between X and Y per ' +
        'cent". Omit for a one-sided comparison.',
      min: 1,
      max: 100,
    },
    body: {
      type: 'string',
      description: 'Optional: restrict to one board or committee.',
    },
    ...WINDOW_PARAMS,
  },
  required: [],
  run(dataset, args): ToolResult {
    const window = readWindow(args)
    const threshold = num(args.threshold, 80)
    // A band when an upper bound is given, otherwise one-sided. Absent rather
    // than defaulted, because "no upper bound" is a different thing from any
    // particular percentage.
    const rawUpper = args.upper_threshold
    const upper =
      rawUpper === undefined || rawUpper === null
        ? null
        : Math.min(100, Math.max(threshold, num(rawUpper, threshold)))
    // Typed check rather than String(): args arrive as unknown, and anything
    // that is not a string would stringify to "[object Object]" and silently
    // mean "below" — the wrong direction, chosen by a coercion.
    const above =
      upper === null &&
      typeof args.direction === 'string' &&
      args.direction.trim().toLowerCase() === 'above'

    /** True for a rate this question asked about. */
    const inScope = (rate: number): boolean =>
      upper !== null ? rate >= threshold && rate <= upper : above ? rate > threshold : rate < threshold

    /** The comparison in the words every sentence here uses. */
    const compareLabel =
      upper !== null
        ? `between ${threshold}% and ${upper}%`
        : above
          ? `above ${threshold}%`
          : `below ${threshold}%`

    const body = resolveBody(dataset, args.body)
    const rows = scope(dataset, body, window)
    const rates = ratesByDirector(rows)

    // No threshold is defined anywhere in the dataset, so a threshold that
    // flags fewer than two directors would produce a degenerate chart. Fall
    // back to the bottom quartile, and say so in the assumptions.
    let flagged = rates.filter((d) => inScope(d.rate))
    let widened = false
    // Widening only makes sense for a one-sided comparison against a threshold
    // the DATA does not define. A band is an explicit request for a range, so
    // widening it would answer a question nobody asked; an empty band returns
    // its nil result and says so.
    if (flagged.length < 2 && rates.length > 0 && upper === null) {
      const quartile = Math.max(2, Math.ceil(rates.length / 4))
      // `rates` is ascending, so the bottom quartile is the head and the top
      // quartile is the tail — the symmetric fallback for "above".
      flagged = above ? rates.slice(-quartile) : rates.slice(0, quartile)
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
        tool: 'attendance_vs_threshold',
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
      highlight: inScope(d.rate),
      detail: `${d.attended} of ${d.eligible} meetings attended`,
    }))

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
    const timeSuffix = window.label !== 'across the whole record' ? ` (${window.label})` : ''
    let headline: string
    if (flagged.length === 0) {
      // The nearest rate is the useful one, and which end that is depends on
      // the question: for "below" it is the lowest, for "above" the highest.
      const nearest = above ? rates[rates.length - 1] : rates[0]
      headline = `No director is ${compareLabel}${scopeLabel}; the ${
        above ? 'highest' : 'lowest'
      } rate is ${nearest ? `${nearest.rate}% (${nearest.name})` : 'not computable'}.`
    } else {
      const inScopeCount = rates.filter((d) => inScope(d.rate)).length
      const lead =
        inScopeCount === 0
          ? `No director is ${compareLabel}${scopeLabel}, so the chart shows the ${
              above ? 'top' : 'bottom'
            } ${flagged.length} instead`
          : `${inScopeCount} director${inScopeCount === 1 ? ' is' : 's are'} ${compareLabel}${scopeLabel} — ${list(
              rates.filter((d) => inScope(d.rate)).map((d) => `${d.name} ${d.rate}%`),
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
      tool: 'attendance_vs_threshold',
      headline,
      chart: {
        kind: 'bar',
        // On the widened path this is NOT "below the threshold": nobody is.
        // The title said so anyway, over bars all above the reference line —
        // the headline explained it, a pinned card or a screenshot did not.
        title: widened
          ? `${above ? 'Highest' : 'Lowest'} ${points.length} attendance rates${scopeLabel}${timeSuffix}`
          : `Attendance ${compareLabel}${scopeLabel}${timeSuffix}`,
        xLabel: 'Director',
        yLabel: 'Attendance',
        unit: 'percent',
        points,
        seriesLabel: 'Present rate',
        // Kept on the widened path, because the threshold is still the thing
        // these rates are being read against — but labelled as a threshold
        // nobody is under rather than as the chart's subject.
        // One line, at the boundary the question named. On a band it marks the
        // BOTTOM of the band, which is the edge a reader is checking against;
        // the title carries the top.
        reference: {
          value: threshold,
          label: widened
            ? `${threshold}% threshold (none ${above ? 'above' : 'below'})`
            : `${threshold}% threshold`,
        },
      },
      table: {
        columns: body
          ? ['Director', 'Body', 'Present', 'Eligible', 'Present rate %']
          : ['Director', 'Present', 'Eligible', 'Present rate %'],
        rows: flagged.map((d) =>
          body
            ? [d.name, body, d.attended, d.eligible, d.rate]
            : [d.name, d.attended, d.eligible, d.rate],
        ),
      },
      assumptions: [
        // States the comparison actually applied, not the phrase the reader
        // used: it is the line that tells them whether "above" or a band was
        // honoured.
        `Directors were selected as ${compareLabel}, ${window.label}. No attendance threshold is stated anywhere in the dataset${
          upper === null ? `; ${threshold}% was used` : ''
        }.`,
        'Apologies count as non-attendance: only a status of "present" counts towards the rate.',
        ...(widened
          ? [
              `Fewer than two directors were ${compareLabel}, so the ${points.length} ${
                above ? 'highest' : 'lowest'
              } rates are shown instead — a quarter of the ${rates.length} assessed, rounded up, ` +
                `and never fewer than two. None of them is ${compareLabel}.`,
            ]
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
    'the year" or "were there meetings where attendance dropped". Set from_date ' +
    'and to_date to narrow it to one period, which is how a follow-up like "just ' +
    'Q4" or "only the last three months" is answered.',
  parameters: {
    body: { type: 'string', description: 'Optional: restrict to one board or committee.' },
    ...WINDOW_PARAMS,
  },
  required: [],
  run(dataset, args): ToolResult {
    const window = readWindow(args)
    const body = resolveBody(dataset, args.body)
    const rows = scope(dataset, body, window)

    const meetings = dataset.attendance.meetings
      .filter((m) => (body ? m.body === body : true))
      // The meeting LIST is narrowed by the same window as the rows. Filtering
      // only the rows would leave every meeting on the axis with an empty rate,
      // so a narrowed question would still draw all 18 points with most of them
      // at zero — worse than not narrowing at all.
      .filter((m) => !window.from || m.date >= window.from)
      .filter((m) => !window.to || m.date <= window.to)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.meeting_id.localeCompare(b.meeting_id))

    const overallRate = pct(rows.filter(isPresent).length, rows.length)
    // "Year" is only true with no window. The figure was always computed from
    // the rows in scope, so what would have been wrong is the WORD — calling a
    // quarter's mean a year's, in the headline and on the chart's own
    // reference line, which is where a reader takes the figure from.
    const periodWord = window.from || window.to ? 'period' : 'year'

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
    const unsized = series.length - sized.length

    // "One meeting's noise" is the swing caused by a single extra absence at
    // the typical meeting size. Any movement smaller than that is not a signal.
    // EVERY figure below is derived from `sized`, not `series`.
    //
    // A meeting with no eligibility rows — a cancelled one, or a body whose
    // membership is recorded elsewhere — gives pct(0, 0) = 0, so it plotted at
    // 0%, was highlighted as a material dip, and dragged the mean meeting size
    // down, which inflates the noise floor and therefore changes which OTHER
    // meetings count as dips. The `sized` filter was introduced for exactly
    // this and then applied only to the caveat.
    //
    // Not reachable on this dataset, where all 18 meetings have rows. Fully
    // reachable on another organisation's, which is the whole premise of the
    // second-dataset test.
    const meanSize =
      sized.length > 0 ? sized.reduce((a, s) => a + s.eligible, 0) / sized.length : 0
    const noise = meanSize > 0 ? Math.round((100 / meanSize) * 10) / 10 : 0

    const half = Math.floor(sized.length / 2)
    const firstRows = sized.slice(0, half)
    const secondRows = sized.slice(half)
    const sum = (xs: typeof sized, k: 'eligible' | 'attended') =>
      xs.reduce((a, s) => a + s[k], 0)
    const firstHalf = pct(sum(firstRows, 'attended'), sum(firstRows, 'eligible'))
    const secondHalf = pct(sum(secondRows, 'attended'), sum(secondRows, 'eligible'))
    const shift = Math.round((secondHalf - firstHalf) * 10) / 10

    const dips = sized
      .filter((s) => s.rate < overallRate - noise)
      .sort((a, b) => a.rate - b.rate || a.meeting.date.localeCompare(b.meeting.date))

    const points: DataPoint[] = sized.map((s) => ({
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
        ? `and no single meeting sits materially below the ${periodWord} average`
        : `but ${dips.length} meeting${dips.length === 1 ? '' : 's'} sit${
            dips.length === 1 ? 's' : ''
          } materially below the ${overallRate}% ${periodWord} average, the lowest ${list(
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
        // "Nothing in this WINDOW" and "nothing in the record at all" are
        // different findings, and saying the second for the first would tell a
        // reader their board never met — the same fault this branch already
        // fixes for an unknown body name.
        headline: unknownBody
          ? `No body called "${body}" appears in the attendance records, so there is nothing to plot. The bodies present are ${list(known)}.`
          : window.from || window.to
            ? `No meetings${body ? ` of ${body}` : ''} fall ${window.label}, so there is no attendance to plot for that period. The record runs from ${
                [...dataset.attendance.meetings].sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? 'an unknown date'
              } to ${dataset.asAt}.`
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
          : `Across ${sized.length} meetings${
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
        reference: {
          value: overallRate,
          label: `${periodWord === 'year' ? 'Year' : 'Period'} average ${overallRate}%`,
        },
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
        // An ASSUMPTION, not a caveat: it describes what the code did rather
        // than how to read the figure. Without it a narrowed answer and a
        // whole-record answer read identically, which is what made a refined
        // question look ignored even when it had been honoured.
        `Meetings included: ${window.label}.`,
        'The halves compared are the first and second halves of the meeting sequence in date order; the dataset defines no reporting periods.',
        // "Year average" is only true with no window. The FIGURE was always
        // computed from the rows in scope; it was the word that would have
        // been wrong, calling a quarter's mean a year's.
        `"Materially below" means more than one meeting's noise (${noise} points at the average attendance size of ${
          Math.round(meanSize * 10) / 10
        } seats) below the ${overallRate}% average ${
          window.from || window.to ? 'for that period' : 'for the year'
        }.`,
        'Apologies count as non-attendance.',
      ],
      caveats: [
        ...(unsized > 0
          ? [
              `${unsized} meeting${unsized === 1 ? ' has' : 's have'} no eligibility rows and ` +
                `${unsized === 1 ? 'is' : 'are'} listed in the table but excluded from every ` +
                `figure and from the chart: a meeting nobody was recorded as eligible for has ` +
                `no attendance rate, and counting it as 0% would read as a meeting nobody came to.`,
            ]
          : []),
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
          `divided by all eligibility rows for that meeting_id, plotted in date order, ${window.label}.`,
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
    ...WINDOW_PARAMS,
  required: [],
  run(dataset, args): ToolResult {
    const window = readWindow(args)
    const rankBy = choice(args.rank_by, ['attendance', 'meetings'] as const, 'attendance')
    const rows = scope(dataset, undefined, window)
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
          // Unrounded, for ordering and for the tie test below.
          ratio: own.length > 0 ? attended / own.length : 0,
          // The actual percentage-point cost of one more miss, computed not asserted.
          swing: own.length > 0 ? Math.round((100 / own.length) * 10) / 10 : 0,
        }
      })
      .sort((a, b) =>
        rankBy === 'meetings'
          ? b.meetings - a.meetings || a.body.localeCompare(b.body)
          : a.ratio - b.ratio || a.body.localeCompare(b.body),
      )

    // Every sentence below describes the ATTENDANCE ordering, so it is derived
    // from a rate-sorted view rather than from the display order. With
    // rank_by=meetings the display is sorted by meeting count, and reading
    // stats[0] as "the lowest attender" produced a robustness caveat comparing
    // the two busiest bodies — a gap that could even come out negative, giving
    // "sits only -6.9 points below".
    const byRate = [...stats].sort(
      (a, b) => a.ratio - b.ratio || a.body.localeCompare(b.body),
    )
    const lowest = byRate[0]
    const highest = byRate[byRate.length - 1]
    // Compared on the exact ratio: two bodies whose rates round to the same
    // figure are not "tied lowest", and saying they are is a claim the data
    // does not support.
    const tiedLowest = byRate.filter((s) => s.ratio === lowest.ratio)

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
    'Directors ranked by meetings MISSED, splitting apologies (advance notice) from ' +
    'absences (none), with the miss rate alongside the count. Use for "who has missed ' +
    'the most meetings". Takes a director name to answer questions about one person. ' +
    'Do NOT use it for who attends BEST: it lists only directors who missed ' +
    'something, so a director with perfect attendance does not appear in it at all — ' +
    'use attendance_vs_threshold with direction "above" for that.',
  parameters: {
    director: {
      type: 'string',
      description:
        'Restrict to one director, for questions about a named person. Omit to rank everyone.',
    },
    ...WINDOW_PARAMS,
  },
  required: [],
  run(dataset, args): ToolResult {
    const window = readWindow(args)
    // Without this, a question naming one director was answered with a
    // full-year trend across every meeting: a real chart, correct figures, and
    // not the question that was asked.
    const wanted = strOrUndefined(args.director) ?? ''
    const knownDirectors = [
      ...new Set(dataset.attendance.records.map((r) => r.director_name)),
    ].sort()
    const matchedDirector = wanted ? matchOne(knownDirectors, wanted) : null

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
      ? scope(dataset, undefined, window).filter((r) => r.director_name === matchedDirector)
      : scope(dataset, undefined, window)

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
    // Ties on RATE are handled the same way ties on COUNT already were.
    //
    // This took the first row of a sort with no tiebreak, so `Array.sort`
    // stability handed back whichever name came first alphabetically. On the
    // live dataset two directors both miss 3 of 10, and one of them was named
    // as "the worst" — an attendance judgement about a real person, published
    // as a singular fact, decided by their surname.
    const byRate = [...stats].sort((a, b) => b.missRate - a.missRate)
    const topRate = byRate.length > 0 ? byRate[0].missRate : 0
    const tiedWorstRate = byRate.filter((s) => s.missRate === topRate)

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
      const worstRate = tiedWorstRate[0]
      const rateClause =
        worstRate && (tiedTop.length > 1 || worstRate.name !== stats[0].name)
          ? tiedWorstRate.length > 1
            ? `, and on rate ${tiedWorstRate.length} tie at ${topRate}% — ${list(
                tiedWorstRate.map((s) => s.name),
              )}`
            : `, and on rate the worst is ${worstRate.name} at ${worstRate.missRate}% (${worstRate.missed} of ${worstRate.eligible})`
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
