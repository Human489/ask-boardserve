import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CONVERSATIONS,
  MAX_TURNS,
  listConversations,
  removeConversation,
  resetConversations,
  saveConversation,
  parseStored,
  summarise,
  titleFrom,
  type StoredTurn,
} from '../src/lib/conversations'
import type { AnswerResult } from '../src/lib/types'

// These run with KV unconfigured, so they exercise the in-memory fallback —
// which is the path local development actually uses. The KV path differs only
// in where the same JSON lands.

function turn(question: string, headline = 'a computed headline'): StoredTurn {
  const result = {
    tool: 'attendance_below_threshold',
    headline,
    chart: null,
    table: null,
    assumptions: [],
    caveats: [],
    provenance: {
      asAt: '2026-08-31',
      sources: ['attendance.json'],
      rowsConsidered: 1,
      derivation: 'test',
    },
  } as unknown as AnswerResult
  return { id: `t-${question.length}-${headline.length}`, question, result }
}

// A fixed clock, because ordering is by updatedAt and a real one gives two
// writes in the same millisecond the same stamp.
function clockFrom(start: number): () => string {
  let n = start
  return () => new Date((n += 1000)).toISOString()
}

test('a new conversation is created and read back', async (t) => {
  t.beforeEach(() => resetConversations())
  resetConversations()

  const saved = await saveConversation('ds', { id: 'c1', turns: [turn('Who is overdue?')] })
  assert.ok(saved.ok)
  assert.equal(saved.conversations.length, 1)
  assert.equal(saved.conversations[0].id, 'c1')

  const store = await listConversations('ds')
  assert.equal(store.conversations.length, 1)
  assert.equal(store.conversations[0].turns.length, 1)
  // KV is unconfigured here, and the caller has to be able to say so rather
  // than implying the history is saved.
  assert.equal(store.durable, false)
  assert.equal(store.reachable, true)
})

test('conversations are scoped per dataset', async () => {
  // The reason transcripts were keyed by dataset in the first place: routing
  // context is fed back to the model, so one shared history would refine a
  // question about one organisation against a sentence about another.
  resetConversations()
  await saveConversation('org-a', { id: 'a1', turns: [turn('A question')] })
  await saveConversation('org-b', { id: 'b1', turns: [turn('B question')] })

  const a = await listConversations('org-a')
  const b = await listConversations('org-b')
  assert.deepEqual(
    a.conversations.map((c) => c.id),
    ['a1'],
  )
  assert.deepEqual(
    b.conversations.map((c) => c.id),
    ['b1'],
  )
  // And switching back restores rather than destroys.
  assert.equal(a.conversations[0].turns[0].question, 'A question')
})

test('the title comes from the first question and then stops moving', async () => {
  // A title that followed the LATEST question would rename a conversation
  // under the reader as they used it, so the entry they were about to click is
  // no longer the one they were looking for.
  resetConversations()
  const first = await saveConversation('ds', { id: 'c1', turns: [turn('Who is below the threshold?')] })
  assert.ok(first.ok)
  assert.equal(first.conversations[0].title, 'Who is below the threshold')

  const second = await saveConversation('ds', {
    id: 'c1',
    turns: [turn('Who is below the threshold?'), turn('Now just Q3')],
  })
  assert.ok(second.ok)
  assert.equal(second.conversations[0].title, 'Who is below the threshold')
})

test('titleFrom trims without cutting a word in half', () => {
  assert.equal(titleFrom('Short one?'), 'Short one')
  assert.equal(titleFrom('   spaced   out   question   '), 'spaced out question')
  assert.equal(titleFrom(''), 'Untitled')
  assert.equal(titleFrom('   '), 'Untitled')

  const long =
    'Which directors are below the attendance threshold across every committee this year and when'
  const title = titleFrom(long)
  assert.ok(title.length <= 61, `too long: ${title.length}`)
  assert.match(title, /…$/, 'a trimmed title says it was trimmed')
  assert.ok(!title.includes('  '), 'no double spaces')
  // Ends on a word, not mid-word.
  const body = title.replace(/…$/, '')
  assert.ok(long.startsWith(body), 'the kept part is a prefix of the question')
  assert.ok(!/\s$/.test(body), 'no trailing space before the ellipsis')

  // A single unbroken token still has to be cut somewhere.
  const oneWord = 'a'.repeat(120)
  assert.ok(titleFrom(oneWord).length <= 61)
})

test('createdAt is kept and updatedAt moves on every save', async () => {
  resetConversations()
  const clock = clockFrom(Date.parse('2026-09-01T00:00:00Z'))
  const first = await saveConversation('ds', { id: 'c1', turns: [turn('One')] }, clock)
  assert.ok(first.ok)
  const created = first.conversations[0].createdAt

  const second = await saveConversation('ds', { id: 'c1', turns: [turn('One'), turn('Two')] }, clock)
  assert.ok(second.ok)
  assert.equal(second.conversations[0].createdAt, created, 'createdAt is fixed')
  assert.ok(
    second.conversations[0].updatedAt > created,
    'updatedAt moves so the list can order by recency',
  )
})

