import test from 'node:test'
import assert from 'node:assert/strict'
// FIRST: recharts and react-dom/client need these globals at evaluation time.
import { container } from './jsdom-setup'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import PinnedDashboard from '../src/components/PinnedDashboard'
import type { PinsState } from '../src/components/usePins'
import type { Pin } from '../src/lib/pins'

// THE DASHBOARD RENDERED EVERY PINNED CHART BLANK, and all 389 other tests
// passed.
//
// Workspace keeps all three views mounted and hides the inactive ones so the
// transcript survives a switch, which means the dashboard's cards mount on
// page load inside a `display: none` subtree. recharts 3 measures its
// container on mount, gets zero there, and never draws; 2.x recovered when the
// view was shown. Nothing in this suite asserts on rendered SVG, so the
// upgrade broke a whole view in silence — the exact failure it was predicted
// to have.
//
// The fix is a latch: the cards are not rendered until the dashboard has been
// shown once, so a chart always mounts visible. This test pins the latch, not
// recharts — it asserts the CARDS are withheld while hidden and present after,
// which is the property the fix depends on and the one a later "tidy" would
// remove.

const pin: Pin = {
  id: 'pin-1',
  question: 'Who is below our attendance threshold?',
  tool: 'attendance_vs_threshold',
  args: {},
  routedBy: 'model',
  pinnedAt: '2026-08-31T10:00:00.000Z',
  datasetAsAt: '2026-08-31',
  result: {
    tool: 'attendance_vs_threshold',
    headline: '3 directors are below 80%.',
    chart: {
      kind: 'bar',
      title: 'Attendance below 80%',
      xLabel: 'Director',
      yLabel: 'Attendance',
      unit: 'percent',
      seriesLabel: 'Present rate',
      points: [{ label: 'A', value: 70, highlight: true }],
    },
    table: null,
    assumptions: [],
    caveats: [],
    provenance: {
      asAt: '2026-08-31',
      sources: ['attendance.json'],
      rowsConsidered: 1,
      derivation: 'test',
    },
  },
}

function state(): PinsState {
  return {
    pins: [pin],
    durable: true,
    loading: false,
    error: null,
    pinnedKeys: new Set<string>(),
    busyKey: null,
    add: async () => {},
    remove: async () => true,
    reload: async () => {},
    dismissError: () => {},
  }
}

function renderDashboard(hidden: boolean): { html: () => string; show: () => void; stop: () => void } {
  const root = createRoot(container)
  const draw = (isHidden: boolean) => {
    act(() => {
      root.render(
        <PinnedDashboard
          pins={state()}
          hidden={isHidden}
          announce={() => {}}
          organisation="Test Org"
          onRejected={() => {}}
        />,
      )
    })
  }
  draw(hidden)
  return {
    html: () => container.innerHTML,
    show: () => draw(false),
    stop: () => act(() => root.unmount()),
  }
}

test('a pinned card is not built while the dashboard is hidden', () => {
  const view = renderDashboard(true)
  // The heading is always there; the CARD is what must wait, because mounting
  // a chart into a display:none subtree is what leaves it blank for ever.
  assert.ok(view.html().includes('Pinned charts'), 'the view itself renders')
  assert.ok(
    !view.html().includes(pin.question),
    'no card is built while the view is hidden',
  )
  view.stop()
})

test('and it appears as soon as the dashboard is shown', () => {
  const view = renderDashboard(true)
  view.show()
  assert.ok(view.html().includes(pin.question), 'the card is built on first showing')
  assert.ok(view.html().includes('Attendance below 80%'), 'and it carries its chart')
  view.stop()
})

test('a dashboard that starts visible builds its cards immediately', () => {
  // The share page and a reload while on the dashboard both land here, and a
  // latch that only ever opened on a CHANGE would leave those blank.
  const view = renderDashboard(false)
  assert.ok(view.html().includes(pin.question))
  view.stop()
})
