'use client'

import { useEffect, useRef, useState } from 'react'
import ChartCard from './ChartCard'
import ShareLinks from './ShareLinks'
import { RemoveMark } from './marks'
import type { PinsState } from './usePins'
import type { Pin } from '@/lib/pins'

// The dashboard the secretary builds themselves, out of answers they already
// trusted enough to keep.
//
// Each card is the same ChartCard the transcript uses, deliberately: a pinned
// chart that looked different from the answer it came from would invite the
// question of whether it is still the same figure.

function formatPinned(pin: Pin): string {
  const when = new Date(pin.pinnedAt)
  if (Number.isNaN(when.getTime())) return ''
  const date = when.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `Pinned ${date} at ${time}`
}

export default function PinnedDashboard({
  pins,
  hidden,
  announce,
  organisation,
  onRejected,
}: {
  pins: PinsState
  hidden: boolean
  /** The app-level live region, owned by Workspace. */
  announce: (text: string) => void
  /** Named on the exported chart's stamp. */
  organisation: string | null
  /** A rejected credential sends the reader back to the gate. */
  onRejected: () => void
}) {
  const { pins: items, durable, loading, error, busyKey, remove, reload } = pins

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
              : `${items.length} ${items.length === 1 ? 'chart' : 'charts'}, newest first. Each shows the figures as they were when it was pinned.`}
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
              {/* The question is the card's title: it is short, it is what a
                  reader recognises the card by, and it was already the
                  section's accessible name — so making it the visible heading
                  is what finally makes those two the same string. */}
              <h3 className="pinned-question" id={questionId}>
                <span className="sr-only">Pinned from the question: </span>
                {pin.question}
              </h3>
              <ChartCard
                result={pin.result}
                routedBy={pin.routedBy}
                // The dashboard is several answers compared against each other,
                // not one answer read closely, and the brief only asked to pin
                // charts. The full treatment made three cards 3,534px tall.
                compact
                organisation={organisation}
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

        {/* Below the cards, not above them: sharing is something a reader does
            once they have assembled a dashboard worth sending, and putting it
            first would offer to publish board data before there is any.

            NOT gated on items.length. It was, and that made live tokens
            unrevocable: removing the last pin unmounted the whole panel while
            the links stayed live server-side, with the panel's own copy
            promising "you can withdraw it at any time". The create button is
            disabled with nothing to share; the list of live links is exactly
            what a reader needs most at that moment. */}
        {!loading && (
          <ShareLinks pinCount={items.length} onRejected={onRejected} announce={announce} />
        )}
      </div>
    </div>
  )
}
