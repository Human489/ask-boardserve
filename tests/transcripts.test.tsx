import test from 'node:test'
import assert from 'node:assert/strict'
import { swapTranscript } from '../src/components/Chat'
import type { Turn } from '../src/components/Message'
import type { ToolResult } from '../src/lib/types'

// Each dataset keeps its own conversation, for the same reason pins are keyed
// by dataset: prior answers' headlines are sent back to the model as routing
// context, so one shared transcript would route a question about one
// organisation while the model reads a sentence about another.

function answered(id: string, headline: string): Turn {
  const result: ToolResult = {
    tool: 'attendance_by_director',
    headline,
    chart: null,
    table: null,
    assumptions: [],
    caveats: [],
    provenance: { asAt: '2026-08-31', sources: ['attendance.json'], rowsConsidered: 1, derivation: 'test' },
  }
  return { id, question: `q-${id}`, status: 'answered', result, routedBy: 'model' }
}

test('a conversation is put aside and restored, not destroyed', () => {
  const store = new Map<string, Turn[]>()
  const orgA = [answered('a1', 'A finding about the first board')]

  // Swap A -> B: B has never been asked anything.
  const inB = swapTranscript(store, 'org-a', 'org-b', orgA)
  assert.deepEqual(inB, [])

  // Ask something under B, then swap back.
  const orgB = [answered('b1', 'A finding about the second board')]
  const backInA = swapTranscript(store, 'org-b', 'org-a', orgB)
  assert.deepEqual(
    backInA.map((t) => t.id),
    ['a1'],
    'switching back restores the conversation that was there',
  )
  assert.equal(backInA[0].result?.headline, 'A finding about the first board')
})

test('no turn ever crosses between datasets', () => {
  const store = new Map<string, Turn[]>()
  swapTranscript(store, 'org-a', 'org-b', [answered('a1', 'first board')])
  const inB = swapTranscript(store, 'org-b', 'org-b', [])
  // Same key both ways, so nothing is restored from A.
  assert.ok(
    !inB.some((t) => t.id === 'a1'),
    'a turn from one organisation must never appear under another',
  )
  assert.deepEqual(store.get('org-a')?.map((t) => t.id), ['a1'])
})

test('a question caught mid-flight does not come back as a permanent skeleton', () => {
  const store = new Map<string, Turn[]>()
  const pending: Turn = { id: 'p1', question: 'in flight', status: 'pending' }

  swapTranscript(store, 'org-a', 'org-b', [pending])
  const stashed = store.get('org-a') ?? []

  // Its answer will arrive keyed to a turn that is no longer on screen, so the
  // card would otherwise sit on a loading skeleton for ever.
  assert.equal(stashed[0].status, 'failed')
  assert.match(stashed[0].error?.message ?? '', /dataset changed/i)
})

test('answered turns are stashed unchanged', () => {
  const store = new Map<string, Turn[]>()
  const turn = answered('a1', 'unchanged')
  swapTranscript(store, 'org-a', 'org-b', [turn])
  assert.deepEqual(store.get('org-a'), [turn])
})
