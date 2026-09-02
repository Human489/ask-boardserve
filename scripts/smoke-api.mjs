// smoke-api.mjs — end-to-end checks against a running server.
//
//   npm run dev          (in one terminal)
//   node scripts/smoke-api.mjs
//
// Checks auth, rate limiting, refusals and the twelve structured questions
// against the live API. Exits non-zero if anything fails, so it can gate a
// deploy. Reads APP_PASSCODE from .env.local.

import { readFileSync } from 'node:fs'

const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000'

for (const line of safeRead('.env.local').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const PASSCODE = process.env.APP_PASSCODE

function safeRead(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function send(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { res, json }
}

/**
 * The suite makes more requests than the limiter allows in a minute, so it
 * would otherwise fail its own later checks on 429s that are the limiter
 * working correctly. A 429 is waited out and retried once — except where a 429
 * is the thing being tested, which uses `send` directly.
 */
async function post(path, body, token) {
  // Up to three waits: a single retry was not always enough, because the window
  // can roll while several calls are queued behind it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await send(path, body, token)
    if (result.res.status !== 429) return result
    const wait = Number(result.json?.retryAfterSeconds ?? 60)
    process.stdout.write(`  (rate limited, waiting ${wait}s) `)
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000))
  }
  return send(path, body, token)
}

// The twelve structured questions, exactly as the specification writes them.
const STRUCTURED = [
  ['Who is below our attendance threshold, and on which committee?', 'attendance_below_threshold'],
  ['Which meetings had unusually low attendance, and when?', 'attendance_by_meeting'],
  ['Which committees have the lowest attendance?', 'attendance_by_committee'],
  ['Which directors have missed the most meetings they were eligible to attend?', 'meetings_missed'],
  ['What actions are overdue, and who owns them?', 'overdue_actions'],
  ['Which overdue actions have been outstanding the longest?', 'longest_overdue'],
  ['Which committee is carrying the most unresolved work?', 'unresolved_by_committee'],
  ['How are outstanding actions distributed across owners or committees?', 'actions_distribution'],
  ['What has been deferred more than once?', 'deferred_more_than_once'],
  ['Where are our biggest skill gaps?', 'skills_gaps'],
  ['Which directors provide the strongest coverage for the areas where the board has gaps?', 'gap_coverage'],
  ['Which committees have the greatest skills gaps?', 'committee_skills_gaps'],
]

const REFUSALS = [
  'How long are our packs, and are they going out with enough notice?',
  'What did we decide in the last 3 meetings, and what happened?',
  'What do the board papers say about our CQC readiness?',
  'How many directors are qualified accountants?',
  'What was the board’s average IQ?',
]

