import { kvAvailable, kvDelete, kvGet, kvPut } from '@/lib/kv'
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

const KEY = 'pins:v1'

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
let memory: Pin[] = []

function parse(raw: string | null): Pin[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Pin[]) : []
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
}

export async function listPins(): Promise<PinStore> {
  if (!kvAvailable()) return { pins: memory, durable: false }
  return { pins: parse(await kvGet(KEY)), durable: true }
}

async function write(pins: Pin[]): Promise<boolean> {
  if (!kvAvailable()) {
    memory = pins
    return true
  }
  // Permanent: no TTL. A pin that expired on its own would be a silent loss.
  return kvPut(KEY, JSON.stringify(pins), null)
}

export type AddOutcome =
  | { ok: true; pins: Pin[]; durable: boolean }
  | { ok: false; reason: 'full' | 'duplicate' | 'write-failed' }

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
export async function addPin(pin: Pin): Promise<AddOutcome> {
  const { pins, durable } = await listPins()

  // Pinning the same analysis twice would put two identical cards on the
  // dashboard, which reads as a bug rather than as two pins.
  const already = pins.find(
    (p) => p.tool === pin.tool && JSON.stringify(p.args) === JSON.stringify(pin.args),
  )
  if (already) return { ok: false, reason: 'duplicate' }

  if (pins.length >= MAX_PINS) return { ok: false, reason: 'full' }

  const next = [pin, ...pins]
  if (!(await write(next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, pins: next, durable }
}

export type MutateOutcome =
  | { ok: true; pins: Pin[]; durable: boolean }
  | { ok: false; reason: 'not-found' | 'write-failed' }

export async function removePin(id: string): Promise<MutateOutcome> {
  const { pins, durable } = await listPins()
  const next = pins.filter((p) => p.id !== id)
  if (next.length === pins.length) return { ok: false, reason: 'not-found' }
  if (next.length === 0) {
    // Leave no empty array behind to be read back on every load.
    if (kvAvailable()) {
      if (!(await kvDelete(KEY))) return { ok: false, reason: 'write-failed' }
    } else {
      memory = []
    }
    return { ok: true, pins: [], durable }
  }
  if (!(await write(next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, pins: next, durable }
}

/** Replaces one pin's frozen snapshot in place, keeping its position. */
export async function replacePin(id: string, updated: Pin): Promise<MutateOutcome> {
  const { pins, durable } = await listPins()
  const index = pins.findIndex((p) => p.id === id)
  if (index === -1) return { ok: false, reason: 'not-found' }
  const next = [...pins]
  next[index] = updated
  if (!(await write(next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, pins: next, durable }
}

/** Test seam. Clears only the in-process layer. */
export function resetPins(): void {
  memory = []
}
