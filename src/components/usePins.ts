'use client'

import { useCallback, useEffect, useState } from 'react'
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
  remove: (id: string) => Promise<void>
  refresh: (id: string) => Promise<void>
  reload: () => Promise<void>
  dismissError: () => void
}

const GENERIC = 'The dashboard could not be reached. Nothing was changed — try again.'

export function usePins(credential: string, onRejected: () => void): PinsState {
  const [pins, setPins] = useState<Pin[]>([])
  const [durable, setDurable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const call = useCallback(
    async (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      body?: unknown,
    ): Promise<boolean> => {
      try {
        const res = await fetch('/api/pins', {
          method,
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
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
          setPins(parsed.pins)
          if (typeof parsed.durable === 'boolean') setDurable(parsed.durable)
          setError(null)
          return true
        }
        setError((parsed && !parsed.ok && parsed.error) || GENERIC)
        return false
      } catch {
        setError(GENERIC)
        return false
      }
    },
    [credential, onRejected],
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
    async (id: string) => {
      if (busyKey) return
      setBusyKey(id)
      await call('DELETE', { id })
      setBusyKey(null)
    },
    [busyKey, call],
  )

  const refresh = useCallback(
    async (id: string) => {
      if (busyKey) return
      setBusyKey(id)
      await call('PATCH', { id })
      setBusyKey(null)
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
    refresh,
    reload,
    dismissError: () => setError(null),
  }
}
