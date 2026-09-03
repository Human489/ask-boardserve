// eval.ts — the evaluation harness.
//
//   npm run dev                      (in one terminal, with AI_CACHE=off)
//   npx tsx scripts/eval.ts
//   npx tsx scripts/eval.ts --runs 5 --write-readme
//
// A fixed set of questions with expected answer types, run against the LIVE
// /api/ask, scored per category, with the results written into the README.
//
// WHY THIS IS NOT THE SMOKE SUITE. Smoke asks each question once and asserts it
// passed. That catches a broken deploy; it cannot catch an unreliable one. The
// router is a model call, and a model call is not deterministic even at
// temperature 0 — measured on this project, "Which meetings had unusually low
// attendance, and when?" routed correctly four times out of five and refused on
// the fifth. Asked once, that question looks perfect 80% of the time.
//
// So this harness asks each question N times and reports a RATE. A question
// that passes 3 of 5 is the finding; a suite that says "pass" is not.
//
// WHY IT HITS THE REAL ENDPOINT. scripts/probe-router.mjs already probes the
// router in isolation, which is the right tool for asking "can this model
// route at all". It bypasses Next, KV, Vectorize and the tools, so it cannot
// see a document question that routes correctly and then fails retrieval, or a
// hybrid that reads its term limit from the wrong place. The spec asks for
// coverage of structured, document, hybrid AND refusal cases, and three of
// those four only exist end to end.
//
// THE CASES ARE NOT DEFINED HERE. They come from tests/spec-questions.ts, the
// one file that holds the customer's wording verbatim. That file exists because
// two routing suites had drifted into paraphrases and scored 12/12 while real
// accuracy on the spec's wording was 3/12. A third copy here would be the same
// mistake a third time.

import { readFileSync, writeFileSync } from 'node:fs'
import {
  SPEC_DOCUMENT,
  SPEC_HYBRID,
  SPEC_REFUSALS,
  SPEC_STRUCTURED,
  SPEC_UPCOMING,
} from '../tests/spec-questions'

const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000'
/**
 * Accepts both `--runs=5` and `--runs 5`.
 *
 * The first version only handled the `=` form, so `npm run eval -- --runs 1`
 * silently ran three — npm forwards them as separate argv entries, `find`
 * matched the bare flag, and the split produced undefined and fell through to
 * the default. A harness quietly measuring something other than what it was
 * asked is worse than one that errors.
 */
