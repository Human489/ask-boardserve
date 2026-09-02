'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Message from './Message'
import type { Turn } from './Message'
import { isRefusal } from '@/lib/types'
import type { AnswerResult } from '@/lib/types'

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
  routedBy: 'model' | 'fallback'
}

interface AskFailure {
  ok: false
  error: string
  retryAfterSeconds?: number
}

const GENERIC_ERROR =
  'Something went wrong reaching the analytics service. Nothing was changed — try again.'

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

interface ChatProps {
  credential: string
  onRejected: () => void
}

export default function Chat({ credential, onRejected }: ChatProps) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [inFlight, setInFlight] = useState(false)
  const transcriptEnd = useRef<HTMLDivElement>(null)
  // Mirrors `turns` so ask/retry can read the prior transcript without doing it
  // inside a setState updater. React double-invokes updaters in StrictMode, so
  // a fetch fired from inside one runs twice — two model calls per click, and
  // twice the rate-limit budget spent.
  const turnsRef = useRef<Turn[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    turnsRef.current = turns
    transcriptEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [turns])

  const run = useCallback(async (turnId: string, question: string, priorTurns: Turn[]) => {
    setInFlight(true)
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Held in memory by Gate; never persisted anywhere.
          Authorization: `Bearer ${credential}`,
        },
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
  }, [credential, onRejected])

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

  return (
    <div className="chat">
      <div className="transcript">
        {turns.length === 0 ? (
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
                  disabled={inFlight}
                  onClick={() => ask(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="transcript-inner">
            {turns.map((turn) => (
              <Message key={turn.id} turn={turn} onRetry={retry} />
            ))}
          </div>
        )}
        <div ref={transcriptEnd} />
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={textarea}
            className="composer-input"
            value={draft}
            rows={1}
            disabled={inFlight}
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
            disabled={inFlight || draft.trim().length === 0}
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
