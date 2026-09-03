'use client'

import { useEffect, useRef } from 'react'
import { RemoveMark } from './marks'
import type { DatasetsState } from './useDatasets'

// Where a dataset comes from, and which one the answers are computed from.
//
// The point of the product is that nothing is specific to one organisation, so
// this view exists to make that demonstrable rather than claimed: upload a
// second organisation's data and every answer recomputes against it, with no
// code change.

function describe(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export default function DatasetsView({
  datasets,
  hidden,
  announce,
}: {
  datasets: DatasetsState
  hidden: boolean
  /** The app-level live region, owned by Workspace. */
  announce: (text: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const {
    datasets: items,
    activeId,
    localAvailable,
    storageAvailable,
    loading,
    busy,
    error,
    lastUploaded,
    upload,
    activate,
    remove,
    reload,
    dismissError,
  } = datasets

  const localActive = activeId === null || activeId === ''

  // Same reason as elsewhere: a role="status" that is inserted already holding
  // its text is not announced by most screen readers, and these statuses sit
  // inside a view that is removed from the accessibility tree when hidden.
  useEffect(() => {
    if (busy) announce('Reading the archive and checking it is a dataset.')
  }, [busy, announce])

  useEffect(() => {
    if (error) announce(error)
  }, [error, announce])

  useEffect(() => {
    if (lastUploaded && !busy) announce(`Loaded ${lastUploaded.organisation}.`)
  }, [lastUploaded, busy, announce])

  return (
    <div className="dashboard" hidden={hidden}>
      <div className="dashboard-inner">
        <div className="dashboard-head">
          <h2 className="dashboard-title">Data</h2>
          <p className="dashboard-sub">
            Answers are computed from the dataset selected here. Upload another
            organisation&rsquo;s data and every question is answered from it instead —
            nothing in the app is specific to one organisation.
          </p>
        </div>

        {!storageAvailable && (
          <p className="dashboard-notice">
            No storage namespace is configured, so datasets cannot be uploaded here. Set{' '}
            <code>CF_KV_NAMESPACE_ID</code> to enable it. Until then the app answers from
            the dataset directory on the server.
          </p>
        )}

        <div className="upload">
          <p className="upload-label">Add a dataset</p>
          <p className="upload-hint">
            A <code>.zip</code> containing <code>attendance.json</code>,{' '}
            <code>actions.json</code>, <code>skills-audit.csv</code> and one or more{' '}
            <code>paper-*.md</code>. Zipping the folder itself is fine.
          </p>
          <input
            ref={input}
            id="dataset-file"
            aria-label="Dataset archive (.zip)"
            className="upload-input"
            type="file"
            accept=".zip,application/zip"
            disabled={busy || !storageAvailable}
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Cleared so the same file can be chosen again after a failure.
              event.target.value = ''
              if (file) void upload(file)
            }}
          />
          {busy && (
            <p className="upload-status">
              Reading the archive and checking it is a dataset…
            </p>
          )}
          {lastUploaded && !busy && (
            <p className="upload-status">
              Loaded {lastUploaded.organisation} — {describe(lastUploaded.directorCount, 'director', 'directors')},{' '}
              {describe(lastUploaded.actionCount, 'action', 'actions')},{' '}
              {describe(lastUploaded.paperCount, 'paper', 'papers')}, as at {lastUploaded.asAt}.
            </p>
          )}
        </div>

        {error && (
          <p className="dashboard-error" role="alert">
            {error}{' '}
            <button type="button" className="link-button" onClick={dismissError}>
              Dismiss
            </button>{' '}
            <button type="button" className="link-button" onClick={() => void reload()}>
              Reload
            </button>
          </p>
        )}

        {!loading && items.length === 0 && !localAvailable && (
          <p className="dashboard-empty">
            No dataset is loaded yet, so no question can be answered. Upload one above to
            begin.
          </p>
        )}

        {localAvailable && (
          <section className="dataset-row">
            <div className="dataset-main">
              <p className="dataset-name">
                Local directory
                {localActive && <span className="dataset-active">In use</span>}
              </p>
              <p className="dataset-meta">
                The dataset folder on the server. Present in development; not part of the
                deployment.
              </p>
            </div>
            {/* aria-disabled throughout this view rather than disabled: `busy`
                is set by pressing one of these very buttons, and disabling the
                pressed control removes it from the tab order, which drops the
                reader's focus onto <body> with nothing to restore it to. */}
            {!localActive && (
              <button
                type="button"
                className="card-action"
                aria-disabled={busy}
                onClick={() => {
                  if (busy) return
                  void activate('local')
                }}
              >
                Use this
              </button>
            )}
          </section>
        )}

        {items.map((dataset) => {
          const isActive = dataset.id === activeId
          return (
            <section className="dataset-row" key={dataset.id}>
              <div className="dataset-main">
                <p className="dataset-name">
                  {dataset.organisation}
                  {isActive && <span className="dataset-active">In use</span>}
                </p>
                <p className="dataset-meta">
                  {describe(dataset.directorCount, 'director', 'directors')} ·{' '}
                  {describe(dataset.actionCount, 'action', 'actions')} ·{' '}
                  {describe(dataset.paperCount, 'paper', 'papers')} · as at {dataset.asAt}
                </p>
              </div>
              {!isActive && (
                <button
                  type="button"
                  className="card-action"
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return
                    void activate(dataset.id)
                  }}
                >
                  Use this
                </button>
              )}
              <button
                type="button"
                className="card-action"
                aria-disabled={busy}
                onClick={() => {
                  if (busy) return
                  void remove(dataset.id)
                }}
              >
                <RemoveMark />
                Remove
              </button>
            </section>
          )
        })}
      </div>
    </div>
  )
}
