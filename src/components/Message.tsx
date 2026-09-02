'use client'

import type { ReactNode } from 'react'
import ChartCard from './ChartCard'
import { WarningMark } from './marks'
import type { AnswerResult } from '@/lib/types'

export interface TurnError {
  message: string
  retryAfterSeconds?: number
}

/** One question and whatever came back for it. Each turn owns its own result so
 *  the transcript survives later questions, errors and retries. */
export interface Turn {
  id: string
  question: string
  status: 'pending' | 'answered' | 'failed'
  result?: AnswerResult
  routedBy?: 'model' | 'fallback'
  /** The tool and arguments that produced this answer, so it can be pinned. */
  routedTo?: { tool: string; args: Record<string, unknown> }
  error?: TurnError
}

function AnswerSkeleton() {
  return (
    <div className="card card-skeleton" aria-hidden="true">
      <div className="skeleton-stack">
        <div className="skeleton-line tall w-90" />
        <div className="skeleton-line tall w-60" />
      </div>
      <div className="skeleton-chart" />
      <div className="skeleton-stack" style={{ marginTop: 22 }}>
        <div className="skeleton-line w-40" />
        <div className="skeleton-line w-60" />
      </div>
    </div>
  )
}

function ErrorCard({
  error,
  busy,
  onRetry,
}: {
  error: TurnError
  busy: boolean
  onRetry: () => void
}) {
  const wait = error.retryAfterSeconds
  return (
    // role="alert" because a failure that arrives while the reader is looking
    // elsewhere in the transcript is otherwise silent.
    <article className="card card-error" role="alert">
      <p className="card-status status-error">
        <WarningMark />
        Could not answer
      </p>
      <p className="error-body">{error.message}</p>
      {typeof wait === 'number' && wait > 0 && (
        <p className="error-body" style={{ marginTop: 8 }}>
          You can try again in {wait} {wait === 1 ? 'second' : 'seconds'}.
        </p>
      )}
      <button type="button" className="retry" onClick={onRetry} disabled={busy}>
        {busy ? 'Waiting…' : 'Retry'}
      </button>
    </article>
  )
}

export default function Message({
  turn,
  busy,
  actions,
  onRetry,
}: {
  turn: Turn
  busy: boolean
  /** Controls for an answered turn, supplied by the view (pinning). */
  actions?: ReactNode
  onRetry: (turn: Turn) => void
}) {
  return (
    <div className="turn">
      <p className="question">
        <span className="sr-only">You asked: </span>
        {turn.question}
      </p>

      {turn.status === 'pending' && (
        <>
          <p className="sr-only" role="status">
            Working out the answer.
          </p>
          <AnswerSkeleton />
        </>
      )}

      {turn.status === 'answered' && turn.result && (
        <ChartCard result={turn.result} routedBy={turn.routedBy} actions={actions} />
      )}

      {turn.status === 'failed' && turn.error && (
        <ErrorCard error={turn.error} busy={busy} onRetry={() => onRetry(turn)} />
      )}
    </div>
  )
}
