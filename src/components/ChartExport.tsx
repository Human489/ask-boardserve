'use client'

// React explicitly, like the other components here: the <> fragment below
// compiles to React.Fragment under the classic JSX runtime the tests use.
import React, { useCallback, useState } from 'react'
import { DownloadMark } from './marks'
import { chartToPngBlob, exportFilename } from '@/lib/chartimage'

// Saving a chart as a PNG for a board pack.
//
// ONE BUTTON, AND THE DATE IS ALWAYS ON IT. An earlier draft offered the
// reader a bare chart or a stamped one. That is a choice worth having in
// principle — a chart going into a slide that already carries the date does
// not need it twice — but it doubles the surface for something nobody asked
// for, and the safe option is the one that should not be opt-in. Every figure
// in this product is measured from the dataset's as-at date, so an undated
// attendance percentage sitting in a board pack is precisely the failure the
// product exists to avoid.

interface ChartExportProps {
  /** Finds the chart's <svg> at click time, not at render time. */
  chartRef: React.RefObject<HTMLElement | null>
  title: string
  /** The date the data describes. Always present on a computed answer. */
  asAt: string
  /**
   * The organisation the data belongs to, when it is known.
   *
   * Null for a local dataset that was never uploaded, and the stamp then
   * carries the date alone rather than a guessed name. A wrong organisation on
   * an exported chart would be worse than no organisation.
   */
  organisation: string | null
}

export default function ChartExport({ chartRef, title, asAt, organisation }: ChartExportProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const svg = chartRef.current?.querySelector('svg')
      if (!svg) throw new Error('There is no chart on this answer to save.')

      const footer = { organisation: organisation ?? '', asAt }
      const blob = await chartToPngBlob(svg, { title, footer })

      // A blob URL and a programmatic click: the only way to hand a file to the
      // reader from the browser without a server round trip. Revoked straight
      // after, or the blob is held for the life of the document.
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = exportFilename(title, footer)
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The chart could not be saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, chartRef, title, asAt, organisation])

  return (
    <>
      <button
        type="button"
        className="card-action"
        onClick={() => void save()}
        aria-disabled={busy}
      >
        <DownloadMark />
        {busy ? 'Saving…' : 'Save chart'}
      </button>
      {error && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
