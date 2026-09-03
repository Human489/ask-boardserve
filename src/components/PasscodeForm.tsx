'use client'

import { useCallback, useState } from 'react'

// The passcode form, and nothing else.
//
// It used to be the outer shell of the application: a component that held the
// passcode in React state and rendered the whole app once it had one. That made
// the gate a rendering decision rather than a boundary — the app and its bundle
// were served to anyone, and a refresh threw the credential away because there
// was nowhere else to keep it.
//
// Now signing in sets a cookie and middleware decides what gets served. The
// passcode is never held in React state, never reaches an Authorization header
// from the browser, and a refresh keeps the reader signed in.

export default function PasscodeForm() {
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
        // The cookie is set; the reader is now allowed past middleware. A full
        // navigation rather than a router push, so the page is fetched again
        // and comes back as the application instead of this form.
        setPasscode('')
        window.location.assign('/')
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

  return (
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
        passcode.
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
        autoComplete="current-password"
        // readOnly rather than disabled: this field holds focus at the moment
        // it would be disabled, and disabling a focused element drops focus to
        // the document body with nothing to restore it to.
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
        aria-disabled={checking || passcode.trim().length === 0}
        onClick={(event) => {
          if (checking || passcode.trim().length === 0) event.preventDefault()
        }}
      >
        {checking ? 'Checking…' : 'Continue'}
      </button>
    </form>
  )
}
