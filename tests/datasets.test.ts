import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

// Exercised against the in-memory layer, which is the path taken when KV is
// unconfigured. Cleared explicitly: with real credentials in the environment
// this suite would otherwise write its fixtures into the live store and change
// which dataset the deployed app is answering from.
delete process.env.CF_KV_NAMESPACE_ID
delete process.env.CF_ACCOUNT_ID
delete process.env.CF_API_TOKEN

import { ArchiveError, filesFromZip } from '../src/lib/dataset/archive'
import { buildDataset } from '../src/lib/dataset/loader'
import {
  saveDataset,
  listDatasets,
  activeDatasetId,
  getDataset,
  deleteDataset,
  setActiveDataset,
  resetDatasetStore,
} from '../src/lib/datasets'
import { addPin, listPins, resetPins } from '../src/lib/pins'
import { isRefusal } from '../src/lib/types'
import type { Pin } from '../src/lib/pins'
import type { ToolResult } from '../src/lib/types'

const DIR = process.env.DATASET_PATH ?? join(process.cwd(), 'dataset')

/** The real dataset's files, which is what an upload will actually contain. */
function realFiles(): Record<string, string> {
  const wanted = (n: string) =>
    ['attendance.json', 'actions.json', 'skills-audit.csv'].includes(n) ||
    (n.startsWith('paper-') && n.endsWith('.md'))
  const files: Record<string, string> = {}
  for (const name of readdirSync(DIR).filter(wanted)) {
    files[name] = readFileSync(join(DIR, name), 'utf8')
  }
  return files
}

/** Zipping a folder puts everything under a prefix, so that is the real case. */
function zipOf(files: Record<string, string>, prefix = 'dataset-a/'): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, body] of Object.entries(files)) {
    entries[`${prefix}${name}`] = strToU8(body)
  }
  return zipSync(entries)
}

// ------------------------------------------------------------------ archive

test('a zipped dataset folder is read despite its folder prefix', () => {
  const files = filesFromZip(zipOf(realFiles()))
  assert.ok(files['attendance.json'])
  assert.ok(files['actions.json'])
  assert.ok(files['skills-audit.csv'])
  assert.ok(Object.keys(files).some((f) => f.startsWith('paper-')))
})

test('a zip with no folder prefix is read too', () => {
  const files = filesFromZip(zipOf(realFiles(), ''))
  assert.ok(files['attendance.json'])
})

test('files outside the dataset are ignored rather than trusted', () => {
  const files = realFiles()
  const entries: Record<string, Uint8Array> = { 'evil.sh': strToU8('rm -rf /') }
  for (const [n, b] of Object.entries(files)) entries[`d/${n}`] = strToU8(b)
  const read = filesFromZip(zipSync(entries))
  assert.equal(read['evil.sh'], undefined)
})

test('a path-traversal entry cannot smuggle a file in under a dataset name', () => {
  // Only the basename is ever used, so "../../attendance.json" would collide
  // with the real one rather than escaping anywhere. The collision is refused.
  const files = realFiles()
  const entries: Record<string, Uint8Array> = {}
  for (const [n, b] of Object.entries(files)) entries[`d/${n}`] = strToU8(b)
  entries['../../attendance.json'] = strToU8('{"malicious": true}')
  assert.throws(() => filesFromZip(zipSync(entries)), ArchiveError)
})

test('an archive missing a required file says which one', () => {
  const files = realFiles()
  delete files['skills-audit.csv']
  assert.throws(
    () => filesFromZip(zipOf(files)),
    (e: Error) => e instanceof ArchiveError && /skills-audit\.csv/.test(e.message),
  )
})

test('something that is not a zip is rejected as one', () => {
  assert.throws(() => filesFromZip(strToU8('this is not a zip')), ArchiveError)
})

// ------------------------------------------------------------------ parsing

test('an uploaded dataset parses to the same thing as the one on disk', () => {
  const fromZip = buildDataset(filesFromZip(zipOf(realFiles())))
  const fromDisk = buildDataset(realFiles())
  // The upload path must not be a second, subtly different parser.
  assert.equal(fromZip.organisation, fromDisk.organisation)
  assert.equal(fromZip.asAt, fromDisk.asAt)
  assert.equal(fromZip.papers.length, fromDisk.papers.length)
  assert.equal(fromZip.skills.length, fromDisk.skills.length)
  assert.deepEqual(fromZip.skillNames, fromDisk.skillNames)
})

