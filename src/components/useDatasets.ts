'use client'

import { useCallback, useEffect, useState } from 'react'
import type { DatasetSummary } from '@/lib/datasets'

// The datasets available to answer from, and which one is active.
//
// Shared state, not per-visitor: one shared passcode, one shared dashboard, one
// active dataset. That is also what makes the deployed link work for someone
// opening it cold once a dataset has been uploaded.

export interface DatasetsState {
  datasets: DatasetSummary[]
  activeId: string | null
  /** True when a dataset directory is present on the server (development). */
  localAvailable: boolean
  /** False when no KV namespace is configured, so uploading is unavailable. */
  storageAvailable: boolean
  /** Nothing to answer from: neither an upload nor a local directory. */
  needsDataset: boolean
  loading: boolean
  busy: boolean
  error: string | null
  /** Set after a successful upload, so the view can say what arrived. */
  lastUploaded: DatasetSummary | null
  upload: (file: File) => Promise<void>
  activate: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reload: () => Promise<void>
  dismissError: () => void
}

interface Payload {
  ok: true
  datasets?: DatasetSummary[]
  activeId?: string | null
  localAvailable?: boolean
  storageAvailable?: boolean
  summary?: DatasetSummary
}

const GENERIC = 'The dataset service could not be reached. Nothing was changed — try again.'

export function useDatasets(onRejected: () => void): DatasetsState {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [localAvailable, setLocalAvailable] = useState(false)
  const [storageAvailable, setStorageAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUploaded, setLastUploaded] = useState<DatasetSummary | null>(null)

  const apply = useCallback((body: Payload) => {
    if (Array.isArray(body.datasets)) setDatasets(body.datasets)
    if (body.activeId !== undefined) setActiveId(body.activeId)
    if (typeof body.localAvailable === 'boolean') setLocalAvailable(body.localAvailable)
    if (typeof body.storageAvailable === 'boolean') setStorageAvailable(body.storageAvailable)
  }, [])

  const call = useCallback(
    async (init: RequestInit): Promise<Payload | null> => {
      try {
        const res = await fetch('/api/datasets', {
          ...init,
          // The session cookie travels automatically; nothing here holds the
          // passcode, and it is httpOnly so nothing here could read it.
          headers: init.headers,
          cache: 'no-store',
        })
        if (res.status === 401) {
          onRejected()
          return null
        }
        const body = (await res.json().catch(() => null)) as
          | Payload
          | { ok: false; error: string }
          | null
        if (res.ok && body && body.ok) {
          apply(body)
          setError(null)
          return body
        }
        // An upload rejected for its contents is the uploader's to fix, so the
        // server's specific reason is shown rather than a generic failure.
        setError((body && !body.ok && body.error) || GENERIC)
        return null
      } catch {
        setError(GENERIC)
        return null
      }
    },
    [apply, onRejected],
  )

  const reload = useCallback(async () => {
    setLoading(true)
    await call({ method: 'GET' })
    setLoading(false)
  }, [call])

  useEffect(() => {
    void reload()
  }, [reload])

  const upload = useCallback(
    async (file: File) => {
      if (busy) return
      setBusy(true)
      setLastUploaded(null)
      const form = new FormData()
      form.set('file', file)
      const body = await call({ method: 'POST', body: form })
      if (body?.summary) setLastUploaded(body.summary)
      setBusy(false)
    },
    [busy, call],
  )

  const activate = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      await call({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setBusy(false)
    },
    [busy, call],
  )

  const remove = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      await call({
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setBusy(false)
    },
    [busy, call],
  )

  return {
    datasets,
    activeId,
    localAvailable,
    storageAvailable,
    needsDataset: !loading && datasets.length === 0 && !localAvailable,
    loading,
    busy,
    error,
    lastUploaded,
    upload,
    activate,
    remove,
    reload,
    dismissError: () => setError(null),
  }
}
