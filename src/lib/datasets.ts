import {
  buildDataset,
  loadDataset,
  localDatasetExists,
  type DatasetFiles,
} from '@/lib/dataset/loader'
import { kvAvailable, kvDelete, kvPut, kvRead } from '@/lib/kv'
import type { Dataset } from '@/lib/types'

// Uploaded datasets, held in KV.
//
// The app is dataset-agnostic by design, but until now it could only read one
// dataset, from a directory that is gitignored and therefore absent from the
// deployment. So the deployed app could not answer anything. Uploading is how a
// dataset gets in; KV is where it stays, because Vercel gives a serverless
// function no writable disk that another instance can read.
//
// What is stored is the FILE MAP, not the parsed dataset: it is smaller, it is
// the actual source of truth, and it means a change to the parser applies to
// datasets already uploaded rather than leaving stale derived data behind.
//
// One active dataset is shared, not per-visitor. That matches the rest of the
// product — a single shared passcode, one shared pinned dashboard — and it is
// what makes the deployed link work for someone opening it cold after the first
// upload has happened.

export interface DatasetSummary {
  id: string
  /** Organisation name, read from the data rather than supplied by the uploader. */
  organisation: string
  /** The as-at date the figures are measured from. */
  asAt: string
  paperCount: number
  directorCount: number
  actionCount: number
  /** Wall clock. Describes the upload, not any figure, so a real clock is right. */
  uploadedAt: string
}

const FILES_KEY = (id: string) => `dataset:v1:${id}`
const INDEX_KEY = 'datasets:v1:index'
const ACTIVE_KEY = 'datasets:v1:active'

/** Local fallback so uploading works in development with no KV configured. */
const memoryFiles = new Map<string, DatasetFiles>()
let memoryIndex: DatasetSummary[] = []
let memoryActive: string | null = null

/** Parsed datasets, per instance, keyed by id. Files in KV never change. */
const parsed = new Map<string, Dataset>()

export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: 'unreachable' }

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

/** Readable, and unique enough that two uploads of the same org do not collide. */
export function datasetId(organisation: string): string {
  const base = slug(organisation) || 'dataset'
  return `${base}-${Date.now().toString(36)}`
}

async function readJson<T>(key: string): Promise<StoreResult<T | null>> {
  if (!kvAvailable()) return { ok: true, value: null }
  const read = await kvRead(key)
  // As with pins: a store that cannot be read is not a store that is empty.
  // Writing on top of an unknown value is how data disappears.
  if (!read.ok) return { ok: false, reason: 'unreachable' }
  if (read.missing) return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(read.value) as T }
  } catch {
    return { ok: true, value: null }
  }
}

export async function listDatasets(): Promise<StoreResult<DatasetSummary[]>> {
  if (!kvAvailable()) return { ok: true, value: memoryIndex }
  const read = await readJson<DatasetSummary[]>(INDEX_KEY)
  if (!read.ok) return read
  return { ok: true, value: Array.isArray(read.value) ? read.value : [] }
}

export async function activeDatasetId(): Promise<StoreResult<string | null>> {
  if (!kvAvailable()) return { ok: true, value: memoryActive }
  const read = await kvRead(ACTIVE_KEY)
  if (!read.ok) return { ok: false, reason: 'unreachable' }
  return { ok: true, value: read.missing ? null : read.value.trim() || null }
}

export async function setActiveDataset(id: string): Promise<StoreResult<true>> {
  if (!kvAvailable()) {
    memoryActive = id
    return { ok: true, value: true }
  }
  const written = await kvPut(ACTIVE_KEY, id, null)
  return written ? { ok: true, value: true } : { ok: false, reason: 'unreachable' }
}

/**
 * Stores a dataset and makes it the active one.
 *
 * The files are parsed BEFORE anything is written. An archive that cannot be
 * turned into a dataset is rejected at upload, where the person who uploaded it
 * can see why, rather than becoming a broken answer later.
 */
export async function saveDataset(
  files: DatasetFiles,
): Promise<
  | { ok: true; summary: DatasetSummary }
  | { ok: false; reason: 'invalid'; error: string }
  | { ok: false; reason: 'unreachable' }
