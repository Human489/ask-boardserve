'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  const [selectedToken, setSelectedToken] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const busy = state.busy !== null
  /** Focus lands here when a revoked row is removed under it. */
  const heading = useRef<HTMLHeadingElement>(null)

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
    const shares = Array.isArray(result.json?.shares) ? (result.json.shares as ShareSummary[]) : []
    setState((s) => ({
      ...s,
      loading: false,
      shares,
      error: result.ok ? null : typeof result.json?.error === 'string' ? result.json.error : null,
    }))
    if (shares.length > 0) {
      setSelectedToken((curr) => curr || shares[0].token)
    }
  }, [request])

  useEffect(() => {
    void load()
  }, [load])

  const handleCopy = useCallback(
    async (textToCopy: string, token: string) => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(textToCopy)
        } else {
          const textarea = document.createElement('textarea')
          textarea.value = textToCopy
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.focus()
          textarea.select()
          document.execCommand('copy')
          document.body.removeChild(textarea)
        }
        setCopiedToken(token)
        announce('Link copied to clipboard.')
        setTimeout(() => {
          setCopiedToken((c) => (c === token ? null : c))
        }, 2500)
      } catch {
        announce('Could not copy link automatically. Please select and copy manually.')
      }
    },
    [announce],
  )

  const create = useCallback(async () => {
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
    if (token) setSelectedToken(token)
    announce('A read-only link has been created.')
  }, [request, announce, busy, pinCount])

  const revoke = useCallback(
    async (token: string) => {
      if (busy) return
      setState((s) => ({ ...s, busy: token, error: null }))
      const result = await request('DELETE', { token })
      if (!result) return
      const updatedShares = Array.isArray(result.json?.shares) ? (result.json.shares as ShareSummary[]) : []
      setState((s) => ({
        ...s,
        busy: null,
        shares: updatedShares,
        error: result.ok ? null : 'That link could not be withdrawn. Try again.',
      }))
      if (justMade === token) setJustMade(null)
      setSelectedToken((curr) => {
        if (curr !== token) return curr
        return updatedShares.length > 0 ? updatedShares[0].token : null
      })
      if (result.ok) announce('The link has been withdrawn and no longer works.')
    },
    [request, announce, justMade, busy],
  )

  const url = (token: string): string =>
    typeof window === 'undefined' ? `/share/${token}` : `${window.location.origin}/share/${token}`

  const activeToken = justMade || selectedToken || (state.shares.length > 0 ? state.shares[0].token : null)

  return (
    <section className="shares">
      <h3 className="shares-title" tabIndex={-1} ref={heading}>
        Share read-only
      </h3>
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

      {activeToken && (
        <div className="shares-new">
          <p className="shares-note">
            {justMade
              ? 'Copy this now. It shows board data to anyone who has it.'
              : 'Shareable link (read-only):'}
          </p>
          <div className="shares-url-bar">
            <input
              className="shares-url"
              readOnly
              aria-label="Shareable link. Copy this now."
              value={url(activeToken)}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="shares-copy-btn"
              onClick={() => void handleCopy(url(activeToken), activeToken)}
              title="Copy link to clipboard"
            >
              {copiedToken === activeToken ? 'Copied!' : 'Copy link'}
            </button>
            <a
              href={url(activeToken)}
              target="_blank"
              rel="noopener noreferrer"
              className="shares-open-link"
              title="Open shared dashboard in new tab"
            >
              Open ↗
            </a>
          </div>
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
              <div className="shares-row-main">
                <span className="shares-meta">
                  {share.pinCount} {share.pinCount === 1 ? 'chart' : 'charts'} ·{' '}
                  {expiryLabel(share.expiresAt)}
                </span>
                {activeToken === share.token && (
                  <span className="shares-active-badge">Active</span>
                )}
              </div>
              <div className="shares-row-actions">
                <button
                  type="button"
                  className="shares-row-btn"
                  onClick={() => void handleCopy(url(share.token), share.token)}
                  title="Copy link"
                >
                  {copiedToken === share.token ? 'Copied!' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="shares-row-btn"
                  onClick={() => setSelectedToken(share.token)}
                  title="View this link above"
                >
                  View
                </button>
                <a
                  href={url(share.token)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shares-row-btn shares-row-open"
                  title="Open link in new tab"
                >
                  Open ↗
                </a>
                <button
                  type="button"
                  className="shares-revoke"
                  onClick={() => void revoke(share.token).then(() => heading.current?.focus())}
                  aria-disabled={state.busy !== null}
                >
                  <RemoveMark />
                  <span className="sr-only">Withdraw this link</span>
                  Withdraw
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
