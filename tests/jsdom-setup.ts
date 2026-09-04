// A DOM for the chart tests, installed on import.
//
// recharts 3 DOES NOT RENDER A CHART'S INTERNALS SERVER-SIDE. Under 2.x,
// renderToStaticMarkup produced the whole SVG, which is how the flagged-hatch
// guard in chart-hatch.test.tsx worked; under 3.x the same call returns an
// empty wrapper div and every assertion about the SVG passes or fails for
// reasons that have nothing to do with the chart.
//
// That mattered more than it sounds. One of those tests asserted that a
// pattern was ABSENT, and an empty string satisfies that trivially — so the
// migration turned a real guard into a test that passes for the wrong reason,
// which is the failure mode this suite has already been bitten by three times.
//
// So the charts are rendered in a DOM instead. IMPORT THIS FIRST: the globals
// have to exist before recharts and react-dom/client are evaluated, and module
// imports run in source order.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true })
const g = globalThis as unknown as Record<string, unknown>

g.window = dom.window
g.document = dom.window.document
g.HTMLElement = dom.window.HTMLElement
g.Element = dom.window.Element
g.SVGElement = dom.window.SVGElement
g.getComputedStyle = dom.window.getComputedStyle
g.MutationObserver = dom.window.MutationObserver
g.requestAnimationFrame = dom.window.requestAnimationFrame
g.cancelAnimationFrame = dom.window.cancelAnimationFrame
// navigator is a getter-only global in Node, so it cannot simply be assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})
// recharts observes its container. jsdom has no layout, and the charts under
// test are given explicit width and height, so this only has to exist.
g.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// jsdom has no matchMedia, and BoardChart uses two: one for the OS theme and
// one for the narrow-screen layout. Neither ever changes during a test.
if (typeof dom.window.matchMedia !== 'function') {
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof dom.window.matchMedia
}

// Components fetch relative paths on mount (ShareLinks asks for /api/shares).
// Node's fetch cannot parse a relative URL and the rejection surfaces AFTER the
// test has ended, where it is reported as an unhandled rejection rather than as
// a failure — noise that hides a real one. These tests assert on markup, so the
// request never needs to succeed; it only needs not to explode.
g.fetch = (() =>
  Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  })) as unknown as typeof fetch

g.IS_REACT_ACT_ENVIRONMENT = true

export const jsdomWindow = dom.window
export const container = dom.window.document.getElementById('root') as HTMLElement
