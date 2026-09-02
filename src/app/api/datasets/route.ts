import { NextResponse } from 'next/server'
import { clientIp, rejectUnauthorised } from '@/lib/apiauth'
import { ArchiveError, filesFromZip } from '@/lib/dataset/archive'
import {
  activeDatasetId,
  deleteDataset,
  listDatasets,
  saveDataset,
  setActiveDataset,
} from '@/lib/datasets'
import { localDatasetExists } from '@/lib/dataset/loader'
import { kvAvailable } from '@/lib/kv'
import { checkRateLimit } from '@/lib/ratelimit'

// Uploading and switching datasets.
//
// The dataset is gitignored and must stay that way, so the deployed app starts
// with nothing to answer from. This route is how one gets in, and KV is where it
// stays — which means the first upload also fixes the cold-open problem for
// everyone afterwards.

export const runtime = 'nodejs'

/** A dataset of a few hundred KB; this is a generous ceiling, not a target. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/**
 * Uploading requires KV, and saying so is better than appearing to work.
 *
 * The in-memory fallback that pins use cannot serve this. Each route handler is
 * its own module instance — separately in development, and as a separate
 * function in production — so a dataset held in one route's memory is invisible
 * to the route that answers questions. Measured, not assumed: an upload with KV
 * unconfigured reported success and the next question was still answered from
 * the local directory. A feature that silently does nothing is worse than one
 * that refuses.
 */
function storageUnavailable(): NextResponse | null {
  if (kvAvailable()) return null
  return fail(
    503,
    'Uploading needs a storage namespace, and none is configured. Set CF_KV_NAMESPACE_ID ' +
      '(with CF_ACCOUNT_ID and CF_API_TOKEN) to upload datasets. Until then the app ' +
      'answers from the dataset directory on the server.',
  )
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status })
}

function logDetail(where: string, e: unknown): void {
  console.error(`[api/datasets] ${where}:`, e instanceof Error ? e.stack ?? e.message : e)
}

async function throttled(req: Request): Promise<NextResponse | null> {
  const limit = await checkRateLimit(clientIp(req))
  if (limit.allowed) return null
  return NextResponse.json(
    {
      ok: false,
      error: `Too many requests in a short time. Please wait ${limit.retryAfterSeconds} seconds and try again.`,
      retryAfterSeconds: limit.retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
  )
}

async function currentState() {
  const [index, active] = await Promise.all([listDatasets(), activeDatasetId()])
  if (!index.ok || !active.ok) return null
  return {
    datasets: index.value,
    activeId: active.value,
    /** True when a dataset directory is present, which is the dev fallback. */
    localAvailable: localDatasetExists(),
    /** False means uploading is unavailable, and the view says why. */
    storageAvailable: kvAvailable(),
  }
}

export async function GET(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited

  const state = await currentState()
  if (!state) return fail(502, 'The dataset store could not be read. Try again in a moment.')
  return NextResponse.json({ ok: true, ...state })
}

/** Upload a .zip holding one dataset. It becomes the active dataset. */
export async function POST(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited
  // After auth: whether storage is configured is a detail of the deployment,
  // not something an unauthenticated caller should be able to probe for.
  const noStore = storageUnavailable()
  if (noStore) return noStore

  let bytes: Uint8Array
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return fail(400, 'Attach a .zip file containing the dataset.')
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return fail(413, 'That file is too large. A dataset archive should be a few hundred KB.')
    }
    if (file.size === 0) return fail(400, 'That file is empty.')
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (e) {
    logDetail('reading upload', e)
    return fail(400, 'The upload could not be read.')
  }

  let files
  try {
    files = filesFromZip(bytes)
  } catch (e) {
    // An archive problem is the uploader's to fix, so it is reported in full
    // rather than reduced to a generic failure.
    if (e instanceof ArchiveError) return fail(400, e.message)
    logDetail('unzip', e)
    return fail(400, 'That file could not be read as a .zip archive.')
  }

  const saved = await saveDataset(files)
  if (!saved.ok) {
    if (saved.reason === 'invalid') {
      // The archive was readable but is not a dataset this app can answer from.
      // Said plainly here, where it can be corrected.
      return fail(422, saved.error)
    }
    return fail(502, 'The dataset could not be saved. Nothing was changed — try again.')
  }

  const state = await currentState()
  return NextResponse.json({ ok: true, summary: saved.summary, ...(state ?? {}) })
}

/** Switch the active dataset. Body: { id }. */
export async function PATCH(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited
  // After auth: whether storage is configured is a detail of the deployment,
  // not something an unauthenticated caller should be able to probe for.
  const noStore = storageUnavailable()
  if (noStore) return noStore

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'The request body was not valid JSON.')
  }
  const { id } = (body ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || id === '') return fail(400, 'Which dataset should be used?')

  const index = await listDatasets()
  if (!index.ok) return fail(502, 'The dataset store could not be read. Try again in a moment.')
  // 'local' is the development directory rather than a stored dataset, so it is
  // selected by clearing the pointer rather than by pointing at an id.
  if (id !== 'local' && !index.value.some((d) => d.id === id)) {
    return fail(404, 'That dataset is no longer available.')
  }

  const set = await setActiveDataset(id === 'local' ? '' : id)
  if (!set.ok) return fail(502, 'The dataset could not be switched. Try again.')

  const state = await currentState()
  if (!state) return fail(502, 'The dataset store could not be read. Try again in a moment.')
  return NextResponse.json({ ok: true, ...state })
}

/** Remove a stored dataset. Body: { id }. */
export async function DELETE(req: Request) {
  const denied = await rejectUnauthorised(req)
  if (denied) return denied
  const limited = await throttled(req)
  if (limited) return limited
  // After auth: whether storage is configured is a detail of the deployment,
  // not something an unauthenticated caller should be able to probe for.
  const noStore = storageUnavailable()
  if (noStore) return noStore

  let body: unknown
  try {
    body = await req.json()
  } catch (e) {
    logDetail('request body', e)
    return fail(400, 'The request body was not valid JSON.')
  }
  const { id } = (body ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || id === '') return fail(400, 'Which dataset should be removed?')

  const removed = await deleteDataset(id)
  if (!removed.ok) {
    return fail(502, 'The dataset could not be removed. Nothing was changed — try again.')
  }

  const state = await currentState()
  if (!state) return fail(502, 'The dataset store could not be read. Try again in a moment.')
  return NextResponse.json({ ok: true, ...state })
}
