---
name: Ask BoardServe
description: BoardServe's own visual system, carried into a product whose whole subject is whether a figure can be trusted.
colors:
  plane: "#faf8f6"
  surface: "#ffffff"
  surface-sunken: "#f2f0ed"
  ink: "#0f0905"
  ink-2: "#342c27"
  ink-muted: "#6a615b"
  hairline-strong: "#8a827b"
  grid: "#e7e4e1"
  axis: "#8a827b"
  accent: "#006b58"
  accent-ink: "#ffffff"
  accent-tint: "#e8f3f0"
  series-1: "#256cc4"
  series-2: "#2a9d7f"
  highlight: "#8f1d1d"
  reference: "#6a615b"
  refusal-bg: "#eff6ff"
  refusal-ink: "#1d4ed8"
  error-bg: "#fef2f2"
  error-ink: "#b91c1c"
  notice-bg: "#f4f1ee"
  focus: "#006b58"
  selection: "#cfe9e1"
typography:
  display:
    fontFamily: "Instrument Serif, Charter, Iowan Old Style, Georgia, serif"
    fontSize: "23px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "-0.011em"
  headline:
    fontFamily: "Instrument Serif, Charter, Iowan Old Style, Georgia, serif"
    fontSize: "25px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Instrument Serif, Charter, Iowan Old Style, Georgia, serif"
    fontSize: "21px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "tabular-nums"
  label:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.14em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "16px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "22px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 18px"
    height: "44px"
  button-primary-inactive:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  input-composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 13px"
    height: "44px"
  card-answer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "22px 24px"
  nav-tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
---

# Design System: Ask BoardServe

## Overview

**Creative North Star: "The Minuted Record"**

This looks the way a well-kept board minute looks. The serif states what was
found; the sans explains it; the mono measures it. Margins are generous, the
page is quiet, and nothing is decorated — because the reader is a company
secretary who will copy a figure off this screen into a paper that carries
their name. The aesthetic job is not to impress them. It is to look like
something that can be checked.

The palette and the typefaces are BoardServe's own, taken from
boardserve.co.uk so this reads as part of that product rather than a neighbour
of it: the warm off-white ground, the warm near-black ink, the deep green
primary, Instrument Serif over a system sans with Geist Mono for data. Where
this system departs from the parent, it is because a marketing page and a
working tool have different obligations — the parent's `--border` is a
1.11:1 divider, and here the same value would be the only boundary of a text
field. Those departures are listed in `## Colors` rather than hidden.

The register to avoid is the analytics dashboard: the tile grid of big numbers,
the sparkline standing in for a finding, the progress ring. This product exists
because a fixed dashboard could not answer the question, so looking like one
would be a lie about what it does. There is one chart per answer, at the size
the answer needs, with the sentence above it.

**Key Characteristics:**

- One serif sentence carries the finding; everything explaining it is sans.
- Mono is reserved for measurement — labels, provenance, figures — never for
  atmosphere.
- Flat surfaces separated by hairlines, with one soft card shadow.
- Green is the interface; blue and oxblood are the data.
- Every colour pair in the system was contrast-computed, and the numbers are
  written into `globals.css` beside the tokens.

## Colors

Warm neutrals under a single deep green, with the chart palette held apart from
the interface palette so brand colour can never be mistaken for data.

### Primary

- **Boardroom Green** (`#006b58`): BoardServe's own primary. Every interactive
  affordance and nothing else — the send button, the gate's Continue, the focus
  ring, the active tab. White on it measures 6.47:1. It is deliberately absent
  from every chart.
- **Green Wash** (`#e8f3f0`): the parent brand's pale tint, used for accent
  grounds and as the light-theme text selection.

### Neutral

- **Warm Paper** (`#faf8f6`): the page ground, and the composer's own
  background so the input area reads as part of the page rather than a bar
  stuck to it.
- **Card White** (`#ffffff`): every answer card, chart ground and example.
- **Sunken Linen** (`#f2f0ed`): table header rows and inset areas. The darkest
  ground any small text lands on, which is why muted ink is measured against
  it rather than against white.
- **Warm Black** (`#0f0905`): body ink, 19.78:1 on card white.
- **Umber** (`#342c27`): secondary prose — assumptions, caveats, example text.
- **Stone** (`#6a615b`): provenance, axis captions and every small label.
  5.31:1 on Sunken Linen, which is the number that set it.
- **Boundary Grey** (`#8a827b`): the visible edge of the composer, the passcode
  field and the chart axis. 3.32:1 at worst.
- **Divider** (`#e7e4e1`): BoardServe's `--border` value, kept for decoration
  only — gridlines and callout edges.

### Tertiary — the data palette

Held separate from the interface, and chosen for separation in **greyscale**
rather than only for contrast against the card.

- **Series Blue** (`#256cc4`): the primary series. 5.22:1.
- **Series Teal** (`#2a9d7f`): the second series. 3.37:1.
- **Oxblood** (`#8f1d1d`): the flagged mark. 8.89:1, the darkest of the three.
- **Reference Stone** (`#6a615b`): threshold and reference lines, dashed.

