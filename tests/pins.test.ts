import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { addPin, listPins, MAX_PINS, pinKey, removePin, replacePin, resetPins } from '../src/lib/pins'
import type { Pin } from '../src/lib/pins'
import type { ToolResult } from '../src/lib/types'

// These run against the in-memory layer, which is the path taken whenever KV is
// unconfigured. The KV path is the same code with a different write target.
//
// The credentials are cleared explicitly rather than relied on being absent: if
// a real namespace were configured in the environment, this suite would write
// its fixtures into the live dashboard and the durability test would fail for a
// reason that has nothing to do with the code.
delete process.env.CF_KV_NAMESPACE_ID
delete process.env.CF_ACCOUNT_ID
delete process.env.CF_API_TOKEN

// Pins are stored per dataset, so every call names one.
const DS = 'test-dataset'

function result(headline: string): ToolResult {
  return {
    tool: 'attendance_by_director',
    headline,
    chart: null,
    table: null,
    assumptions: [],
    caveats: [],
    provenance: {
      asAt: '2026-03-31',
      sources: ['attendance.json'],
      rowsConsidered: 10,
      derivation: 'test',
    },
  }
}

function pin(id: string, args: Record<string, unknown> = {}): Pin {
  return {
    id,
    question: `question ${id}`,
    tool: 'attendance_by_director',
    args,
    result: result(`headline ${id}`),
    routedBy: 'model',
    pinnedAt: '2026-09-02T10:00:00.000Z',
    datasetAsAt: '2026-03-31',
  }
}

test('a pin is stored and read back newest first', async () => {
  resetPins()
  await addPin(DS, pin('a', { body: 'Board' }))
  await addPin(DS, pin('b', { body: 'Audit' }))
  const { pins } = await listPins(DS)
  assert.deepEqual(
    pins.map((p) => p.id),
    ['b', 'a'],
  )
})

test('pins are not durable when KV is unconfigured, and say so', async () => {
  resetPins()
  const { durable } = await listPins(DS)
  // The UI tells the reader their pins are only held in memory. If this ever
  // reports true without KV, that warning silently disappears.
  assert.equal(durable, false)
})

test('the same analysis cannot be pinned twice', async () => {
  resetPins()
  await addPin(DS, pin('a', { threshold: 80 }))
  const second = await addPin(DS, pin('b', { threshold: 80 }))
  assert.equal(second.ok, false)
  assert.equal(second.ok === false && second.reason, 'duplicate')
  const { pins } = await listPins(DS)
  assert.equal(pins.length, 1)
})

test('the same tool with different arguments is a different pin', async () => {
  resetPins()
  await addPin(DS, pin('a', { threshold: 80 }))
  const second = await addPin(DS, pin('b', { threshold: 75 }))
  assert.equal(second.ok, true)
  const { pins } = await listPins(DS)
  assert.equal(pins.length, 2)
})

test('the dashboard refuses a pin past its cap rather than dropping the oldest', async () => {
  resetPins()
  for (let i = 0; i < MAX_PINS; i++) {
    const outcome = await addPin(DS, pin(`p${i}`, { n: i }))
    assert.equal(outcome.ok, true, `pin ${i} fits`)
  }
  const overflow = await addPin(DS, pin('one-too-many', { n: MAX_PINS }))
  assert.equal(overflow.ok, false)
  assert.equal(overflow.ok === false && overflow.reason, 'full')
  // Silently evicting the oldest pin would lose something the reader chose to
  // keep. The cap is reported instead.
  const { pins } = await listPins(DS)
  assert.equal(pins.length, MAX_PINS)
  assert.ok(pins.some((p) => p.id === 'p0'))
})

test('removing a pin leaves the rest in order', async () => {
  resetPins()
  await addPin(DS, pin('a', { n: 1 }))
  await addPin(DS, pin('b', { n: 2 }))
  await addPin(DS, pin('c', { n: 3 }))
  const outcome = await removePin(DS, 'b')
  assert.equal(outcome.ok, true)
  const { pins } = await listPins(DS)
  assert.deepEqual(
    pins.map((p) => p.id),
    ['c', 'a'],
  )
})

test('removing a pin that is not there reports not-found', async () => {
  resetPins()
  await addPin(DS, pin('a'))
  const outcome = await removePin(DS, 'nope')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.reason, 'not-found')
})

test('removing the last pin empties the dashboard', async () => {
  resetPins()
  await addPin(DS, pin('a'))
  const outcome = await removePin(DS, 'a')
  assert.equal(outcome.ok, true)
  const { pins } = await listPins(DS)
  assert.equal(pins.length, 0)
})

