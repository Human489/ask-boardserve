'use client'

import { useCallback, useState } from 'react'
import Chat from './Chat'

// The session token lives in React state and nowhere else — no cookie, no
// localStorage, no sessionStorage. A refresh loses it and returns here, which
// is the intended behaviour for now.

export default function Gate() {
  const [token, setToken] = useState<string | null>(null)
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
        | { ok: true; token: string }
        | { ok: false; error: string }
        | null

      if (res.ok && body && body.ok) {
        setPasscode('')
        setToken(body.token)
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

  /** Called when the API reports the session has expired mid-conversation. */
  const signOut = useCallback(() => {
    setToken(null)
    setError('Your session has ended. Enter the passcode again to continue.')
  }, [])

  if (token) return <Chat token={token} onSessionExpired={signOut} />

  return (
    <div className="gate">
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
          passcode, and your session ends when you close or refresh this page.
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
          disabled={checking}
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
          disabled={checking || passcode.trim().length === 0}
        >
          {checking ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  )
}