### Named Rules

**The Green-Is-Not-Data Rule.** `#006b58` never appears inside a chart. It is
the colour of things you can click. A reader who sees green has found a
control, not a value. This is why the second series is a lighter teal rather
than the brand green: it has to be a different thing.

**The Greyscale Rule.** Any two marks that can appear in one chart must differ
in luminance, not merely in hue. A pair that passes contrast against the card
and fails against each other in greyscale is a failure. The light trio sits at
3.37 / 5.22 / 8.89 and the dark trio at 4.75 / 6.36 / 10.16, roughly 1.6x
apart at each step. An earlier draft had the second series and the flagged mark
both at 6.47:1 — each fine alone, identical in monochrome.

**The Parent-Brand-Is-Not-Exempt Rule.** BoardServe's values are adopted unless
they would fail an obligation this product has and the marketing site does not.
`--border` at 1.11:1 is the live case: kept for dividers, replaced by
`#8a827b` wherever it is the only boundary of a control. Divergence is recorded
in a comment beside the token, with the measured ratio.

## Typography

**Display Font:** Instrument Serif (with Charter, Iowan Old Style, Georgia)
**Body Font:** system-ui (with -apple-system, Segoe UI)
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** A high-contrast editorial serif over a neutral system sans, with
a mono that reads as instrumentation. The serif is doing the same work here as
on boardserve.co.uk — it makes a sentence feel stated rather than generated,
which matters in a product where a sentence is a finding.

Both self-hosted, latin subsets only, `font-display: swap`. The app is opened
live in meetings; a third-party font request is a dependency nobody chose.

### Hierarchy

- **Display / Finding** (400, 23px, 1.3, -0.011em, max 46ch): the one sentence
  that states what was found. The only body copy in the serif.
- **Headline / Lede** (400, 25px, 1.2, -0.015em): the first line of an empty
  screen — the Ask view's opening, the gate's title.
- **Title / Wordmark** (400, 21px, 1.1, -0.02em): the masthead.
- **Body** (400, 15px, 1.55, tabular figures): everything explanatory.
  Assumptions, caveats, table cells, example questions. Capped at 72ch inside
  the card.
- **Label** (500, 10–11px, 0.10–0.14em, uppercase, mono): section labels,
  provenance field names, chart legends. Never a sentence.

### Named Rules

**The One Serif Sentence Rule.** Exactly one sentence per answer is set in the
display face, and it is the finding. Card titles, table headers, axis labels
and caveats stay sans. A dashboard of serif headings reads as a magazine; a
single serif sentence reads as a conclusion.

**The No-Faux-Bold Rule.** Instrument Serif ships at 400 only. Never ask for
600 — the browser synthesises a bold that smears the stems of a face whose
thin-thick contrast is the entire reason it was chosen. Presence comes from
size and tighter tracking, which is how the parent brand sets it (-1.5px at
60px).

**The Mono-Means-Measured Rule.** Geist Mono is for labels, provenance and
figures — things that were counted. It is never used to make prose look
technical. The test: if the text is a sentence, it is not mono.

## Layout

A single centred column, 780px at its widest, with prose capped at 72ch inside
it and the finding sentence at 46ch — deliberately narrower than its own card,
so the eye returns quickly on the line that matters most.

Three regions stack: masthead, scrolling answer region, composer pinned below.
The composer takes the page ground rather than the card white, so it reads as
part of the page. Example questions use `repeat(auto-fit, minmax(300px, 1fr))`,
which is two columns on a desk and one on a phone with no breakpoint declared.

Spacing runs 6 / 10 / 14 / 22 / 28. Tight inside a group — a label 5px above
its list — and generous between them, with more space above a heading than
below it. At the 640px breakpoint the card padding drops to 18px 16px and the
finding steps from 23px to 20px; nothing else moves.

## Elevation & Depth

Flat, with one exception. Depth comes from tonal layering — page ground, card
white, sunken linen — and from hairlines, not from shadow. Surfaces do not
lift on hover; borders and text colour change instead.

The single shadow is BoardServe's own card cast: a real offset with a soft
blur, at 6% opacity. It says "this is a sheet on a surface", not "this is
floating".

### Shadow Vocabulary

- **Card** (`0 2px 8px rgba(23, 20, 18, 0.06)`): answer cards and pinned
  cards. The only shadow at rest anywhere in the product.
- **Tooltip** (`0 4px 14px rgba(23, 20, 18, 0.14)`): chart tooltips only,
  which genuinely float above the plane.

In dark, a black shadow is invisible on a near-black ground, so the card cast
drops to `0 1px 2px rgba(0,0,0,0.3)` and separation is carried by the lift in
surface tone plus the hairline.

### Named Rules

**The Flat-At-Rest Rule.** No shadow appears as a response to hover. If an
element needs to respond, it changes its border colour or its ink. The two
shadows in the system describe what a thing *is*, not what the pointer is
doing.

