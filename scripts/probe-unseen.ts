// probe-unseen.ts — accuracy on questions that are NOT in the spec set.
//
//   npm run dev            (with AI_CACHE=off)
//   npx tsx scripts/probe-unseen.ts
//
// The eval harness runs the customer's own 26 questions. Those are the ones
// the router was built against, so a good score on them proves it does not
// regress — not that it generalises. A secretary will not type the spec's
// wording; they will type their own.
//
// So these are new. Realistic phrasings a company secretary might actually
// use, none of them in tests/spec-questions.ts, grouped by what SHOULD happen.
// The interesting column is not the pass rate, it is which ones fail and why.
//
// Nothing here is scored automatically as "correct wording" — only the ROUTE
// is checked, because that is the silent failure the brief warns about.

import { readFileSync } from 'node:fs'

const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000'

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
for (const line of safeRead('.env.local').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const PASSCODE = process.env.APP_PASSCODE

const STRUCTURED = [
  'attendance_below_threshold',
  'attendance_by_meeting',
  'attendance_by_committee',
  'meetings_missed',
  'overdue_actions',
  'longest_overdue',
  'unresolved_by_committee',
  'actions_distribution',
  'deferred_more_than_once',
  'skills_gaps',
  'gap_coverage',
  'committee_skills_gaps',
]
const HYBRID = ['tenure_and_skills_impact', 'upcoming_unprepared']
const PAPERS = ['search_board_papers']

interface Case {
  q: string
  /** What a correct route looks like. */
  expect: string[]
  why: string
}

const CASES: Case[] = [
  // --- plain-English versions of things the tools DO compute -------------
  { q: 'Who keeps missing meetings?', expect: [...STRUCTURED], why: 'blunt, no jargon' },
  { q: 'Is anyone turning up less than they should?', expect: [...STRUCTURED], why: 'no threshold named' },
  { q: 'Which of our committees is struggling to get people in the room?', expect: [...STRUCTURED], why: 'idiom' },
  { q: 'What is stuck?', expect: [...STRUCTURED], why: 'two words, no subject noun' },
  { q: 'Anything been sitting around too long?', expect: [...STRUCTURED], why: 'colloquial overdue' },
  { q: 'Who has the most on their plate?', expect: [...STRUCTURED], why: 'idiom for workload' },
  { q: 'Where are we weakest as a board?', expect: [...STRUCTURED], why: 'skills, no jargon' },
  { q: 'Do we have enough finance expertise?', expect: [...STRUCTURED], why: 'names a skill area loosely' },
  { q: 'Has attendance got better or worse this year?', expect: [...STRUCTURED], why: 'trend phrasing' },
  { q: 'Which trustees are letting the side down on attendance?', expect: [...STRUCTURED], why: 'loaded phrasing' },

  // --- should reach the papers, or refuse honestly -----------------------
  { q: 'What did the board discuss about the day therapy unit?', expect: [...PAPERS, 'refusal'], why: 'documents' },
  { q: 'Why are we closing a service?', expect: [...PAPERS, 'refusal'], why: 'documents, no noun from the data' },
  { q: 'What did the papers say about our finances?', expect: [...PAPERS, 'refusal'], why: 'documents, money' },

  // --- hybrid: a fact in prose plus a column ----------------------------
  { q: 'Is anyone about to hit their term limit?', expect: [...HYBRID, 'refusal'], why: 'prose limit + tenure column' },
  { q: 'Do we need to recruit anyone soon?', expect: [...HYBRID, ...STRUCTURED, 'refusal'], why: 'implies tenure' },

  // --- must refuse: the data genuinely does not hold this ---------------
  { q: 'How much are we paying our directors?', expect: ['refusal'], why: 'no pay data anywhere' },
  { q: 'What is the average age of our board?', expect: ['refusal'], why: 'no ages recorded' },
  { q: 'How diverse is the board?', expect: ['refusal'], why: 'no protected characteristics' },
  { q: 'When does each director’s term actually end?', expect: ['refusal', ...HYBRID], why: 'no appointment dates' },
  { q: 'Who is going to resign next?', expect: ['refusal'], why: 'unknowable' },
  { q: 'Which director is the best?', expect: ['refusal', ...STRUCTURED], why: 'no such measure' },
  { q: 'What is the weather like today?', expect: ['refusal'], why: 'entirely off-domain' },

  // --- awkward but answerable -------------------------------------------
  { q: 'attendance', expect: [...STRUCTURED], why: 'one bare word' },
  { q: 'overdue actions please', expect: [...STRUCTURED], why: 'terse, polite' },
  { q: 'Tell me everything wrong with this board.', expect: [...STRUCTURED, 'refusal'], why: 'unbounded' },
]

interface Result {
  case: Case
  tool: string
  detail: string
}

async function ask(question: string): Promise<{ tool: string; detail: string }> {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PASSCODE ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null
    const wait = Math.min(body?.retryAfterSeconds ?? 60, 90)
    process.stdout.write(`  (rate limited ${wait}s) `)
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000))
    return ask(question)
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: true; result: { tool: string; headline?: string; reason?: string } }
    | { ok: false; error: string }
    | null
  if (!res.ok || !body || !body.ok) {
    return { tool: `error:${res.status}`, detail: body && !body.ok ? body.error : '' }
  }
  return {
    tool: body.result.tool,
    detail: (body.result.headline ?? body.result.reason ?? '').slice(0, 110),
  }
}

async function main(): Promise<void> {
  if (!PASSCODE) {
    console.error('APP_PASSCODE is not set in .env.local.')
    process.exit(2)
  }
  console.log(`\nUnseen-question probe — ${BASE}`)
  console.log(`${CASES.length} questions the router has never been tuned against\n`)

  const results: Result[] = []
  for (const c of CASES) {
    const { tool, detail } = await ask(c.q)
    results.push({ case: c, tool, detail })
    const ok = c.expect.includes(tool)
    console.log(`  ${ok ? 'ok  ' : 'MISS'} ${tool.padEnd(28)} ${c.q.slice(0, 52)}`)
    if (!ok) console.log(`       expected one of: ${c.expect.slice(0, 3).join(', ')}${c.expect.length > 3 ? ', …' : ''}`)
    console.log(`       ${detail}`)
  }

  const misses = results.filter((r) => !r.case.expect.includes(r.tool))
  console.log('\n' + '-'.repeat(66))
  console.log(`${results.length - misses.length}/${results.length} routed acceptably`)
  if (misses.length > 0) {
    console.log('\nMissed:')
    for (const m of misses) {
      console.log(`  ${m.case.q}`)
      console.log(`    got ${m.tool} — ${m.case.why}`)
    }
  }
}

void main()
