'use client'

// React is imported explicitly, like BoardChart, because the shorthand <>
// fragments below compile to React.Fragment under the classic JSX runtime
// the test suite uses — Next's automatic runtime hides the need.
import React, { useRef, type ReactNode } from 'react'
import BoardChart from './BoardChart'
import ChartExport from './ChartExport'
import { UnavailableMark } from './marks'
import { isRefusal } from '@/lib/types'
import type { AnswerResult, FallbackReason, Provenance as ProvenanceSpec, RoutedBy, TableSpec } from '@/lib/types'

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
 * The as-at date, always visible, outside every disclosure.
 *
 * Every figure in this product is measured from it — "overdue" means overdue
 * as at that date and nothing else — so it is part of what the figure MEANS
 * rather than part of its audit trail. It is the one line that never folds.
 */
function AsAt({ provenance, note }: { provenance: ProvenanceSpec; note?: ReactNode }) {
  return (
    <div className="card-meta">
      <p className="provenance-asat">
        <span className="provenance-asat-label">As at</span> {provenance.asAt}
      </p>
      {note}
    </div>
  )
}

/**
 * The audit trail: sources, rows considered, derivation. Always inside the
 * working disclosure — an audit trail is consulted when checking rather than
 * read when reading, which is what earns it the brief's "a small note".
 */
function AuditTrail({ provenance }: { provenance: ProvenanceSpec }) {
  return (
    <div className="provenance">
      <dl>
        <dt>Sources</dt>
        <dd>{provenance.sources.join(', ')}</dd>
        <dt>Rows</dt>
        <dd>{provenance.rowsConsidered.toLocaleString('en-GB')} considered</dd>
        <dt>Derivation</dt>
        <dd>{provenance.derivation}</dd>
      </dl>
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

function FallbackNotice({ reason }: { reason?: FallbackReason }) {
  let explanation: string
  switch (reason) {
    case 'timeout':
      explanation =
        'the AI model routing service timed out, so the question was matched to a tool by keyword fallback.'
      break
    case 'rate_limit':
      explanation =
        'the AI model routing service was rate-limited, so the question was matched to a tool by keyword fallback.'
      break
    case 'service_error':
      explanation =
        'the AI model routing service was temporarily unavailable, so the question was matched to a tool by keyword fallback.'
      break
    case 'auth_error':
      explanation =
        'AI Gateway credentials failed authentication, so the question was matched to a tool by keyword fallback.'
      break
    case 'no_credentials':
    default:
      explanation =
        'no model credentials are configured, so the question was matched to a tool by keyword rather than by a model.'
      break
  }

  return (
    <p className="routing-notice">
      Routed by the offline keyword classifier — {explanation} The figures
      themselves are unaffected; they are computed from the dataset either way.
    </p>
  )
}

export default function ChartCard({
  result,
  routedBy,
  fallbackReason,
  actions,
  note,
  headingLevel = 2,
  compact = false,
  organisation = null,
}: {
  result: AnswerResult
  routedBy?: RoutedBy
  fallbackReason?: FallbackReason
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
  /**
   * The organisation the data belongs to, for the exported image's stamp.
   *
   * Threaded down rather than added to `provenance`, which every tool would
   * then have to populate with a dataset-level fact it does not otherwise
   * touch. Null for a local dataset that was never uploaded.
   */
  organisation?: string | null
}) {
  const cardRef = useRef<HTMLElement | null>(null)
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
        {routedBy === 'fallback' && <FallbackNotice reason={fallbackReason} />}
        {actions && <div className="card-actions">{actions}</div>}
      </article>
    )
  }

  const { headline, chart, table, assumptions, caveats, provenance } = result

  // Paper citations are references, not data. Rendered as a table they read as
  // a two-column dataset with nothing in it; rendered as a list they read as
  // "where this came from", which is what a secretary needs in order to go and
  // check the paper.
  // rows.length too, like the branch beside it. A paper answer with no
  // citations rendered a "Drawn from" heading over an empty list.
  const isCitation =
    result.tool === 'search_board_papers' && table !== null && table.rows.length > 0

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

    </>
  )

  /**
   * What was assumed, what is worth knowing, and how the route was chosen.
   *
   * Kept apart from the evidence above because THE TABLE IS NOT A CAVEAT — it
   * is the answer, and for a question that produces no chart it is the whole
   * answer. Folding it away with the notes left a card showing one sentence
   * and nothing else.
   */
  const qualification = (
    <>
      {(assumptions.length > 0 || caveats.length > 0) && (
        <div className="notes">
          <NoteList label="Assumed:" items={assumptions} />
          <NoteList label="Worth knowing:" items={caveats} />
        </div>
      )}

      {routedBy === 'fallback' && <FallbackNotice reason={fallbackReason} />}
    </>
  )

  const qualifiers = qualifierSummary(assumptions.length, caveats.length)

  const hasChart = Boolean(chart && chart.points.length > 0)

  return (
    <article className={compact ? 'card card-compact' : 'card'} ref={cardRef}>
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

      {hasChart && chart && <BoardChart spec={chart} />}

      {/* ONE DISCLOSURE FOR THE WHOLE QUALIFICATION, in both modes, collapsed
          by default. Asked for directly, and it reverses PRODUCT.md's second
          principle, which kept caveats on the face of the card in the chat
          because they change how the figure reads.

          What makes the reversal safe is the SUMMARY LABEL: it counts what is
          inside — "2 assumptions and 1 thing worth knowing" — so a reader who
          never opens it still knows the figure carries qualification, which is
          the part that matters to someone about to repeat it to a board. A
          bare "Details" toggle here would be the failure that principle was
          written against; a label stating the count is not.

          The FIGURES do not fold in the chat: the table is the answer, not a
          caveat. On the dashboard it folds with everything else, because that
          surface is several answers compared at a glance and a full table made
          three cards 3,534px tall. */}
      {!compact && evidence}

      <AsAt provenance={provenance} note={note} />

      <details className="working">
        <summary>
          Show the working
          {qualifiers ? <span className="working-count">{qualifiers}</span> : null}
        </summary>
        <div className="working-body">
          {compact && evidence}
          {qualification}
          <AuditTrail provenance={provenance} />
        </div>
      </details>

      {(actions || hasChart) && (
        <div className="card-actions">
          {actions}
          {hasChart && chart && (
            <ChartExport
              chartRef={cardRef}
              title={chart.title}
              asAt={provenance.asAt}
              organisation={organisation}
            />
          )}
        </div>
      )}
    </article>
  )
}
