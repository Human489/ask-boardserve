import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { allBodies, loadDataset, pct } from '../src/lib/dataset/loader'
import { ANALYTICS_TOOLS, TOOLS, getTool } from '../src/lib/analytics/registry'
import type { ToolResult } from '../src/lib/types'

const dataset = loadDataset()

// The tool contract allows async results and refusals, because paper retrieval
// needs both. The twelve analytics tools must be neither: they compute from
// files already in memory, and a computation that cannot be done is a caveated
// nil result, not a refusal.
function asComputed(name: string, result: unknown): ToolResult {
  assert.ok(!(result instanceof Promise), `${name} must be synchronous`)
  const r = result as ToolResult
  assert.notEqual(r.tool, 'refusal', `${name} must not refuse`)
  return r
}

function run(name: string, args: Record<string, unknown> = {}): ToolResult {
  const tool = getTool(name)
  assert.ok(tool, `tool ${name} is registered`)
  return asComputed(name, tool!.run(dataset, args))
}

function tableRow(r: ToolResult, predicate: (row: (string | number | null)[]) => boolean) {
  assert.ok(r.table, 'result has a table')
  return r.table!.rows.filter(predicate)
}

function allNumbers(r: ToolResult): number[] {
  const out: number[] = []
  for (const p of r.chart?.points ?? []) {
    out.push(p.value)
    if (p.value2 !== undefined) out.push(p.value2)
  }
  if (r.chart?.reference) out.push(r.chart.reference.value)
  for (const row of r.table?.rows ?? []) {
    for (const cell of row) if (typeof cell === 'number') out.push(cell)
  }
  return out
}

// ------------------------------------------------------------ dataset sanity

test('as-at date comes from the data, not the clock', () => {
  assert.equal(dataset.asAt, '2026-08-31')
})

test('own aggregation matches director_summary for all 10 directors', () => {
  const summary = dataset.attendance.director_summary
  assert.equal(summary.length, 10)
  for (const d of summary) {
    const own = dataset.attendance.records.filter((r) => r.director_name === d.director_name)
    const present = own.filter((r) => r.status === 'present')
    assert.equal(own.length, d.all_meetings_eligible, `${d.director_name} eligible`)
    assert.equal(present.length, d.all_meetings_attended, `${d.director_name} attended`)
    assert.equal(pct(present.length, own.length), d.overall_attendance_pct, `${d.director_name} overall %`)

    const board = own.filter((r) => r.body === 'Board')
    const boardPresent = board.filter((r) => r.status === 'present')
    assert.equal(board.length, d.board_meetings_eligible, `${d.director_name} board eligible`)
    assert.equal(boardPresent.length, d.board_meetings_attended, `${d.director_name} board attended`)
    assert.equal(
      pct(boardPresent.length, board.length),
      d.board_attendance_pct,
      `${d.director_name} board %`,
    )
  }
})

test('exactly 3 records dataset-wide have status absent', () => {
  assert.equal(dataset.attendance.records.filter((r) => r.status === 'absent').length, 3)
})

// ------------------------------------------------------------ Q1

test('attendance_below_threshold flags the three directors below 80%', () => {
  const r = run('attendance_below_threshold', { threshold: 80 })
  const flagged = r.chart!.points.filter((p) => p.highlight)
  assert.deepEqual(
    flagged.map((p) => [p.label, p.value]).sort(),
    [
      ['Hilary Batchford', 78.6],
      ['Malcolm Whitbourne', 70],
      ['Terence Oduya', 70],
    ].sort(),
  )
  assert.match(r.headline, /3 directors are below 80%/)
  assert.ok(r.assumptions.some((a) => a.includes('80')))
})

test('Oduya is 50% at Board and 100% at Finance and Audit', () => {
  const r = run('attendance_below_threshold', { threshold: 80 })
  const board = tableRow(r, (row) => row[0] === 'Terence Oduya' && row[1] === 'Board')
  assert.equal(board.length, 1)
  assert.equal(board[0][4], 50)
  const fa = tableRow(r, (row) => row[0] === 'Terence Oduya' && row[1] === 'Finance and Audit Committee')
  assert.equal(fa.length, 1)
  assert.equal(fa[0][4], 100)
})

test('a per-body scope uses that body only', () => {
  const r = run('attendance_below_threshold', { threshold: 80, body: 'Board' })
  const oduya = r.chart!.points.find((p) => p.label === 'Terence Oduya')
  assert.ok(oduya)
  assert.equal(oduya!.value, 50)
})

// ------------------------------------------------------------ Q2

test('attendance_by_meeting is a line chart, one point per meeting, in date order', () => {
  const r = run('attendance_by_meeting')
  assert.equal(r.chart!.kind, 'line')
  assert.equal(r.chart!.points.length, dataset.attendance.meetings.length)
  const dates = r.table!.rows.map((row) => String(row[2]))
  assert.deepEqual(dates, [...dates].sort())
})

