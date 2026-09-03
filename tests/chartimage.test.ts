import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { exportFilename, type ExportFooter } from '../src/lib/chartimage'

// The rasterising itself needs a DOM — getComputedStyle, getBoundingClientRect,
// canvas — so it is verified in a browser instead, where the produced PNG was
// decoded and its pixels counted rather than its preview eyeballed.
//
// What IS testable here is the part that broke, and the part that names the
// file a secretary has to find again.

const footer: ExportFooter = {
  organisation: 'St Ambrose Hospice Care',
  asAt: '2026-08-31',
}

test('a font stack interpolated into an XML attribute carries no double quote', () => {
  // The bug this exists for. The stacks are written straight into
  // font-family="..." when the title and the stamp are composed, so a nested
  // double quote closes the attribute and malforms the whole SVG. The only
  // signal is that the <img> fails to load, which surfaced to the reader as
  // "The chart could not be drawn as an image" with nothing to say why.
  //
  // Measured in a browser at the time: the same SVG with double quotes failed
  // to load and with single quotes loaded. Single quotes are equally valid in
  // a CSS font-family list, so nothing about the typography changes.
  const source = readFileSync('src/lib/chartimage.ts', 'utf8')
  const stacks = [...source.matchAll(/^const (SANS|MONO) = (.+)$/gm)]
  assert.equal(stacks.length, 2, 'both font stacks should be found')

  for (const [, name, value] of stacks) {
    assert.ok(
      !value.includes('\\"') && !value.includes('"'),
      `${name} must not contain a double quote: ${value}`,
    )
    assert.match(value, /Segoe UI|SF Mono/, `${name} should still name its fallbacks`)
  }
})

test('the filename says which chart, whose data, and as at when', () => {
  // A secretary exports several of these into one folder. "chart.png" and
  // "chart (1).png" is the failure mode.
  const name = exportFilename('Attendance below 80%', footer)
  assert.equal(name, 'attendance-below-80-st-ambrose-hospice-care-2026-08-31.png')
})

test('the filename survives punctuation, spacing and length', () => {
  const messy = exportFilename('  Who is below?  Attendance / committees — 2026  ', footer)
  assert.match(messy, /^[a-z0-9-]+\.png$/, 'only safe characters reach the filesystem')
  assert.ok(!messy.includes('--'), 'no doubled separators')
  assert.ok(!messy.startsWith('-'), 'no leading separator')

  const long = exportFilename('a'.repeat(200), footer)
  assert.ok(long.length < 130, `too long for comfort: ${long.length}`)
})

test('an unnamed chart still produces a usable filename', () => {
  assert.equal(exportFilename('', footer), 'chart-st-ambrose-hospice-care-2026-08-31.png')
  // Symbols alone slug to nothing, which must not leave a bare separator.
  assert.equal(exportFilename('%%%', footer), 'chart-st-ambrose-hospice-care-2026-08-31.png')
})

test('an unknown organisation is left out rather than guessed', () => {
  // The local-dataset case: nothing was uploaded, so no organisation is known.
  // A wrong name on an exported chart would be worse than no name.
  const name = exportFilename('Attendance below 80%', { organisation: '', asAt: '2026-08-31' })
  assert.equal(name, 'attendance-below-80-2026-08-31.png')
  assert.ok(!name.includes('--'), 'no gap where the organisation would have been')
})
