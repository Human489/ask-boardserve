// ingest-papers.mjs — embed the board papers into Vectorize.
//
//   node scripts/ingest-papers.mjs            ingest
//   node scripts/ingest-papers.mjs --dry-run  chunk only, no network
//
// Reads the papers through the app's own dataset loader rather than a separate
// corpus folder, so there is one source of truth for which papers exist.
//
// Derived from gai-rag-skeleton (Hamada Mahdi), scripts/ingest.ts.
//
// Every vector carries the organisation name as `datasetId`. The retrieval tool
// checks it on the way back out, so pointing DATASET_PATH at one organisation
// while CF_VECTORIZE_INDEX still points at another's index fails loudly instead
// of quietly answering with the wrong board's papers.

import { spawnSync } from 'node:child_process'
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

const DRY = process.argv.includes('--dry-run')
const ACCOUNT = process.env.CF_ACCOUNT_ID
const TOKEN = process.env.CF_API_TOKEN
const INDEX = process.env.CF_VECTORIZE_INDEX
const GATEWAY = process.env.CF_AI_GATEWAY_ID || 'default'
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'

if (!DRY && (!ACCOUNT || !TOKEN || !INDEX)) {
  console.error('Set CF_ACCOUNT_ID, CF_API_TOKEN and CF_VECTORIZE_INDEX in .env.local')
  process.exit(1)
}

// The chunker and loader are TypeScript with path aliases, so shell out to tsx
// rather than duplicating either here.
function chunksFromDataset() {
  // Single command string rather than an args array: passing args with
  // shell: true is deprecated because they are concatenated unescaped.
  const run = spawnSync('npx tsx scripts/dump-chunks.ts', { encoding: 'utf8', shell: true })
  if (run.status !== 0 || !run.stdout.includes('{')) {
    const detail = run.stderr || run.stdout || '(no output)'
    console.error(`Could not read the dataset:
${detail}`)
    process.exit(1)
  }
  return JSON.parse(run.stdout.slice(run.stdout.indexOf('{')))
}

const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`
const auth = { Authorization: `Bearer ${TOKEN}`, 'cf-aig-gateway-id': GATEWAY }

async function cf(path, init, what) {
  const res = await fetch(`${base}${path}`, init)
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) {
    const detail = json?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`
    throw new Error(`${what}: ${detail}`)
  }
  return json.result
}

const embed = (texts) =>
  cf(
    `/ai/run/${EMBED_MODEL}`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texts }) },
    'Embedding',
  ).then((r) => r.data)

const info = () => cf(`/vectorize/v2/indexes/${INDEX}/info`, { headers: auth }, 'Index info')

const upsert = (records) =>
  cf(
    `/vectorize/v2/indexes/${INDEX}/upsert`,
    {
      method: 'POST',
      // NDJSON: one object per line. A JSON array is rejected.
      headers: { ...auth, 'Content-Type': 'application/x-ndjson' },
      body: records.map((r) => JSON.stringify(r)).join('\n'),
    },
    'Upsert',
  )

async function main() {
  const { datasetId, asAt, papers, chunks } = chunksFromDataset()
  const totalWords = chunks.reduce((a, c) => a + c.words, 0)

  console.log(`\norganisation : ${datasetId}`)
  console.log(`papers       : ${papers}`)
  console.log(`chunks       : ${chunks.length}  (${totalWords} words, mean ${Math.round(totalWords / chunks.length)})`)
  console.log(`index        : ${DRY ? '(dry run)' : INDEX}\n`)

  for (const c of chunks) {
    console.log(`  ${c.id.padEnd(34)} ${String(c.words).padStart(3)}w  ${c.section}`)
  }

  if (DRY) {
    console.log('\nDry run: nothing embedded, nothing written.\n')
    return
  }

  const before = await info()
  if (before.dimensions !== 768) {
    console.error(`\nIndex ${INDEX} has ${before.dimensions} dimensions; ${EMBED_MODEL} produces 768. Nothing will work.`)
    process.exit(1)
  }
  console.log(`\nindex holds ${before.vectorCount} vectors before ingest`)

  // Small corpus, so one batch. Chunk ids are stable, so a re-run overwrites
  // rather than duplicating.
  const vectors = await embed(chunks.map((c) => c.text))
  console.log(`embedded ${vectors.length} chunks`)

  const records = chunks.map((c, i) => ({
    id: `${datasetId}::${c.id}`,
    values: vectors[i],
    metadata: {
      datasetId,
      asAt,
      paperId: c.paperId,
      paperTitle: c.paperTitle,
      section: c.section,
      chunkIndex: c.chunkIndex,
      text: c.text,
    },
  }))

  const { mutationId } = await upsert(records)
  console.log(`upserted, mutation ${mutationId}`)

  // Vectorize is eventually consistent, and becomes consistent a few vectors at
  // a time. Querying during that window returns confident, wrong answers. Poll
  // rather than sleeping for a guess.
  process.stdout.write('waiting for the index to catch up')
  const started = Date.now()
  let caughtUp = false
  while (Date.now() - started < 180_000) {
    const i = await info()
    if (i.processedUpToMutation === mutationId) {
      caughtUp = true
      console.log(`\ncaught up after ${Math.round((Date.now() - started) / 1000)}s — ${i.vectorCount} vectors`)
      break
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (!caughtUp) {
    console.warn('\nIndex did not report the mutation within 180s. Queries may be incomplete.')
    process.exit(1)
  }
  console.log('\nDone.\n')
}

main().catch((e) => {
  console.error(`\n${e.message}\n`)
  process.exit(1)
})
