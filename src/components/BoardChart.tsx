'use client'

import { useEffect, useMemo, useState } from 'react'
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
interface Palette {
  series1: string
  series2: string
  highlight: string
  reference: string
  grid: string
  axis: string
  muted: string
}

const TOKENS: Record<keyof Palette, string> = {
  series1: '--series-1',
  series2: '--series-2',
  highlight: '--highlight',
  reference: '--reference',
  grid: '--grid',
  axis: '--axis',
  muted: '--ink-muted',
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
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', read)
    return () => mq.removeEventListener('change', read)
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

// --------------------------------------------------------------------- chart

export default function BoardChart({ spec }: { spec: ChartSpec }) {
  const palette = usePalette()
  const narrow = useIsNarrow()

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

  const legendEntries: { label: string; color: string }[] = []
  if (palette) {
    if (hasSecond) {
      legendEntries.push({ label: seriesLabel, color: palette.series1 })
      legendEntries.push({ label: series2Label ?? 'Second series', color: palette.series2 })
    }
    if (hasHighlight) {
      legendEntries.push({ label: 'Flagged', color: palette.highlight })
    }
  }

  const axisCaption = horizontal
    ? `${spec.xLabel} (vertical) · ${spec.yLabel} (horizontal)`
    : `${spec.xLabel} (horizontal) · ${spec.yLabel} (vertical)`

  return (
    <div className="chart-block">
      <p className="chart-title">{spec.title}</p>
      <p className="chart-axis-note">{axisCaption}</p>

      <div className="chart-frame" style={{ height }}>
        {palette && (
          <ResponsiveContainer width="100%" height="100%">
            {spec.kind === 'line' ? (
              <LineChart
                data={spec.points}
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
                    return (
                      <circle
                        key={`dot-${props.index}`}
                        cx={props.cx}
                        cy={props.cy}
                        r={flagged ? 5.5 : 4}
                        fill={flagged ? palette.highlight : palette.series1}
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
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={{ r: 4, fill: palette.series2, stroke: 'var(--surface)', strokeWidth: 2 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            ) : (
              <BarChart
                data={spec.points}
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
                      fill={point.highlight ? palette.highlight : palette.series1}
                    />
                  ))}
                </Bar>
                {hasSecond && (
                  <Bar
                    dataKey="value2"
                    maxBarSize={24}
                    fill={palette.series2}
                    radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                )}
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {legendEntries.length > 0 && (
        <div className="chart-legend">
          {legendEntries.map((entry) => (
            <span className="legend-item" key={entry.label}>
              <span className="legend-swatch" style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
