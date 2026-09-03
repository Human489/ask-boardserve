'use client'

import { BoardServeMark } from './marks'
import ThemeToggle from './ThemeToggle'

export type View = 'ask' | 'dashboard' | 'data'

/**
 * The masthead is present on the passcode screen too, so the view switch is a
 * slot rather than part of it: there is nothing to switch between until the
 * reader is through the gate.
 */
export default function Masthead({
  view,
  onView,
  pinCount,
  organisation,
  announce,
}: {
  view?: View
  onView?: (view: View) => void
  pinCount?: number
  /** The dataset currently answering. Shown so a swap is never invisible. */
  organisation?: string | null
  /** So a theme change is announced, not just painted. */
  announce?: (message: string) => void
}) {
  const showSwitch = view !== undefined && onView !== undefined

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div className="masthead-row">
          <div>
            {/* The mark and the name are one lockup: BoardServe's own glyph
                beside the product name, so this reads as part of that product
                rather than something adjacent in similar colours. */}
            <div className="lockup">
              <BoardServeMark className="lockup-mark" />
              <h1 className="wordmark">Ask BoardServe</h1>
            </div>
            <p className="positioning">
              A companion to BoardServe&rsquo;s analytics, not a replacement — for the
              questions a fixed dashboard was never built to answer.
            </p>
            {organisation && (
              <p className="masthead-dataset">
                Answering from <strong>{organisation}</strong>
              </p>
            )}
          </div>

          {showSwitch && (
            // Two buttons rather than a segmented novelty: this is a pair of
            // views, and the current one is stated with aria-current so it is
            // not carried by the highlight alone. The value is "true", not
            // "page" — nothing navigates, these are views of one page, and
            // "page" would have a screen reader announce a location change
            // that did not happen.
            <nav className="view-switch" aria-label="View">
              <button
                type="button"
                className="view-tab"
                aria-current={view === 'ask' ? 'true' : undefined}
                onClick={() => onView('ask')}
              >
                Ask
              </button>
              <button
                type="button"
                className="view-tab"
                aria-current={view === 'dashboard' ? 'true' : undefined}
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
              <button
                type="button"
                className="view-tab"
                aria-current={view === 'data' ? 'true' : undefined}
                onClick={() => onView('data')}
              >
                Data
              </button>
            </nav>
          )}

          {/* Outside the showSwitch guard on purpose: the passcode screen has
              no views to switch between, but a reader who cannot stand this
              theme should be able to change it before signing in. */}
          <ThemeToggle announce={announce} />
        </div>
      </div>
    </header>
  )
}
