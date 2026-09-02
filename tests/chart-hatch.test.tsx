import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bar, BarChart, Cell } from 'recharts'

import { flaggedHatchDefs, type Palette } from '../src/components/BoardChart'

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
  series2: '#0f8e61',
  highlight: '#c62f2f',
  reference: '#6b6963',
  grid: '#e1e0d9',
  axis: '#b4b3a8',
  muted: '#6b6963',
  surface: '#fcfcfb',
}

const data = [
  { label: 'A', value: 5, highlight: true },
  { label: 'B', value: 3 },
]

function render(child: React.ReactNode, fill: string): string {
  return renderToStaticMarkup(
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

test('wrapping the same defs in a component loses the pattern', () => {
  // Pins the recharts behaviour itself, so the reason for the rule above cannot
  // be quietly forgotten if someone "tidies" it back into a component.
  function Wrapped() {
    return flaggedHatchDefs('wrapped', palette)
  }
  const markup = render(<Wrapped />, 'url(#wrapped)')
  assert.ok(!markup.includes('<pattern'), 'a component child is dropped by recharts')
})
