'use client'

// The default import is here so this module can be rendered outside Next's JSX
// transform — tests/chart-hatch.test.tsx renders the flagged-hatch defs through
// react-dom/server to prove the pattern actually reaches the SVG. Next itself
// does not need it.
import React, { useEffect, useId, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartSpec, DataPoint, Unit } from '@/lib/types'

// Chart colours live in globals.css so light and dark stay in one place. Recharts
// needs concrete values for its SVG props, so we read the computed tokens back at
// runtime and re-read them when the OS theme flips.
export interface Palette {
  series1: string
  series2: string
  highlight: string
  reference: string
  grid: string
  axis: string
  muted: string
  surface: string
}

const TOKENS: Record<keyof Palette, string> = {
  series1: '--series-1',
  series2: '--series-2',
  highlight: '--highlight',
  reference: '--reference',
  grid: '--grid',
  axis: '--axis',
  muted: '--ink-muted',
  surface: '--surface',
}

/** Recharts hands the dot renderer the row it is drawing, which is how a
 *  per-point highlight reaches the line. */
interface LineDotProps {
  cx?: number
  cy?: number
  index?: number
  payload?: { highlight?: boolean }
}

function usePalette(): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(null)

  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(document.documentElement)
      const next = {} as Palette
      for (const key of Object.keys(TOKENS) as (keyof Palette)[]) {
        next[key] = style.getPropertyValue(TOKENS[key]).trim()
      }
      setPalette(next)
    }
    read()

    // Two triggers, because there are now two ways the theme can change.
    //
    // The media query alone was enough while the OS was the only input. Adding
    // the System/Light/Dark control broke that: switching to Light on a dark
    // machine changes the data-theme attribute and fires no media event, so the
    // chart kept the palette it read on mount. Measured — the tokens said
    // --series-1: #256cc4 while the bars were still filled #5f9ee8, the dark
    // blue, on a white card. That is not merely stale: a dark-theme series
    // colour is tuned for a dark ground and #5f9ee8 on white is about 2.6:1,
    // under the 3:1 a chart mark has to hold.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', read)

    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      mq.removeEventListener('change', read)
      observer.disconnect()
    }
  }, [])

  return palette
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return narrow
}

// ------------------------------------------------------------------ formatting

function formatValue(value: number, unit: Unit): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  const num = rounded.toLocaleString('en-GB')
  switch (unit) {
    case 'percent':
      return `${num}%`
    case 'days':
      return `${num} ${Math.abs(rounded) === 1 ? 'day' : 'days'}`
    default:
      return num
  }
}

/** Axis ticks stay terse — the unit is spelled out in the axis caption instead. */
function formatTick(value: number, unit: Unit): string {
  const num = (Math.round(value * 10) / 10).toLocaleString('en-GB')
  return unit === 'percent' ? `${num}%` : num
}

function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

// ------------------------------------------------------------------- tooltip

interface TooltipPayloadItem {
  dataKey?: string | number
  payload?: DataPoint
}

interface ChartTooltipProps {
  active?: boolean
  payload?: TooltipPayloadItem[]
  unit: Unit
  seriesLabel: string
  series2Label?: string
  hasSecond: boolean
}

function ChartTooltip({
  active,
  payload,
  unit,
  seriesLabel,
  series2Label,
  hasSecond,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0]?.payload
  if (!point) return null

  return (
    <div className="tooltip">
      <p className="tooltip-label">{point.label}</p>
      <p className="tooltip-row">
        {hasSecond ? `${seriesLabel}: ` : ''}
        {formatValue(point.value, unit)}
      </p>
      {hasSecond && typeof point.value2 === 'number' && (
        <p className="tooltip-row">
          {series2Label ?? 'Second series'}: {formatValue(point.value2, unit)}
        </p>
      )}
      {point.detail && <p className="tooltip-detail">{point.detail}</p>}
    </div>
  )
}

// --------------------------------------------------------------------- ticks

interface AngledTickProps {
  x?: number
  y?: number
  payload?: { value: string | number }
  fill: string
}

function AngledTick({ x = 0, y = 0, payload, fill }: AngledTickProps) {
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={10}
        textAnchor="end"
        transform="rotate(-40)"
        fill={fill}
        fontSize={11}
      >
        {truncate(String(payload?.value ?? ''), 22)}
      </text>
    </g>
  )
}

