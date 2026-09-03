'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Conversation, ConversationSummary, StoredTurn } from '@/lib/conversations'

// The conversation list, and the plumbing that keeps it honest.
//
// Modelled on usePins: a ticket per request so a slow reply cannot overwrite a
// faster later one, an explicit `durable` flag so the UI can say when history
// only lives for this process, and errors surfaced rather than swallowed.

export interface ConversationsState {
  list: ConversationSummary[]
  /** False when KV is unconfigured, so history dies with the server. */
  durable: boolean
  loading: boolean
  error: string | null
  /** The id currently being written or removed, for a per-row busy state. */
  busyId: string | null
  reload: () => Promise<void>
  save: (id: string, turns: StoredTurn[]) => Promise<void>
  open: (id: string) => Promise<Conversation | null>
  forget: (id: string) => Promise<void>
}

const UNREACHABLE = 'Your conversations could not be reached. Nothing was changed — try again.'

export function useConversations(
  datasetKey: string,
  onRejected: () => void,
): ConversationsState {
  const [list, setList] = useState<ConversationSummary[]>([])
  const [durable, setDurable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Every request takes a ticket; a reply whose ticket is stale is dropped.
  // Without this, a slow list load landing after a fast save would put the
  // pre-save list back on screen.
  const ticket = useRef(0)

  const request = useCallback(
    async (
      method: 'GET' | 'POST' | 'DELETE',
      body?: unknown,
      query = '',
    ): Promise<{ ok: boolean; json: Record<string, unknown> | null; status: number }> => {
      const res = await fetch(`/api/conversations${query}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      // A rejected credential means the cookie is gone or no longer valid.
      // There is nothing this hook can do about it.
      if (res.status === 401) {
        onRejected()
        return { ok: false, json: null, status: 401 }
      }
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
      return { ok: res.ok, json, status: res.status }
    },
    [onRejected],
  )

  const applyList = useCallback((json: Record<string, unknown> | null) => {
    if (!json) return
    if (Array.isArray(json.conversations)) {
      setList(json.conversations as ConversationSummary[])
    }
    if (typeof json.durable === 'boolean') setDurable(json.durable)
  }, [])

  const reload = useCallback(async () => {
    const mine = ++ticket.current
    setLoading(true)
    setError(null)
    try {
      const { ok, json } = await request('GET')
      if (mine !== ticket.current) return
      if (!ok) {
        // A dataset that is not loaded yet is not an error worth shouting
        // about: the reader is about to be sent to the Data view anyway.
        const message = typeof json?.error === 'string' ? json.error : UNREACHABLE
        setError(message)
        setList([])
        return
      }
      applyList(json)
    } catch {
      if (mine === ticket.current) setError(UNREACHABLE)
    } finally {
      if (mine === ticket.current) setLoading(false)
    }
  }, [request, applyList])

  // The list belongs to the dataset, so it is re-read when the dataset
  // changes — the same reason the dashboard reloads on a swap.
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey])

  const save = useCallback(
    async (id: string, turns: StoredTurn[]) => {
      const mine = ++ticket.current
      try {
        const { ok, json } = await request('POST', { id, turns })
        if (mine !== ticket.current) return
        if (!ok) {
          setError(typeof json?.error === 'string' ? json.error : UNREACHABLE)
          return
        }
        setError(null)
        applyList(json)
      } catch {
        if (mine === ticket.current) setError(UNREACHABLE)
      }
    },
    [request, applyList],
  )

  const open = useCallback(
    async (id: string): Promise<Conversation | null> => {
      setBusyId(id)
      try {
        const { ok, json } = await request('GET', undefined, `?id=${encodeURIComponent(id)}`)
        if (!ok) {
          setError(typeof json?.error === 'string' ? json.error : UNREACHABLE)
          return null
        }
        setError(null)
        return (json?.conversation as Conversation | undefined) ?? null
      } catch {
        setError(UNREACHABLE)
        return null
      } finally {
        setBusyId(null)
      }
    },
    [request],
  )

  const forget = useCallback(
    async (id: string) => {
      setBusyId(id)
      const mine = ++ticket.current
      try {
        const { ok, json } = await request('DELETE', { id })
        if (mine !== ticket.current) return
        if (!ok) {
          setError(typeof json?.error === 'string' ? json.error : UNREACHABLE)
          return
        }
        setError(null)
        applyList(json)
      } catch {
        if (mine === ticket.current) setError(UNREACHABLE)
      } finally {
        setBusyId(null)
      }
    },
    [request, applyList],
  )

  return { list, durable, loading, error, busyId, reload, save, open, forget }
}
