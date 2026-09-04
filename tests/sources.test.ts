import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

// Regexes have twice been written into these sources with backslash-b escapes
// that were mangled into literal backspace characters by the editing tool.
// They typecheck, they build, and they can never match anything — a silently
// dead pattern. For a refusal rule that means it quietly stops refusing, which
// is the failure this project cares most about.

// Tests and scripts are scanned too. A word-boundary escape in this very suite was mangled
// into a literal backspace by an editing script, producing a guard that
// compiled, ran, and could never match — and the scan that exists to catch
// exactly that was only looking at src/. A broken assertion in a test is the
// worst place for this to hide, because the test still reports success.
const ROOTS = ['src/lib', 'src/app', 'src/components', 'tests', 'scripts']
// Everything below space except tab, newline and carriage return.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    // .mjs too: the smoke suite is the only coverage several routes have, and
    // it was outside this scan entirely — a mangled escape in one of its
    // regexes would silently stop a check from ever matching.
    else if (/\.(tsx?|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

// The markdown is scanned too. Writing the sentence "a template literal eats a
// backslash escape" into CLAUDE.md put two literal backspaces into that very
// sentence, and nothing here was looking at .md — so the file describing the
// failure demonstrated it instead, and would have been read by the next person
// as the correct spelling.
const DOCS = ['CLAUDE.md', 'README.md']

test('no source file contains a stray control character', () => {
  const offenders: string[] = []
  for (const doc of DOCS) {
    readFileSync(doc, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (CONTROL.test(line)) offenders.push(`${doc}:${i + 1}`)
      })
  }
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (CONTROL.test(line)) offenders.push(`${file}:${i + 1}`)
        })
    }
  }
  assert.deepEqual(offenders, [], `control characters found at ${offenders.join(', ')}`)
})

// CLAUDE.md: "Refusals must not claim data is absent when it is not. Say what
// no TOOL computes, not what the DATA lacks."
//
// That invariant was tested for the router's `reason` field and never for the
// copy a reader actually sees. Both the refusal card's status chip and its
// headline said the data could not answer — "Not answerable from this data"
// above "This question cannot be answered from the data available" — which is
// false whenever the dataset holds the figures and simply no tool computes
// that particular cut. Asking for a median rather than a mean is exactly that
// case: the numbers are all there.
//
// It also said the same thing three times before the reason added anything,
// which is how the wording survived review: it read as a house style.
const REFUSAL_COPY_ROOTS = ['src/lib', 'src/app', 'src/components']

// Built from character codes rather than typed. This file has had an escape
// mangled into a control character three times, and these are exactly the
// patterns that would go silently dead if it happened a fourth.
const NEWLINE = String.fromCharCode(10)
const SQ = String.fromCharCode(39)
const DQ = String.fromCharCode(34)
const BT = String.fromCharCode(96)
const STRING_PATTERNS = [
  SQ + '([^' + SQ + ']{12,})' + SQ,
  DQ + '([^' + DQ + ']{12,})' + DQ,
  BT + '([^' + BT + ']{12,})' + BT,
]

/** Phrasings that attribute the limit to the data rather than to the tools. */
const BLAMES_THE_DATA = [
  /cannot be answered from the data/i,
  /not answerable from this data/i,
  /the data (?:cannot|does not|doesn't|can't) answer/i,
  /no data (?:for|on) (?:this|that)/i,
  /data (?:is|are) not available for/i,
]

test('no user-facing refusal copy blames the data', () => {
  const found: string[] = []
  for (const root of REFUSAL_COPY_ROOTS) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8')
      const rel = file.slice(process.cwd().length + 1).split(sep).join('/')
      // Quoted strings only, scanned a line at a time.
      //
      // A comment may legitimately quote the banned wording: this suite has to
      // name what it forbids, and so does the commit that removed it. Only the
      // copy a reader can actually see is a finding.
      //
      // Matching per line rather than across the file keeps the pattern free of
      // a newline escape. The first version of this test carried one, an
      // editing step turned it into a literal newline, and the regex no longer
      // parsed — which is the exact failure the control-character test above
      // exists to catch, arrived at from a different direction.
      // ALL THREE DELIMITERS. This scanned single quotes only, so the same
      // banned wording written in a double-quoted string, a template literal,
      // or JSX text was invisible — and refusal copy here is routinely a
      // template literal, because it interpolates the organisation name. A
      // guard that reads a third of the strings it claims to check is worse
      // than none: it is believed. Found by external audit.
      for (const line of src.split(NEWLINE)) {
        for (const spelling of STRING_PATTERNS) {
          for (const quoted of line.matchAll(new RegExp(spelling, 'g'))) {
            for (const pattern of BLAMES_THE_DATA) {
              if (pattern.test(quoted[1])) found.push(`${rel}: ${quoted[1].slice(0, 80)}`)
            }
          }
        }
      }
    }
  }
  assert.deepEqual(
    found,
    [],
    'refusal copy must say what no analysis computes, not that the data lacks it:\n' +
      found.join('\n'),
  )
})

// A regex built from an ordinary template literal cannot carry a `\b`.
//
// Inside `` `...` `` the sequence is the BACKSPACE character, not a word
// boundary — so `new RegExp(`\b${word}\b`)` compiles, runs, and matches
// nothing, for ever. That is the same silent-dead-pattern failure the
// control-character test above exists for, but the scan cannot see it: the
// source holds a legitimate two-character escape and only becomes a backspace
// when the template is evaluated.
//
// It shipped here once, in the month filter for commitments, and the fix was
// to compare whole words instead of building a pattern at all.
test('no regex is built from a template literal carrying a backslash escape', () => {
  const found: string[] = []
  // ROOTS, not REFUSAL_COPY_ROOTS: this scanned src only, while this file's own
  // header says a mangled escape hiding in a TEST is the worst case, because
  // the test still reports success. The scan that exists for exactly that was
  // not looking at tests or scripts. Found by external audit.
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8')
      const rel = file.slice(process.cwd().length + 1).split(sep).join('/')
      for (const line of src.split('\n')) {
        // A RegExp constructed from a backtick string, where that string
        // contains a backslash escape and is not String.raw.
        // A comment may legitimately show the broken form: this suite has to
        // name what it forbids, and the comment above does. Only code counts —
        // the same rule the refusal-copy scan applies by reading quoted
        // strings alone. Without this, widening the scan to `tests` made the
        // guard fail on its own documentation.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
        if (!/new RegExp\(\s*`/.test(line)) continue
        if (/String\.raw/.test(line)) continue
        if (/\\[bdswWDSB]/.test(line)) found.push(`${rel}: ${line.trim().slice(0, 92)}`)
      }
    }
  }
  assert.deepEqual(
    found,
    [],
    'use String.raw, a literal regex, or compare words — a template literal eats the escape:\n' +
      found.join('\n'),
  )
})