## Shapes

Two radii, chosen by size of surface, not per component: 8px for controls and
small containers, 16px for the one large card. 6px for the smallest controls
where 8px reads soft at that scale. Nothing else.

Every boundary is a 1px hairline. There are no thick borders, no coloured
left-edges, and no rules heavier than 1px anywhere — a callout is separated by
its tint and a hairline, never by a bar down its side.

The one drawn form in the system is the diagonal hatch on a flagged chart mark:
a real SVG pattern, because colour may never be the only carrier of meaning.

## Components

### Buttons

- **Shape:** gently rounded (8px; 6px on the gate, where the control is
  smaller).
- **Primary:** Boardroom Green ground, white label, 44px tall, `0 18px`
  padding, weight 600 in the sans. The send button and the gate's Continue.
- **Hover:** `filter: brightness(1.06)`. No lift, no shadow.
- **Inactive:** `aria-disabled` with `opacity: 0.45`, never the `disabled`
  attribute — the field holds focus at the moment it would be disabled, and
  disabling a focused element drops focus to the document.
- **Quiet:** card-white ground, umber ink, hairline border. Example questions
  and Pin to dashboard. Hover shifts border and ink only.

### Cards / Containers

- **Corner Style:** 16px for the answer card, 8px for examples and small
  containers.
- **Background:** Card White on Warm Paper.
- **Shadow Strategy:** the Card cast only; see Elevation.
- **Border:** 1px hairline at 10% ink.
- **Internal Padding:** 22px 24px, dropping to 18px 16px under 640px.

### Inputs / Fields

- **Style:** card-white ground, 1px Boundary Grey border, 8px radius,
  `10px 13px` padding, 44px minimum height. The border is at 3:1 because it is
  the field's only boundary.
- **Focus:** the border becomes Boardroom Green, plus the global 2px focus ring
  at 2px offset. Two signals, because the border shift alone is a hue change.
- **Disabled / read-only:** `opacity: 0.6`. The composer goes read-only rather
  than disabled while a question is in flight, to keep focus.

### Navigation

- **Style:** a three-tab group — Ask, Dashboard, Data — as 30px pills, 4px
  radius, transparent until active. Sans, 13px, weight 500, umber ink.
- **Active:** marked with `aria-current`, card-white ground and a hairline, so
  the state is in the accessibility tree and not only in the paint.
- **Mobile:** unchanged. Three short words fit at 375px.

### Chart

The signature component, and the reason the palette is split.

- One chart per answer, bar or line only.
- Series take Series Blue then Series Teal; the flagged mark takes Oxblood
  **and** a diagonal hatch. The hatch is the second signal required by the
  product's accessibility commitment, and it is drawn as an SVG pattern
  returned from a `<defs>` element — not from a function component, which
  recharts silently drops.
- Threshold and reference lines are dashed in Reference Stone and always
  labelled with their value.
- Axis lines and captions are at 3:1 and 4.5:1 respectively; gridlines are
  decorative and quieter.
- Figures everywhere use tabular numerals, because they are read off the screen
  and typed into board papers by hand.

### Provenance Block

Under every answer, without a disclosure: as-at date, sources, rows considered,
derivation. Mono uppercase field names in a two-column grid, Stone ink at
11.5px. It is small but never hidden — the product's second principle is that
the reader is accountable for what they repeat.

## Do's and Don'ts

### Do:

- **Do** put exactly one serif sentence on an answer, and make it the finding.
- **Do** keep `#006b58` out of every chart. Green means clickable.
- **Do** check any new chart colour for luminance separation against the marks
  it can appear beside, not just for contrast against the card.
- **Do** write the measured contrast ratio into a comment beside any new colour
  token, as every existing token does.
- **Do** give a flagged or otherwise meaningful mark a second, non-colour
  signal — a hatch, a label, a shape.
- **Do** use `--radius` (8px) for controls and `--radius-lg` (16px) for the
  large card, rather than introducing a third value.
- **Do** use tabular numerals for anything a reader might copy.
- **Do** state a threshold's value wherever its line is drawn.

### Don't:

- **Don't** set Instrument Serif at any weight but 400. There is no bold file;
  the browser will fake one badly.
- **Don't** use mono for prose. It is for things that were counted.
- **Don't** add a third shadow, or a shadow on hover. Hover changes border and
  ink.
- **Don't** use a coloured `border-left` to mark a callout. Tint plus a 1px
  hairline, as the existing callouts do.
- **Don't** adopt BoardServe's `#e7e4e1` as the boundary of a control. It
  measures 1.11:1 on the sunken surface; it is a divider only.
- **Don't** build the answer area as a grid of equal tiles with big numbers.
  That is the dashboard this product exists to complement, and looking like it
  misrepresents what the product does.
- **Don't** put a kicker or eyebrow above a heading. The parent's landing page
  has one; a working tool does not need a label above its own title.
- **Don't** hard-code any organisation's name, committee, skill or figure into
  a style or a string. A test greps `src/lib` for exactly this, comments
  included.
