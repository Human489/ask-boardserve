// Turning a chart on screen into a PNG a secretary can put in a board pack.
//
// Three decisions worth stating, because each has a wrong answer that looks
// fine until the image is somewhere you cannot correct it.
//
// IT ALWAYS EXPORTS LIGHT. The app has a real dark theme and a reader working
// at night is in it — but a PNG goes into a document, and a dark chart in a
// board pack is wrong in a way the exporter cannot undo. So the light palette
// is read regardless of the theme on screen.
//
// NO WEBFONTS ARE EMBEDDED. The chart's own text is system-ui already, on
// screen and in this export, so nothing has to be inlined and nothing can
// silently fall back. That failure mode is not hypothetical here: the
// self-hosted faces were once served as the gate's HTML and the page fell back
// to Georgia, which still looks like a serif, so every screenshot looked
// right. An export that quietly loses its typeface would be the same bug
// somewhere nobody is looking. The footer takes a system mono stack for the
// same reason.
//
// NOTHING OF OURS IS BRANDED ONTO IT. The stamp names the ORGANISATION whose
// data it is, not this product. The reader is putting this in front of their
// own board; our wordmark on their attendance figures would be an advert in
// someone else's paper. Their own logo would be better still, and is recorded
// in CLAUDE.md as an idea — it needs somewhere to upload one, which is a
// feature and not a detail.

/** What the footer says, when there is one. */
export interface ExportFooter {
  /** The organisation the data belongs to, from the dataset. */
  organisation: string
  /**
   * The date the DATA describes, not when the file was made.
   *
   * "as at" is the governance register for exactly this — "balance as at 31
   * March" — and it is the term the whole app uses, because every figure here
   * is measured from `dataset.asAt` and never from a wall clock. The word
   * "Data" is prefixed so a reader cannot take it for an export timestamp,
   * which is the one genuine ambiguity in the phrase.
   */
  asAt: string
}

export interface ExportOptions {
  /** The chart's own title, drawn above the plot. */
  title: string
  /**
   * The recessed provenance stamp. Always present.
   *
   * Not optional, because a bare-chart option was considered and dropped: it
   * doubles the surface for something nobody asked for, and the safe choice
   * should not be the opt-in one.
   */
  footer: ExportFooter
  /** Pixel ratio. 2 so the text is not soft on a normal screen or in print. */
  scale?: number
}

const PAD = 22
const TITLE_SIZE = 14
const FOOTER_SIZE = 11
// SINGLE quotes inside the stacks, not double.
//
// These are interpolated straight into a double-quoted XML attribute when
// the title and the stamp are written below, so a nested double quote closes
// the attribute and malforms the whole document. The browser's only signal is
// that the <img> fails to load, which surfaced as "the chart could not be
// drawn as an image" with nothing to say why. Measured: the same SVG with
// double quotes fails to load and with single quotes loads.
//
// Single quotes are equally valid in a CSS font-family list, so nothing about
// the typography changes.
const SANS = 'system-ui, -apple-system, \'Segoe UI\', sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, \'SF Mono\', Menlo, monospace'

/** Tokens the export needs, always in their light values. */
interface Palette {
  surface: string
  ink: string
  ink2: string
  muted: string
  hairline: string
}

/**
 * Reads the LIGHT palette, whatever theme is on screen.
 *
 * The dark values are declared under a media query and under
 * `[data-theme='dark']`, both of which key off the root element — so the only
 * way to read the light values from a dark screen is to put the root in light
 * for the duration of the read. Synchronous, with no await in between, so the
 * browser never paints the intermediate state and the reader sees no flash.
 */
function lightPalette(root: HTMLElement): Palette {
  const previous = root.dataset.theme
  root.dataset.theme = 'light'
  const style = getComputedStyle(root)
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  const palette: Palette = {
    surface: read('--surface', '#ffffff'),
    ink: read('--ink', '#0f0905'),
    ink2: read('--ink-2', '#342c27'),
    muted: read('--ink-muted', '#6a615b'),
    hairline: read('--grid', '#e7e4e1'),
  }
  if (previous === undefined) delete root.dataset.theme
  else root.dataset.theme = previous
  return palette
}

/**
 * Copies the computed paint onto each node as attributes.
 *
 * A serialised SVG carries no stylesheet, so anything styled by a CSS class —
 * which is most of what recharts draws — comes out unpainted. Reading the
 * computed value and writing it as an attribute is what makes the clone
 * self-contained.
 */
const PAINTED = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
] as const

