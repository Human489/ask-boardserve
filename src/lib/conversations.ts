import { kvAvailable, kvPut, kvRead } from '@/lib/kv'
import type { AnswerResult, RoutedBy } from '@/lib/types'

// Separate conversations, each with its own history.
//
// Until now the transcript was a Map in Chat.tsx keyed by dataset, so it lived
// exactly as long as the tab did: a refresh returned to an empty composer, and
// the reader could hold only one line of enquiry at a time. A secretary
// preparing a pack is doing several at once — attendance for one committee,
// then the action log, then back — and losing the first to ask the second is
// the kind of thing that makes a tool feel like a demo.
//
// Two things this must not break.
//
// ROUTING CONTEXT IS PER CONVERSATION. Prior answers' headlines are sent back
// to the model so "now just Q3" can refine the previous chart. If that context
// came from anywhere but the active conversation, a follow-up would be refined
// against a question the reader is not looking at — the same class of fault as
// sharing one transcript across two organisations, which is why transcripts
// were keyed by dataset in the first place.
//
// CONVERSATIONS ARE PER DATASET, for that same reason. `pins:v1:<datasetId>`
// set the precedent and this follows it: switching dataset switches the list,
// and switching back restores it rather than destroying it.

/** One question and the answer it got, as stored. */
export interface StoredTurn {
  id: string
  question: string
  result: AnswerResult
  routedBy?: RoutedBy
  /** The tool and arguments that produced it, so the answer can still be pinned. */
  routedTo?: { tool: string; args: Record<string, unknown> }
}

export interface Conversation {
  id: string
  /** Derived from the first question. Never model-written; see `titleFrom`. */
  title: string
  turns: StoredTurn[]
  createdAt: string
  updatedAt: string
}

/** A conversation with its turns dropped, for the list in the sidebar. */
export type ConversationSummary = Omit<Conversation, 'turns'> & { turnCount: number }

const KEY = (datasetId: string) => `conversations:v1:${datasetId}`

/**
 * The whole list travels in one KV value on every read, and a transcript is
 * far heavier than a pin — each turn carries a full AnswerResult with its
 * table. These caps are what stop one reader's history becoming a value too
 * large to fetch on every page load.
 */
export const MAX_CONVERSATIONS = 20
export const MAX_TURNS = 40

/** Longest title kept, so the list stays scannable and the value stays small. */
const TITLE_LIMIT = 60

/**
 * A conversation's name, from the question that started it.
 *
 * Deliberately NOT a model call. A title is not a figure, so the rule about
 * models and numbers does not forbid it — but it would be a network round trip
 * and a cost per conversation to restate a sentence the reader just typed, and
 * it could come back different for the same question. This is a trim.
 */
