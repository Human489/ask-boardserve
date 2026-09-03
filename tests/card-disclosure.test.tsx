import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import ChartCard from '../src/components/ChartCard'
import type { AnswerResult } from '../src/lib/types'

// The dashboard reused the transcript's card exactly. That sounds like
// consistency and was not: a card measured 1,178px, so three pinned answers
// were 3,534px of scrolling on a surface whose whole job is comparing several
// answers at once. The brief only ever asked to pin CHARTS.
//
// Provenance was the other half. The brief's words are "a small note showing
// which rows or passages produced it"; it was a 131px block under every
// answer, and PRODUCT.md had been written to require that, stricter than the
// client ever asked.
//
// What must NOT be lost in compacting: the qualification, and the data. A
// figure repeated to a board without its caveat is the failure this product
// exists to avoid, and a chart whose table is collapsed must still be readable
// by a screen reader.

const result: AnswerResult = {
  tool: 'attendance_below_threshold',
  headline: '3 directors are below 80%.',
  chart: {
    kind: 'bar',
    title: 'Attendance below 80%',
    xLabel: 'Director',
    yLabel: 'Attendance',
    unit: 'percent',
    seriesLabel: 'Attendance',
    points: [
      { label: 'A. Director', value: 70, highlight: true },
      { label: 'B. Director', value: 78.6 },
    ],
  },
  table: {
    columns: ['Director', 'Attendance'],
    rows: [
      ['A. Director', 70],
      ['B. Director', 78.6],
    ],
  },
  assumptions: ['80% is the default threshold; the dataset defines none.'],
  caveats: [
    'Committee membership is inferred from eligibility rows.',
    'Only 5 meetings, so one absence moves a rate 20 points.',
  ],
  provenance: {
    asAt: '2026-08-31',
    sources: ['attendance.json'],
    rowsConsidered: 135,
    derivation: 'Present rate per director against the 80% default.',
  },
}

function render(compact: boolean): string {
  return renderToStaticMarkup(React.createElement(ChartCard, { result, compact }))
}

test('the compact card folds the evidence into one disclosure', () => {
  const html = render(true)
  assert.match(html, /<details/, 'compact must carry a disclosure')
  assert.match(html, /Show the working/, 'and it must be labelled')

  // The table and the notes are inside the details, not removed.
  assert.match(html, /A\. Director/, 'the table content is still in the DOM')
  assert.match(html, /Committee membership is inferred/, 'caveats are still in the DOM')
})

test('the compact summary states how much qualification is folded away', () => {
  // A reader who never opens the disclosure must still know the figure is
  // qualified and by how much. That is the part that protects someone
  // repeating it to a board.
  const html = render(true)
  assert.match(html, /1 assumption and 2 things worth knowing/)
})

test('the qualifier count reads as English, not as a bare number', () => {
  const one: AnswerResult = {
    ...result,
    assumptions: ['Only one.'],
    caveats: ['Only one.'],
  }
  const html = renderToStaticMarkup(
    React.createElement(ChartCard, { result: one, compact: true }),
  )
  assert.match(html, /1 assumption and 1 thing worth knowing/, 'singular forms')
  assert.doesNotMatch(html, /1 assumptions|1 things/, 'no mismatched plural')

  const none: AnswerResult = { ...result, assumptions: [], caveats: [] }
  const bare = renderToStaticMarkup(
    React.createElement(ChartCard, { result: none, compact: true }),
  )
  assert.match(bare, /Show the working/, 'the control still exists')
  assert.doesNotMatch(bare, /0 assumption/, 'never "0 assumptions"')
})

test('the full card keeps its caveats visible, outside any disclosure', () => {
  // The chat is one answer read carefully. Caveats change how the figure
  // reads, so they are not behind a control there.
  const html = render(false)
  const beforeDetails = html.split('<details')[0]
  assert.match(beforeDetails, /Committee membership is inferred/, 'caveats visible')
  assert.match(beforeDetails, /80% is the default threshold/, 'assumptions visible')
})

test('the as-at date is outside the disclosure in both modes', () => {
  // Every figure in this product is measured from it: "overdue" means overdue
  // as at that date and nothing else. It is part of what the figure means, not
  // part of its audit trail.
  for (const compact of [true, false]) {
    const html = render(compact)
    const provenanceDetails = html.indexOf('provenance-detail')
    const asAt = html.indexOf('2026-08-31')
    assert.ok(asAt > -1, `as-at must be rendered (compact=${String(compact)})`)
    assert.ok(
      asAt < provenanceDetails,
      `as-at must precede the provenance disclosure (compact=${String(compact)})`,
    )
  }
})

test('the audit trail is behind the disclosure, not on the face of the card', () => {
  const html = render(false)
  const summary = html.indexOf('Where this came from')
  assert.ok(summary > -1, 'the provenance disclosure must be labelled')
  assert.ok(html.indexOf('Present rate per director') > summary, 'derivation is inside')
  assert.ok(html.indexOf('135 considered') > summary, 'row count is inside')
})

test('collapsing the table does not take the chart data with it', () => {
  // BoardChart renders an sr-only description and table so the chart is not
  // pixels-only. If compacting had moved that inside the collapsed details,
  // screen-reader users would have lost the figures entirely while sighted
  // users kept the chart.
  const html = render(true)
  assert.match(html, /sr-only/, 'the accessible fallback must survive compacting')
  assert.match(html, /Bar chart\./, 'and it must still describe the chart')
})
