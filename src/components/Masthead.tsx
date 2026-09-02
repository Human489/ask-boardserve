'use client'

export type View = 'ask' | 'dashboard'

/**
 * The masthead is present on the passcode screen too, so the view switch is a
 * slot rather than part of it: there is nothing to switch between until the
 * reader is through the gate.
 */
export default function Masthead({
  view,
  onView,
  pinCount,
}: {
  view?: View
  onView?: (view: View) => void
  pinCount?: number
}) {
  const showSwitch = view !== undefined && onView !== undefined

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div className="masthead-row">
          <div>
            <h1 className="wordmark">Ask BoardServe</h1>
            <p className="positioning">
              A companion to BoardServe&rsquo;s analytics, not a replacement — for the
              questions a fixed dashboard was never built to answer.
            </p>
          </div>

          {showSwitch && (
            // Two buttons rather than a segmented novelty: this is a pair of
            // views, and the current one is stated with aria-current so it is
            // not carried by the highlight alone.
            <nav className="view-switch" aria-label="View">
              <button
                type="button"
                className="view-tab"
                aria-current={view === 'ask' ? 'page' : undefined}
                onClick={() => onView('ask')}
              >
                Ask
              </button>
              <button
                type="button"
                className="view-tab"
                aria-current={view === 'dashboard' ? 'page' : undefined}
                onClick={() => onView('dashboard')}
              >
                Dashboard
                {typeof pinCount === 'number' && pinCount > 0 && (
                  <span className="view-count">
                    {pinCount}
                    <span className="sr-only"> pinned charts</span>
                  </span>
                )}
              </button>
            </nav>
          )}
        </div>
      </div>
    </header>
  )
}