export function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return 'Untitled'
  // Drop a trailing question mark: a list of titles all ending in "?" reads as
  // noise, and the shape of the line already says it was a question.
  const trimmed = clean.replace(/\?+$/, '')
  if (trimmed.length <= TITLE_LIMIT) return trimmed
  // Cut on a word boundary so a title never ends mid-word. Falls back to a
  // hard cut for a single very long token.
  const cut = trimmed.slice(0, TITLE_LIMIT)
  const lastSpace = cut.lastIndexOf(' ')
  const body = lastSpace > TITLE_LIMIT * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${body.trimEnd()}…`
}

// Without KV the app still has to work — the same promise the router makes when
// it falls back to the keyword classifier. Conversations then live for the
// lifetime of the process, and the caller is told so rather than being left to
// assume they are saved.
const memory = new Map<string, Conversation[]>()

/** Test seam: drops the in-memory store so cases cannot leak into each other. */
export function resetConversations(): void {
  memory.clear()
}

function isStoredTurn(value: unknown): value is StoredTurn {
  if (!value || typeof value !== 'object') return false
  const t = value as Partial<StoredTurn>
  return (
    typeof t.id === 'string' &&
    typeof t.question === 'string' &&
    typeof t.result === 'object' &&
    t.result !== null &&
    typeof (t.result as { headline?: unknown }).headline === 'string'
  )
}

/**
 * A stored entry has to look like a conversation before the UI is handed it.
 *
 * Unrecognised entries are dropped rather than thrown on, which is the lesson
 * from pins: a null element survived an `Array.isArray` check and threw on
 * first property access, taking the whole view with it.
 */
function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false
  const c = value as Partial<Conversation>
  return (
    typeof c.id === 'string' &&
    c.id.length > 0 &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'string' &&
    typeof c.updatedAt === 'string' &&
    Array.isArray(c.turns) &&
    c.turns.every(isStoredTurn)
  )
}

/**
 * Exported as a test seam, like `swapTranscript` in `Chat.tsx`.
 *
 * The validator is the only thing standing between a hand-edited or
 * half-written KV value and the reader's view, so it is worth asserting on
 * directly rather than through a store that has already cleaned its input.
 */
export function parseStored(raw: string): Conversation[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isConversation)
  } catch {
    return []
  }
}

export interface ConversationStore {
  conversations: Conversation[]
  /** False when KV is unconfigured and these survive only this process. */
  durable: boolean
  /**
   * False when KV could not be read at all. The list is then not empty, it is
   * UNKNOWN, and nothing may be written on top of it.
   */
  reachable: boolean
}

export async function listConversations(datasetId: string): Promise<ConversationStore> {
  if (!kvAvailable()) {
    return { conversations: memory.get(datasetId) ?? [], durable: false, reachable: true }
  }
  const read = await kvRead(KEY(datasetId))
  if (!read.ok) return { conversations: [], durable: true, reachable: false }
  if (read.missing) return { conversations: [], durable: true, reachable: true }
  return { conversations: parseStored(read.value), durable: true, reachable: true }
}

async function write(datasetId: string, conversations: Conversation[]): Promise<boolean> {
  if (!kvAvailable()) {
    memory.set(datasetId, conversations)
    return true
  }
  // Permanent: no TTL. A conversation that expired on its own would be a
  // silent loss, which is the same call pins made.
  return kvPut(KEY(datasetId), JSON.stringify(conversations), null)
}

/** Newest first, which is the order a reader expects a history in. */
function byRecency(a: Conversation, b: Conversation): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

export type SaveOutcome =
  | { ok: true; conversations: Conversation[]; durable: boolean }
  | { ok: false; reason: 'unreachable' | 'write-failed' | 'too-long' }

/**
 * Writes one conversation's turns, creating it if it is new.
 *
 * The whole turn list is replaced rather than appended to, because the client
 * already holds the authoritative transcript for the conversation on screen —
 * including retries, which change a turn in place rather than adding one. An
 * append API would need a second endpoint to express "that turn failed, then
 * succeeded".
 */
export async function saveConversation(
  datasetId: string,
  conversation: { id: string; title?: string; turns: StoredTurn[] },
  now: () => string = () => new Date().toISOString(),
): Promise<SaveOutcome> {
  if (conversation.turns.length > MAX_TURNS) return { ok: false, reason: 'too-long' }

  const store = await listConversations(datasetId)
  if (!store.reachable) return { ok: false, reason: 'unreachable' }

  const stamp = now()
  const existing = store.conversations.find((c) => c.id === conversation.id)

  // The title comes from the FIRST question and then stops moving. A title that
  // followed the latest question would rename a conversation under the reader
  // as they used it, so the entry they were about to click is no longer the one
  // they were looking for.
  const title =
    existing?.title ??
    conversation.title ??
    titleFrom(conversation.turns[0]?.question ?? '')

  const updated: Conversation = {
    id: conversation.id,
    title,
    turns: conversation.turns,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  }

  const others = store.conversations.filter((c) => c.id !== conversation.id)
  // Oldest are dropped once the cap is reached. The one just written is never
  // a candidate, because discarding what the reader is actively using would be
  // the worst possible eviction.
  const next = [updated, ...others].sort(byRecency).slice(0, MAX_CONVERSATIONS)

  if (!(await write(datasetId, next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, conversations: next, durable: store.durable }
}

export type RemoveOutcome =
  | { ok: true; conversations: Conversation[]; durable: boolean }
  | { ok: false; reason: 'not-found' | 'unreachable' | 'write-failed' }

export async function removeConversation(
  datasetId: string,
  id: string,
): Promise<RemoveOutcome> {
  const store = await listConversations(datasetId)
  if (!store.reachable) return { ok: false, reason: 'unreachable' }
  if (!store.conversations.some((c) => c.id === id)) return { ok: false, reason: 'not-found' }

  const next = store.conversations.filter((c) => c.id !== id)
  if (!(await write(datasetId, next))) return { ok: false, reason: 'write-failed' }
  return { ok: true, conversations: next, durable: store.durable }
}

/**
 * The list without the transcripts.
 *
 * The sidebar needs titles and dates; sending every stored AnswerResult with
 * them would make opening the app download every answer the reader has ever
 * had, on a surface that shows none of them.
 */
export function summarise(conversations: Conversation[]): ConversationSummary[] {
  return conversations.map(({ turns, ...rest }) => ({ ...rest, turnCount: turns.length }))
}