> {
  let dataset: Dataset
  try {
    dataset = buildDataset(files)
  } catch (e) {
    return { ok: false, reason: 'invalid', error: (e as Error).message }
  }

  const summary: DatasetSummary = {
    id: datasetId(dataset.organisation),
    organisation: dataset.organisation,
    asAt: dataset.asAt,
    paperCount: dataset.papers.length,
    directorCount: dataset.attendance.director_summary?.length ?? 0,
    actionCount: dataset.actions.actions?.length ?? 0,
    uploadedAt: new Date().toISOString(),
  }

  if (!kvAvailable()) {
    memoryFiles.set(summary.id, files)
    memoryIndex = [summary, ...memoryIndex.filter((d) => d.id !== summary.id)]
    memoryActive = summary.id
    parsed.set(summary.id, dataset)
    return { ok: true, summary }
  }

  const index = await listDatasets()
  if (!index.ok) return { ok: false, reason: 'unreachable' }

  if (!(await kvPut(FILES_KEY(summary.id), JSON.stringify(files), null))) {
    return { ok: false, reason: 'unreachable' }
  }
  const next = [summary, ...index.value.filter((d) => d.id !== summary.id)]
  if (!(await kvPut(INDEX_KEY, JSON.stringify(next), null))) {
    // The files landed but the index did not, so the dataset would be invisible.
    // Remove it rather than leave an orphan consuming the namespace.
    await kvDelete(FILES_KEY(summary.id))
    return { ok: false, reason: 'unreachable' }
  }
  await setActiveDataset(summary.id)
  parsed.set(summary.id, dataset)
  return { ok: true, summary }
}

export async function getDataset(id: string): Promise<StoreResult<Dataset | null>> {
  const already = parsed.get(id)
  if (already) return { ok: true, value: already }

  if (!kvAvailable()) {
    const files = memoryFiles.get(id)
    if (!files) return { ok: true, value: null }
    const dataset = buildDataset(files)
    parsed.set(id, dataset)
    return { ok: true, value: dataset }
  }

  const read = await readJson<DatasetFiles>(FILES_KEY(id))
  if (!read.ok) return read
  if (!read.value) return { ok: true, value: null }
  try {
    const dataset = buildDataset(read.value)
    parsed.set(id, dataset)
    return { ok: true, value: dataset }
  } catch {
    // Stored files that no longer parse are treated as absent rather than
    // crashing every question asked of them.
    return { ok: true, value: null }
  }
}

export async function deleteDataset(id: string): Promise<StoreResult<DatasetSummary[]>> {
  parsed.delete(id)
  if (!kvAvailable()) {
    memoryFiles.delete(id)
    memoryIndex = memoryIndex.filter((d) => d.id !== id)
    if (memoryActive === id) memoryActive = memoryIndex[0]?.id ?? null
    return { ok: true, value: memoryIndex }
  }

  const index = await listDatasets()
  if (!index.ok) return index
  const next = index.value.filter((d) => d.id !== id)
  if (!(await kvPut(INDEX_KEY, JSON.stringify(next), null))) {
    return { ok: false, reason: 'unreachable' }
  }
  await kvDelete(FILES_KEY(id))

  // Never leave the active pointer aimed at something that is gone.
  const active = await activeDatasetId()
  if (active.ok && active.value === id) {
    if (next[0]) await setActiveDataset(next[0].id)
    else await kvDelete(ACTIVE_KEY)
  }
  return { ok: true, value: next }
}

/** Test seam. Clears only the in-process layer. */
export function resetDatasetStore(): void {
  memoryFiles.clear()
  memoryIndex = []
  memoryActive = null
  parsed.clear()
}

export type Resolved =
  | { ok: true; dataset: Dataset; id: string; source: 'uploaded' }
  | { ok: true; dataset: Dataset; id: 'local'; source: 'local' }
  | { ok: false; reason: 'none' }
  | { ok: false; reason: 'unreachable' }

/**
 * The dataset a request should answer from.
 *
 * An uploaded dataset wins, because uploading one is an explicit act. The local
 * directory is the development fallback and is what the test suite uses. When
 * there is neither, that is not an error to be logged and turned into a 500 —
 * it is a first run, and the caller is told so it can ask for a dataset.
 */
export async function resolveDataset(): Promise<Resolved> {
  const active = await activeDatasetId()
  if (!active.ok) return { ok: false, reason: 'unreachable' }

  if (active.value) {
    const stored = await getDataset(active.value)
    if (!stored.ok) return { ok: false, reason: 'unreachable' }
    if (stored.value) {
      return { ok: true, dataset: stored.value, id: active.value, source: 'uploaded' }
    }
    // The pointer outlived the data. Fall through rather than fail: a local
    // dataset, if there is one, is a better answer than an error.
  }

  if (localDatasetExists()) {
    return { ok: true, dataset: loadDataset(), id: 'local', source: 'local' }
  }
  return { ok: false, reason: 'none' }
}
