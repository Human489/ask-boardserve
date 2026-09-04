import test from 'node:test'
import assert from 'node:assert/strict'
// FIRST: installs the globals recharts and react-dom/client need. Imports run
// in source order, so moving this below them breaks every chart test here.
import { container } from './jsdom-setup'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bar, BarChart, Cell } from 'recharts'

import BoardChart, {
  flaggedHatchDefs,
  seriesTwoPatternDefs,
  type Palette,
} from '../src/components/BoardChart'

// PRODUCT.md requires that chart colour is never the only carrier of meaning,
// so a flagged bar is filled with a hatch pattern rather than a flat red.
//
// This test exists because that hatch shipped broken and nothing caught it.
// The defs were wrapped in a function component, and recharts renders a chart's
// children through renderByOrder, which keeps only elements whose type is a
// string in its SVG tag list or a component it recognises. A function component
// is neither, so the pattern was silently dropped, every flagged Cell pointed at
// a paint server that did not exist, and in SVG that means the element does not
// render — the flagged bars were invisible while the legend still showed a
// hatch swatch. Every unit test passed and the chart looked plausible.

const palette: Palette = {
  series1: '#256cc4',
  series2: '#2a9d7f',
  highlight: '#8f1d1d',
  reference: '#6a615b',
  grid: '#e7e4e1',
  axis: '#b4b3a8',
  muted: '#6b6963',
  surface: '#fcfcfb',
}

const data = [
  { label: 'A', value: 5, highlight: true },
  { label: 'B', value: 3 },
]

/**
 * Renders a chart into a DOM and returns its markup.
 *
 * NOT renderToStaticMarkup, which is what this used before recharts 3. Under
 * 2.x that produced the entire SVG; under 3.x it produces an empty wrapper div,
 * so every assertion below would have been made against an empty string.
 */
function renderChart(tree: React.ReactElement): string {
  const root = createRoot(container)
  act(() => {
    root.render(tree)
  })
  const html = container.innerHTML
  act(() => {
    root.unmount()
  })
  return html
}

function render(child: React.ReactNode, fill: string): string {
  return renderChart(
    <BarChart width={300} height={200} data={data}>
      {child}
      <Bar dataKey="value" isAnimationActive={false}>
        {data.map((point, i) => (
          <Cell key={i} fill={point.highlight ? fill : palette.series1} />
        ))}
      </Bar>
    </BarChart>,
  )
}

test('the flagged hatch reaches the rendered SVG', () => {
  const markup = render(flaggedHatchDefs('hatch-test', palette), 'url(#hatch-test)')
  // The pattern must actually exist in the output, not merely be referenced.
  assert.match(markup, /<pattern[^>]*id="hatch-test"/)
  assert.ok(
    markup.includes('url(#hatch-test)'),
    'the flagged cell references the pattern',
  )
})

test('the hatch is a raw SVG element, not a component recharts would drop', () => {
  const element = flaggedHatchDefs('x', palette) as React.ReactElement
  // A string type is what renderByOrder keeps. If this ever becomes a function,
  // the pattern silently vanishes and flagged bars stop rendering.
  assert.equal(typeof element.type, 'string')
  assert.equal(element.type, 'defs')
})

test('recharts 3 KEEPS a component-wrapped defs, which 2.x dropped', () => {
  // This test used to assert the opposite, and pinned the recharts behaviour
  // that caused the original bug: 2.x's renderByOrder kept only children whose
  // type it recognised, so a function component vanished and the flagged bars
  // pointed at a paint server that did not exist.
  //
  // recharts 3 fixed that upstream. Measured here rather than assumed, because
  // the assertion is what tells the next person whether the rule above is still
  // load-bearing — it is now belt and braces, not the thing standing between a
  // reader and invisible bars.
  //
  // It is also why this file could not simply be deleted during the upgrade.
  // Under 3.x, server-side rendering returns an empty string, and an empty
  // string satisfies "does not include <pattern>" perfectly: the test went on
  // passing while measuring nothing at all.
  function Wrapped() {
    return flaggedHatchDefs('wrapped', palette)
  }
  const markup = render(<Wrapped />, 'url(#wrapped)')
  assert.ok(markup.includes('<pattern'), 'recharts 3 keeps a component child')
  assert.ok(markup.length > 200, 'and the chart rendered at all')
})

// ---------------------------------------------------------------------------
// The second series had the same defect the flagged mark did: it was
// distinguished from the first by hue alone. Measured 1.26:1 apart in light and
// 1.07:1 in dark, which is no separation at all for a colour-deficient reader,
// and the legend repeated the failure rather than resolving it.

test('the second series pattern reaches the rendered SVG', () => {
  const markup = renderChart(
    <BarChart width={300} height={200} data={data}>
      {seriesTwoPatternDefs('series2-test', palette)}
      <Bar dataKey="value" isAnimationActive={false} fill="url(#series2-test)" />
    </BarChart>,
  )
  assert.match(markup, /<pattern[^>]*id="series2-test"/)
  assert.ok(markup.includes('url(#series2-test)'))
})

test('the two patterns differ by direction, not only by colour', () => {
  const flagged = renderToStaticMarkup(
    <svg>{flaggedHatchDefs('a', palette)}</svg>,
  )
  const second = renderToStaticMarkup(
    <svg>{seriesTwoPatternDefs('b', palette)}</svg>,
  )
  // Printed, or seen by someone who cannot separate the hues, the hatch
  // direction is what tells them apart.
  const angle = (m: string) => m.match(/rotate\((-?\d+)\)/)?.[1]
  assert.ok(angle(flagged), 'the flagged hatch has a direction')
  assert.ok(angle(second), 'the second series hatch has a direction')
  assert.notEqual(angle(flagged), angle(second))
})

test('both defs are raw SVG elements recharts will keep', () => {
  for (const el of [flaggedHatchDefs('x', palette), seriesTwoPatternDefs('y', palette)]) {
    assert.equal(typeof (el as React.ReactElement).type, 'string')
  }
})

test('a chart carries its data in text, not only in pixels', () => {
  const spec = {
    kind: 'bar' as const,
    title: 'Attendance by director',
    xLabel: 'Director',
    yLabel: 'Attendance',
    unit: 'percent' as const,
    seriesLabel: 'Board',
    series2Label: 'Committee',
    points: [
      { label: 'A', value: 70, value2: 60, highlight: true, detail: '7 of 10 attended' },
      { label: 'B', value: 95, value2: 88 },
    ],
    reference: { value: 80, label: '80% threshold' },
  }
  const html = renderToStaticMarkup(<BoardChart spec={spec} />)
  // The tooltip was the only place `detail` and unrounded values appeared, and
  // it is reachable by mouse alone.
  assert.ok(html.includes('7 of 10 attended'), 'tooltip-only detail must exist in text')
  assert.match(html, /role="group"/)
  assert.match(html, /aria-labelledby/)
  assert.match(html, /aria-describedby/)
  assert.ok(/Flagged/.test(html), 'a flagged point is named, not only coloured')
  assert.ok(html.includes('Committee'), 'the second series is named in the text alternative')
})
