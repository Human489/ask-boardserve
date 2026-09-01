// probe-router.mjs — kill-or-confirm test for the riskiest assumption in Ask BoardServe:
// "the model I can actually call will pick the right tool, with the right arguments,
//  and will refuse when nothing answers the question."
//
// No UI, no Next.js, no Vectorize, no KV. One file, no dependencies, Node 18+.
//
//   node scripts/probe-router.mjs
//   node scripts/probe-router.mjs --model @cf/meta/llama-3.3-70b-instruct-fp8-fast
//
// Reads CF_ACCOUNT_ID, CF_API_TOKEN, CF_AI_GATEWAY_ID from
// .env.local. Prints a per-question pass/fail table and an overall accuracy figure.
//
// Read the result like this:
//   >= 90% and no refusal misses .... assumption holds, build the UI
//   70-90% ......................... holds only with a repair pass; budget for it
//   < 70% ......................... this model cannot route. Change model or
//                                    replace the router with a classifier before
//                                    you build anything on top of it.

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------- env

for (const line of safeRead('.env.local').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const ACCOUNT = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN
const GATEWAY = process.env.CF_AI_GATEWAY_ID || process.env.CLOUDFLARE_AI_GATEWAY_ID || 'default'
const MODEL = argOf('--model') || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
const RUNS = Number(argOf('--runs') || 1) // >1 tells you how *stable* it is, not just how right

if (!ACCOUNT || !TOKEN) {
  console.error('Missing CF_ACCOUNT_ID / CF_API_TOKEN in .env.local')
  process.exit(1)
}

// ---------------------------------------------------------------- the tools
// These are stubs. They are never executed. The only thing under test is whether
// the model picks the right one and fills the arguments correctly.

const tools = [
  {
    type: 'function',
    function: {
      name: 'attendance_stats',
      description:
        'Attendance figures per director, per committee, or per meeting, computed from the attendance records. Use for anything about who attended, missed, apologies, absences, attendance rates or trends.',
      parameters: {
        type: 'object',
        properties: {
          group_by: { type: 'string', enum: ['director', 'body', 'meeting'] },
          threshold_pct: {
            type: 'number',
            description: 'Optional. Only return directors below this attendance percentage.',
          },
        },
        required: ['group_by'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'actions_query',
      description:
        'Action-log items with owners, due dates, deferrals and derived overdue status. Use for anything about outstanding, overdue, deferred or unresolved work.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['overdue', 'unresolved', 'deferred_more_than_once', 'due_in_window', 'all'],
          },
          group_by: { type: 'string', enum: ['owner', 'committee', 'none'] },
        },
        required: ['filter'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skills_matrix',
      description:
        'Self-assessed skills scores by director and skill area. Use for skill gaps, coverage of gaps, and committee-level skill weakness.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['gaps', 'director_coverage', 'by_committee'] },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_board_papers',
      description:
        'Full-text search across the board papers. Use when the question asks what the papers say, or about a topic, risk, project or theme discussed in writing rather than a number in a dataset.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refuse',
      description:
        'Call this when the available data cannot answer the question, even approximately. Better to refuse than to answer from something that only looks similar.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
    },
  },
]

const SYSTEM = [
  'You route company-secretary questions about board data to tools.',
  'The data available is: meeting attendance records, an action log, a self-assessed skills audit, and three board papers.',
  'There is no record of pack length, notice periods, meeting minutes, decisions, or professional qualifications.',
  'Call exactly one tool. Never compute or state a number yourself.',
  'If nothing in the data answers the question, call refuse.',
].join(' ')

// ---------------------------------------------------------------- the cases
// expect: the tool that must be called. args: assertions on the arguments.
// The hard ones are marked. They are the reason for running this at all.

const cases = [
  { q: 'Who is below our attendance threshold, and on which committee?', expect: 'attendance_stats' },
  { q: 'Which meetings had unusually low attendance, and when?', expect: 'attendance_stats', args: { group_by: 'meeting' } },
  { q: 'Which committees have the lowest attendance?', expect: 'attendance_stats', args: { group_by: 'body' } },
  { q: 'Which directors have missed the most meetings they were eligible to attend?', expect: 'attendance_stats', args: { group_by: 'director' } },

  { q: 'What actions are overdue, and who owns them?', expect: 'actions_query', args: { filter: 'overdue', group_by: 'owner' } },
  { q: 'Which overdue actions have been outstanding the longest?', expect: 'actions_query', args: { filter: 'overdue' } },
  { q: 'Which committee is carrying the most unresolved work?', expect: 'actions_query', args: { filter: 'unresolved', group_by: 'committee' } },
  { q: 'What has been deferred more than once?', expect: 'actions_query', args: { filter: 'deferred_more_than_once' } },

  { q: 'Where are our biggest skill gaps?', expect: 'skills_matrix', args: { mode: 'gaps' } },
  { q: 'Which directors provide the strongest coverage for the areas where the board has gaps?', expect: 'skills_matrix', args: { mode: 'director_coverage' } },
  { q: 'Which committees have the greatest skills gaps?', expect: 'skills_matrix', args: { mode: 'by_committee' } },

  { q: 'What do the board papers say about the Ashcombe day therapy unit?', expect: 'search_board_papers' },
  { q: 'What concerns or themes recur across recent board papers?', expect: 'search_board_papers' },
  { q: 'Why did the hospice close the Ashcombe unit?', expect: 'search_board_papers' },

  // Refusals. These are the ones that matter most: a router that never refuses
  // will confidently answer a question the data cannot answer, in front of a client.
  { q: 'How long are our packs, and are they going out with enough notice?', expect: 'refuse', hard: true },
  { q: 'What did we decide in the last three meetings, and what happened?', expect: 'refuse', hard: true },
  { q: 'How many directors are qualified accountants?', expect: 'refuse', hard: true },
  { q: "What was the board's average IQ?", expect: 'refuse' },

  // Near-misses: superficially like a supported question, but not one.
  { q: 'Which directors are chartered surveyors?', expect: 'refuse', hard: true },
  { q: 'How many people dialled into the last board meeting from abroad?', expect: 'refuse', hard: true },
]

// ---------------------------------------------------------------- run

// Workers AI REST endpoint with the gateway applied by header. The
// gateway.ai.cloudflare.com/{account}/{gateway} URL form returns 401 unless a
// gateway already exists under that exact name.
const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`

async function route(question) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-gateway-id': GATEWAY,
    },
    body: JSON.stringify({
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: question },
      ],
      tools,
    }),
  })
  const text = await res.text()
  if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { error: `unparseable response: ${text.slice(0, 200)}` }
  }

  // This endpoint nests everything under `result` and offers the tool call in
  // two shapes; take whichever is present.
  const result = body.result ?? body
  const msg = result.choices?.[0]?.message ?? {}
  const call = msg.tool_calls?.[0] ?? result.tool_calls?.[0]
  if (!call) return { tool: null, prose: String(msg.content || result.response || '').slice(0, 120) }

  const fn = call.function ?? call
  let args = fn.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return { tool: fn.name, badArgs: args.slice(0, 120) }
    }
  }
  return { tool: fn.name, args: args ?? {} }
}

const stats = { total: 0, tool: 0, args: 0, refusalTotal: 0, refusalHit: 0, errors: 0 }
const failures = []

console.log(`\nmodel: ${MODEL}   gateway: ${GATEWAY}   runs per question: ${RUNS}\n`)

for (const c of cases) {
  for (let run = 0; run < RUNS; run++) {
    const r = await route(c.q)
    stats.total++
    const isRefusal = c.expect === 'refuse'
    if (isRefusal) stats.refusalTotal++

    if (r.error) {
      stats.errors++
      failures.push({ q: c.q, why: r.error })
      console.log(`ERR  ${trim(c.q)}\n     ${r.error}`)
      continue
    }

    const toolOk = r.tool === c.expect
    if (toolOk) {
      stats.tool++
      if (isRefusal) stats.refusalHit++
    }

    // Argument check only applies when the right tool was chosen.
    const argMisses = []
    if (toolOk && c.args) {
      for (const [k, v] of Object.entries(c.args)) {
        if (r.args?.[k] !== v) argMisses.push(`${k}=${JSON.stringify(r.args?.[k])} want ${JSON.stringify(v)}`)
      }
    }
    if (toolOk && argMisses.length === 0) stats.args++

    const mark = !toolOk ? 'FAIL' : argMisses.length ? 'ARGS' : 'ok  '
    const detail = !toolOk
      ? `got ${r.tool ?? `no tool — prose: "${r.prose}"`}, want ${c.expect}`
      : argMisses.join(', ')
    console.log(`${mark} ${trim(c.q)}${detail ? `\n     ${detail}` : ''}`)
    if (mark !== 'ok  ') failures.push({ q: c.q, why: detail, hard: c.hard })
  }
}

const pct = (n) => `${((n / stats.total) * 100).toFixed(0)}%`
console.log('\n' + '-'.repeat(64))
console.log(`right tool          ${stats.tool}/${stats.total}  ${pct(stats.tool)}`)
console.log(`right tool + args   ${stats.args}/${stats.total}  ${pct(stats.args)}`)
console.log(
  `refusals caught     ${stats.refusalHit}/${stats.refusalTotal}` +
    (stats.refusalTotal ? `  ${((stats.refusalHit / stats.refusalTotal) * 100).toFixed(0)}%` : '')
)
if (stats.errors) console.log(`transport errors    ${stats.errors}`)

const verdict =
  stats.errors > 0
    ? 'INCONCLUSIVE — fix the transport errors first.'
    : stats.refusalHit < stats.refusalTotal
      ? 'REFUSAL IS THE WEAK POINT. The routing works; the model answers questions it should decline. Fix this before the UI: it is the failure a client will notice.'
      : stats.args / stats.total >= 0.9
        ? 'ASSUMPTION HOLDS. Build the UI.'
        : stats.tool / stats.total >= 0.7
          ? 'MARGINAL. Tool choice is mostly right, arguments are not. Loosen the tool surface (fewer tools, fewer enums) and re-run before building.'
          : 'ASSUMPTION KILLED. This model cannot route reliably. Try a larger model, or drop to a deterministic keyword classifier with the model only narrating.'

console.log('\n' + verdict + '\n')

if (failures.some((f) => f.hard)) {
  console.log('The failures marked hard are the designed traps. If those are the ones failing,')
  console.log('the problem is your system prompt, not the model: it does not know what is absent.\n')
}

// ---------------------------------------------------------------- helpers

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : process.argv[i + 1]
}
function safeRead(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
function trim(s) {
  return s.length > 68 ? s.slice(0, 65) + '...' : s.padEnd(68)
}
