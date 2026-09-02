'use client'

import { useCallback, useRef, useState } from 'react'

// One live region for the whole authenticated app, owned by Workspace.
//
// It exists at that level for two reasons. A region nested inside a view is
// dead while that view is hidden: `[hidden] { display: none !important }`
// takes it out of the accessibility tree entirely, so an answer arriving while
// the reader is on the dashboard was announced to nobody. And most screen
// readers do not announce a live region that is inserted already carrying its
// text — the region has to be in the tree, empty, before the message lands.
// Regions created together with their content (the pending skeleton, the
// dashboard's "Loading pinned charts") were therefore probably never spoken.

export interface Announcer {
  /** The text the region is currently carrying. */
  message: string
  announce: (text: string) => void
}

export function useAnnouncer(): Announcer {
  const [message, setMessage] = useState('')
  const alternate = useRef(false)

  const announce = useCallback((text: string) => {
    setMessage((current) => {
      if (text === '') {
        alternate.current = false
        return ''
      }
      // Two answers in a row can share a headline — ask the same question
      // twice and they will. An unchanged string is not a mutation, so the
      // region stays silent. A trailing space that flips on each call makes
      // every announcement a real change without changing what is read out.
      const stripped = current.replace(/ $/, '')
      if (stripped === text) alternate.current = !alternate.current
      else alternate.current = false
      return alternate.current ? `${text} ` : text
    })
  }, [])

  return { message, announce }
}

export function AnnouncerRegion({ message }: { message: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  )
}