test('refreshing replaces a snapshot in place, keeping its position', async () => {
  resetPins()
  await addPin(DS, pin('a', { n: 1 }))
  await addPin(DS, pin('b', { n: 2 }))
  await addPin(DS, pin('c', { n: 3 }))

  const { pins: before } = await listPins(DS)
  const target = before.find((p) => p.id === 'b')!
  const outcome = await replacePin(DS, 'b', {
    ...target,
    result: result('refreshed headline'),
    refreshedAt: '2026-09-02T12:00:00.000Z',
  })
  assert.equal(outcome.ok, true)

  const { pins } = await listPins(DS)
  // Position matters: a refreshed card jumping to the top of the dashboard
  // would look like a new pin.
  assert.deepEqual(
    pins.map((p) => p.id),
    ['c', 'b', 'a'],
  )
  const refreshed = pins.find((p) => p.id === 'b')!
  assert.equal(refreshed.result.headline, 'refreshed headline')
  assert.equal(refreshed.refreshedAt, '2026-09-02T12:00:00.000Z')
  // The question and the analysis are unchanged — a refresh is the same card.
  assert.equal(refreshed.question, target.question)
  assert.deepEqual(refreshed.args, target.args)
})

test('refreshing a pin that is not there reports not-found', async () => {
  resetPins()
  const outcome = await replacePin(DS, 'nope', pin('nope'))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.reason, 'not-found')
})

test('the pin route computes the frozen result rather than trusting the client', () => {
  // The governing rule is that no figure on screen was produced outside a tool.
  // A pin is a figure on screen, so the route must run the tool itself; reading
  // `result` from the request body would put an unverified number on the
  // dashboard.
  //
  // This assertion was previously pinned to the literal text
  // `definition.run(dataset, args)` and matched destructuring with `[^}]*`.
  // Both were brittle in the worst way: adding a default value inside a
  // destructuring pattern stopped that block being inspected at all, while the
  // test still passed on the remaining blocks. It now checks the property.
  const source = readFileSync('src/app/api/pins/route.ts', 'utf8')

  // Brace-balanced, so a `= {}` default inside the pattern cannot terminate the
  // block early and hide what follows it.
  const blocks: string[] = []
  const marker = /(?:const|let)\s*\{/g
  for (let m = marker.exec(source); m; m = marker.exec(source)) {
    let depth = 1
    let i = m.index + m[0].length
    const from = i
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    const inner = source.slice(from, i - 1)
    const tail = source.slice(i, i + 40)
    if (/=\s*\(?\s*body/.test(tail) || /body\s*\?\?/.test(tail)) blocks.push(inner)
  }

  assert.ok(blocks.length > 0, 'the route destructures its request body somewhere')
  for (const inner of blocks) {
    assert.ok(
      !/\bresult\b/.test(inner),
      'the pins route must never take "result" from the request body',
    )
  }

  // Destructuring is not the only way to read a field, so forbid any single
  // expression that pulls `result` straight off the body too.
  assert.ok(
    !/body[^\n;]*\.\s*result\b/.test(source),
    'the pins route must not read `result` off the request body',
  )

  // And the tool must actually run server-side, however its arguments are
  // wrapped on the way in.
  assert.match(source, /definition\.run\(\s*dataset\s*,/)
})

test('the same analysis is one pin however its arguments are ordered', async () => {
  // The arguments come back from a model as a JSON object, and key order is not
  // guaranteed to repeat. Keying on the raw stringification made {body, from}
  // and {from, body} different pins: the dashboard would end up with two cards
  // showing identical figures, and the Pin button would offer to pin something
  // already on it.
  resetPins()
  const first = { ...pin('a'), args: { body: 'Board', from: '2026-01-01' } }
  const second = { ...pin('b'), args: { from: '2026-01-01', body: 'Board' } }

  assert.equal(
    pinKey(first.tool, first.args),
    pinKey(second.tool, second.args),
    'key order must not change the identity of an analysis',
  )

  await addPin(DS, first)
  const duplicate = await addPin(DS, second)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.ok === false && duplicate.reason, 'duplicate')
  assert.equal((await listPins(DS)).pins.length, 1)
})

test('genuinely different arguments remain different pins', async () => {
  resetPins()
  await addPin(DS, { ...pin('a'), args: { body: 'Board' } })
  const other = await addPin(DS, { ...pin('b'), args: { body: 'Audit' } })
  assert.equal(other.ok, true)
  assert.equal((await listPins(DS)).pins.length, 2)
})

test('an absent argument and an explicitly empty one are the same pin', () => {
  // Otherwise the duplicate check misses, and the dashboard shows two
  // identical cards each with its own Refresh button.
  assert.equal(pinKey('attendance_by_body', {}), pinKey('attendance_by_body', { body: undefined }))
  assert.equal(
    pinKey('attendance_by_body', { body: 'Board' }),
    pinKey('attendance_by_body', { body: 'Board', threshold: undefined }),
  )
  // Real arguments must still separate pins, or Refresh would recompute the
  // wrong question.
  assert.notEqual(
    pinKey('attendance_by_body', { body: 'Board' }),
    pinKey('attendance_by_body', { body: 'People' }),
  )
  // And a defaulted value is still NOT equal to the absent one, which is the
  // half of this deliberately left alone.
  assert.notEqual(
    pinKey('attendance_by_body', {}),
    pinKey('attendance_by_body', { threshold: 80 }),
  )
})
