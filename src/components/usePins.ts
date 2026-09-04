'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
// The key is defined with the store, so the button and the server cannot
// disagree about whether something is already pinned.
import { pinKey } from '@/lib/pins'
import type { Pin } from '@/lib/pins'

export { pinKey }

// One source of truth for the pinned set, because two would disagree. The pin
// button in the transcript and the dashboard itself are the same state: pinning
// a chart has to change what the dashboard holds, and removing it from the
// dashboard has to turn the button back.



export interface PinsState {
  pins: Pin[]
  /** False when KV is unconfigured: pins live only as long as the server. */
  durable: boolean
  loading: boolean
  error: string | null
  /** Keys of pinned analyses, so a card can show its own state. */
  pinnedKeys: Set<string>
  /** The pin currently being written, so exactly one control shows as busy. */
  busyKey: string | null
  add: (input: {
    question: string
    tool: string
    args: Record<string, unknown>
    routedBy?: 'model' | 'fallback'
  }) => Promise<void>
  remove: (id: string) => Promise<boolean>
  reload: () => Promise<void>
  dismissError: () => void
}

const GENERIC = 'The dashboard could not be reached. Nothing was changed — try again.'

export function usePins(onRejected: () => void): PinsState {
  const [pins, setPins] = useState<Pin[]>([])
  const [durable, setDurable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // Responses are applied in the order they were REQUESTED, not the order they
  // arrive. A reload started before a pin can finish after it, and applying it
  // would clobber the fresher list — the card you just pinned vanishes until
  // something else refreshes. Every request takes a ticket; a stale one is read
  // for its errors and then discarded.
  const issued = useRef(0)
  const applied = useRef(0)

  const call = useCallback(
    async (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      body?: unknown,
    ): Promise<boolean> => {
      const ticket = ++issued.current
      try {
        const res = await fetch('/api/pins', {
          method,
          // No Authorization header: the session cookie is sent automatically
          // on a same-origin request, and it is httpOnly so this code could not
          // read it even if it wanted to.
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        })

        // The passcode changed on the server mid-session. Hand control back to
        // the gate rather than showing an error nothing here can act on.
        if (res.status === 401) {
          onRejected()
          return false
        }

        const parsed = (await res.json().catch(() => null)) as
          | { ok: true; pins: Pin[]; durable?: boolean }
          | { ok: false; error: string }
          | null

        if (res.ok && parsed && parsed.ok) {
          if (ticket < applied.current) return true
          applied.current = ticket
          setPins(parsed.pins)
          if (typeof parsed.durable === 'boolean') setDurable(parsed.durable)
          setError(null)
          return true
        }
        // Stale failures are dropped too.
        //
        // Only the SUCCESS path was ticket-guarded, so an older request that
        // failed could set an error after a newer one had already succeeded —
        // painting "could not be reached" over freshly loaded pins.
        // useConversations guards both paths; this did not.
        if (ticket < applied.current) return false
        setError((parsed && !parsed.ok && parsed.error) || GENERIC)
        return false
      } catch {
        if (ticket < applied.current) return false
        setError(GENERIC)
        return false
      }
    },
    [onRejected],
  )

  const reload = useCallback(async () => {
    setLoading(true)
    await call('GET')
    setLoading(false)
  }, [call])

  useEffect(() => {
    void reload()
  }, [reload])

  const add: PinsState['add'] = useCallback(
    async (input) => {
      const key = pinKey(input.tool, input.args)
      if (busyKey) return
      setBusyKey(key)
      await call('POST', input)
      setBusyKey(null)
    },
    [busyKey, call],
  )

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      if (busyKey) return false
      setBusyKey(id)
      // The outcome is RETURNED. It was swallowed, so a caller's .then() ran
      // on failure too: the card stayed on screen, focus jumped to the
      // heading, and the live region said "Removed from the dashboard" while
      // the error alert appeared beside it. A screen-reader user was told the
      // opposite of what happened.
      const ok = await call('DELETE', { id })
      setBusyKey(null)
      return ok
    },
    [busyKey, call],
  )


  const pinnedKeys = new Set(pins.map((p) => pinKey(p.tool, p.args)))

  return {
    pins,
    durable,
    loading,
    error,
    pinnedKeys,
    busyKey,
    add,
    remove,
    reload,
    dismissError: () => setError(null),
  }
}