test('an archive that is readable but not a dataset is refused with a reason', () => {
  const files = realFiles()
  files['attendance.json'] = '{ not json'
  assert.throws(
    () => buildDataset(files),
    (e: Error) => /attendance\.json is not valid JSON/.test(e.message),
  )
})

// -------------------------------------------------------------------- store

test('an uploaded dataset is stored, summarised and made active', async () => {
  resetDatasetStore()
  const saved = await saveDataset(realFiles())
  assert.equal(saved.ok, true)
  if (!saved.ok) return

  // The summary is read from the data, never supplied by the uploader.
  assert.ok(saved.summary.organisation.length > 0)
  assert.match(saved.summary.asAt, /^\d{4}-\d{2}-\d{2}/)
  assert.ok(saved.summary.paperCount > 0)

  const active = await activeDatasetId()
  assert.equal(active.ok && active.value, saved.summary.id)

  const list = await listDatasets()
  assert.equal(list.ok && list.value.length, 1)
})

test('a stored dataset reads back as an equivalent dataset', async () => {
  resetDatasetStore()
  const saved = await saveDataset(realFiles())
  assert.ok(saved.ok)
  if (!saved.ok) return
  const got = await getDataset(saved.summary.id)
  assert.ok(got.ok && got.value)
  assert.equal(got.value?.organisation, saved.summary.organisation)
})

test('an invalid dataset is rejected before anything is stored', async () => {
  resetDatasetStore()
  const broken = realFiles()
  broken['actions.json'] = 'nonsense'
  const saved = await saveDataset(broken)
  assert.equal(saved.ok, false)
  assert.equal(saved.ok === false && saved.reason, 'invalid')
  // Nothing must be left behind by a rejected upload.
  const list = await listDatasets()
  assert.equal(list.ok && list.value.length, 0)
})

test('deleting the active dataset moves the pointer rather than dangling', async () => {
  resetDatasetStore()
  const first = await saveDataset(realFiles())
  const second = await saveDataset(realFiles())
  assert.ok(first.ok && second.ok)
  if (!first.ok || !second.ok) return

  const removed = await deleteDataset(second.summary.id)
  assert.ok(removed.ok)
  const active = await activeDatasetId()
  // The pointer must never name something that is gone.
  assert.notEqual(active.ok && active.value, second.summary.id)
  assert.equal(active.ok && active.value, first.summary.id)
})

// --------------------------------------------------------------------- pins

function samplePin(id: string): Pin {
  const result: ToolResult = {
    tool: 'attendance_by_director',
    headline: `headline ${id}`,
    chart: null,
    table: null,
    assumptions: [],
    caveats: [],
    provenance: { asAt: '2026-03-31', sources: ['attendance.json'], rowsConsidered: 1, derivation: 'test' },
  }
  return {
    id,
    question: `question ${id}`,
    tool: 'attendance_by_director',
    args: {},
    result,
    routedBy: 'model',
    pinnedAt: '2026-09-02T10:00:00.000Z',
    datasetAsAt: '2026-03-31',
  }
}

test('pins do not leak between datasets', async () => {
  resetPins()
  await addPin('org-a', samplePin('a1'))
  await addPin('org-b', samplePin('b1'))

  const a = await listPins('org-a')
  const b = await listPins('org-b')
  // A card pinned from one organisation must never appear under another, or a
  // Refresh would recompute it against the wrong board.
  assert.deepEqual(a.pins.map((p) => p.id), ['a1'])
  assert.deepEqual(b.pins.map((p) => p.id), ['b1'])
})

test('switching away and back leaves the first dataset pins untouched', async () => {
  resetPins()
  resetDatasetStore()
  await addPin('org-a', samplePin('a1'))
  await setActiveDataset('org-b')
  assert.equal((await listPins('org-b')).pins.length, 0)
  await setActiveDataset('org-a')
  assert.deepEqual((await listPins('org-a')).pins.map((p) => p.id), ['a1'])
})

test('the refusal type guard is real, so these fixtures mean something', () => {
  assert.equal(isRefusal({ tool: 'refusal', headline: 'h', reason: 'r' }), true)
})