test('attendance_by_meeting finds the December-January dip', () => {
  const r = run('attendance_by_meeting')
  // Looking a meeting up by its id must give the same rate as looking it up by
  // body and date. This used to be defined and never called, then asserted with
  // `typeof rate === 'function'` — a test that could not fail.
  const rate = (id: string) => r.table!.rows.find((row) => row[0] === id)?.[5]

  const people = r.table!.rows.find((row) => row[1] === 'People Committee' && row[2] === '2025-12-03')
  assert.equal(people?.[5], 50)
  assert.equal(rate(String(people![0])), 50)
  const cg = r.table!.rows.find((row) => row[1] === 'Clinical Governance Committee' && row[2] === '2025-12-22')
  assert.equal(cg?.[5], 60)
  assert.equal(rate(String(cg![0])), 60)
  const board = r.table!.rows.find((row) => row[1] === 'Board' && row[2] === '2026-01-17')
  assert.equal(board?.[5], 70)
  assert.equal(rate(String(board![0])), 70)
  // Meeting ids are unique, or a lookup by id would silently return the first
  // of several.
  const ids = r.table!.rows.map((row) => String(row[0]))
  assert.equal(new Set(ids).size, ids.length, 'meeting ids in the table must be unique')
  assert.equal(rate('no-such-meeting'), undefined)
})

// ------------------------------------------------------------ Q3

test('committee order is People < Board < Clinical Governance < Finance and Audit', () => {
  const r = run('attendance_by_committee')
  assert.deepEqual(
    r.chart!.points.map((p) => [p.label, p.value]),
    [
      ['People Committee', 83.3],
      ['Board', 86.7],
      ['Clinical Governance Committee', 88],
      ['Finance and Audit Committee', 95],
    ],
  )
})

test('the small-n caveat for People is computed, with the real n and swing', () => {
  const r = run('attendance_by_committee')
  const peopleRow = r.table!.rows.find((row) => row[0] === 'People Committee')!
  assert.equal(peopleRow[1], 3) // met 3 times
  assert.equal(peopleRow[2], 12) // 12 eligibility rows
  assert.equal(peopleRow[5], 8.3) // one more miss moves it 8.3 points
  assert.ok(r.caveats.some((c) => c.includes('8.3')))
})

// ------------------------------------------------------------ Q4

test('meetings_missed surfaces the three-way tie and the absent count', () => {
  const r = run('meetings_missed')
  const top = r.chart!.points.filter((p) => p.value === 3)
  assert.deepEqual(
    top.map((p) => p.label).sort(),
    ['Hilary Batchford', 'Malcolm Whitbourne', 'Terence Oduya'],
  )
  // The absent series carries the sharper signal: one each, three in total.
  const absentTotal = r.chart!.points.reduce((a, p) => a + (p.value2 ?? 0), 0)
  assert.equal(absentTotal, 3)
  assert.match(r.headline, /3 rows in the whole dataset are absences without notice/)
  const batchford = r.table!.rows.find((row) => row[0] === 'Hilary Batchford')!
  assert.equal(batchford[1], 14)
  const whitbourne = r.table!.rows.find((row) => row[0] === 'Malcolm Whitbourne')!
  assert.equal(whitbourne[1], 10)
})

// ------------------------------------------------------------ Q5

test('overdue: 9 derived vs 7 recorded, extras SAH-A015 and SAH-A021', () => {
  const r = run('overdue_actions')
  const derivedTotal = r.chart!.points.reduce((a, p) => a + p.value, 0)
  const recordedTotal = r.chart!.points.reduce((a, p) => a + (p.value2 ?? 0), 0)
  assert.equal(derivedTotal, 9)
  assert.equal(recordedTotal, 7)
  assert.equal(r.table!.rows.length, 9)
  assert.match(r.headline, /9 actions are overdue/)
  assert.match(r.headline, /against 7 the log records as overdue/)
  assert.match(r.headline, /SAH-A015 and SAH-A021/)
})

test('overdue headline is generated from the comparison, not templated', () => {
  const r = run('overdue_actions')
  assert.ok(!/derived is higher/i.test(r.headline))
  assert.match(r.headline, /still logged as "in progress"/)
})

test('overdue names the owner-resolution gap as a count', () => {
  const r = run('overdue_actions')
  // Only "Chair" maps to a role in the skills audit; the rest are job titles.
  assert.ok(r.caveats.some((c) => /job title/.test(c)))
  assert.ok(r.caveats.some((c) => /cannot be matched to a person/.test(c)))
})

test('overdue can group by committee instead', () => {
  const r = run('overdue_actions', { group_by: 'committee' })
  assert.equal(r.chart!.xLabel, 'Body that raised it')
  assert.equal(
    r.chart!.points.reduce((a, p) => a + p.value, 0),
    9,
  )
})

// ------------------------------------------------------------ Q6

test('longest_overdue: 145, 138, then a tie on 103 that is not truncated', () => {
  const r = run('longest_overdue', { limit: 3 })
  const pts = r.chart!.points
  assert.equal(pts[0].label, 'SAH-A011')
  assert.equal(pts[0].value, 145)
  assert.equal(pts[1].label, 'SAH-A018')
  assert.equal(pts[1].value, 138)
  // The tie at the cut-off is shown in full rather than one row being dropped.
  const tied = pts.filter((p) => p.value === 103).map((p) => p.label).sort()
  assert.deepEqual(tied, ['SAH-A014', 'SAH-A015'])
  assert.equal(pts.length, 4)
  assert.match(r.headline, /tie on 103 days/)
})

test('longest_overdue uses as_at from the file, so the numbers do not drift', () => {
  const r = run('longest_overdue')
  assert.equal(r.provenance.asAt, '2026-08-31')
  assert.ok(r.assumptions.some((a) => a.includes('2026-08-31')))
  assert.equal(r.chart!.points.length, 9)
})

// ------------------------------------------------------------ Q7

test('unresolved: Board 9 of 19 at 47%, People 4 of 5 at 80%', () => {
  const r = run('unresolved_by_committee')
  const board = r.table!.rows.find((row) => row[0] === 'Board')!
  assert.deepEqual(board.slice(1, 4), [19, 9, 47])
  const people = r.table!.rows.find((row) => row[0] === 'People')!
  assert.deepEqual(people.slice(1, 4), [5, 4, 80])
  // 9 of all 18 unresolved items is a different measure from 47%.
  assert.equal(board[4], 50)
})

