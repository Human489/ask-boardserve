// calibrate-retrieval.mjs — find the score below which retrieval should refuse.
//
//   node scripts/calibrate-retrieval.mjs
//
// Cosine similarity with this embedding model never approaches zero, so a score
// cannot be judged by eye and a threshold cannot be guessed. The skeleton this
// derives from measured 0.62-0.65 on a corpus of Steam documentation; that
// number says nothing about board papers. This measures it here.
//
// It asks two sets of questions: ones whose answer is definitely in a specific
// paper, and ones on subjects no paper covers (they appear only in the action
// log, or nowhere). The gap between the worst COVERED score and the best
// UNCOVERED score is the room available for a threshold. If they overlap, no
// single number separates them and the agent needs more than a score to decide.

import { readFileSync } from 'node:fs'

for (const line of safeRead('.env.local').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
function safeRead(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

const ACCOUNT = process.env.CF_ACCOUNT_ID
const TOKEN = process.env.CF_API_TOKEN
const INDEX = process.env.CF_VECTORIZE_INDEX
const GATEWAY = process.env.CF_AI_GATEWAY_ID || 'default'
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'

if (!ACCOUNT || !TOKEN || !INDEX) {
  console.error('Set CF_ACCOUNT_ID, CF_API_TOKEN and CF_VECTORIZE_INDEX in .env.local')
  process.exit(1)
}

const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`
const auth = { Authorization: `Bearer ${TOKEN}`, 'cf-aig-gateway-id': GATEWAY }

async function cf(path, init, what) {
  const res = await fetch(`${base}${path}`, init)
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) {
    throw new Error(`${what}: ${json?.errors?.map((e) => e.message).join('; ') ?? res.status}`)
  }
  return json.result
}

const embed = (text) =>
  cf(
    `/ai/run/${EMBED_MODEL}`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text] }),
    },
    'Embedding',
  ).then((r) => r.data[0])

const search = (vector) =>
  cf(
    `/vectorize/v2/indexes/${INDEX}/query`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, topK: 3, returnMetadata: 'all' }),
    },
    'Query',
  ).then((r) => r.matches ?? [])

// Answer is in a named paper. `expect` is the paper the top hit should come from.
const COVERED = [
  ['What did the Ashcombe unit cost per attendance?', 'paper-02'],
  ['Why is the hospice closing the Ashcombe day therapy unit?', 'paper-02'],
  ['What is our reserves position against policy?', 'paper-01'],
  ['How much are we spending on agency nursing?', 'paper-01'],
  ['Which skill is weakest across the board?', 'paper-03'],
  ['What does the paper say about trustee succession?', 'paper-03'],
  ['What is happening with the retail shops?', 'paper-01'],
  ['What are the risks of the closure?', 'paper-02'],
]

// No paper covers these. Some appear in the action log, which is the trap: the
// subject exists in the organisation but not in this corpus.
const UNCOVERED = [
  ['What do the papers say about our CQC readiness?', 'in the action log only'],
  ['What is our safeguarding policy?', 'nowhere'],
  ['What did the board resolve at the March meeting?', 'no minutes exist'],
  ['How many directors are qualified accountants?', 'skills audit is self-assessed'],
  ["What was the board's average IQ?", 'nowhere'],
  ['What is our treasury policy for cash deposits?', 'in the action log only'],
  ['How long are our board packs?', 'nowhere'],
]

async function main() {
  console.log(`\nCalibrating against index ${INDEX}\n`)

  const covered = []
  console.log('COVERED — the answer is in a paper')
  for (const [q, expect] of COVERED) {
    const matches = await search(await embed(q))
    const top = matches[0]
    const hit = top?.metadata?.paperId ?? '(none)'
    const right = String(hit).startsWith(expect)
    covered.push(top?.score ?? 0)
    console.log(
      `  ${(top?.score ?? 0).toFixed(4)}  ${right ? 'right paper' : `WRONG (${hit})`}  ${q}`,
    )
    if (top?.metadata?.section) console.log(`          -> ${hit} / ${top.metadata.section}`)
  }

  const uncovered = []
  console.log('\nUNCOVERED — no paper covers this')
  for (const [q, why] of UNCOVERED) {
    const matches = await search(await embed(q))
    const top = matches[0]
    uncovered.push(top?.score ?? 0)
    console.log(`  ${(top?.score ?? 0).toFixed(4)}  ${q}`)
    console.log(`          -> best hit ${top?.metadata?.paperId ?? '-'} (${why})`)
  }

  const worstCovered = Math.min(...covered)
  const bestUncovered = Math.max(...uncovered)
  const gap = worstCovered - bestUncovered

  console.log('\n' + '-'.repeat(64))
  console.log(`covered   : min ${worstCovered.toFixed(4)}  max ${Math.max(...covered).toFixed(4)}`)
  console.log(`uncovered : min ${Math.min(...uncovered).toFixed(4)}  max ${bestUncovered.toFixed(4)}`)
  console.log(`separation: ${gap.toFixed(4)}`)

  if (gap > 0) {
    const suggested = Math.round((bestUncovered + gap / 2) * 1000) / 1000
    console.log(`\nA threshold of ${suggested} separates every case tested.`)
    if (gap < 0.03) {
      console.log('That margin is thin. One new question could cross it.')
    }
  } else {
    console.log('\nNO single threshold separates these. The worst covered question scores')
    console.log('below the best uncovered one, so a score alone cannot decide whether to')
    console.log('answer. The agent needs another signal as well.')
  }
  console.log('')
}

main().catch((e) => {
  console.error(`\n${e.message}\n`)
  process.exit(1)
})
