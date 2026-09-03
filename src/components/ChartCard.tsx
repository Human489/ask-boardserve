'use client'

// React is imported explicitly, like BoardChart, because the shorthand <>
// fragments below compile to React.Fragment under the classic JSX runtime
// the test suite uses — Next's automatic runtime hides the need.
import React, { type ReactNode } from 'react'
import BoardChart from './BoardChart'
import { UnavailableMark } from './marks'
import { isRefusal } from '@/lib/types'
import type { AnswerResult, Provenance as ProvenanceSpec, RoutedBy, TableSpec } from '@/lib/types'

function NoteList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="note-label">{label}</p>
      <ul className="note-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

/** "1 assumption and 2 things worth knowing" — never a bare count. */
function qualifierSummary(assumptions: number, caveats: number): string | null {
  const parts: string[] = []
  if (assumptions > 0) {
    parts.push(`${assumptions} assumption${assumptions === 1 ? '' : 's'}`)
  }
  if (caveats > 0) {
    parts.push(caveats === 1 ? '1 thing worth knowing' : `${caveats} things worth knowing`)
  }
  if (parts.length === 0) return null
  return parts.join(' and ')
}

/**
 * Provenance as "a small note", which is the brief's wording for it.
 *
 * It used to be a 131px block under every answer. On a dashboard of pinned
 * cards that made three answers 3,534px tall, and the note it was supposed to
 * be had become the largest thing on the card after the chart.
 *
 * The as-at date stays OUTSIDE the disclosure. Every figure in this product is
 * measured from it — "overdue" means overdue as at that date and nothing else —
 * so it is part of what the figure means rather than part of its audit trail.
 * The sources, row count and derivation are the audit trail, and an audit trail
 * is consulted when checking rather than read when reading.
 *
 * A native <details> rather than a scripted toggle: it is keyboard operable and
 * announced as expandable with no JavaScript, and it still works if hydration
 * never happens.
 */
function Provenance({
  provenance,
  note,
}: {
  provenance: ProvenanceSpec
  note?: ReactNode
}) {
  return (
    <div className="provenance">
      <p className="provenance-asat">
        <span className="provenance-asat-label">As at</span> {provenance.asAt}
      </p>
      {note}
      <details className="provenance-detail">
        <summary>Where this came from</summary>
        <dl>
          <dt>Sources</dt>
          <dd>{provenance.sources.join(', ')}</dd>
          <dt>Rows</dt>
          <dd>{provenance.rowsConsidered.toLocaleString('en-GB')} considered</dd>
          <dt>Derivation</dt>
          <dd>{provenance.derivation}</dd>
        </dl>
      </details>
    </div>
  )
}