test('unresolved headline says count and rate disagree', () => {
  const r = run('unresolved_by_committee')
  assert.match(r.headline, /Count and rate disagree/)
  assert.match(r.headline, /Board/)
  assert.match(r.headline, /People/)
})

// ------------------------------------------------------------ Q8

test('actions_distribution: 18 unresolved, Director of People and Chair on 4', () => {
  const r = run('actions_distribution')
  assert.equal(
    r.chart!.points.reduce((a, p) => a + p.value, 0),
    18,
  )
  const top = r.chart!.points.filter((p) => p.value === 4).map((p) => p.label).sort()
  assert.deepEqual(top, ['Chair', 'Director of People'])
})

test('actions_distribution reads owner_type from the data', () => {
  const r = run('actions_distribution', { group_by: 'owner_type' })
  const labels = r.chart!.points.map((p) => p.label).sort()
  assert.deepEqual(labels, ['executive', 'trustee'])
  assert.ok(r.assumptions.some((a) => a.includes('trustee')))
})

// ------------------------------------------------------------ Q9

test('deferred_more_than_once returns exactly SAH-A014 and SAH-A024', () => {
  const r = run('deferred_more_than_once', { min_deferrals: 2 })
  assert.deepEqual(
    r.table!.rows.map((row) => row[0]).sort(),
    ['SAH-A014', 'SAH-A024'],
  )
  // Two rows is a list, not a chart.
  assert.equal(r.chart, null)
  assert.match(r.headline, /2 actions have been deferred 2 or more times/)
})

test('deferred_more_than_once reads naturally when nothing qualifies', () => {
  const r = run('deferred_more_than_once', { min_deferrals: 3 })
  assert.equal(r.table!.rows.length, 0)
  assert.match(r.headline, /Nothing has been deferred 3 or more times/)
})

// ------------------------------------------------------------ Q10

test('skills: Estates and assets 2.40 with 7 at 2 or below; Digital 2.50; Stakeholder 3.50', () => {
  const r = run('skills_gaps')
  const row = (skill: string) => r.table!.rows.find((x) => x[0] === skill)!
  assert.deepEqual(row('Estates and assets').slice(1, 4), [2.4, 2, 7])
  assert.equal(row('Digital and data')[1], 2.5)
  assert.equal(row('Stakeholder and communications')[1], 3.5)
  assert.equal(r.chart!.points[0].label, 'Estates and assets')
  assert.equal(r.chart!.points[r.chart!.points.length - 1].label, 'Stakeholder and communications')
})

test('skills_gaps reports spread, not just the mean, and caveats self-assessment', () => {
  const r = run('skills_gaps')
  assert.match(r.headline, /7 of 10 directors at 2 or below/)
  assert.match(r.headline, /only 2 at 4 or above/)
  assert.ok(r.caveats.some((c) => /self-assessed/i.test(c)))
})

test('skill names are read from the file, not hard-coded', () => {
  const r = run('skills_gaps')
  assert.equal(r.table!.rows.length, dataset.skillNames.length)
  assert.deepEqual(
    r.table!.rows.map((row) => String(row[0])).sort(),
    [...dataset.skillNames].sort(),
  )
})

// ------------------------------------------------------------ Q11

test('gap_coverage ranks Oduya 11, Pomeroy 10, Cheatle 9, Batchford weakest at 5', () => {
  const r = run('gap_coverage', { top_n_gaps: 3 })
  const pts = r.chart!.points
  assert.deepEqual(
    pts.slice(0, 3).map((p) => [p.label, p.value]),
    [
      ['Terence Oduya', 11],
      ['Gareth Pomeroy', 10],
      ['Rosalind Cheatle', 9],
    ],
  )
  const last = pts[pts.length - 1]
  assert.equal(last.label, 'Hilary Batchford')
  assert.equal(last.value, 5)
})

test('gap_coverage states the tiebreak on the third-weakest skill', () => {
  const r = run('gap_coverage', { top_n_gaps: 3 })
  assert.match(r.headline, /tie at a mean of 2\.80/)
  assert.match(r.headline, /Finance and audit/)
  assert.match(r.headline, /Sector or operational expertise/)
  assert.ok(r.assumptions.some((a) => /tie/.test(a)))
})

// ------------------------------------------------------------ Q12

test('committee_skills_gaps: People weakest, Estates and Finance at 2.00 with none at 4+', () => {
  const r = run('committee_skills_gaps')
  assert.equal(r.chart!.points[0].label, 'People Committee')
  const peopleRows = r.table!.rows.filter((row) => row[0] === 'People Committee')
  const estates = peopleRows.find((row) => row[2] === 'Estates and assets')!
  assert.equal(estates[3], 2)
  assert.equal(estates[4], 0)
  const finance = peopleRows.find((row) => row[2] === 'Finance and audit')!
  assert.equal(finance[3], 2)
  assert.equal(finance[4], 0)
})

test('committee_skills_gaps caveats that membership is inferred', () => {
  const r = run('committee_skills_gaps')
  assert.ok(r.caveats.some((c) => /inferred from which directors have eligibility rows/.test(c)))
  assert.ok(r.caveats.some((c) => /more than one of these bodies/.test(c)))
})

