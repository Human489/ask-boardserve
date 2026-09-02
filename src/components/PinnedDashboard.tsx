'use client'

import { useEffect, useRef, useState } from 'react'
import ChartCard from './ChartCard'
import { RefreshMark, RemoveMark } from './marks'
import type { PinsState } from './usePins'
import type { Pin } from '@/lib/pins'

// The dashboard the secretary builds themselves, out of answers they already
// trusted enough to keep.
//
// Each card is the same ChartCard the transcript uses, deliberately: a pinned
// chart that looked different from the answer it came from would invite the
// question of whether it is still the same figure.

function formatPinned(pin: Pin): string {
  const stamp = pin.refreshedAt ?? pin.pinnedAt
  const when = new Date(stamp)
  if (Number.isNaN(when.getTime())) return ''
  const date = when.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${pin.refreshedAt ? 'Refreshed' : 'Pinned'} ${date} at ${time}`
}

export default function PinnedDashboard({
  pins,
  hidden,
  announce,
}: {
  pins: PinsState
  hidden: boolean
  /** The app-level live region, owned by Workspace. */
  announce: (text: string) => void
}) {
  const { pins: items, durable, loading, error, busyKey, remove, refresh, reload } = pins

  // A second failure produces the identical error string, so the alert's text
  // never changes and nothing is re-announced — from the reader's side "Try
  // again" is a button that does nothing. Counting the attempts gives the
  // alert a new key, so it is genuinely re-inserted, and lets the button say
  // it is working.
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  // Removing a card destroys the button that was focused. Nothing else on the
  // page claims the focus, so it falls to <body> and a keyboard reader starts
  // again from the top of the document; the heading is the nearest sensible
  // place to put them back.
  const heading = useRef<HTMLHeadingElement>(null)

  const tryAgain = async () => {
    if (retrying) return
    setRetrying(true)
    setAttempt((n) => n + 1)
    try {
      await reload()
    } finally {
      setRetrying(false)
    }
  }

  // Announced through the app-level region rather than a role="status" created
  // alongside its own text, which most screen readers never read out.
  const wasLoading = useRef(false)
  useEffect(() => {
    if (loading && !wasLoading.current) announce('Loading pinned charts.')
    wasLoading.current = loading
  }, [loading, announce])

  useEffect(() => {
    if (error) announce(error)
  }, [error, attempt, announce])

  return (
    <div className="dashboard" hidden={hidden}>
      <div className="dashboard-inner">
        <div className="dashboard-head">
          <h2 className="dashboard-title" tabIndex={-1} ref={heading}>
            Pinned charts
          </h2>
          <p className="dashboard-sub">
            {items.length === 0
              ? 'Charts you pin from an answer are kept here.'
              : `${items.length} ${items.length === 1 ? 'chart' : 'charts'}, newest first. Each shows the figures as they were when it was pinned — refresh a card to run its analysis again.`}
          </p>
        </div>

        {/* Stated rather than hidden: without KV configured these pins are held
            in the server process and are lost when it restarts. A dashboard
            that implies it saved something it did not is worse than one that
            says so. */}
        {!durable && items.length > 0 && (
          <p className="dashboard-notice">
            No storage is configured, so these pins are held in memory and will be lost
            when the server restarts. Set <code>CF_KV_NAMESPACE_ID</code> to keep them.
          </p>
        )}

        {error && (
          <p className="dashboard-error" role="alert" key={attempt}>
            {error}{' '}
            <button
              type="button"
              className="link-button"
              aria-disabled={retrying}
              onClick={() => void tryAgain()}
            >
              {retrying ? 'Trying…' : 'Try again'}
            </button>
          </p>
        )}

        {loading && items.length === 0 && (
          <>
            <div className="card card-skeleton" aria-hidden="true">
              <div className="skeleton-stack">
                <div className="skeleton-line tall w-90" />
                <div className="skeleton-line tall w-60" />
              </div>
              <div className="skeleton-chart" />
            </div>
          </>
        )}

        {!loading && items.length === 0 && !error && (
          <p className="dashboard-empty">
            Nothing pinned yet. Ask a question, then use <strong>Pin</strong> on the answer
            to keep it here.
          </p>
        )}

        {items.map((pin) => {
          const busy = busyKey === pin.id
          const inert = busy || busyKey !== null
          const questionId = `pinned-question-${pin.id}`
          return (
            // Named by the question it answers, so it is exposed as a region a
            // screen reader can list and jump between rather than an anonymous
            // <section> that is not exposed at all.
            <section className="pinned" key={pin.id} aria-labelledby={questionId}>
              <p className="pinned-question" id={questionId}>
                <span className="sr-only">Pinned from the question: </span>
                {pin.question}
              </p>
              <ChartCard
                result={pin.result}
                routedBy={pin.routedBy}
                // The section title above is the h2, so the card's headline is
                // content within it rather than its sibling.
                headingLevel={3}
                note={<p className="provenance-pinned">{formatPinned(pin)}</p>}
                actions={
                  <>
                    {/* aria-disabled rather than disabled throughout: these are
                        the buttons the reader just pressed, and disabling one
                        under their focus drops them onto <body>. */}
                    <button
                      type="button"
                      className="card-action"
                      onClick={() => {
                        if (inert) return
                        void refresh(pin.id).then(() => announce('Chart refreshed.'))
                      }}
                      aria-disabled={inert}
                    >
                      <RefreshMark />
                      {busy ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <button
                      type="button"
                      className="card-action"
                      onClick={() => {
                        if (inert) return
                        void remove(pin.id).then(() => {
                          announce('Removed from the dashboard.')
                          heading.current?.focus()
                        })
                      }}
                      aria-disabled={inert}
                    >
                      <RemoveMark />
                      Remove
                    </button>
                  </>
                }
              />
            </section>
          )
        })}
      </div>
    </div>
  )
}