// ------------------------------------------------------------------- flagged

/* A flagged bar must be distinguishable without colour, so it is filled with a
   hatch rather than a flat red. The legend swatch repeats the same hatch, which
   is what makes it decodable.
   
   This is deliberately NOT a component. Recharts renders a chart's children
   through renderByOrder, which keeps only elements whose type is a string in
   its own SVG tag list, or a component it recognises. A function component is
   neither, so wrapping these defs in one had them silently dropped — leaving
   every flagged Cell pointing at a paint server that did not exist, which in
   SVG means the bar does not render at all. The flagged bars, the whole point
   of the answer, were invisible while the legend still advertised a hatch.
   It is the same trap the comment about axes below warns about. */
export function flaggedHatchDefs(id: string, palette: Palette) {
  return (
    <defs key="flagged-hatch">
      <pattern
        id={id}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="6" height="6" fill={palette.highlight} />
        <line x1="0" y1="0" x2="0" y2="6" stroke={palette.surface} strokeWidth="2.2" />
      </pattern>
    </defs>
  )
}

/* The second series was distinguished from the first by hue alone: the two
   measured 1.17:1 apart in light and 1.07:1 in dark, so to a reader who cannot
   separate blue from green — or to anyone printing the answer — the chart had
   one series drawn twice. Bars get a pattern, lines get a dash, and the legend
   repeats whichever applies.

   Not a component, for the same reason as flaggedHatchDefs above: recharts'
   renderByOrder drops children whose type is a function, so a <defs> wrapped in
   one never reaches the SVG and every bar pointing at the pattern renders as
   nothing at all. */
export function seriesTwoPatternDefs(id: string, palette: Palette) {
  return (
    <defs key="series-two-pattern">
      <pattern
        id={id}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        // The opposite diagonal to the flagged hatch, so the two patterns are
        // told apart by direction and not only by their colour.
        patternTransform="rotate(-45)"
      >
        <rect width="6" height="6" fill={palette.series2} />
        <line x1="0" y1="0" x2="0" y2="6" stroke={palette.surface} strokeWidth="1.6" />
      </pattern>
    </defs>
  )
}

/** Matches the SVG hatch in CSS so the legend and the chart cannot drift. */
function hatchSwatch(palette: Palette): string {
  return `repeating-linear-gradient(45deg, ${palette.highlight} 0 2px, ${palette.surface} 2px 4px)`
}

/** The legend twin of seriesTwoPatternDefs. */
function seriesTwoSwatch(palette: Palette): string {
  return `repeating-linear-gradient(-45deg, ${palette.series2} 0 2px, ${palette.surface} 2px 3px)`
}

/** The legend twin of the second line's dash pattern. */
function dashedSwatch(palette: Palette): string {
  return `repeating-linear-gradient(90deg, ${palette.series2} 0 7px, transparent 7px 11px)`
}

// --------------------------------------------------------------------- chart

