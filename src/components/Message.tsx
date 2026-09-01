'use client'

import ChartCard from './ChartCard'
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
  error?: TurnError
}

function AnswerSkeleton() {
  return (
    <div className="card" aria-hidden="true">
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

function ErrorCard({ error, onRetry }: { error: TurnError; onRetry: () => void }) {
  const wait = error.retryAfterSeconds
  return (
    <article className="card card-error">
      <p className="error-kicker">Could not answer</p>
      <p className="error-body">{error.message}</p>
      {typeof wait === 'number' && wait > 0 && (
        <p className="error-body" style={{ marginTop: 8 }}>
          You can try again in {wait} {wait === 1 ? 'second' : 'seconds'}.
        </p>
      )}
      <button type="button" className="retry" onClick={onRetry}>
        Retry
      </button>
    </article>
  )
}

export default function Message({ turn, onRetry }: { turn: Turn; onRetry: (turn: Turn) => void }) {
  return (
    <div className="turn">
      <p className="question">{turn.question}</p>

      {turn.status === 'pending' && (
        <>
          <p className="sr-only" role="status">
            Working out the answer.
          </p>
          <AnswerSkeleton />
        </>
      )}

      {turn.status === 'answered' && turn.result && (
        <ChartCard result={turn.result} routedBy={turn.routedBy} />
      )}

      {turn.status === 'failed' && turn.error && (
        <ErrorCard error={turn.error} onRetry={() => onRetry(turn)} />
      )}
    </div>
  )
}
