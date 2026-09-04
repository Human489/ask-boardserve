'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Message from './Message'
import type { Turn } from './Message'
import { ChevronMark, PinMark, RemoveMark } from './marks'
import type { ConversationsState } from './useConversations'
import type { StoredTurn } from '@/lib/conversations'
import { pinKey, type PinsState } from './usePins'
import { isRefusal } from '@/lib/types'
import type { AnswerResult, RoutedBy } from '@/lib/types'

const EXAMPLES = [
  'Who is below our attendance threshold, and on which committee?',
  'What actions are overdue, and who owns them?',
  'Which overdue actions have been outstanding the longest?',
  'Where are our biggest skill gaps?',
  'Which directors best cover the areas where the board has gaps?',
  'Which meetings had unusually low attendance, and when?',
]

interface AskSuccess {
  ok: true
  result: AnswerResult
  question: string
  routedBy: RoutedBy
  /** Absent for a refusal: there is no tool behind it to re-run. */
  routedTo?: { tool: string; args: Record<string, unknown> }
}

interface AskFailure {
  ok: false
  error: string
  retryAfterSeconds?: number
}

const GENERIC_ERROR =
  'The question could not be sent. Nothing was changed — try again.'

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Prior turns become conversation history. Only the headline goes back — the
 *  figures are recomputed server-side every time, never carried in the prompt. */
function historyFrom(turns: Turn[]): { role: 'user' | 'assistant'; content: string }[] {
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  for (const turn of turns) {
    if (turn.status !== 'answered' || !turn.result) continue
    history.push({ role: 'user', content: turn.question })
    const answer = isRefusal(turn.result)
      ? `${turn.result.headline} ${turn.result.reason}`
      : turn.result.headline
    history.push({ role: 'assistant', content: answer })
  }
  return history
}

/**
 * Moves the conversation aside when the dataset changes, and brings back the
 * one belonging to the dataset now answering.
 *
 * Pure, and exported, so the behaviour can be asserted without a renderer: the
 * thing worth checking is that nothing crosses between datasets and that a
 * question caught mid-flight does not come back as a permanent skeleton.
 */
export function swapTranscript(
  transcripts: Map<string, Turn[]>,
  fromKey: string,
  toKey: string,
  current: Turn[],
): Turn[] {
  // A question still in flight belongs to the dataset that is going away. Its
  // answer will arrive keyed to a turn that is no longer on screen, so the card
  // would sit on a loading skeleton for ever. Say what happened instead.
  const outgoing = current.map((turn) =>
    turn.status === 'pending'
      ? {
          ...turn,
          status: 'failed' as const,
          error: {
            message:
              'The dataset changed while this question was being answered. Ask it again.',
          },
        }
      : turn,
  )
  transcripts.set(fromKey, outgoing)
  return transcripts.get(toKey) ?? []
}

/**
 * When a saved conversation was last added to.
 *
 * THE LIST WAS UNUSABLE WITHOUT THIS. Titles are derived from the first
 * question — deliberately, because a model-written one would cost a round trip
 * and could come back different each time — so asking the same question twice
 * produces two rows reading exactly the same. Seven saved conversations showed
 * five identical titles and nothing else to tell them apart, and the one
 * distinguishing value was already on the summary and simply never displayed.
 *
 * A real clock is correct here, unlike everywhere else in this product: this
 * is when the READER saved something, not a figure measured from the dataset's
 * as-at date. The pinned card's own stamp does the same.
 *
 * Absolute rather than relative. "2 hours ago" changes while the panel sits
 * open, and a secretary comparing two runs of the same question wants the time
 * it happened, not a countdown.
 */
