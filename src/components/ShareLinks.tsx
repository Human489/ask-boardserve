'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { RemoveMark } from './marks'
import type { ShareSummary } from '@/lib/shares'

// Creating and withdrawing read-only links to the pinned dashboard.
//
// The copy here does more work than usual on purpose. A reader is about to put
// named directors' attendance behind a URL that needs no passcode, and the
// interface should say that plainly rather than presenting it as a convenience.
// It says what the link exposes, when it stops working, and that it can be
// withdrawn — before it is made, not after.

interface ShareState {
  shares: ShareSummary[]
  loading: boolean
  error: string | null
  busy: string | null
}

function expiryLabel(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'unknown'
  const days = Math.max(0, Math.round((when.getTime() - Date.now()) / 86_400_000))
  const date = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  if (days === 0) return `expires today (${date})`
  return `expires in ${days} ${days === 1 ? 'day' : 'days'} (${date})`
}

export default function ShareLinks({
  pinCount,
  onRejected,
  announce,
}: {
  pinCount: number
  onRejected: () => void
  announce: (text: string) => void
}) {
  const [state, setState] = useState<ShareState>({
    shares: [],
    loading: true,
    error: null,
    busy: null,
  })
  const [justMade, setJustMade] = useState<string | null>(null)
  const busy = state.busy !== null

  const request = useCallback(
    async (method: 'GET' | 'POST' | 'DELETE', body?: unknown) => {
      const res = await fetch('/api/shares', {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (res.status === 401) {
        onRejected()
        return null
      }
      return { ok: res.ok, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
    },
    [onRejected],
  )

  const load = useCallback(async () => {
    const result = await request('GET')
    if (!result) return
    setState((s) => ({
      ...s,
      loading: false,
      shares: Array.isArray(result.json?.shares) ? (result.json.shares as ShareSummary[]) : [],
      // A dataset that is not loaded yet is not worth shouting about.
      error: result.ok ? null : typeof result.json?.error === 'string' ? result.json.error : null,
    }))
  }, [request])

  useEffect(() => {
    void load()
  }, [load])

  const create = useCallback(async () => {
    // aria-disabled is a claim, not an enforcement. Every other control in
    // this app pairs it with a guard; this one did not, so double-pressing
    // minted two live tokened URLs to named directors' attendance while the
    // button said it was unavailable — and a screen-reader user was told it
    // was unavailable and it fired anyway.
    if (busy || pinCount === 0) return
    setState((s) => ({ ...s, busy: 'new', error: null }))
    const result = await request('POST', {})
    if (!result) return
    if (!result.ok) {
      setState((s) => ({
        ...s,
        busy: null,
        error: typeof result.json?.error === 'string' ? result.json.error : 'That link could not be created.',
      }))
      return
    }
    const token = typeof result.json?.token === 'string' ? result.json.token : null
    setState((s) => ({
      ...s,
      busy: null,
      shares: Array.isArray(result.json?.shares) ? (result.json.shares as ShareSummary[]) : s.shares,
    }))
    setJustMade(token)
    announce('A read-only link has been created.')
  }, [request, announce, busy, pinCount])

  const revoke = useCallback(
    async (token: string) => {
      if (busy) return
      setState((s) => ({ ...s, busy: token, error: null }))
      const result = await request('DELETE', { token })
      if (!result) return
      setState((s) => ({
        ...s,
        busy: null,
        shares: Array.isArray(result.json?.shares) ? (result.json.shares as ShareSummary[]) : s.shares,
        error: result.ok ? null : 'That link could not be withdrawn. Try again.',
      }))
      if (justMade === token) setJustMade(null)
      if (result.ok) announce('The link has been withdrawn and no longer works.')
    },
    [request, announce, justMade, busy],
  )

  const url = (token: string): string =>
    typeof window === 'undefined' ? `/share/${token}` : `${window.location.origin}/share/${token}`

  return (
    <section className="shares">
      <h3 className="shares-title">Share read-only</h3>
      <p className="shares-lede">
        A link anyone can open without the passcode. It shows these charts as they are
        now — it does not update — and it stops working on its own. You can withdraw it
        at any time.
      </p>

      <button
        type="button"
        className="card-action"
        onClick={() => void create()}
        aria-disabled={state.busy !== null || pinCount === 0}
      >
        {state.busy === 'new' ? 'Creating…' : 'Create a link'}
      </button>

      {pinCount === 0 && (
        <p className="shares-note">Pin a chart first — there is nothing to share yet.</p>
      )}

      {justMade && (
        // Shown once, immediately, because this is the only moment the reader
        // needs the URL in full. It is listed afterwards without being splayed
        // across the screen.
        <div className="shares-new">
          <p className="shares-note">Copy this now. It shows board data to anyone who has it.</p>
          <input
            className="shares-url"
            readOnly
            aria-label="Shareable link. Copy this now."
            value={url(justMade)}
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}

      {state.error && (
        <p className="shares-note shares-error" role="alert">
          {state.error}
        </p>
      )}

      {state.shares.length > 0 && (
        <ul className="shares-list">
          {state.shares.map((share) => (
            <li key={share.token}>
              <span className="shares-meta">
                {share.pinCount} {share.pinCount === 1 ? 'chart' : 'charts'} ·{' '}
                {expiryLabel(share.expiresAt)}
              </span>
              <button
                type="button"
                className="shares-revoke"
                onClick={() => void revoke(share.token)}
                aria-disabled={state.busy !== null}
              >
                <RemoveMark />
                <span className="sr-only">Withdraw this link</span>
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