test('the list is newest first', async () => {
  resetConversations()
  const clock = clockFrom(Date.parse('2026-09-01T00:00:00Z'))
  await saveConversation('ds', { id: 'old', turns: [turn('Old')] }, clock)
  await saveConversation('ds', { id: 'mid', turns: [turn('Mid')] }, clock)
  await saveConversation('ds', { id: 'new', turns: [turn('New')] }, clock)

  const store = await listConversations('ds')
  assert.deepEqual(
    store.conversations.map((c) => c.id),
    ['new', 'mid', 'old'],
  )

  // Touching the oldest brings it to the front, because that is what a reader
  // who just used it expects.
  await saveConversation('ds', { id: 'old', turns: [turn('Old'), turn('Again')] }, clock)
  const after = await listConversations('ds')
  assert.equal(after.conversations[0].id, 'old')
})

test('the cap evicts the oldest, never the one being written', async () => {
  resetConversations()
  const clock = clockFrom(Date.parse('2026-09-01T00:00:00Z'))
  for (let i = 0; i < MAX_CONVERSATIONS + 4; i++) {
    const saved = await saveConversation('ds', { id: `c${i}`, turns: [turn(`Q${i}`)] }, clock)
    assert.ok(saved.ok, `save ${i} should succeed rather than refuse`)
  }
  const store = await listConversations('ds')
  assert.equal(store.conversations.length, MAX_CONVERSATIONS)
  // Discarding what the reader is actively using would be the worst eviction.
  assert.equal(store.conversations[0].id, `c${MAX_CONVERSATIONS + 3}`)
  assert.ok(!store.conversations.some((c) => c.id === 'c0'), 'the oldest went')
})

test('a transcript longer than the cap is refused, not silently truncated', async () => {
  // Truncating would drop answers the reader can still see on screen, so the
  // stored conversation would disagree with the one in front of them.
  resetConversations()
  const tooMany = Array.from({ length: MAX_TURNS + 1 }, (_, i) => turn(`Q${i}`))
  const saved = await saveConversation('ds', { id: 'c1', turns: tooMany })
  assert.equal(saved.ok, false)
  if (!saved.ok) assert.equal(saved.reason, 'too-long')
})

test('a conversation can be removed, and a missing one says so', async () => {
  resetConversations()
  await saveConversation('ds', { id: 'c1', turns: [turn('One')] })
  await saveConversation('ds', { id: 'c2', turns: [turn('Two')] })

  const gone = await removeConversation('ds', 'c1')
  assert.ok(gone.ok)
  assert.deepEqual(
    gone.conversations.map((c) => c.id),
    ['c2'],
  )

  const missing = await removeConversation('ds', 'c1')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason, 'not-found')
})

test('the summary drops the transcripts but keeps the count', async () => {
  // Opening the app must not download every answer the reader has ever had, on
  // a surface that shows none of them.
  resetConversations()
  await saveConversation('ds', { id: 'c1', turns: [turn('One'), turn('Two')] })
  const store = await listConversations('ds')
  const summaries = summarise(store.conversations)

  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].turnCount, 2)
  assert.ok(!('turns' in summaries[0]), 'no turns in a summary')
  assert.ok(!JSON.stringify(summaries).includes('a computed headline'), 'no results either')
})

test('a hand-edited or half-written value cannot crash the reader', () => {
  // The lesson from pins: a null element survived an Array.isArray check and
  // threw on first property access, taking the whole view with it. This
  // asserts on the real validator, not on a re-implementation of it.
  const good = {
    id: 'good',
    title: 'Fine',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    turns: [turn('Fine')],
  }
  const raw = JSON.stringify([
    null,
    'not an object',
    42,
    { id: 'no-turns', title: 't', createdAt: 'x', updatedAt: 'y' },
    { id: '', title: 't', createdAt: 'x', updatedAt: 'y', turns: [] },
    { id: 'bad-turn', title: 't', createdAt: 'x', updatedAt: 'y', turns: [null] },
    { id: 'turn-no-result', title: 't', createdAt: 'x', updatedAt: 'y', turns: [{ id: 'a', question: 'q' }] },
    good,
  ])

  const parsed = parseStored(raw)
  assert.deepEqual(
    parsed.map((c) => c.id),
    ['good'],
    'only the well-formed entry survives',
  )

  // And nothing about a broken value may throw.
  assert.deepEqual(parseStored('not json at all'), [])
  assert.deepEqual(parseStored('{}'), [], 'an object is not a list')
  assert.deepEqual(parseStored('null'), [])
})