function numericArg(flag: string, fallback: number): number {
  const argv = process.argv
  const joined = argv.find((a) => a.startsWith(`${flag}=`))
  if (joined) {
    const value = Number(joined.slice(flag.length + 1))
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const at = argv.indexOf(flag)
  if (at !== -1 && at + 1 < argv.length) {
    const value = Number(argv[at + 1])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return fallback
}

const RUNS = numericArg('--runs', 3)
const WRITE_README = process.argv.includes('--write-readme')

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

/** The four kinds the spec asks to be covered. */
type Category = 'structured' | 'document' | 'hybrid' | 'refusal'

interface Case {
  category: Category
  question: string
  /**
   * The answer types that count as correct.
   *
   * A SET rather than one tool, because for three of the four categories the
   * spec constrains the KIND of answer rather than the exact tool. What must
   * never happen is a structured tool answering a document question, or a
   * plausible answer to a question that has to be refused — those are the
   * silent failures this exists to catch.
   */
  expect: string[]
  /** Why this set, when it is not a single named tool. */
  note?: string
}

const RETRIEVAL_TOOLS = ['search_board_papers']
const HYBRID_TOOLS = ['tenure_and_skills_impact', 'upcoming_unprepared']

const CASES: Case[] = [
  ...SPEC_STRUCTURED.map(
    ({ q, tool }): Case => ({ category: 'structured', question: q, expect: [tool] }),
  ),
  ...SPEC_DOCUMENT.map(
    (q): Case => ({
      category: 'document',
      question: q,
      // A refusal counts. The corpus is three papers covering 2 of 6 meetings,
      // so some reasonable document questions genuinely have no passage —
      // CQC readiness is the recorded example. What must NOT happen is a
      // structured tool answering from the wrong source, which is exactly the
      // failure the brief calls silent.
      expect: [...RETRIEVAL_TOOLS, 'refusal'],
      note: 'papers or an honest refusal; never a structured tool',
    }),
  ),
  ...[...SPEC_HYBRID, ...SPEC_UPCOMING].map(
    (q): Case => ({
      category: 'hybrid',
      question: q,
      expect: [...HYBRID_TOOLS, 'refusal'],
      note: 'a hybrid tool, or a refusal when the prose does not state the fact',
    }),
  ),
  ...SPEC_REFUSALS.map(
    (q): Case => ({ category: 'refusal', question: q, expect: ['refusal'] }),
  ),
]

interface Outcome {
  tool: string
  routedBy: string
  ok: boolean
}

async function ask(question: string): Promise<Outcome> {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PASSCODE ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question }),
  })

  // A rate limit is not a routing result and must not be scored as one.
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null
    const wait = Math.min(body?.retryAfterSeconds ?? 60, 90)
    process.stdout.write(`  (rate limited, waiting ${wait}s) `)
    await new Promise((r) => setTimeout(r, wait * 1000))
    return ask(question)
  }

  const body = (await res.json().catch(() => null)) as
    | { ok: true; result: { tool: string }; routedBy: string }
    | { ok: false; error: string }
    | null

  if (!res.ok || !body || !body.ok) {
    return { tool: `error:${res.status}`, routedBy: 'none', ok: false }
  }
  return { tool: body.result.tool, routedBy: body.routedBy, ok: true }
}

interface Scored {
  case: Case
  runs: string[]
  passes: number
}

function pct(n: number, of: number): string {
  if (of === 0) return '—'
  return `${Math.round((n / of) * 1000) / 10}%`
}

async function main(): Promise<void> {
  if (!PASSCODE) {
    console.error('APP_PASSCODE is not set in .env.local. Cannot sign in.')
    process.exit(2)
  }

  console.log(`\nAsk BoardServe eval — ${BASE}`)
  console.log(`${CASES.length} questions x ${RUNS} run${RUNS === 1 ? '' : 's'}\n`)

  // Whether these numbers mean anything.
  //
  // With the AI cache on, every repeat of a question returns the first answer,
  // so a flaky router reports as perfectly stable and this harness becomes a
  // slower smoke suite. It says so rather than quietly producing a good score.
  let cacheWarning = ''
  try {
    const usage = await fetch(`${BASE}/api/usage`, {
      headers: { Authorization: `Bearer ${PASSCODE}` },
    })
    if (usage.ok) {
      const body = (await usage.json()) as { aiCacheDisabled?: boolean }
      if (body.aiCacheDisabled === false && RUNS > 1) {
        cacheWarning =
          'The AI cache was ON. Repeat runs were served from cache, so the ' +
          'stability column is not a measurement. Restart the server with ' +
          'AI_CACHE=off.'
      }
    }
  } catch {
    // /api/usage 404s in production by design. Not knowing is not a failure.
  }
  if (cacheWarning) console.log(`!! ${cacheWarning}\n`)

  const scored: Scored[] = []
  for (const c of CASES) {
    const runs: string[] = []
    for (let i = 0; i < RUNS; i++) {
      const outcome = await ask(c.question)
      runs.push(outcome.tool)
    }
    const passes = runs.filter((tool) => c.expect.includes(tool)).length
    scored.push({ case: c, runs, passes })

    const mark = passes === RUNS ? 'ok  ' : passes === 0 ? 'FAIL' : 'FLAKY'
    console.log(
      `  ${mark.padEnd(5)} [${c.category}] ${c.question.slice(0, 58)}` +
        (passes === RUNS ? '' : `\n         ${passes}/${RUNS} — saw ${[...new Set(runs)].join(', ')}`),
    )
  }

  const categories: Category[] = ['structured', 'document', 'hybrid', 'refusal']
  const rows = categories.map((category) => {
    const mine = scored.filter((s) => s.case.category === category)
    const attempts = mine.length * RUNS
    const passes = mine.reduce((a, s) => a + s.passes, 0)
    const flaky = mine.filter((s) => s.passes > 0 && s.passes < RUNS).length
    return { category, questions: mine.length, attempts, passes, flaky }
  })

  const totalAttempts = rows.reduce((a, r) => a + r.attempts, 0)
  const totalPasses = rows.reduce((a, r) => a + r.passes, 0)
  const totalFlaky = rows.reduce((a, r) => a + r.flaky, 0)
  const hardFails = scored.filter((s) => s.passes === 0)

  console.log('\n' + '-'.repeat(64))
  console.log('category      questions  attempts  passed  rate     unstable')
  for (const r of rows) {
    console.log(
      `${r.category.padEnd(14)}${String(r.questions).padStart(9)}${String(r.attempts).padStart(10)}` +
        `${String(r.passes).padStart(8)}  ${pct(r.passes, r.attempts).padEnd(8)} ${r.flaky}`,
    )
  }
  console.log('-'.repeat(64))
  console.log(
    `overall: ${totalPasses}/${totalAttempts} (${pct(totalPasses, totalAttempts)})   ` +
      `never passed: ${hardFails.length}   unstable: ${totalFlaky}`,
  )

  if (WRITE_README) writeReadme(rows, { totalAttempts, totalPasses, totalFlaky, hardFails, cacheWarning })

  // A question that NEVER passes is a broken deploy and fails the gate. A
  // question that sometimes passes is a measurement, and is reported rather
  // than used to block: the flake is a property of the model, and blocking on
  // it would mean never deploying.
  process.exit(hardFails.length > 0 ? 1 : 0)
}