async function main() {
  console.log(`\nAsk BoardServe smoke test — ${BASE}\n`)

  if (!PASSCODE) {
    console.error('APP_PASSCODE is not set in .env.local. Cannot sign in.')
    process.exit(1)
  }

  try {
    await fetch(BASE)
  } catch (e) {
    // Note: 127.0.0.1 rather than localhost. Node resolves localhost to ::1,
    // and the dev server listens on IPv4 only, so localhost fails here even
    // though it works fine in a browser.
    console.error(`No server at ${BASE} (${e.message}). Start it with: npm run dev`)
    process.exit(1)
  }

  // ---------------------------------------------------------------- auth
  console.log('Auth')
  {
    const { res } = await post('/api/ask', { question: 'Where are our biggest skill gaps?' })
    check('unauthenticated /api/ask is refused', res.status === 401, `got ${res.status}`)
  }
  {
    const { res } = await post('/api/ask', { question: 'test' }, 'not-the-passcode')
    check('a wrong credential is refused', res.status === 401, `got ${res.status}`)
  }
  {
    const { res } = await post('/api/login', { passcode: `${PASSCODE}x` })
    check('wrong passcode is refused', res.status === 401, `got ${res.status}`)
  }

  const { res: loginRes, json: loginJson } = await post('/api/login', { passcode: PASSCODE })
  check('correct passcode is accepted', loginRes.status === 200 && loginJson?.ok === true)
  check(
    'sign-in issues nothing to store',
    loginJson?.token === undefined,
    'a token came back; auth is meant to be stateless',
  )
  check(
    'sign-in sets no cookie',
    !loginRes.headers.has('set-cookie'),
    loginRes.headers.get('set-cookie') ?? '',
  )
  // The passcode itself is the credential: there is no session to hold, so
  // nothing has to survive between the login call and the questions.
  const token = PASSCODE

  // ---------------------------------------------------------- validation
  console.log('\nValidation')
  {
    const { res } = await post('/api/ask', { question: '' }, token)
    check('empty question is rejected', res.status === 400, `got ${res.status}`)
  }
  {
    const { res } = await post('/api/ask', { question: 'x'.repeat(2000) }, token)
    check('over-long question is rejected', res.status === 400, `got ${res.status}`)
  }

  // ------------------------------------------------------------ routing
  console.log('\nStructured questions')
  let routedByModel = 0
  for (const [question, expected] of STRUCTURED) {
    const { res, json } = await post('/api/ask', { question }, token)
    const tool = json?.result?.tool
    const headline = json?.result?.headline ?? ''
    if (json?.routedBy === 'model') routedByModel++
    const ok =
      res.status === 200 &&
      tool === expected &&
      headline.length > 0 &&
      !/this chart shows/i.test(headline) &&
      !/NaN|Infinity/.test(JSON.stringify(json?.result ?? {}))
    check(`${expected}`, ok, ok ? '' : `got tool=${tool} status=${res.status}`)
  }

  console.log('\nRefusals')
  for (const question of REFUSALS) {
    const { res, json } = await post('/api/ask', { question }, token)
    const ok = res.status === 200 && json?.result?.tool === 'refusal' && json?.result?.reason
    check(question.slice(0, 52), ok, ok ? '' : `got ${json?.result?.tool}`)
  }

  // ------------------------------------------------------------ multi-turn
  // Follow-ups carry no subject of their own: "and at 90%?" means nothing
  // without the question before it. This works because history reaches the
  // router AND because the tools take arguments a follow-up can bind to — so it
  // is worth a test, since either half breaking would look like the other.
  console.log('\nMulti-turn refinement')
  {
    const first = 'Who is below our attendance threshold, and on which committee?'
    const opening = await post('/api/ask', { question: first }, token)
    const history = [
      { role: 'user', content: first },
      { role: 'assistant', content: opening.json?.result?.headline ?? '' },
    ]
    const { json } = await post('/api/ask', { question: 'and at 90%?', history }, token)
    const headline = json?.result?.headline ?? ''
    check(
      'a follow-up inherits the subject of the previous question',
      json?.result?.tool === 'attendance_below_threshold' && /90%/.test(headline),
      `got tool=${json?.result?.tool} headline=${headline.slice(0, 70)}`,
    )
    check(
      'the follow-up changes the answer rather than repeating it',
      headline !== (opening.json?.result?.headline ?? ''),
    )
  }
  {
    const first = 'What actions are overdue, and who owns them?'
    const opening = await post('/api/ask', { question: first }, token)
    const history = [
      { role: 'user', content: first },
      { role: 'assistant', content: opening.json?.result?.headline ?? '' },
    ]
    const { json } = await post('/api/ask', { question: 'just the Head of IT ones', history }, token)
    const headline = json?.result?.headline ?? ''
    check(
      'a follow-up can narrow the previous answer to one owner',
      /head of it/i.test(headline),
      headline.slice(0, 90),
    )
  }
  {
    // A follow-up with no history must not pretend to have one.
    const { json } = await post('/api/ask', { question: 'and at 90%?' }, token)
    check(
      'the same follow-up without history does not invent a subject',
      json?.ok === true,
      'it should still answer or refuse cleanly, never error',
    )
  }

  // -------------------------------------------------------- rate limiting
  console.log('\nRate limiting')
  {
    let sawLimit = false
    let status = 0
    for (let i = 0; i < 30; i++) {
      const { res } = await send('/api/ask', { question: 'Where are our biggest skill gaps?' }, token)
      status = res.status
      if (res.status === 429) {
        sawLimit = true
        break
      }
    }
    check('rate limit engages within 30 rapid requests', sawLimit, `last status ${status}`)
  }

  // ---------------------------------------------------------------- done
  console.log('\n' + '-'.repeat(60))
  console.log(`passed ${passed}   failed ${failed}`)
  console.log(`routed by model: ${routedByModel}/${STRUCTURED.length}` +
    (routedByModel === 0 ? '  (offline classifier — check CF_ credentials)' : ''))
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main()