function inlinePaint(source: Element, clone: Element): void {
  const computed = getComputedStyle(source)
  for (const property of PAINTED) {
    const value = computed.getPropertyValue(property)
    if (value && value !== 'none' && value !== 'normal') {
      clone.setAttribute(property, value)
    }
  }
  // Explicit on every node, so nothing depends on inheritance surviving
  // serialisation. The chart is system-ui on screen too, so this changes
  // nothing about how it looks.
  if (clone.tagName === 'text' || clone.tagName === 'tspan') {
    clone.setAttribute('font-family', SANS)
  }

  const sourceChildren = Array.from(source.children)
  const cloneChildren = Array.from(clone.children)
  for (let i = 0; i < sourceChildren.length && i < cloneChildren.length; i++) {
    inlinePaint(sourceChildren[i], cloneChildren[i])
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Builds the composed SVG: title, the chart, and an optional footer.
 *
 * The chart is nested as its own <svg> rather than having its coordinates
 * rewritten, so nothing about the plot's geometry is recalculated here and the
 * exported chart cannot disagree with the one on screen.
 */
function composeSvg(
  chart: SVGSVGElement,
  options: ExportOptions,
  palette: Palette,
): { svg: string; width: number; height: number } {
  const rect = chart.getBoundingClientRect()
  const chartWidth = Math.max(1, Math.round(rect.width))
  const chartHeight = Math.max(1, Math.round(rect.height))

  const clone = chart.cloneNode(true) as SVGSVGElement
  inlinePaint(chart, clone)
  clone.setAttribute('width', String(chartWidth))
  clone.setAttribute('height', String(chartHeight))
  clone.removeAttribute('style')

  const titleBlock = options.title ? TITLE_SIZE + 12 : 0
  const footerBlock = FOOTER_SIZE + 20
  const width = chartWidth + PAD * 2
  const height = titleBlock + chartHeight + footerBlock + PAD * 2

  const inner = new XMLSerializer().serializeToString(clone)

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${palette.surface}"/>`,
  ]

  if (options.title) {
    parts.push(
      `<text x="${PAD}" y="${PAD + TITLE_SIZE}" font-family="${SANS}" font-size="${TITLE_SIZE}" ` +
        `font-weight="600" fill="${palette.ink2}">${escapeXml(options.title)}</text>`,
    )
  }

  parts.push(`<g transform="translate(${PAD}, ${PAD + titleBlock})">${inner}</g>`)

  const y = PAD + titleBlock + chartHeight + 14
  // Recessed on purpose: it is a provenance stamp, not a caption. Muted ink, a
  // hairline above it, and the smallest type in the image — present for the
  // reader who checks, quiet for the reader who does not.
  //
  // The organisation is omitted rather than left as an empty separator when it
  // is unknown, which is the local-dataset case.
  const stamp = options.footer.organisation
    ? `${options.footer.organisation} · Data as at ${options.footer.asAt}`
    : `Data as at ${options.footer.asAt}`
  parts.push(
    `<line x1="${PAD}" y1="${y - 10}" x2="${width - PAD}" y2="${y - 10}" ` +
      `stroke="${palette.hairline}" stroke-width="1"/>`,
    `<text x="${PAD}" y="${y + FOOTER_SIZE - 2}" font-family="${MONO}" font-size="${FOOTER_SIZE}" ` +
      `fill="${palette.muted}">${escapeXml(stamp)}</text>`,
  )

  parts.push('</svg>')
  return { svg: parts.join(''), width, height }
}

/** Rasterises the composed SVG. Rejects rather than producing a blank image. */
export async function chartToPngBlob(
  chart: SVGSVGElement,
  options: ExportOptions,
): Promise<Blob> {
  const root = document.documentElement
  const palette = lightPalette(root)
  const { svg, width, height } = composeSvg(chart, options, palette)
  const scale = options.scale ?? 2

  // A data URL rather than a blob URL: a blob URL taints the canvas in some
  // browsers, and a tainted canvas throws on toBlob — which would surface as
  // an export that silently produced nothing.
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  const image = new Image()
  image.decoding = 'sync'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The chart could not be drawn as an image.'))
    image.src = encoded
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not prepare an image.')
  context.setTransform(scale, 0, 0, scale, 0, 0)
  // Painted rather than left transparent: a transparent PNG dropped onto a
  // dark slide would render the ink invisible.
  context.fillStyle = palette.surface
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('The image could not be encoded.'))
    }, 'image/png')
  })
}

/** A filename a reader can find again: the chart, the organisation, the date. */
export function exportFilename(title: string, footer: ExportFooter): string {
  const slug = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
  const parts = [slug(title) || 'chart']
  if (footer.organisation) parts.push(slug(footer.organisation))
  if (footer.asAt) parts.push(footer.asAt)
  return `${parts.join('-')}.png`
}
