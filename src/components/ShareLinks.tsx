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
          // Whatever was focused when Copy was pressed — the Copy button —
          // has to get focus back. This appends a textarea, focuses it, then
          // removes it: the focused element is destroyed by its own action and
          // focus falls to <body>, which is the sixth instance of that failure
          // in this project. A keyboard reader would be returned to the top of
          // the document by pressing Copy.
          const previous = document.activeElement as HTMLElement | null
          document.body.appendChild(textarea)
          textarea.focus()
          textarea.select()
          document.execCommand('copy')
          document.body.removeChild(textarea)
          previous?.focus()
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
      // ONLY TRUST A LIST THE SERVER ACTUALLY SENT. A failed DELETE — a 500, a
      // malformed body — carries no `shares` array, and this replaced the list
      // with an empty one while showing "could not be withdrawn". The reader
      // was told they had no links at the same moment as being told one could
      // not be removed, and every one of them was still live and still
      // serving named directors' attendance to anyone holding the URL.
      // Implying a link is dead when it is alive is the dangerous direction.
      const sent = Array.isArray(result.json?.shares)
        ? (result.json.shares as ShareSummary[])
        : null
      setState((s) => ({
        ...s,
        busy: null,
        shares: sent ?? s.shares,
        error: result.ok ? null : 'That link could not be withdrawn. It is still live. Try again.',
      }))
      if (justMade === token) setJustMade(null)
      setSelectedToken((curr) => {
        if (curr !== token) return curr
        const remaining = sent ?? []
        return remaining.length > 0 ? remaining[0].token : null
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
          {/* THE WARNING BELONGS TO THE URL, not to the moment of minting.
              It used to be shown only while `justMade` was set, because that
              was the only time a full URL appeared. Auto-selecting an existing
              link means the bearer URL is now painted on EVERY visit — and on
              that path the sentence explaining what it exposes had been
              replaced by "Shareable link (read-only):", which describes the
              page rather than the risk. Anyone holding this URL reads named
              directors' attendance with no passcode; that is true whenever
              the box is on screen. */}
          <p className="shares-note">
            {justMade
              ? 'Copy this now. It shows board data to anyone who has it.'
              : 'This link shows board data to anyone who has it, with no passcode.'}
          </p>
          <div className="shares-url-bar">
            <input
              className="shares-url"
              readOnly
              // The label followed the same "just made" wording on both
              // paths, telling a screen-reader user to copy something now
              // that they may have created days ago.
              aria-label={
                justMade
                  ? 'Shareable link. Copy this now.'
                  : 'Shareable link, readable by anyone who has it'
              }
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
