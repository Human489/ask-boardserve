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