// ---------------------------------------------------------------------------
// Valid JSON is not the same as a dataset. These were found by feeding
// buildDataset malformed-but-parseable files, and each one produced either a
// confident wrong answer or a 500 at question time rather than a rejection at
// upload time — where the person holding the file can fix it.

test('an as-at date that is not a quoted ISO string is refused', () => {
  // Every date in the product is compared as text: overdue is
  // `due_date < asAt`. An unquoted date in JSON arrives as a number, and
  // comparing a string to a number is false for every row — so a dataset with
  // nine overdue actions reported NONE of them, as a finished sentence,
  // against a date reading "20260831".
  const files = realFiles()
  const actions = JSON.parse(files['actions.json']) as Record<string, unknown>
  actions.as_at = 20260831
  files['actions.json'] = JSON.stringify(actions)

  assert.throws(
    () => buildDataset(files),
    (e: Error) => /as-at date must be a plain quoted ISO date/.test(e.message),
  )
})

test('a prose date is refused for the same reason', () => {
  const files = realFiles()
  const actions = JSON.parse(files['actions.json']) as Record<string, unknown>
  actions.as_at = '31 August 2026'
  files['actions.json'] = JSON.stringify(actions)
  assert.throws(() => buildDataset(files), /plain quoted ISO date/)
})

test('an as-at date carrying a time is refused, not quietly accepted', () => {
  // This test used to assert the opposite, and was wrong.
  //
  // "2026-08-31T00:00:00Z" sorts ABOVE "2026-08-31" as text, and every date
  // here is compared as text. So an action due ON the as-at date satisfied
  // `due_date < asAt` and was reported "overdue by 0 days", while
  // upcoming_unprepared asks `due_date >= asAt` and excluded it — the same row
  // overdue and not upcoming, which is precisely the both-tools-miss-it hole
  // the inclusive fix had just closed.
  //
  // Refused rather than trimmed to a date: silently reinterpreting someone's
  // data is how a dataset comes to mean something its owner did not write.
  const files = realFiles()
  const actions = JSON.parse(files['actions.json']) as Record<string, unknown>
  actions.as_at = '2026-08-31T00:00:00Z'
  files['actions.json'] = JSON.stringify(actions)
  assert.throws(() => buildDataset(files), /plain quoted ISO date/)
})

test('an as-at date that is not a real calendar date is refused', () => {
  // "2026-99-99" passed the shape check and produced "3049 days past due".
  const files = realFiles()
  const actions = JSON.parse(files['actions.json']) as Record<string, unknown>
  actions.as_at = '2026-99-99'
  files['actions.json'] = JSON.stringify(actions)
  assert.throws(() => buildDataset(files), /plain quoted ISO date/)
})

test('an empty action log answers rather than throwing', async () => {
  // unresolved_by_committee read byCount[0].body with no guard, so a board with
  // nothing outstanding — a real state, and one buildDataset accepts — crashed
  // into "the analysis could not be completed".
  const { getTool } = await import('../src/lib/analytics/registry')
  const files = realFiles()
  const actions = JSON.parse(files['actions.json']) as Record<string, unknown>
  actions.actions = []
  files['actions.json'] = JSON.stringify(actions)
  const dataset = buildDataset(files)

  for (const name of ['unresolved_by_committee', 'overdue_actions', 'actions_distribution']) {
    const tool = getTool(name)
    assert.ok(tool, name)
    const result = await tool.run(dataset, {})
    assert.ok(result.headline.length > 0, `${name} produced no headline`)
  }
})

test('a JSON file of the wrong shape is refused rather than crashing a tool later', () => {
  // `[]` parses cleanly, then every field reads as undefined and the first tool
  // to touch `records` throws — a 500 when a question is asked, rather than a
  // rejected upload.
  const asArray = realFiles()
  asArray['attendance.json'] = '[]'
  assert.throws(() => buildDataset(asArray), /must be a JSON object, not an array/)

  const missingArray = realFiles()
  const actions = JSON.parse(missingArray['actions.json']) as Record<string, unknown>
  delete actions.actions
  missingArray['actions.json'] = JSON.stringify(actions)
  assert.throws(() => buildDataset(missingArray), /missing its "actions" array/)
})