export default function BoardChart({ spec }: { spec: ChartSpec }) {
  const palette = usePalette()
  const narrow = useIsNarrow()
  // Several answer cards sit on the page at once, each with its own SVG. A
  // shared pattern id would resolve to whichever chart mounted first.
  const uid = useId().replace(/[^\w-]/g, '')
  const hatchId = `flagged-hatch-${uid}`
  const seriesTwoId = `series-two-${uid}`
  const titleId = `chart-title-${uid}`
  const descId = `chart-desc-${uid}`
  const tableId = `chart-table-${uid}`

  const hasSecond = useMemo(
    () => spec.points.some((p) => typeof p.value2 === 'number'),
    [spec.points],
  )
  const hasHighlight = useMemo(() => spec.points.some((p) => p.highlight), [spec.points])

  const longestLabel = useMemo(
    () => spec.points.reduce((max, p) => Math.max(max, p.label.length), 0),
    [spec.points],
  )

  // Director and job-title labels collide badly on a vertical axis. Past a handful
  // of categories, or once labels get long, lay the bars out horizontally so every
  // name reads straight. Lines are always time-ordered, so they stay vertical.
  const horizontal =
    spec.kind === 'bar' && (spec.points.length > 7 || longestLabel > 14 || narrow)

  const seriesLabel = spec.seriesLabel ?? spec.yLabel
  const series2Label = spec.series2Label

  const height = horizontal
    ? Math.max(200, spec.points.length * 34 + 56)
    : narrow
      ? 250
      : 300

  const isLine = spec.kind === 'line'

  const legendEntries: {
    label: string
    color: string
    fill?: string
    shape?: 'diamond' | 'line'
  }[] = []
  if (palette) {
    if (hasSecond) {
      // The swatches carry the second signal, not just the colour: a solid rule
      // against a dashed one for lines, a flat block against a hatched one for
      // bars. A legend that repeated only the hue would leave the reader with
      // two entries they cannot tell apart on the chart.
      legendEntries.push({
        label: seriesLabel,
        color: palette.series1,
        shape: isLine ? 'line' : undefined,
      })
      legendEntries.push({
        label: series2Label ?? 'Second series',
        color: palette.series2,
        fill: isLine ? dashedSwatch(palette) : seriesTwoSwatch(palette),
        shape: isLine ? 'line' : undefined,
      })
    }
    if (hasHighlight) {
      legendEntries.push({
        label: 'Flagged',
        color: palette.highlight,
        fill: spec.kind === 'bar' ? hatchSwatch(palette) : undefined,
        shape: isLine ? 'diamond' : undefined,
      })
    }
  }

  const axisCaption = horizontal
    ? `${spec.xLabel} (vertical) · ${spec.yLabel} (horizontal)`
    : `${spec.xLabel} (horizontal) · ${spec.yLabel} (vertical)`

  // A description of the shape of the chart, for a reader who cannot see it.
  // Computed from the points rather than written, so it cannot describe a chart
  // other than the one drawn — the same reason the headline is computed by the
  // tool rather than narrated.
  const flaggedCount = spec.points.filter((p) => p.highlight).length
  const values = spec.points.map((p) => p.value)
  const description = [
    `${spec.kind === 'line' ? 'Line' : 'Bar'} chart.`,
    `${spec.points.length} ${spec.points.length === 1 ? 'point' : 'points'}.`,
    `${axisCaption}.`,
    values.length > 0
      ? `${seriesLabel} from ${formatValue(Math.min(...values), spec.unit)} to ${formatValue(Math.max(...values), spec.unit)}.`
      : '',
    hasSecond ? `A second series, ${series2Label ?? 'second series'}, is drawn dashed.` : '',
    flaggedCount > 0
      ? `${flaggedCount} ${flaggedCount === 1 ? 'point is' : 'points are'} flagged.`
      : '',
    spec.reference ? `A reference line marks ${spec.reference.label}.` : '',
    'The figures follow in a table.',
  ]
    .filter(Boolean)
    .join(' ')

  // Whether the table needs a notes column at all — `detail` and the flag are
  // otherwise reachable only by hovering a tooltip with a mouse.
  const hasNotes = spec.points.some((p) => p.detail || p.highlight)

  return (
    // Grouped and named, so the chart is announced as one thing with a title
    // rather than as loose paragraphs followed by an unlabelled graphic.
    <div
      className="chart-block"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <p className="chart-title" id={titleId}>
        {spec.title}
      </p>
      <p className="chart-axis-note">{axisCaption}</p>
      <p className="sr-only" id={descId}>
        {description}
      </p>

      <div className="chart-frame" style={{ height }}>
        {palette && (
          <ResponsiveContainer width="100%" height="100%">
            {spec.kind === 'line' ? (
              <LineChart
                data={spec.points}
                // Off by default in recharts 2.x, which leaves the SVG with no
                // role, no tab stop and no title — the chart existed for a
                // mouse only. On, it also gives the points arrow-key
                // navigation, which is the only way to reach the tooltip (and
                // so `detail` and the unrounded values) without one.
                accessibilityLayer
                title={spec.title}
                desc={description}
                margin={{ top: 8, right: 18, bottom: longestLabel > 8 ? 46 : 14, left: 4 }}
              >
                <CartesianGrid stroke={palette.grid} vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke={palette.axis}
                  tickLine={false}
                  interval={0}
                  height={longestLabel > 8 ? 56 : 24}
                  tick={
                    longestLabel > 8 ? (
                      <AngledTick fill={palette.muted} />
                    ) : (
                      { fill: palette.muted, fontSize: 11 }
                    )
                  }
                />
                <YAxis
                  stroke={palette.axis}
                  tickLine={false}
                  width={48}
                  tick={{ fill: palette.muted, fontSize: 11 }}
                  allowDecimals={spec.unit !== 'count'}
                  tickFormatter={(v: number) => formatTick(v, spec.unit)}
                />
                {spec.reference && (
                  <ReferenceLine
                    y={spec.reference.value}
                    stroke={palette.reference}
                    strokeDasharray="4 4"
                    label={{
                      value: spec.reference.label,
                      position: 'insideTopRight',
                      fill: palette.muted,
                      fontSize: 11,
                    }}
                  />
                )}
                <Tooltip
                  cursor={{ stroke: palette.axis }}
                  content={
                    <ChartTooltip
                      unit={spec.unit}
                      seriesLabel={seriesLabel}
                      series2Label={series2Label}
                      hasSecond={hasSecond}
                    />
                  }
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={palette.series1}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  // A plain dot object cannot vary per point, so flagged
                  // meetings would be drawn identically to the rest while the
                  // legend still promised a "Flagged" colour. Render dots
                  // individually so the highlight is honoured on lines as it
                  // already is on bars.
                  dot={(props: LineDotProps) => {
                    const flagged = props.payload?.highlight === true
                    // A flagged meeting becomes a diamond rather than a redder
                    // circle: the shape survives being printed or read by
                    // someone who cannot separate the two colours.
                    return flagged ? (
                      <rect
                        key={`dot-${props.index}`}
                        x={(props.cx ?? 0) - 5}
                        y={(props.cy ?? 0) - 5}
                        width={10}
                        height={10}
                        transform={`rotate(45 ${props.cx ?? 0} ${props.cy ?? 0})`}
                        fill={palette.highlight}
                        stroke="var(--surface)"
                        strokeWidth={2}
                      />
                    ) : (
                      <circle
                        key={`dot-${props.index}`}
                        cx={props.cx}
                        cy={props.cy}
                        r={4}
                        fill={palette.series1}
                        stroke="var(--surface)"
                        strokeWidth={2}
                      />
                    )
                  }}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                />
                {hasSecond && (
                  <Line
                    type="monotone"
                    dataKey="value2"
                    stroke={palette.series2}
                    strokeWidth={2}
                    // Dashed, and marked with squares rather than the first
                    // series' circles. The two series colours are 1.17:1 apart
                    // in light and 1.07:1 in dark, so hue alone identified
                    // neither of them; the dash and the shape do.
                    strokeDasharray="7 4"
                    strokeLinecap="butt"
                    strokeLinejoin="round"
                    dot={(props: LineDotProps) => (
                      <rect
                        key={`dot2-${props.index}`}
                        x={(props.cx ?? 0) - 4}
                        y={(props.cy ?? 0) - 4}
                        width={8}
                        height={8}
                        fill={palette.series2}
                        stroke="var(--surface)"
                        strokeWidth={2}
                      />
                    )}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            ) : (
              <BarChart
                data={spec.points}
                accessibilityLayer
                title={spec.title}
                desc={description}
                layout={horizontal ? 'vertical' : 'horizontal'}
                margin={
                  horizontal
                    ? // A reference line sits near the right edge; leave room for its label.
                      {
                        top: spec.reference ? 22 : 8,
                        right: spec.reference ? 68 : 20,
                        bottom: 14,
                        left: 4,
                      }
                    : { top: 8, right: 18, bottom: longestLabel > 8 ? 46 : 14, left: 4 }
                }
                barGap={2}
              >
                {flaggedHatchDefs(hatchId, palette)}
                {seriesTwoPatternDefs(seriesTwoId, palette)}
                <CartesianGrid
                  stroke={palette.grid}
                  vertical={horizontal}
                  horizontal={!horizontal}
                />
                {/* Axes are direct children on purpose: recharts inspects the chart's
                    own children to find them, so a Fragment wrapper makes them vanish. */}
                {horizontal && (
                  <XAxis
                    type="number"
                    stroke={palette.axis}
                    tickLine={false}
                    tick={{ fill: palette.muted, fontSize: 11 }}
                    allowDecimals={spec.unit !== 'count'}
                  tickFormatter={(v: number) => formatTick(v, spec.unit)}
                  />
                )}
                {horizontal && (
                  <YAxis
                    type="category"
                    dataKey="label"
                    stroke={palette.axis}
                    tickLine={false}
                    interval={0}
                    width={Math.min(narrow ? 108 : 190, Math.max(84, longestLabel * 7))}
                    tick={{ fill: palette.muted, fontSize: 11 }}
                    tickFormatter={(v: string) => truncate(v, narrow ? 15 : 26)}
                  />
                )}
                {!horizontal && (
                  <XAxis
                    type="category"
                    dataKey="label"
                    stroke={palette.axis}
                    tickLine={false}
                    interval={0}
                    height={longestLabel > 8 ? 56 : 24}
                    tick={
                      longestLabel > 8 ? (
                        <AngledTick fill={palette.muted} />
                      ) : (
                        { fill: palette.muted, fontSize: 11 }
                      )
                    }
                  />
                )}
                {!horizontal && (
                  <YAxis
                    type="number"
                    stroke={palette.axis}
                    tickLine={false}
                    width={48}
                    tick={{ fill: palette.muted, fontSize: 11 }}
                    allowDecimals={spec.unit !== 'count'}
                  tickFormatter={(v: number) => formatTick(v, spec.unit)}
                  />
                )}
                {spec.reference &&
                  (horizontal ? (
                    <ReferenceLine
                      x={spec.reference.value}
                      stroke={palette.reference}
                      strokeDasharray="4 4"
                      label={{
                        value: spec.reference.label,
                        position: 'top',
                        fill: palette.muted,
                        fontSize: 11,
                      }}
                    />
                  ) : (
                    <ReferenceLine
                      y={spec.reference.value}
                      stroke={palette.reference}
                      strokeDasharray="4 4"
                      label={{
                        value: spec.reference.label,
                        position: 'insideTopRight',
                        fill: palette.muted,
                        fontSize: 11,
                      }}
                    />
                  ))}
                <Tooltip
                  cursor={{ fill: palette.grid, fillOpacity: 0.4 }}
                  content={
                    <ChartTooltip
                      unit={spec.unit}
                      seriesLabel={seriesLabel}
                      series2Label={series2Label}
                      hasSecond={hasSecond}
                    />
                  }
                />
                <Bar
                  dataKey="value"
                  maxBarSize={24}
                  radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  {spec.points.map((point, i) => (
                    <Cell
                      key={i}
                      fill={point.highlight ? `url(#${hatchId})` : palette.series1}
                      stroke={point.highlight ? palette.highlight : undefined}
                      strokeWidth={point.highlight ? 1 : 0}
                    />
                  ))}
                </Bar>
                {hasSecond && (
                  <Bar
                    dataKey="value2"
                    maxBarSize={24}
                    // Hatched on the opposite diagonal to the flagged bars, so
                    // the second series is not identified by its colour alone.
                    fill={`url(#${seriesTwoId})`}
                    stroke={palette.series2}
                    strokeWidth={1}
                    radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                )}
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* The tooltip was the only place `detail` and the unrounded figures
          appeared, and it opens on hover. This is the same data as a table, so
          it can be read, navigated cell by cell, and copied into a board paper
          without a mouse. Visually hidden because the chart above already says
          it to anyone who can see it. */}
      <table className="sr-only" id={tableId}>
        <caption>{spec.title}</caption>
        <thead>
          <tr>
            <th scope="col">{spec.xLabel}</th>
            <th scope="col">{seriesLabel}</th>
            {hasSecond && <th scope="col">{series2Label ?? 'Second series'}</th>}
            {hasNotes && <th scope="col">Notes</th>}
          </tr>
        </thead>
        <tbody>
          {spec.points.map((point, i) => (
            <tr key={i}>
              <th scope="row">{point.label}</th>
              <td>{formatValue(point.value, spec.unit)}</td>
              {hasSecond && (
                <td>
                  {typeof point.value2 === 'number'
                    ? formatValue(point.value2, spec.unit)
                    : 'Not applicable'}
                </td>
              )}
              {hasNotes && (
                <td>
                  {[point.highlight ? 'Flagged' : '', point.detail ?? '']
                    .filter(Boolean)
                    .join('. ')}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {legendEntries.length > 0 && (
        <div className="chart-legend">
          {legendEntries.map((entry) => (
            <span className="legend-item" key={entry.label}>
              <span
                className={`legend-swatch${entry.shape ? ` is-${entry.shape}` : ''}`}
                style={{ background: entry.fill ?? entry.color }}
              />
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
