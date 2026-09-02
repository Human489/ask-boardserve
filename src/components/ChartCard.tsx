'use client'

import type { ReactNode } from 'react'
import BoardChart from './BoardChart'
import { UnavailableMark } from './marks'
import { isRefusal } from '@/lib/types'
import type { AnswerResult, RoutedBy, TableSpec } from '@/lib/types'

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
}) {
  const Headline = (headingLevel === 3 ? 'h3' : 'h2') as 'h2' | 'h3'

  // A refusal is a correct answer — it gets its own calm treatment, deliberately
  // unlike the error card.
  if (isRefusal(result)) {
    return (
      <article className="card card-refusal">
        <p className="card-status status-refusal">
          <UnavailableMark />
          Not answerable from this data
        </p>
        <Headline className="headline">{result.headline}</Headline>
        <p className="refusal-body">{result.reason}</p>
        {result.alternative && (
          <p className="refusal-alt">
            <strong>What the data can offer instead: </strong>
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

  return (
    <article className="card">
      <Headline className="headline">{headline}</Headline>

      {chart && chart.points.length > 0 && <BoardChart spec={chart} />}

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

      <div className="provenance">
        {note}
        <dl>
          <dt>As at</dt>
          <dd>{provenance.asAt}</dd>
          <dt>Sources</dt>
          <dd>{provenance.sources.join(', ')}</dd>
          <dt>Rows</dt>
          <dd>{provenance.rowsConsidered.toLocaleString('en-GB')} considered</dd>
          <dt>Derivation</dt>
          <dd>{provenance.derivation}</dd>
        </dl>
      </div>

      {actions && <div className="card-actions">{actions}</div>}
    </article>
  )
}
