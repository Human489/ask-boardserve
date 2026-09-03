import { kvAvailable, kvDelete, kvPut, kvRead } from '@/lib/kv'
import type { ToolResult } from '@/lib/types'

// Pinned charts: the dashboard the secretary assembles for themselves.
//
// A pin stores the FROZEN result, not a live query. The reader pinned a
// particular set of figures and expects to find those figures there — a
// dashboard that silently recomputes is a dashboard whose contents can change
// between being assembled and being presented.
//
// The cost of freezing is staleness, so the tool and its arguments are stored
// alongside the result. That is what makes Refresh possible: the same tool, the
// same arguments, run again, replacing the snapshot in place. Nothing else can
// produce a pinned figure.
//
// It also means the invariant survives. `result` is never accepted from a
// client — the route computes it server-side by running the named tool, exactly
// as answering a question does. A pinned figure has the same provenance as a
// figure on screen because it was produced the same way.

/**
 * Identity of an analysis, stable regardless of key order.
 *
 * The arguments come back from a model as a JSON object, and object key order
 * is not guaranteed to repeat. Keying on the raw stringification made
 * {body, from} and {from, body} different pins, so the same analysis could be
 * pinned twice and the Pin button offered again for a card already on the
 * dashboard. Keys are sorted so the identity is the content.
 */
export function pinKey(tool: string, args: Record<string, unknown>): string {
  const canonical = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join('&')
  return `${tool}:${canonical}`
}

export interface Pin {
  id: string
  /** The question as asked, so the dashboard reads as a set of answers. */
  question: string
  /** The tool and arguments that produced this, and that Refresh re-runs. */
  tool: string
  args: Record<string, unknown>
  /** The frozen answer. Computed server-side, never supplied by a client. */
  result: ToolResult
  routedBy: 'model' | 'fallback'
  /** Wall clock: when the reader pinned it. Not a figure, so a real clock is right. */
  pinnedAt: string
  /** Wall clock: when Refresh last replaced the snapshot, if it ever has. */
  refreshedAt?: string
  /** The dataset as-at the frozen figures were computed against. */
  datasetAsAt: string
}

/**
 * Pins are stored per dataset.
 *
 * A pinned card is a figure about one organisation. Refreshing it re-runs its
 * tool against whatever dataset is active, so a single shared list would let a
 * card pinned from one organisation quietly recompute against another and go on
 * displaying the same question above different figures. Keying by dataset means
 * switching shows that dataset's own pins, and switching back restores the
 * first set exactly as it was.
 */
const KEY = (datasetId: string) => `pins:v1:${datasetId}`

/**
 * A dashboard is something a reader scans, so it has an end. Past a couple of
 * dozen cards it stops being a dashboard and becomes a second transcript, and
 * the whole list travels in one KV value on every read.
 */
export const MAX_PINS = 24

// Without KV configured the app still has to work — that is the same promise
// the router makes when it falls back to the keyword classifier. Pins then live
// for the lifetime of the server process, which is honest for local development
// and is reported to the caller so the UI can say so rather than implying they
// are saved.
const memory = new Map<string, Pin[]>()

/** A stored entry has to look like a pin before the UI is handed it. */
function isPin(value: unknown): value is Pin {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<Pin>
  return (
    typeof p.id === 'string' &&
    typeof p.question === 'string' &&
    typeof p.tool === 'string' &&
    typeof p.args === 'object' &&
    p.args !== null &&
    typeof p.result === 'object' &&
    p.result !== null &&
    typeof (p.result as { headline?: unknown }).headline === 'string'
  )
}

function parse(raw: string): Pin[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Dropping an unrecognised entry keeps a schema change or a hand-edited
    // value from crashing the dashboard render, which `Array.isArray` alone did
    // not: a null element survived the cast and threw on first property access.
    return parsed.filter(isPin)
  } catch {
    // A corrupt value is treated as no pins rather than as an error: the
    // dashboard being empty is recoverable, the app failing to load is not.
    return []
  }
}

export interface PinStore {
  pins: Pin[]
  /** False when KV is unconfigured and pins only survive this process. */
  durable: boolean
  /**
   * False when KV could not be read at all. The pins list is then not empty,
   * it is UNKNOWN, and nothing may be written on top of it.
   */
  reachable: boolean
}

