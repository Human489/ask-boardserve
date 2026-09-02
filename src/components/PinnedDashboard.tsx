'use client'

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
}: {
  pins: PinsState
  hidden: boolean
}) {
  const { pins: items, durable, loading, error, busyKey, remove, refresh, reload } = pins

  return (
    <div className="dashboard" hidden={hidden}>
      <div className="dashboard-inner">
        <div className="dashboard-head">
          <h2 className="dashboard-title">Pinned charts</h2>
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
          <p className="dashboard-error" role="alert">
            {error}{' '}
            <button type="button" className="link-button" onClick={() => void reload()}>
              Try again
            </button>
          </p>
        )}

        {loading && items.length === 0 && (
          <>
            <p className="sr-only" role="status">
              Loading pinned charts.
            </p>
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
          return (
            <section className="pinned" key={pin.id}>
              <p className="pinned-question">
                <span className="sr-only">Pinned from the question: </span>
                {pin.question}
              </p>
              <ChartCard
                result={pin.result}
                routedBy={pin.routedBy}
                note={<p className="provenance-pinned">{formatPinned(pin)}</p>}
                actions={
                  <>
                    <button
                      type="button"
                      className="card-action"
                      onClick={() => void refresh(pin.id)}
                      disabled={busy || busyKey !== null}
                    >
                      <RefreshMark />
                      {busy ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <button
                      type="button"
                      className="card-action"
                      onClick={() => void remove(pin.id)}
                      disabled={busy || busyKey !== null}
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
