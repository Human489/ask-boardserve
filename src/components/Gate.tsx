'use client'

import { useCallback, useState } from 'react'
import Masthead from './Masthead'
import Workspace from './Workspace'

// The passcode lives in React state and nowhere else — no cookie, no
// localStorage, no sessionStorage. A refresh loses it and returns here, which
// is the intended behaviour for now.
//
// It is the passcode itself rather than a session token because a token would
// need a server-side store to validate against, and that store is the thing
// that made the first request after a cold start fail.

export default function Gate() {
  const [credential, setCredential] = useState<string | null>(null)
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const signIn = useCallback(async () => {
    const supplied = passcode.trim()
    if (!supplied || checking) return
    setChecking(true)
    setError(null)
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: supplied }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error: string }
        | null

      if (res.ok && body && body.ok) {
        setCredential(supplied)
        setPasscode('')
        return
      }
      setError(
        (body && !body.ok && body.error) ||
          'Sign-in could not be completed. Please try again.',
      )
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setChecking(false)
    }
  }, [passcode, checking])

  /** Called when the API rejects the passcode mid-conversation. */
  const signOut = useCallback(() => {
    setCredential(null)
    setError('That passcode is no longer accepted. Enter it again to continue.')
  }, [])

  if (credential) return <Workspace credential={credential} onRejected={signOut} />

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Masthead />
      <main id="main-content" className="gate" tabIndex={-1}>
        <form
          className="gate-card"
          onSubmit={(event) => {
            event.preventDefault()
            void signIn()
          }}
        >
          <h2 className="gate-title">Enter your passcode</h2>
          <p className="gate-sub">
            Ask BoardServe holds board attendance, action and skills data. Access is by
            passcode, and access ends when you close or refresh this page.
          </p>

          <label className="gate-label" htmlFor="passcode">
            Passcode
          </label>
          <input
            id="passcode"
            className="gate-input"
            type="password"
            value={passcode}
            autoFocus
            autoComplete="off"
            // readOnly rather than disabled: this is the focused element while
            // the check runs, and disabling it drops it out of the tab order,
            // which throws focus to <body> with nothing to restore it to.
            readOnly={checking}
            onChange={(event) => setPasscode(event.target.value)}
          />

          {error ? (
            <p className="gate-error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="gate-button"
            // Same reason as the field: the button that was just pressed must
            // not vanish from the tab order under the reader's focus.
            aria-disabled={checking || passcode.trim().length === 0}
          >
            {checking ? 'Checking…' : 'Continue'}
          </button>
        </form>
      </main>
    </div>
  )
}