export async function listPins(datasetId: string): Promise<PinStore> {
  if (!kvAvailable()) {
    return { pins: memory.get(datasetId) ?? [], durable: false, reachable: true }
  }
  const read = await kvRead(KEY(datasetId))
  // An unreachable store reports itself rather than presenting as empty. This
  // is the difference between "you have no pins" and "we could not ask".
  if (!read.ok) return { pins: [], durable: true, reachable: false }
  if (read.missing) return { pins: [], durable: true, reachable: true }
  return { pins: parse(read.value), durable: true, reachable: true }
}

async function write(datasetId: string, pins: Pin[]): Promise<boolean> {
  if (!kvAvailable()) {
    memory.set(datasetId, pins)
    return true
  }
  // Permanent: no TTL. A pin that expired on its own would be a silent loss.
  return kvPut(KEY(datasetId), JSON.stringify(pins), null)
}

export type AddOutcome =
  | { ok: true; pins: Pin[]; durable: boolean }
  | { ok: false; reason: 'full' | 'duplicate' | 'write-failed' | 'unreachable' }

/**
 * Newest first, because the dashboard is read from the top and the thing just
 * pinned is the thing being looked for.
 *
 * The read-modify-write here is not atomic — KV has no compare-and-set — so two
 * people pinning at the same moment can lose one of the two pins. With a single
 * shared passcode and one reader that is a theoretical race rather than a
 * practical one, and the alternative (a key per pin plus a list operation on
 * every read) costs a round trip per card for a collision that will not happen.
 */
export async function addPin(datasetId: string, pin: Pin): Promise<AddOutcome> {
  const { pins, durable, reachable } = await listPins(datasetId)
  // Writing here would replace every existing pin with just this one, because
  // an unreadable list looks exactly like an empty one.
  if (!reachable) return { ok: false, reason: 'unreachable' }

  // Pinning the same analysis twice would put two identical cards on the
  // dashboard, which reads as a bug rather than as two pins.
  const already = pins.find(
    (p) => pinKey(p.tool, p.args) === pinKey(pin.tool, pin.args),
  )
  if (already) return { ok: false, reason: 'duplicate' }

  if (pins.length >= MAX_PINS) return { ok: false, reason: 'full' }

  const next = [pin, ...pins]
  if (!(await write(datasetId, next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, pins: next, durable }
}

export type MutateOutcome =
  | { ok: true; pins: Pin[]; durable: boolean }
  | { ok: false; reason: 'not-found' | 'write-failed' | 'unreachable' }

export async function removePin(datasetId: string, id: string): Promise<MutateOutcome> {
  const { pins, durable, reachable } = await listPins(datasetId)
  if (!reachable) return { ok: false, reason: 'unreachable' }
  const next = pins.filter((p) => p.id !== id)
  if (next.length === pins.length) return { ok: false, reason: 'not-found' }
  if (next.length === 0) {
    // Leave no empty array behind to be read back on every load.
    if (kvAvailable()) {
      if (!(await kvDelete(KEY(datasetId)))) return { ok: false, reason: 'write-failed' }
    } else {
      memory.delete(datasetId)
    }
    return { ok: true, pins: [], durable }
  }
  if (!(await write(datasetId, next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, pins: next, durable }
}

/** Replaces one pin's frozen snapshot in place, keeping its position. */
export async function replacePin(
  datasetId: string,
  id: string,
  updated: Pin,
): Promise<MutateOutcome> {
  const { pins, durable, reachable } = await listPins(datasetId)
  if (!reachable) return { ok: false, reason: 'unreachable' }
  const index = pins.findIndex((p) => p.id === id)
  if (index === -1) return { ok: false, reason: 'not-found' }
  const next = [...pins]
  next[index] = updated
  if (!(await write(datasetId, next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, pins: next, durable }
}

/**
 * Removes a dataset's whole dashboard.
 *
 * Called when the dataset itself is deleted. Re-uploading the same files
 * produces a new id, so pins left behind could never be reached again — they
 * would just sit in the namespace, and a "remove everything" would not have.
 */
export async function deletePinsFor(datasetId: string): Promise<void> {
  memory.delete(datasetId)
  if (kvAvailable()) await kvDelete(KEY(datasetId))
}

/** Test seam. Clears only the in-process layer. */
export function resetPins(): void {
  memory.clear()
}