const START = '<!-- eval:start -->'
const END = '<!-- eval:end -->'

function writeReadme(
  rows: { category: Category; questions: number; attempts: number; passes: number; flaky: number }[],
  totals: {
    totalAttempts: number
    totalPasses: number
    totalFlaky: number
    hardFails: Scored[]
    cacheWarning: string
  },
): void {
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const lines = [
    START,
    '',
    `_Last run ${when} UTC, ${RUNS} run${RUNS === 1 ? '' : 's'} per question against a live server._`,
    '',
    '| Category | Questions | Attempts | Passed | Rate | Unstable |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.category} | ${r.questions} | ${r.attempts} | ${r.passes} | ${pct(r.passes, r.attempts)} | ${r.flaky} |`,
    ),
    `| **overall** | ${rows.reduce((a, r) => a + r.questions, 0)} | ${totals.totalAttempts} | ${totals.totalPasses} | **${pct(totals.totalPasses, totals.totalAttempts)}** | ${totals.totalFlaky} |`,
    '',
  ]

  if (totals.hardFails.length > 0) {
    lines.push('**Never passed:**', '')
    for (const f of totals.hardFails) {
      lines.push(`- \`${f.case.category}\` — ${f.case.question} (saw ${[...new Set(f.runs)].join(', ')})`)
    }
    lines.push('')
  }

  if (totals.totalFlaky > 0) {
    lines.push(
      `**${totals.totalFlaky} question${totals.totalFlaky === 1 ? '' : 's'} answered ` +
        'inconsistently across runs.** Routing is a model call and is not ' +
        'deterministic even at temperature 0, so this column is the honest ' +
        'reading of reliability — a single run would report these as passes.',
      '',
    )
  }

  if (totals.cacheWarning) lines.push(`**Caveat:** ${totals.cacheWarning}`, '')
  lines.push(END)

  const readme = safeRead('README.md')
  const block = lines.join('\n')
  const next =
    readme.includes(START) && readme.includes(END)
      ? readme.slice(0, readme.indexOf(START)) + block + readme.slice(readme.indexOf(END) + END.length)
      : `${readme.trimEnd()}\n\n## Eval results\n\n${block}\n`

  writeFileSync('README.md', next)
  console.log('\nREADME.md updated between the eval markers.')
}

void main()
