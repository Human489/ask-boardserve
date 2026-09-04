'use client'

import { useEffect, useState } from 'react'
import {
  THEME_CHOICES,
  THEME_COLORS,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  applyTheme,
  readChoice,
  type ThemeChoice,
} from '@/lib/theme'

/**
 * System / Light / Dark, as a radio group.
 *
 * A radio group rather than a button that cycles: three states cannot be
 * cycled discoverably — the reader cannot see what the next press will do, and
 * "System" is invisible in a two-state toggle. All three are on screen, and
 * the current one is marked with aria-checked so the state is in the
 * accessibility tree rather than only in the highlight.
 *
 * The light palette existed from the start and was unreachable: the stylesheet
 * keyed off prefers-color-scheme alone, so a reader on a dark machine only
 * ever saw dark and had no way to know there was anything else.
 */
export default function ThemeToggle({
  announce,
}: {
  announce?: (message: string) => void
}) {
  // 'system' until mounted. The inline script in layout.tsx has already
  // painted the right theme; this is only about which control reads as
  // selected, and server and client must agree on the first render.
  const [choice, setChoice] = useState<ThemeChoice>('system')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      // Private windows and blocked site data throw on access rather than
      // returning null. A reader who cannot store a choice still gets one.
    }
    setChoice(readChoice(stored))
    setReady(true)
  }, [])

  // Re-apply on every choice, not only on 'system'.
  //
  // The inline script in layout.tsx is what prevents a flash of the wrong
  // theme, but it cannot be the only thing that applies it: React's hydration
  // removed the attribute it had stamped, so a stored choice of Dark left the
  // page light with the control reading Dark. Applying it here as well means
  // the theme is correct even if that script never runs, and the script's only
  // job is to make it correct EARLIER.
  //
  // Also follows the machine while the choice is 'system' — a laptop that
  // switches at sunset should take the page with it, with no reload.
  useEffect(() => {
    if (!ready) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => {
      applyTheme(document.documentElement, choice, query.matches, THEME_COLORS)
    }
    sync()
    if (choice !== 'system') return
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [choice, ready])

  const pick = (next: ThemeChoice) => {
    setChoice(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // The choice still applies to this page; it just will not survive a
      // reload. Better than refusing to change the theme at all.
    }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const resolved = applyTheme(document.documentElement, next, prefersDark, THEME_COLORS)
    announce?.(
      next === 'system'
        ? `Theme follows your system, currently ${resolved}.`
        : `${THEME_LABELS[next]} theme.`,
    )
  }

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Colour theme">
      {THEME_CHOICES.map((option, index) => (
        <button
          key={option}
          type="button"
          role="radio"
          className="theme-option"
          // Before the stored choice is read, nothing is marked selected
          // rather than 'System' being marked wrongly for a frame.
          aria-checked={ready && choice === option}
          // A ROVING TAB STOP, which is what role="radio" promises.
          //
          // All three were in the tab order with no key handling, so a screen
          // reader announced "radio, 1 of 3", switched to forms mode where
          // arrow keys are the expected and only interaction — and nothing
          // happened. Operable by Tab and Space, so not a hard 2.1.1 failure,
          // but broken against what the role tells every AT user to expect.
          tabIndex={ready && choice === option ? 0 : index === 0 && !ready ? 0 : -1}
          onKeyDown={(event) => {
            const step =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0
            if (step === 0) return
            event.preventDefault()
            const next =
              THEME_CHOICES[(index + step + THEME_CHOICES.length) % THEME_CHOICES.length]
            pick(next)
            // Selection follows focus, as it does in a native radio group, so
            // the button that is now checked is the one that holds focus.
            const group = event.currentTarget.parentElement
            const moved = group?.querySelectorAll('[role="radio"]')[
              (index + step + THEME_CHOICES.length) % THEME_CHOICES.length
            ]
            if (moved instanceof HTMLElement) moved.focus()
          }}
          onClick={() => pick(option)}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
    </div>
  )
}
