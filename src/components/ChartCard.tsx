'use client'

import BoardChart from './BoardChart'
import { isRefusal } from '@/lib/types'
import type { AnswerResult, TableSpec } from '@/lib/types'

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
  return (
    <div className="table-block">
      <div className="table-scroll">
        <table className="answer-table">
          <thead>
            <tr>
              {spec.columns.map((column, i) => (
                <th key={i} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={typeof cell === 'number' ? 'numeric' : undefined}>
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
}: {
  result: AnswerResult
  routedBy?: 'model' | 'fallback'
}) {
  // A refusal is a correct answer — it gets its own calm treatment, deliberately
  // unlike the error card.
  if (isRefusal(result)) {
    return (
      <article className="card card-refusal">
        <p className="refusal-kicker">Not answerable from this data</p>
        <h2 className="headline">{result.headline}</h2>
        <p className="refusal-body">{result.reason}</p>
        {result.alternative && (
          <p className="refusal-alt">
            <strong>What the data can offer instead: </strong>
            {result.alternative}
          </p>
        )}
        {routedBy === 'fallback' && <FallbackNotice />}
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
      <h2 className="headline">{headline}</h2>

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
    </article>
  )
}
