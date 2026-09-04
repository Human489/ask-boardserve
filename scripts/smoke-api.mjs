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

// The model-routing assertion below is only meaningful against live model calls.
// A cached route reports routedBy 'model' too — correctly, the decision was the
// model's — so a suite run twice would satisfy it from cache even with the
// gateway dead. Run the server with AI_CACHE=off to make that check mean
// something; this line is a reminder in the output, not a substitute.
const CACHE_NOTE =
  'model routing is asserted against live calls only when the server runs with AI_CACHE=off'

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
let skipped = 0
const failures = []

/** Model routing can only be asserted where the credentials for it exist. */
const HAS_MODEL_CREDENTIALS = Boolean(
  (process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) &&
    (process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN),
)

function skip(name, why) {
  skipped++
  console.log(`  skip  ${name} — ${why}`)
}

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

// Twelve structured questions. SIX ARE PARAPHRASES, NOT THE SPEC'S WORDING —
// this comment claimed they were verbatim and they are not, which is the exact
// habit tests/spec-questions.ts was created to end.
//
// Kept as paraphrases deliberately: real readers paraphrase too, and the
// ~20-33% routing flake this project has measured lives in one of these
// shortened forms rather than in the customer's own longer sentence. They are
// a second, harder set. tests/routing-spec.test.ts holds the verbatim twelve.
// What was wrong was the claim, not the questions.
const STRUCTURED = [
  ['Who is below our attendance threshold, and on which committee?', 'attendance_below_threshold'],
  ['Which meetings had unusually low attendance, and when?', 'attendance_by_meeting'],
  ['Which committees have the lowest attendance?', 'attendance_by_committee'],
  ['Which directors have missed the most meetings they were eligible to attend?', 'meetings_missed'],
  ['What actions are overdue, and who owns them?', 'overdue_actions'],
  ['Which overdue actions have been outstanding the longest?', 'longest_overdue'],
  ['Which committee is carrying the most unresolved work?', 'unresolved_by_committee'],
  ['How are outstanding actions distributed across owners or committees?', 'actions_distribution'],
  ['What has been deferred more than once?', 'deferred_actions'],
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
  {
    // This used to assert that sign-in set NO cookie, because auth was stateless
    // and the passcode lived in React state. The brief asks for middleware
    // protecting every page, and a page cannot be protected by a header — a
    // browser typing the URL sends none — so a cookie is now issued. What is
    // asserted is the security of the thing that replaced it.
    const setCookie = loginRes.headers.get('set-cookie') ?? ''
    check(
      'sign-in issues an httpOnly session cookie',
      /bs_session=/.test(setCookie) && /HttpOnly/i.test(setCookie),
      setCookie.slice(0, 90),
    )
    check(
      'the session cookie is not the passcode itself',
      setCookie.length > 0 && !setCookie.includes(PASSCODE),
      'a leaked cookie must not hand over the credential',
    )
    check(
      'the session cookie is same-site and scoped to the app',
      /SameSite=strict/i.test(setCookie) && /Path=\//.test(setCookie),
      setCookie.slice(0, 90),
    )
  }
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

  // Model routing is the primary path; the keyword classifier is the safety
  // net. Counting how often the model was used and only PRINTING the number
  // meant a completely broken AI Gateway — wrong credentials, a deleted
  // gateway, an expired token — passed the whole suite silently, because the
  // fallback answers the same twelve questions correctly. The count is now an
  // assertion wherever it can be one.
  if (HAS_MODEL_CREDENTIALS) {
    check(
      'every structured question was routed by the model, not the fallback',
      routedByModel === STRUCTURED.length,
      `${routedByModel}/${STRUCTURED.length} routed by model — with CF_ credentials set, a ` +
        `fallback means the model call failed (check the gateway id, the token, and that a ` +
        `gateway exists under that exact name)`,
    )
  } else {
    skip(
      'every structured question was routed by the model',
      'no CF_ACCOUNT_ID / CF_API_TOKEN, so only the offline classifier can run',
    )
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
    const tool = json?.result?.tool
    // The old check here asserted only `json?.ok === true` under a name that
    // promised something much stronger, so it passed however the subject was
    // invented. Both properties are now checked, separately, so a failure says
    // which one broke.
    check(
      'a follow-up without history answers or refuses cleanly, never errors',
      json?.ok === true,
      `got ${JSON.stringify(json).slice(0, 90)}`,
    )
    check(
      'the same follow-up without history does not invent a subject',
      // Nothing in "and at 90%?" names attendance, directors or a threshold.
      // Reaching the previous question's tool means the subject came from
      // somewhere the reader never supplied.
      tool !== 'attendance_below_threshold',
      `routed to ${tool} — the subject was carried in from nowhere: ${String(
        json?.result?.headline ?? '',
      ).slice(0, 70)}`,
    )
  }

  // ------------------------------------------------------ pinned dashboard
  console.log('\nPinned dashboard')
  {
    const asJson = async (method, body) => {
      const res = await fetch(`${BASE}/api/pins`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      return { res, json: await res.json().catch(() => null) }
    }

    // Start from a known state: clear anything this suite left behind before.
    const initial = await asJson('GET')
    for (const pin of initial.json?.pins ?? []) {
      if (/^smoke:/.test(pin.question)) await asJson('DELETE', { id: pin.id })
    }

    {
      const res = await fetch(`${BASE}/api/pins`)
      check('the dashboard refuses without a passcode', res.status === 401, `got ${res.status}`)
    }

    const pinned = await asJson('POST', {
      question: 'smoke: who is below our attendance threshold?',
      tool: 'attendance_below_threshold',
      args: { threshold: 80 },
    })
    check(
      'an analysis can be pinned',
      pinned.res.status === 200 && Array.isArray(pinned.json?.pins),
      `status ${pinned.res.status} ${String(pinned.json?.error ?? '').slice(0, 80)}`,
    )

    const mine = (pinned.json?.pins ?? []).find((p) => /^smoke: who/.test(p.question))
    check(
      'the pinned card carries figures the server computed',
      Boolean(mine?.result?.headline) && Boolean(mine?.result?.provenance?.asAt),
      `headline=${String(mine?.result?.headline).slice(0, 60)}`,
    )
    check(
      'the pin records the tool and arguments that produced it',
      mine?.tool === 'attendance_below_threshold' && mine?.args?.threshold === 80,
      JSON.stringify({ tool: mine?.tool, args: mine?.args }),
    )

    {
      // The governing rule: a figure the client supplied must never reach the
      // dashboard. The route recomputes, so an injected headline is discarded.
      const forged = await asJson('POST', {
        question: 'smoke: forged figures',
        tool: 'attendance_below_threshold',
        args: { threshold: 55 },
        result: { headline: 'FORGED', provenance: { asAt: '1999-01-01' } },
      })
      const stored = (forged.json?.pins ?? []).find((p) => p.question === 'smoke: forged figures')
      check(
        'a client-supplied result is ignored in favour of the computed one',
        forged.res.status === 200 && Boolean(stored) && stored.result.headline !== 'FORGED',
        `stored headline=${String(stored?.result?.headline).slice(0, 60)}`,
      )
      if (stored) await asJson('DELETE', { id: stored.id })
    }

    {
      const duplicate = await asJson('POST', {
        question: 'smoke: the same thing again',
        tool: 'attendance_below_threshold',
        args: { threshold: 80 },
      })
      check(
        'the same analysis cannot be pinned twice',
        duplicate.res.status === 409,
        `got ${duplicate.res.status}`,
      )
    }

    {
      const unknown = await asJson('POST', {
        question: 'smoke: not a real analysis',
        tool: 'no_such_tool',
        args: {},
      })
      check('an unknown analysis is rejected', unknown.res.status === 400, `got ${unknown.res.status}`)
    }

    {
      const removed = await asJson('DELETE', { id: mine?.id })
      const left = (removed.json?.pins ?? []).some((p) => p.id === mine?.id)
      check('a pin can be removed', removed.res.status === 200 && !left, `status ${removed.res.status}`)
    }
  }

  // ------------------------------------------------- conversation history
  console.log('\nConversation history')
  {
    const asJson = async (method, body, query = '') => {
      const res = await fetch(`${BASE}/api/conversations${query}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      return { res, json: await res.json().catch(() => null) }
    }

    // Start from a known state: clear anything an earlier run left behind.
    const initial = await asJson('GET')
    for (const c of initial.json?.conversations ?? []) {
      if (/^smoke:/.test(c.title)) await asJson('DELETE', { id: c.id })
    }

    {
      const res = await fetch(`${BASE}/api/conversations`)
      check(
        'conversation history refuses without a passcode',
        res.status === 401,
        `got ${res.status}`,
      )
    }

    const id = `smoke-${Date.now().toString(36)}`
    const turn = {
      id: 't1',
      question: 'smoke: who is below the attendance threshold?',
      result: { headline: 'a computed headline', provenance: { asAt: '2026-08-31' } },
      routedBy: 'model',
      routedTo: { tool: 'attendance_below_threshold', args: { threshold: 80 } },
    }

    {
      const saved = await asJson('POST', { id, turns: [turn] })
      const mine = (saved.json?.conversations ?? []).find((c) => c.id === id)
      check(
        'a conversation is saved and titled from its first question',
        saved.res.status === 200 && mine?.title === 'smoke: who is below the attendance threshold',
        `title=${String(mine?.title)}`,
      )
      check(
        'the list carries no transcripts, only a count',
        Boolean(mine) && mine.turnCount === 1 && !('turns' in (mine ?? {})),
        `turnCount=${String(mine?.turnCount)} hasTurns=${String('turns' in (mine ?? {}))}`,
      )
    }

    {
      const one = await asJson('GET', null, `?id=${encodeURIComponent(id)}`)
      const turns = one.json?.conversation?.turns ?? []
      check(
        'opening a conversation returns its transcript',
        one.res.status === 200 && turns.length === 1 && turns[0].question === turn.question,
        `status ${one.res.status} turns=${turns.length}`,
      )
      check(
        'the stored turn keeps the tool and args, so a restored answer can be pinned',
        turns[0]?.routedTo?.tool === 'attendance_below_threshold',
        `routedTo=${JSON.stringify(turns[0]?.routedTo)}`,
      )
    }

    {
      const missing = await asJson('GET', null, '?id=does-not-exist')
      check(
        'asking for a conversation that is gone reports it',
        missing.res.status === 404,
        `got ${missing.res.status}`,
      )
    }

    {
      // A turn the card could not render is rejected rather than stored as an
      // answer that comes back blank.
      const bad = await asJson('POST', {
        id: `${id}-bad`,
        turns: [{ id: 't1', question: 'smoke: no headline', result: {} }],
      })
      check(
        'a turn with no headline is rejected',
        bad.res.status === 400,
        `got ${bad.res.status}`,
      )
    }

    {
      const empty = await asJson('POST', { id: `${id}-empty`, turns: [] })
      const created = (empty.json?.conversations ?? []).some((c) => c.id === `${id}-empty`)
      check(
        'an abandoned conversation with no questions is not recorded',
        empty.res.status === 200 && !created,
        `created=${String(created)}`,
      )
    }

    {
      const gone = await asJson('DELETE', { id })
      const still = (gone.json?.conversations ?? []).some((c) => c.id === id)
      check(
        'a conversation can be forgotten',
        gone.res.status === 200 && !still,
        `status ${gone.res.status} present=${String(still)}`,
      )
    }
  }

  // ------------------------------------------------------- share links
  console.log('\nShare links')
  {
    // Waits out a 429 like the rest of the suite. Without this, a revoke that
    // happened to land on the rate limit was scored as "a link cannot be
    // withdrawn", and the check that followed then failed for the same reason
    // — one throttled request reported as two security failures.
    const asJson = async (method, body) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${BASE}/api/shares`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        })
        const json = await res.json().catch(() => null)
        if (res.status !== 429) return { res, json }
        const wait = Number(json?.retryAfterSeconds ?? 60)
        process.stdout.write(`  (rate limited, waiting ${wait}s) `)
        await new Promise((r) => setTimeout(r, (wait + 1) * 1000))
      }
      return { res: { status: 429, ok: false }, json: null }
    }

    // Clear anything an earlier run left live, so this does not leak links.
    const initial = await asJson('GET')
    for (const share of initial.json?.shares ?? []) {
      await asJson('DELETE', { token: share.token })
    }

    {
      const res = await fetch(`${BASE}/api/shares`)
      check('creating a link refuses without a passcode', res.status === 401, `got ${res.status}`)
    }

    // A pin has to exist before there is anything to share.
    await fetch(`${BASE}/api/pins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'smoke: something to share',
        tool: 'attendance_below_threshold',
        args: { threshold: 80 },
      }),
    })

    const made = await asJson('POST', {})
    const shareToken = made.json?.token
    check(
      'a link is created over the pinned dashboard',
      made.res.status === 200 && typeof shareToken === 'string',
      `status ${made.res.status}`,
    )
    check(
      'the token carries real entropy and is URL-safe',
      typeof shareToken === 'string' && shareToken.length >= 42 && /^[A-Za-z0-9_-]+$/.test(shareToken),
      `token length ${shareToken?.length ?? 0}`,
    )
    check(
      'the link is given an expiry',
      typeof made.json?.expiresAt === 'string' && Date.parse(made.json.expiresAt) > Date.now(),
      `expiresAt=${made.json?.expiresAt}`,
    )

    if (shareToken) {
      // The point of the whole feature: reachable with NO credential at all.
      const open = await fetch(`${BASE}/share/${shareToken}`)
      const html = await open.text()
      check(
        'the shared page opens with no passcode',
        open.status === 200 && !html.includes('Enter your passcode'),
        `status ${open.status}`,
      )
      check(
        'the shared page is not indexable and not cacheable',
        /noindex/i.test(open.headers.get('x-robots-tag') ?? '') &&
          /no-store/i.test(open.headers.get('cache-control') ?? ''),
        `robots=${open.headers.get('x-robots-tag')} cache=${open.headers.get('cache-control')}`,
      )
      check(
        'the shared page offers no way into the app',
        !html.includes('Ask a question') && !html.includes('composer'),
        'no composer on the shared page',
      )

      const revoked = await asJson('DELETE', { token: shareToken })
      check('a link can be withdrawn', revoked.res.status === 200, `got ${revoked.res.status}`)

      const after = await fetch(`${BASE}/share/${shareToken}`)
      const afterHtml = await after.text()
      check(
        'a withdrawn link stops working immediately',
        afterHtml.includes('not available'),
        `status ${after.status}`,
      )
    }

    {
      const bogus = await fetch(`${BASE}/share/not-a-real-token`)
      const html = await bogus.text()
      check(
        'a guessed token gets the same answer as an expired one',
        html.includes('not available'),
        'no distinction between wrong and expired',
      )
    }

    {
      const bare = await fetch(`${BASE}/share`, { redirect: 'manual' })
      const html = await bare.text().catch(() => '')
      check(
        'the bare /share path stays behind the passcode',
        html.includes('Enter your passcode') || bare.status === 404 || bare.status >= 300,
        `status ${bare.status}`,
      )
    }

    // Leave nothing behind.
    const mine = await fetch(`${BASE}/api/pins`, { headers: { Authorization: `Bearer ${token}` } })
    const pins = (await mine.json().catch(() => null))?.pins ?? []
    for (const pin of pins) {
      if (/^smoke:/.test(pin.question)) {
        await fetch(`${BASE}/api/pins`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pin.id }),
        })
      }
    }
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
  console.log(`passed ${passed}   failed ${failed}   skipped ${skipped}`)
  console.log(
    `routed by model: ${routedByModel}/${STRUCTURED.length}
  (${CACHE_NOTE})` +
      (HAS_MODEL_CREDENTIALS
        ? ''
        : '  (no CF_ credentials, so the offline classifier is the only path available)'),
  )
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main()
