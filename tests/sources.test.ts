import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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

test('no source file contains a stray control character', () => {
  const offenders: string[] = []
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