function formatWhen(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  const date = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time}`
}

/** Ids are opaque and client-made, so a conversation can be saved before it
 *  has a server-side identity. Matches the pin route's own format. */
function newConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * What of a transcript is worth storing.
 *
 * Only ANSWERED turns. A pending turn is in flight and its answer will arrive
 * into this same list; a failed one is a network state, not a record — storing
 * it would restore an error card the reader can no longer retry against the
 * request that caused it.
 */
function storable(turns: Turn[]): StoredTurn[] {
  const out: StoredTurn[] = []
  for (const turn of turns) {
    if (turn.status !== 'answered' || !turn.result) continue
    out.push({
      id: turn.id,
      question: turn.question,
      result: turn.result,
      routedBy: turn.routedBy,
      routedTo: turn.routedTo,
    })
  }
  return out
}

/**
 * Changes when an answer lands, and when a retry replaces one in place.
 *
 * Persisting on every `turns` change would write on each keystroke-driven
 * re-render and on every pending turn. Keying on the answered set means one
 * write per answer — and the headline length is in the signature so a retry,
 * which keeps the turn's id, is not mistaken for no change.
 */
function answeredSignature(turns: StoredTurn[]): string {
  return turns.map((t) => `${t.id}:${t.result.headline.length}`).join(',')
}

interface ChatProps {
  onRejected: () => void
  pins: PinsState
  /** The saved conversation list for this dataset, owned by Workspace. */
  conversations: ConversationsState
  hidden: boolean
  /** Identifies the dataset answering. A change clears the transcript. */
  datasetKey: string
  needsDataset: boolean
  onGoToData: () => void
  /** Named on the exported chart's stamp. Null for an un-uploaded local set. */
  organisation: string | null
  /** The app-level live region, owned by Workspace. See Announcer.tsx for why
   *  it cannot live in this component. */
  announce: (text: string) => void
}

export default function Chat({
  onRejected,
  pins,
  conversations,
  hidden,
  datasetKey,
  needsDataset,
  onGoToData,
  organisation,
  announce,
}: ChatProps) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [inFlight, setInFlight] = useState(false)
  const transcriptInner = useRef<HTMLDivElement>(null)
  // Mirrors `turns` so ask/retry can read the prior transcript without doing it
  // inside a setState updater. React double-invokes updaters in StrictMode, so
  // a fetch fired from inside one runs twice — two model calls per click, and
  // twice the rate-limit budget spent.
  const turnsRef = useRef<Turn[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  /** Focus lands here when a conversation row is removed under it. */
  const newConversationButton = useRef<HTMLButtonElement>(null)

  // Scroll to the *top* of the newest turn, not the foot of the transcript. An
  // answer card is taller than the viewport, and the headline is the sentence
  // the reader needs first — landing at the bottom scrolls it off screen.
  const turnCount = turns.length
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  useEffect(() => {
    if (turnCount === 0) return
    const newest = transcriptInner.current?.lastElementChild
    if (!newest) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    newest.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  }, [turnCount])

  // Each dataset keeps its own conversation.
  //
  // Prior answers' headlines are sent back to the model as context, so it picks
  // the next tool partly from what it already answered. One shared transcript
  // would route a question about one organisation while the model reads a
  // sentence about another — the figures are always recomputed server-side so
  // nothing wrong could reach the screen, but the routing could be steered by a
  // board that is no longer loaded, and a transcript mixing two organisations
  // invites being read as one.
  //
  // Wiping on every swap would prevent that too, and it was what this did
  // first. Scoping is better for the same reason pins are scoped: switching
  // back restores the conversation you were having rather than destroying it,
  // and the two views then agree about what a dataset "has". It also makes the
  // comparison the product exists to demonstrate — the same question against
  // two organisations — something a reader can flip between.
  const transcripts = useRef(new Map<string, Turn[]>())
  const shownKey = useRef(datasetKey)

  // Which saved conversation the transcript on screen belongs to, per dataset.
  //
  // Kept beside `transcripts` and swapped with it, because a conversation id
  // and the turns it names have to move together. Restoring one dataset's
  // transcript under another dataset's conversation id would save those turns
  // over a conversation belonging to a different organisation — the same
  // failure the per-dataset scoping exists to prevent, arrived at from the
  // storage side.
  const conversationIds = useRef(new Map<string, string>())
  const [activeId, setActiveId] = useState(() => {
    const id = newConversationId()
    conversationIds.current.set(datasetKey, id)
    return id
  })

  useEffect(() => {
    if (shownKey.current === datasetKey) return

    const restored = swapTranscript(
      transcripts.current,
      shownKey.current,
      datasetKey,
      turnsRef.current,
    )
    setTurns(restored)
    turnsRef.current = restored
    setDraft('')

    conversationIds.current.set(shownKey.current, activeId)
    let incoming = conversationIds.current.get(datasetKey)
    if (!incoming) {
      incoming = newConversationId()
      conversationIds.current.set(datasetKey, incoming)
    }
    setActiveId(incoming)

    shownKey.current = datasetKey
    // `activeId` is read to stash the OUTGOING id and must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey])

  // Persist the answered transcript whenever an answer lands.
  //
  // One write per answer, not per render: `answeredSignature` changes only
  // when a turn becomes answered or a retry replaces one. The save is fired
  // and not awaited — the reader has their answer on screen already, and
  // blocking the UI on a KV round trip to record something they can see would
  // be the wrong trade. A failure surfaces through the hook's error, which the
  // history panel shows.
  const stored = storable(turns)
  const signature = answeredSignature(stored)
  const savedSignature = useRef('')
  const saveConversation = conversations.save
  useEffect(() => {
    if (signature === '' || signature === savedSignature.current) return
    savedSignature.current = signature
    void saveConversation(activeId, storable(turnsRef.current))
  }, [signature, activeId, saveConversation])

  /**
   * Start a fresh conversation.
   *
   * The current one is already saved — the effect above wrote it when its last
   * answer arrived — so this only has to clear the screen and take a new id.
   * Nothing is written here, which means abandoning an empty new conversation
   * leaves no trace, and the route drops an empty transcript for that reason.
   */
  const startNewConversation = useCallback(() => {
    if (inFlight) return
    const id = newConversationId()
    conversationIds.current.set(datasetKey, id)
    setActiveId(id)
    setTurns([])
    turnsRef.current = []
    savedSignature.current = ''
    setDraft('')
    announce('Started a new conversation.')
    textarea.current?.focus()
  }, [inFlight, datasetKey, announce])

  /** Replace the screen with a saved conversation. */
  const openConversation = useCallback(
    async (id: string) => {
      if (inFlight || id === activeId) return
      const found = await conversations.open(id)
      if (!found) return

      const restored: Turn[] = found.turns.map((turn) => ({
        id: turn.id,
        question: turn.question,
        status: 'answered' as const,
        result: turn.result,
        routedBy: turn.routedBy,
        routedTo: turn.routedTo,
      }))

      conversationIds.current.set(datasetKey, id)
      setActiveId(id)
      setTurns(restored)
      turnsRef.current = restored
      // Marked as already saved, or opening a conversation would immediately
      // rewrite it and move it to the top of the list unread.
      savedSignature.current = answeredSignature(found.turns)
      setDraft('')
      announce(`Opened ${found.title}.`)
    },
    [inFlight, activeId, conversations, datasetKey, announce],
  )

  /** Forget a saved conversation, and clear the screen if it was showing. */
  const forgetConversation = useCallback(
    async (id: string, title: string) => {
      if (inFlight) return
      // The row and its button are about to be removed. PinnedDashboard
      // handles the identical case by returning focus to its heading; this
      // did not, so a keyboard reader was dropped onto <body>.
      const returnTo = newConversationButton.current
      await conversations.forget(id)
      returnTo?.focus()
      announce(`Forgot ${title}.`)
      if (id !== activeId) return
      const fresh = newConversationId()
      conversationIds.current.set(datasetKey, fresh)
      setActiveId(fresh)
      setTurns([])
      turnsRef.current = []
      savedSignature.current = ''
    },
    [inFlight, activeId, conversations, datasetKey, announce],
  )

  // Answers arrive asynchronously into a card the reader may not be looking at
  // — possibly not even in this view. The announcement goes to the app-level
  // region rather than one nested in `.chat`, which is removed from the
  // accessibility tree whenever another view is showing.
  const latest = turns[turns.length - 1]
  const latestId = latest?.id
  const latestStatus = latest?.status
  const latestHeadline =
    latest && latest.status === 'answered' && latest.result ? latest.result.headline : ''
  useEffect(() => {
    if (latestStatus === 'answered' && latestHeadline) announce(latestHeadline)
    else if (latestStatus === 'pending') announce('Working out the answer.')
  }, [latestId, latestStatus, latestHeadline, announce])

  // The pin button relabels itself to "On the dashboard" and stops responding,
  // which is the only feedback a pin succeeded — and it is feedback nobody
  // hears. Announce the outcome from the pinned set actually growing, rather
  // than from the click, so a pin that failed says nothing and leaves the
  // error alert to speak instead.
  const pinnedCount = pins.pinnedKeys.size
  const priorPinned = useRef(pinnedCount)
  useEffect(() => {
    if (pinnedCount > priorPinned.current) announce('Pinned to the dashboard.')
    priorPinned.current = pinnedCount
  }, [pinnedCount, announce])

  const run = useCallback(async (turnId: string, question: string, priorTurns: Turn[]) => {
    setInFlight(true)
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        // No Authorization header: the session cookie is sent automatically on
        // a same-origin request, and it is httpOnly, so this code holds no
        // credential and could not read one.
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: historyFrom(priorTurns) }),
      })

      let body: AskSuccess | AskFailure | null = null
      try {
        body = (await response.json()) as AskSuccess | AskFailure
      } catch {
        body = null
      }

      if (response.ok && body && body.ok) {
        const success = body
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  status: 'answered',
                  result: success.result,
                  routedBy: success.routedBy,
                  routedTo: success.routedTo,
                  error: undefined,
                }
              : turn,
          ),
        )
        return
      }

      // A 401 means the passcode is no longer accepted — it changed on the
      // server, or was never right. Hand control back to the gate rather than
      // showing an error the user cannot act on here.
      if (response.status === 401) {
        onRejected()
        return
      }

      const failure = body && !body.ok ? body : null
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: 'failed',
                error: {
                  message: failure?.error ?? GENERIC_ERROR,
                  retryAfterSeconds: failure?.retryAfterSeconds,
                },
              }
            : turn,
        ),
      )
    } catch {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? { ...turn, status: 'failed', error: { message: GENERIC_ERROR } }
            : turn,
        ),
      )
    } finally {
      setInFlight(false)
    }
  }, [onRejected])

  const ask = useCallback(
    (question: string) => {
      const trimmed = question.trim()
      if (!trimmed || inFlight) return
      const turn: Turn = { id: newId(), question: trimmed, status: 'pending' }
      const prior = turnsRef.current
      setTurns((current) => [...current, turn])
      void run(turn.id, trimmed, prior)
      setDraft('')
      if (textarea.current) textarea.current.style.height = 'auto'
    },
    [inFlight, run],
  )

  const retry = useCallback(
    (target: Turn) => {
      if (inFlight) return
      const current = turnsRef.current
      const index = current.findIndex((turn) => turn.id === target.id)
      if (index === -1) return
      setTurns((turns) =>
        turns.map((turn) =>
          turn.id === target.id ? { ...turn, status: 'pending', error: undefined } : turn,
        ),
      )
      void run(target.id, target.question, current.slice(0, index))
    },
    [inFlight, run],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      ask(draft)
    }
  }

  /** A refusal has no figures, so there is nothing to pin. */
  const pinControl = (turn: Turn) => {
    const routed = turn.routedTo
    if (!routed || !turn.result || isRefusal(turn.result)) return null
    const key = pinKey(routed.tool, routed.args)
    const alreadyPinned = pins.pinnedKeys.has(key)
    const busy = pins.busyKey === key

    const inert = alreadyPinned || busy || pins.busyKey !== null

    return (
      <button
        type="button"
        className="card-action"
        // Unpinning from here would need the pin's id, which the transcript
        // does not hold; the dashboard owns removal. So once pinned this
        // states the fact rather than offering a toggle that half works.
        //
        // aria-disabled rather than disabled, because this is the control the
        // reader just pressed: `disabled` removes it from the tab order under
        // their focus, which lands them on <body> with no way back, and the
        // change from "Pin to dashboard" to "On the dashboard" happens on an
        // element they can no longer reach to hear it. The click handler
        // no-ops instead, and the outcome is spoken.
        aria-disabled={inert}
        onClick={() => {
          if (inert) return
          void pins.add({
            question: turn.question,
            tool: routed.tool,
            args: routed.args,
            // Only a tool route can be pinned, and a tool route is never
            // 'guard' — that value belongs to refusals decided by a
            // deterministic check, and a refusal has no figures to pin.
            routedBy: turn.routedBy === 'fallback' ? 'fallback' : 'model',
          })
        }}
      >
        <PinMark filled={alreadyPinned} />
        {alreadyPinned ? 'On the dashboard' : busy ? 'Pinning…' : 'Pin to dashboard'}
      </button>
    )
  }

  const historyPanel = (
    <div className="history">
      {/* The bar's own content is centred on the transcript's measure. Left
          flush to the page it started 226px to the left of the column it
          belongs to, so the list of past questions and the answers they
          produced read as two unrelated things. */}
      <div className="history-inner">
      <button
        type="button"
        className="history-new"
        ref={newConversationButton}
        onClick={startNewConversation}
        aria-disabled={inFlight || turns.length === 0}
      >
        New conversation
      </button>

      {conversations.list.length > 0 && (
        // A disclosure rather than a permanent sidebar: this is an Operate
        // surface where the answer is the point, and a list of past questions
        // beside every answer would compete with it. Native <details>, so it
        // is keyboard operable and announced as expandable with no script.
        <details className="history-list">
          <summary>
            <ChevronMark />
            Earlier conversations
            <span className="history-count">
              {conversations.list.length} saved
            </span>
          </summary>
          <ul>
            {conversations.list.map((saved) => {
              const current = saved.id === activeId
              return (
                <li key={saved.id} className="history-row">
                  <button
                    type="button"
                    className="history-open"
                    onClick={() => void openConversation(saved.id)}
                    aria-disabled={inFlight || current}
                    aria-current={current ? 'true' : undefined}
                  >
                    <span className="history-title">{saved.title}</span>
                    {/* Its own column rather than another clause in the meta
                        line, so the timestamps stack into something the eye can
                        run down — which is the whole point of showing them. */}
                    <span className="history-when">{formatWhen(saved.updatedAt)}</span>
                    <span className="history-meta">
                      {saved.turnCount} {saved.turnCount === 1 ? 'question' : 'questions'}
                      {current ? ' · showing' : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="history-forget"
                    onClick={() => void forgetConversation(saved.id, saved.title)}
                    aria-disabled={inFlight || conversations.busyId === saved.id}
                  >
                    <RemoveMark />
                    <span className="sr-only">Forget {saved.title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </details>
      )}

      {/* Said plainly rather than implied. Without KV a conversation lasts
          until the server restarts, and a reader who assumed otherwise would
          lose work they thought was kept. */}
      {!conversations.durable && conversations.list.length > 0 && (
        <p className="history-note">
          Not saved anywhere: no storage is configured, so these last until the
          server restarts.
        </p>
      )}
      {conversations.error && (
        <p className="history-note history-error" role="alert">
          {conversations.error}
        </p>
      )}
      </div>
    </div>
  )

  return (
    <div className="chat" hidden={hidden}>
      {historyPanel}
      <div className="transcript">
        {needsDataset ? (
          <div className="empty">
            <p className="empty-lede">No dataset is loaded yet.</p>
            <p className="empty-sub">
              Answers are computed from a dataset, and none has been uploaded. Add one and
              every question here is answered from it.
            </p>
            <button type="button" className="send" onClick={onGoToData}>
              Add a dataset
            </button>
          </div>
        ) : turns.length === 0 ? (
          <div className="empty">
            <p className="empty-lede">Ask a question of your board data.</p>
            <p className="empty-sub">
              Attendance, actions and the skills audit, queried in plain English. Every
              figure is computed from the dataset by deterministic code and shown with the
              assumptions behind it — so you can check the answer, not just read it.
            </p>
            <p className="empty-label">Try one of these</p>
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button
                  type="button"
                  key={example}
                  className="example"
                  // aria-disabled: `ask` already refuses while a question is in
                  // flight, so the button can stay focusable and keep the
                  // reader's place instead of disappearing from the tab order
                  // the instant they press it.
                  aria-disabled={inFlight}
                  onClick={() => {
                    // Focus moves to the composer BEFORE asking. Asking
                    // replaces the whole empty state, so this button is
                    // unmounted with focus on it and a keyboard reader lands
                    // on <body> — on the very first interaction anyone has
                    // with the app. The comment above was right that
                    // aria-disabled keeps it focusable; it does not survive
                    // being removed from the tree.
                    textarea.current?.focus()
                    ask(example)
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="transcript-inner" ref={transcriptInner}>
            {turns.map((turn) => (
              <Message
                key={turn.id}
                turn={turn}
                busy={inFlight}
                actions={pinControl(turn)}
                onRetry={retry}
            organisation={organisation}
              />
            ))}
          </div>
        )}
      </div>

      <div className="composer">
        {/* A pin is initiated from this view, so its failure has to be reported
            in this view. It sits inside the composer so it picks up the same
            gutter and measure as the field below it. */}
        {pins.error && (
          <p className="composer-error" role="alert">
            {pins.error}{' '}
            <button type="button" className="link-button" onClick={pins.dismissError}>
              Dismiss
            </button>
          </p>
        )}
        <div className="composer-inner">
          <textarea
            ref={textarea}
            className="composer-input"
            value={draft}
            rows={1}
            // readOnly, not disabled: the composer holds focus when Enter is
            // pressed, and disabling it there drops focus to <body>.
            readOnly={inFlight}
            placeholder="Ask a question…"
            aria-label="Your question"
            onChange={(event) => {
              setDraft(event.target.value)
              const element = event.target
              element.style.height = 'auto'
              element.style.height = `${Math.min(element.scrollHeight, 160)}px`
            }}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="send"
            // Same as the example buttons — the send button is by definition
            // the focused control at the moment it would be disabled.
            aria-disabled={inFlight || draft.trim().length === 0}
            onClick={() => ask(draft)}
          >
            {inFlight ? 'Asking…' : 'Ask'}
          </button>
        </div>
        <p className="composer-hint">
          Enter to send, Shift+Enter for a new line. Answers are computed from the loaded
          dataset only.
        </p>
      </div>
    </div>
  )
}