test('committee_skills_gaps can be scoped to one body', () => {
  const r = run('committee_skills_gaps', { body: 'Clinical Governance Committee' })
  assert.equal(r.chart!.points.length, 1)
  assert.equal(r.chart!.points[0].label, 'Clinical Governance Committee')
  const estates = r.table!.rows.find((row) => row[2] === 'Estates and assets')!
  assert.equal(estates[3], 1.8)
})

// ------------------------------------------------------------ cross-cutting

test('the registry exposes twelve deterministic tools plus the three that read papers', () => {
  assert.equal(ANALYTICS_TOOLS.length, 12)
  assert.equal(TOOLS.length, 15)
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 15)
  for (const t of TOOLS) assert.equal(getTool(t.name), t)
  assert.equal(getTool('no_such_tool'), undefined)
  // The split is load-bearing: everything numeric must be computed, so the one
  // tool that answers from prose is deliberately not in ANALYTICS_TOOLS.
  // Neither is a pure computation: one answers from prose, the other has to
  // read a term limit out of a paper before it can compute anything.
  assert.ok(!ANALYTICS_TOOLS.some((t) => t.name === 'search_board_papers'))
  assert.ok(!ANALYTICS_TOOLS.some((t) => t.name === 'tenure_and_skills_impact'))
  assert.ok(!ANALYTICS_TOOLS.some((t) => t.name === 'upcoming_unprepared'))
})

test('every tool returns a non-empty headline that says something', () => {
  for (const t of ANALYTICS_TOOLS) {
    const r = asComputed(t.name, t.run(dataset, {}))
    assert.ok(r.headline.trim().length > 20, `${t.name} headline is substantive`)
    assert.ok(
      !/this chart shows/i.test(r.headline),
      `${t.name} headline describes the finding, not the axes`,
    )
    assert.equal(r.tool, t.name)
    assert.equal(r.provenance.asAt, dataset.asAt)
    assert.ok(r.provenance.sources.length > 0, `${t.name} names its sources`)
    assert.ok(r.provenance.derivation.length > 0, `${t.name} explains its derivation`)
    assert.ok(r.assumptions.length > 0, `${t.name} states its assumptions`)
  }
})

test('no tool output contains NaN or Infinity', () => {
  for (const t of ANALYTICS_TOOLS) {
    const r = asComputed(t.name, t.run(dataset, {}))
    for (const n of allNumbers(r)) {
      assert.ok(Number.isFinite(n), `${t.name} produced a non-finite number`)
    }
    const text = JSON.stringify(r)
    assert.ok(!/NaN|Infinity/.test(text), `${t.name} output mentions NaN or Infinity`)
  }
})

/**
 * Every .ts under src/lib, found by walking rather than listed by hand.
 *
 * The list used to be eleven paths typed out in this file, so eight modules —
 * analytics/tenure, analytics/upcoming, retrieval/termlimit, commitments,
 * disagreement, pins, datasets and dataset/loader — were never scanned at all.
 * A list has to be maintained; a walk does not.
 */
