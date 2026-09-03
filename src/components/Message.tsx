'use client'

import type { ReactNode } from 'react'
import ChartCard from './ChartCard'
import { WarningMark } from './marks'
import type { AnswerResult, RoutedBy } from '@/lib/types'

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
  routedBy?: RoutedBy
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
      {/* aria-disabled, not disabled: this is the button the reader just
          pressed, and removing it from the tab order sends focus to <body>. */}
      <button
        type="button"
        className="retry"
        aria-disabled={busy}
        onClick={() => {
          if (busy) return
          onRetry()
        }}
      >
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
  organisation = null,
}: {
  turn: Turn
  busy: boolean
  /** Controls for an answered turn, supplied by the view (pinning). */
  actions?: ReactNode
  onRetry: (turn: Turn) => void
  /** Named on the exported chart's stamp. */
  organisation?: string | null
}) {
  return (
    <div className="turn">
      <p className="question">
        <span className="sr-only">You asked: </span>
        {turn.question}
      </p>

      {/* The pending state used to announce itself from a role="status" that
          was inserted already carrying its text, which most screen readers do
          not read. Chat announces it through the app-level region instead. */}
      {turn.status === 'pending' && <AnswerSkeleton />}

      {turn.status === 'answered' && turn.result && (
        <ChartCard
          result={turn.result}
          routedBy={turn.routedBy}
          actions={actions}
          organisation={organisation}
        />
      )}

      {turn.status === 'failed' && turn.error && (
        <ErrorCard error={turn.error} busy={busy} onRetry={() => onRetry(turn)} />
      )}
    </div>
  )
}