function AnswerTable({ spec }: { spec: TableSpec }) {
  // A column of figures is read down, not across, so it is set flush right —
  // and the heading has to follow the column or it stops labelling it. CSS
  // cannot see the cell types, so the column is classified here.
  const numericColumn = spec.columns.map((_, c) =>
    spec.rows.some((row) => typeof row[c] === 'number') &&
    spec.rows.every((row) => row[c] === null || typeof row[c] === 'number'),
  )

  return (
    <div className="table-block">
      <div className="table-scroll">
        <table className="answer-table">
          <thead>
            <tr>
              {spec.columns.map((column, i) => (
                <th key={i} scope="col" className={numericColumn[i] ? 'numeric' : undefined}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={numericColumn[c] ? 'numeric' : undefined}>
                    {cell === null ? '—' : typeof cell === 'number' ? cell.toLocaleString('en-GB') : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FallbackNotice() {
  return (
    <p className="routing-notice">
      Routed by the offline keyword classifier — no model credentials are configured, so
      the question was matched to a tool by keyword rather than by a model. The figures
      themselves are unaffected; they are computed from the dataset either way.
    </p>
  )
}

export default function ChartCard({
  result,
  routedBy,
  actions,
  note,
  headingLevel = 2,
  compact = false,
}: {
  result: AnswerResult
  routedBy?: RoutedBy
  /** The card's headline is a heading, and its level depends on what encloses
   *  it: in the transcript it sits directly under the page, on the dashboard it
   *  sits under the "Pinned charts" heading. A card whose headline is a sibling
   *  of the section title reads as another section rather than as its content. */
  headingLevel?: 2 | 3
  /** Controls the surrounding view owns — pinning here, refresh and remove on
   *  the dashboard. The card renders the row; it does not know what is in it. */
  actions?: ReactNode
  /** A line about this card's provenance as a pin, e.g. when it was frozen. */
  note?: ReactNode
  /**
   * Dashboard treatment: the finding, the chart, and everything else folded
   * into one disclosure whose label states how much is in there.
   *
   * The dashboard reused the transcript's card exactly, which sounds like
   * consistency and was not: a card is 1,178px, so three pinned answers were
   * 3,534px of scrolling. The two surfaces are doing different jobs. The chat
   * is one answer read carefully; the dashboard is several answers scanned
   * against each other, and the brief only ever asked to pin CHARTS.
   *
   * What is never folded away is the qualification itself. The summary says
   * "2 assumptions and 1 thing worth knowing", so a reader who never opens it
   * still knows the figure is qualified and by how much — which is the part
   * that protects someone repeating it to a board.
   */
  compact?: boolean
}) {
  const Headline = (headingLevel === 3 ? 'h3' : 'h2')

  // A refusal is a correct answer — it gets its own calm treatment, deliberately
  // unlike the error card.
  if (isRefusal(result)) {
    return (
      <article className="card card-refusal">
        {/* A state label, and only that. It said "Not answerable from this
            data", the headline said the data could not answer, and the reason
            then explained why — the same idea three times, twice in wording
            the refusal invariant forbids. */}
        <p className="card-status status-refusal">
          <UnavailableMark />
          Not answerable
        </p>
        <Headline className="headline">{result.headline}</Headline>
        <p className="refusal-body">{result.reason}</p>
        {result.alternative && (
          <p className="refusal-alt">
            <strong>What this can answer instead: </strong>
            {result.alternative}
          </p>
        )}
        {routedBy === 'fallback' && <FallbackNotice />}
        {actions && <div className="card-actions">{actions}</div>}
      </article>
    )
  }

  const { headline, chart, table, assumptions, caveats, provenance } = result

  // Paper citations are references, not data. Rendered as a table they read as
  // a two-column dataset with nothing in it; rendered as a list they read as
  // "where this came from", which is what a secretary needs in order to go and
  // check the paper.
  const isCitation = result.tool === 'search_board_papers' && table !== null

  const evidence = (
    <>
      {isCitation ? (
        <div className="citations">
          <p className="citations-label">Drawn from</p>
          <ul className="citation-list">
            {table.rows.map((row, i) => (
              <li key={`${String(row[0])}-${String(row[1])}-${i}`} className="citation">
                <span className="citation-paper">{String(row[0])}</span>
                {row[1] ? <span className="citation-section">{String(row[1])}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        table && table.rows.length > 0 && <AnswerTable spec={table} />
      )}

      {(assumptions.length > 0 || caveats.length > 0) && (
        <div className="notes">
          <NoteList label="Assumed:" items={assumptions} />
          <NoteList label="Worth knowing:" items={caveats} />
        </div>
      )}

      {routedBy === 'fallback' && <FallbackNotice />}
    </>
  )

  const qualifiers = qualifierSummary(assumptions.length, caveats.length)

  return (
    <article className={compact ? 'card card-compact' : 'card'}>
      {/* On the dashboard the card's TITLE is the question, rendered by the
          section around it, so the finding is a paragraph rather than a second
          heading competing to name the same region.

          It is set in body text there too. The findings run 130 to 470
          characters (median 202), and at the 23px display step a 470-character
          one is a paragraph pretending to be a title. It is never shortened:
          every headline is computed, and the notable clause can be anywhere in
          it, so truncating could cut the very thing worth reading. */}
      {compact ? (
        <p className="finding">{headline}</p>
      ) : (
        <Headline className="headline">{headline}</Headline>
      )}

      {chart && chart.points.length > 0 && <BoardChart spec={chart} />}

      {compact ? (
        <details className="working">
          <summary>
            Show the working
            {qualifiers ? <span className="working-count">{qualifiers}</span> : null}
          </summary>
          <div className="working-body">
            {evidence}
            <Provenance provenance={provenance} note={note} />
          </div>
        </details>
      ) : (
        <>
          {evidence}
          <Provenance provenance={provenance} note={note} />
        </>
      )}

      {actions && <div className="card-actions">{actions}</div>}
    </article>
  )
}