function libSources(): string[] {
  const root = new URL('../src/lib/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * Words that are this organisation's vocabulary AND ordinary English, so a
 * substring scan cannot tell a leak from prose. Each is listed with the reason
 * it cannot be enforced, rather than the whole scan being weakened.
 *
 *   Board    — a body name and the commonest noun in the domain.
 *   People   — a body name ("People Committee") and the plural of person.
 *   Chair    — an action owner and the ordinary word for the role.
 *   Company Secretary — an action owner and the product's own user persona,
 *                       which the retrieval prompt names on purpose.
 */
const GENERIC_ENGLISH = new Set(['board', 'people', 'chair', 'company secretary'])

/**
 * Leaks found by this scan once it was widened, and deliberately left in place
 * because fixing them is a change to src/lib, not to the tests.
 *
 * Removing a name from here when the leak is fixed is enforced below, so this
 * cannot quietly become a permanent exemption list.
 */
/**
 * Leaks that are known and not yet fixed.
 *
 * Empty, and it should stay that way. The list is asserted in both directions:
 * a leak that is fixed but still listed fails, so an entry cannot quietly
 * become a permanent exemption for something nobody intends to fix.
 */
const KNOWN_LEAKS: [file: string, term: string][] = []

test('no organisation-specific value is hard-coded anywhere an answer is produced', () => {
  // Retrieval was added later and was never covered by this test. Its scope
  // guard held a list of words — board, finance, audit, people — chosen by
  // reading THIS organisation's committee names, which is exactly the leak this
  // test exists to catch.
  //
  // Three blind spots were found by audit and are closed here: the hand-written
  // file list (now a walk of src/lib), the case-SENSITIVE comparison (a
  // lowercase leak passed), and a banned list built only from attendance.json's
  // body names — so the DIFFERENT spelling the same bodies carry in
  // actions.json ("Finance and Audit" against "Finance and Audit Committee"),
  // the risk codes, the director ids and the owner job titles all went unbanned.
  const banned = [
    ...dataset.skills.map((s) => s.director_name),
    ...dataset.skillNames,
    // Body names as attendance.json spells them...
    ...dataset.attendance.meetings.map((m) => m.body),
    // ...and as actions.json spells them, which is not the same string.
    ...dataset.actions.actions.map((a) => a.committee_or_board),
    // Owners are job titles at this organisation, not roles that travel.
    ...dataset.actions.actions.map((a) => a.owner),
    // Identifiers: SAH-, R03, D07 and so on differ between organisations.
    ...dataset.actions.actions.map((a) => a.action_id.split('-')[0]),
    ...dataset.actions.actions.map((a) => a.linked_risk).filter((r): r is string => Boolean(r)),
    ...dataset.attendance.records.map((r) => r.director_id),
    dataset.organisation,
  ]
  const terms = [...new Set(banned.map((t) => t.trim()).filter(Boolean))].filter(
    (t) => !GENERIC_ENGLISH.has(t.toLowerCase()),
  )
  assert.ok(terms.length > 20, 'the banned list is built from the data, and must not be empty')

  const libRoot = new URL('../src/lib/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')
  const known = new Set(KNOWN_LEAKS.map(([f, t]) => `${f}::${t}`))
  const stillLeaking = new Set<string>()
  const found: string[] = []

  for (const file of libSources()) {
    const rel = file.slice(libRoot.length).replace(/\\/g, '/')
    // Case-insensitive: `src.includes(term)` let a lower-cased copy of a
    // director's name or a skill column through untouched.
    const src = readFileSync(file, 'utf8').toLowerCase()
    for (const term of terms) {
      if (!src.includes(term.toLowerCase())) continue
      const key = `${rel}::${term}`
      if (known.has(key)) stillLeaking.add(key)
      else found.push(`${rel} hard-codes "${term}"`)
    }
  }
  assert.deepEqual(found, [], found.join('; '))

  // A known leak that has been fixed must be struck off this list, or the list
  // becomes a permanent exemption nobody rereads.
  assert.deepEqual(
    [...known].filter((k) => !stillLeaking.has(k)),
    [],
    'these leaks are recorded as known but no longer present — remove them from KNOWN_LEAKS',
  )

  // Only the analytics layer is barred from the clock; retrieval measures
  // timeouts and the usage meter stamps a date, neither of which is an answer.
  for (const file of libSources()) {
    const rel = file.slice(libRoot.length).replace(/\\/g, '/')
    if (!rel.startsWith('analytics/')) continue
    const src = readFileSync(file, 'utf8')
    assert.ok(!/Date\.now\(\)|new Date\(/.test(src), `${rel} must not read the system clock`)
  }
})

test('every tool returns non-empty caveats, including on a nil result', () => {
  // deferred_more_than_once returned an empty caveats array when nothing met
  // the threshold, so the answer rendered with no "worth knowing" block at all
  // — reading as though the figure needed no qualification rather than as a
  // nil return.
  const dataset = loadDataset()
  for (const tool of ANALYTICS_TOOLS) {
    const result = asComputed(tool.name, tool.run(dataset, {}))
    assert.ok(result.caveats.length > 0, `${tool.name} returned no caveats`)
    assert.ok(result.assumptions.length > 0, `${tool.name} returned no assumptions`)
  }
  const nil = asComputed('deferred_more_than_once', getTool('deferred_more_than_once')!.run(dataset, { min_deferrals: 3 }))
  assert.equal(nil.table?.rows.length ?? 0, 0, 'expected a nil result for this threshold')
  assert.ok(nil.caveats.length > 0, 'a nil result still needs its caveat')
})

test('committee_skills_gaps states the metric it actually ranks on', () => {
  // The disclosed assumption said the ranking used each body's single weakest
  // skill, while the code ranked on the mean across all skills. The two put
  // different bodies first, so the wrong text misdescribed the answer.
  const dataset = loadDataset()
  const result = asComputed('committee_skills_gaps', getTool('committee_skills_gaps')!.run(dataset, {}))
  const values = result.chart?.points.map((p) => p.value) ?? []
  const ascending = values.every((v, i) => i === 0 || v >= values[i - 1])
  assert.ok(ascending, 'expected bodies ordered weakest mean first')
  assert.ok(
    result.assumptions.some((a) => /mean across all skills/i.test(a)),
    'assumptions must name the metric actually used for the ranking',
  )
})

// Every cross-cutting sweep in this file called tools with their defaults only.
// Two bugs hid behind that: an unmatched `body` crashed committee_skills_gaps,
// and attendance_by_meeting described a non-event as a finding ("attendance
// moves 0% to 0%, a 0-point improvement larger than one meeting's noise of 0
// points"). The router can emit any of these arguments.
const HOSTILE_ARGS: Record<string, unknown>[] = [
  { body: 'Nonexistent Committee' },
  { threshold: 0 },
  { threshold: 1000 },
  { threshold: -5 },
  { limit: 0 },
  { limit: 9999 },
  { min_deferrals: 0 },
  { group_by: 'not-a-real-grouping' },
  { top_n_gaps: 0 },
]

for (const args of HOSTILE_ARGS) {
  test(`no tool throws or emits NaN for args ${JSON.stringify(args)}`, () => {
    const dataset = loadDataset()
    for (const tool of ANALYTICS_TOOLS) {
      let result
      try {
        result = asComputed(tool.name, tool.run(dataset, args))
      } catch (e) {
        assert.fail(`${tool.name} threw: ${(e as Error).message}`)
      }
      const serialised = JSON.stringify(result)
      assert.ok(!/NaN|Infinity/.test(serialised), `${tool.name} produced NaN or Infinity`)
      assert.ok(result.headline.length > 0, `${tool.name} produced no headline`)
      assert.ok(result.caveats.length > 0, `${tool.name} produced no caveats`)
    }
  })
}

test('an unmatched body returns a nil answer that says so, not a vacuous one', () => {
  const dataset = loadDataset()
  const missing = 'Nonexistent Committee'

  const skills = asComputed('committee_skills_gaps', getTool('committee_skills_gaps')!.run(dataset, { body: missing }))
  assert.match(skills.headline, /no body matching/i)
  assert.equal(skills.chart, null)

  const meetings = asComputed('attendance_by_meeting', getTool('attendance_by_meeting')!.run(dataset, { body: missing }))
  assert.match(meetings.headline, /no (body|meetings)/i)
  assert.match(meetings.headline, new RegExp(missing))
  // The old headline claimed a 0-point move was "larger than one meeting's noise".
  assert.ok(
    !/0-point|0% year average/.test(meetings.headline),
    'a nil result must not be described as a trend',
  )
  assert.equal(meetings.chart, null, 'a nil result draws no chart')

  // The rest of the answer has to be nil too. The headline was special-cased
  // long before the assumptions and caveats were, so an empty series still
  // announced a "0% year average" and a noise threshold measured "at the
  // average attendance size of 0 seats" — figures invented from an empty set,
  // presented as the qualifications of a finding.
  const narration = [...meetings.assumptions, ...meetings.caveats].join(' ')
  assert.ok(
    !/\b0(\.0)?%|0 seats|0 points|0 percentage points/.test(narration),
    `a nil result must not carry computed figures: ${narration}`,
  )

  const below = asComputed(
    'attendance_below_threshold',
    getTool('attendance_below_threshold')!.run(dataset, { body: missing }),
  )
  // "No director is below the threshold" and "there is no data here" are
  // opposite findings. This used to issue the first for the second, giving a
  // body that does not exist a clean bill of health.
  assert.ok(
    !/no director is below/i.test(below.headline),
    `an absent body must not be reported as compliant: ${below.headline}`,
  )
  assert.match(below.headline, new RegExp(missing))
  assert.equal(below.chart, null, 'a nil result draws no chart')
})

// Filters exist because the tools answered a narrower question with their full
// output: "which actions does the Head of IT own" returned every overdue action
// in the log, and a question naming one director returned a full-year trend.
// Correct data at the wrong scope reads as an answer and buries what was asked.

test('overdue_actions can be filtered to one owner', () => {
  const owners = [...new Set(dataset.actions.actions.map((a) => a.owner))]
  const owner = owners[0]
  const all = run('overdue_actions')
  const filtered = run('overdue_actions', { owner })

  assert.ok(filtered.headline.includes(owner), 'the headline must name the owner filtered to')
  assert.equal(filtered.chart, null, 'one owner is one bar, which is padding not a finding')
  const expected = dataset.actions.actions.filter(
    (a) => a.owner === owner && a.due_date < dataset.asAt && a.status !== 'complete',
  ).length
  assert.equal(filtered.table?.rows.length ?? 0, expected)
  assert.ok((all.table?.rows.length ?? 0) >= expected, 'filtering must narrow, not widen')
})

test('an owner that does not exist returns a caveated nil, not a crash or a full dump', () => {
  const r = run('overdue_actions', { owner: 'Chief Gardener' })
  assert.match(r.headline, /no action in the log is owned by/i)
  assert.equal(r.table, null)
  assert.ok(r.caveats.length > 0, 'a nil result still needs its caveat')
})

test('meetings_missed can be filtered to one director', () => {
  const name = dataset.attendance.records[0].director_name
  const r = run('meetings_missed', { director: name })

  assert.ok(r.headline.includes(name))
  assert.equal(r.chart, null, 'one director is one bar')
  // A ranking sentence is nonsense for a single person.
  assert.ok(!/missed the most|tie on/i.test(r.headline), r.headline)
  assert.ok(!/whole dataset/i.test(r.headline), 'the rows are one director, not the dataset')

  const own = dataset.attendance.records.filter((x) => x.director_name === name)
  const attended = own.filter((x) => x.status === 'present').length
  // Perfect attendance reads "attended all 15", anything else "attended 7 of 10".
  const expected =
    attended === own.length ? `all ${own.length}` : `${attended} of ${own.length}`
  assert.ok(r.headline.includes(expected), `expected "${expected}" in: ${r.headline}`)
})

test('a filtered director with perfect attendance does not speak for the board', () => {
  // Such a director produces no rows in the misses table, and the empty-result
  // branch then said "every director attended every meeting" — true of them,
  // read as a statement about everyone.
  const perfect = dataset.attendance.director_summary.find(
    (d) => d.overall_attendance_pct === 100,
  )
  if (!perfect) return
  const r = run('meetings_missed', { director: perfect.director_name })
  assert.ok(r.headline.startsWith(perfect.director_name), r.headline)
  assert.ok(!/every director/i.test(r.headline), r.headline)
})

test('a director who does not exist returns a caveated nil', () => {
  const r = run('meetings_missed', { director: 'Nobody Here' })
  assert.match(r.headline, /no one named/i)
  assert.equal(r.table, null)
  assert.ok(r.caveats.length > 0)
})

test('attendance_by_committee can rank on meetings held instead of attendance', () => {
  const byRate = run('attendance_by_committee')
  const byMeetings = run('attendance_by_committee', { rank_by: 'meetings' })

  assert.equal(byRate.chart?.unit, 'percent')
  assert.equal(byMeetings.chart?.unit, 'count')

  // The busiest body, computed independently from the meetings list.
  const counts = new Map<string, number>()
  for (const m of dataset.attendance.meetings) {
    counts.set(m.body, (counts.get(m.body) ?? 0) + 1)
  }
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  assert.equal(byMeetings.chart?.points[0].label, busiest[0])
  assert.equal(byMeetings.chart?.points[0].value, busiest[1])
  assert.ok(byMeetings.headline.includes(String(busiest[1])), byMeetings.headline)
  // Meeting count is not workload, and the answer should not imply it is.
  assert.match(byMeetings.headline, /not workload/i)
})

test('skills_gaps can lead on one named skill', () => {
  const skill = dataset.skillNames[0]
  const r = run('skills_gaps', { skill })

  assert.ok(r.headline.startsWith(skill), r.headline)
  // The mean, computed independently from the CSV.
  const scores = dataset.skills.map((d) => d.scores[skill])
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  assert.ok(r.headline.includes(mean.toFixed(2)), `expected ${mean.toFixed(2)} in: ${r.headline}`)
  const strong = scores.filter((n) => n >= 4).length
  const weak = scores.filter((n) => n <= 2).length
  assert.ok(r.headline.includes(`${strong} at 4 or above`), r.headline)
  assert.ok(r.headline.includes(`${weak} at 2 or below`), r.headline)
})

test('a skill that is not in the audit returns a caveated nil', () => {
  const r = run('skills_gaps', { skill: 'Underwater basket weaving' })
  assert.match(r.headline, /not one of the skill areas/i)
  assert.equal(r.chart, null)
  assert.ok(r.caveats.length > 0)
})

test('a chunk spanning two sections says so, rather than naming one', async () => {
  // A window that straddles a heading can hold a figure living on the far side
  // of it. Naming only the dominant section sent a reader to a section where
  // the quoted figure was not, which is a citation nobody can follow.
  const { chunkPapers } = await import('../src/lib/retrieval/chunk')
  const chunks = chunkPapers(dataset.papers)

  const spanning = chunks.filter((c) => c.section.includes(' into '))
  assert.ok(spanning.length > 0, 'this corpus has windows that cross headings')

  for (const chunk of spanning) {
    const [first, second] = chunk.section.split(' into ')
    assert.ok(first.length > 0 && second.length > 0, chunk.section)
    assert.notEqual(first, second, 'a span must name two different sections')
  }

  // Every section named must be a real heading in that paper, or the citation
  // points at something that does not exist.
  const headings = new Map<string, Set<string>>()
  for (const paper of dataset.papers) {
    const found = new Set<string>(['Front matter'])
    for (const line of paper.body.split(/\r?\n/)) {
      const m = line.match(/^###\s+(.+)$/)
      if (m) found.add(m[1].trim())
    }
    headings.set(paper.id, found)
  }
  for (const chunk of chunks) {
    for (const part of chunk.section.split(' into ')) {
      assert.ok(
        headings.get(chunk.paperId)?.has(part),
        `"${part}" is cited for ${chunk.paperId} but is not a heading in it`,
      )
    }
  }
})

// The hybrid tool's own contract — that the limit is attributed to a paper and
// every consequence computed — is exercised in tests/retrieval-offline.test.ts.
// It used to live here behind `if (isRefusal(result)) return`, which with no
// credentials in the environment was taken on EVERY run: the tool always
// refused, so nothing below the early return ever executed, and the test also
// made a real network call.

test('the tenure tool refuses when no paper states a limit', async () => {
  const { findTermLimit } = await import('../src/lib/retrieval/termlimit')
  // No limit in the text, so nothing to count towards.
  assert.equal(
    findTermLimit([
      {
        score: 0.9,
        text: 'The board met four times and reviewed the risk register.',
        paperId: 'p',
        paperTitle: 'T',
        section: 'S',
      },
    ]),
    null,
  )
})

test('a stated limit is read whatever number it uses', async () => {
  const { findTermLimit } = await import('../src/lib/retrieval/termlimit')
  const make = (text: string) => [
    { score: 0.9, text, paperId: 'p', paperTitle: 'T', section: 'S' },
  ]
  // Nine years is not assumed: another organisation's limit must read correctly.
  assert.equal(findTermLimit(make('with a maximum term of twelve.'))?.years, 12)
  assert.equal(findTermLimit(make('both reach the six year limit soon.'))?.years, 6)
  assert.equal(findTermLimit(make('a maximum term of 9 applies.'))?.years, 9)
})

// ---------------------------------------------------------------------------
// Narration that described nothing as if it were something. Each of these was a
// sentence the tool asserted with confidence, computed over an empty or
// wrongly-ordered set, and none of them was caught by a test.

test('no answer names a "heaviest" group that holds nothing', () => {
  const dataset = loadDataset()
  for (const group_by of ['owner', 'committee', 'owner_type']) {
    const r = asComputed('overdue_actions', getTool('overdue_actions')!.run(dataset, { group_by }))
    const claim = r.headline.match(/heaviest \w+ is (.+?) with (\d+)/)
    if (!claim) continue
    // Groups are populated from the recorded-overdue set as well as the derived
    // one, so sorting by derived count could put a zero first — naming it as
    // heaviest while the chart beside it showed another group with more.
    assert.notEqual(claim[2], '0', `named a group holding zero as heaviest: ${r.headline}`)
  }
})

test('an owner with nothing overdue gets caveats about the nil, not about zero bars', () => {
  const dataset = loadDataset()
  const owners = [...new Set(dataset.actions.actions.map((a) => a.owner))]
  const clean = owners.find(
    (o) =>
      !dataset.actions.actions.some(
        (a) => a.owner === o && a.due_date < dataset.asAt && a.status !== 'complete',
      ),
  )
  assert.ok(clean, 'the dataset has an owner with nothing overdue')
  const r = asComputed('overdue_actions', getTool('overdue_actions')!.run(dataset, { owner: clean }))

  const text = r.caveats.join(' ')
  assert.ok(!/\b0 of the 0\b/.test(text), `degenerate caveat: ${text}`)
  assert.ok(!/Only 0 rows/.test(text), `degenerate caveat: ${text}`)
  // A nil still has to be qualified, or it reads as a settled fact.
  assert.ok(r.caveats.length > 0, 'a nil result still needs its caveats')
})

test('the ranking robustness caveat is not emitted for an ordering the chart does not show', () => {
  const dataset = loadDataset()
  const byMeetings = asComputed(
    'attendance_by_committee',
    getTool('attendance_by_committee')!.run(dataset, { rank_by: 'meetings' }),
  )
  // Ranked by meeting count, a caveat about how robust the ATTENDANCE ordering
  // is describes an ordering the reader cannot see — and it was computed from
  // the wrong array, so it named the busiest body as the lowest attender and
  // could produce a negative gap.
  assert.ok(
    !byMeetings.caveats.some((c) => /ranking is not robust/i.test(c)),
    `attendance robustness claimed while ranking on meetings: ${byMeetings.caveats.join(' | ')}`,
  )

  // Ranked on attendance it must still fire, and must name the genuinely
  // lowest body rather than whichever happened to sort first.
  const byRate = asComputed(
    'attendance_by_committee',
    getTool('attendance_by_committee')!.run(dataset, {}),
  )
  const robustness = byRate.caveats.find((c) => /ranking is not robust/i.test(c))
  if (robustness) {
    assert.ok(
      !/-\d/.test(robustness),
      `a gap between ranked bodies cannot be negative: ${robustness}`,
    )
  }
})

test('a tiebreak is only reported when the tie was actually split', () => {
  const dataset = loadDataset()
  // Every skill sharing the cutoff mean was reported as a tiebreak even when
  // all of them made the list, so the answer said choosing the other "would
  // change the ranking" when nothing had been cut.
  for (const top_n_gaps of [1, 2, 3, 4, 5]) {
    const r = asComputed('gap_coverage', getTool('gap_coverage')!.run(dataset, { top_n_gaps }))
    const mentionsTie = /cut through a tie/i.test(r.headline + r.assumptions.join(' '))
    if (!mentionsTie) continue
    const named = r.assumptions.find((a) => /gap areas/i.test(a)) ?? ''
    const tieClause =
      r.headline.match(/cut through a tie at a mean of [\d.]+ between (.+?);/)?.[1] ?? ''
    // Whatever the tiebreak names as the loser must not itself be in the list.
    for (const skill of tieClause.split(/ and |, /).map((x) => x.trim())) {
      if (!skill) continue
      const inList = named.includes(skill)
      const bothIn = tieClause
        .split(/ and |, /)
        .every((x) => named.includes(x.trim()))
      assert.ok(!bothIn || !inList, `a tiebreak was reported though nothing was cut: ${tieClause}`)
    }
  }
})

test('a single body in scope makes no claim about a ranking', () => {
  const dataset = loadDataset()
  const body = allBodies(dataset).find((b) => b !== 'Board')
  assert.ok(body)
  const r = asComputed(
    'committee_skills_gaps',
    getTool('committee_skills_gaps')!.run(dataset, { body }),
  )
  // "carries the widest skills gap" and "ranking on the weakest skill alone
  // puts a different body first" are both comparisons, asserted with no other
  // body in the answer.
  assert.ok(
    !/widest skills gap/i.test(r.headline),
    `superlative with one body in scope: ${r.headline}`,
  )
  assert.ok(
    !r.assumptions.some((a) => /puts a different body first/i.test(a)),
    'claimed another body would rank first, with no other body in scope',
  )
})

test('an action due exactly on the as-at date is not invisible to every tool', async () => {
  // Overdue is due_date < asAt and upcoming was due_date > asAt, so an action
  // due exactly ON the as-at date fell through both and appeared in no answer.
  // Latent on this dataset, which has no such row — so it is constructed.
  const base = loadDataset()
  const sample = base.actions.actions[0]
  const onTheDay = { ...sample, action_id: 'BOUNDARY-1', due_date: base.asAt, status: 'in progress' as const }
  const dataset = {
    ...base,
    actions: { ...base.actions, actions: [...base.actions.actions, onTheDay] },
  }

  const overdue = asComputed('overdue_actions', getTool('overdue_actions')!.run(dataset, {}))
  // Hybrid and async: it reads a fact from a paper before computing.
  const upcoming = await getTool('upcoming_unprepared')!.run(dataset, { within_days: 30 })
  const inOverdue = JSON.stringify(overdue.table?.rows ?? []).includes('BOUNDARY-1')
  const inUpcoming = JSON.stringify(upcoming).includes('BOUNDARY-1')

  assert.ok(
    inOverdue || inUpcoming,
    'an action due on the as-at date must appear somewhere, not fall between the two tools',
  )
  // It is due today, not past due, so upcoming is the correct home for it.
  assert.equal(inOverdue, false, 'due today is not yet overdue')
})

test('every thin group is qualified, not just the largest', () => {
  const dataset = loadDataset()
  const r = asComputed('actions_distribution', getTool('actions_distribution')!.run(dataset, {}))
  const thin = (r.table?.rows ?? []).filter((row) => typeof row[1] === 'number' && (row[1] as number) < 5)
  if (thin.length < 2) return

  const text = r.caveats.join(' ')
  // The loop used to `break` after the first, so the groups a single completion
  // moves furthest — the smallest ones — went unqualified.
  for (const row of thin) {
    assert.ok(
      text.includes(String(row[0])),
      `${row[0]} holds ${row[1]} rows but is not qualified: ${text}`,
    )
  }
})
