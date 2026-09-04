// wipe-kv.ts — list, and optionally delete, everything this app has stored in KV.
//
//   npx tsx scripts/wipe-kv.ts               # LIST ONLY. Never deletes.
//   npx tsx scripts/wipe-kv.ts --delete-all  # actually deletes
//   npx tsx scripts/wipe-kv.ts --delete-all --prefix pins:v1:
//
// Listing is the default and deleting needs the explicit flag, because what is
// in here is not reproducible: a pinned dashboard and a saved conversation were
// made by hand, and a live share link is a URL somebody may already hold. The
// AI cache and the rate-limit buckets ARE reproducible, and are the only two
// things here that cost nothing to lose.
//
// Not part of the app. The app never enumerates or bulk-deletes keys — this is
// an operator tool for resetting a demo to a clean slate.

import { readFileSync } from 'node:fs'

function loadEnv(): void {
  let raw = ''
  try {
    raw = readFileSync('.env.local', 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

const ACCOUNT = process.env.CF_ACCOUNT_ID
const TOKEN = process.env.CF_API_TOKEN
const NAMESPACE = process.env.CF_KV_NAMESPACE_ID

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}`
const auth = { Authorization: `Bearer ${TOKEN}` }

/** What each prefix holds, and whether losing it costs anything. */
const FAMILIES: { prefix: string; what: string; recoverable: boolean }[] = [
  // Two prefixes, one letter apart, and it matters: `datasets:v1:` is the
  // registry (which dataset is active, and the index of them) while
  // `dataset:v1:` holds an uploaded dataset's actual FILES. Listing only the
  // plural one reported the uploaded dataset as an unrecognised key.
  { prefix: 'datasets:v1:', what: 'the registry: which dataset is active', recoverable: false },
  { prefix: 'dataset:v1:', what: "an uploaded dataset's files", recoverable: false },
  { prefix: 'pins:v1:', what: 'pinned dashboards', recoverable: false },
  { prefix: 'conversations:v1:', what: 'saved conversations', recoverable: false },
  { prefix: 'share:v1:', what: 'live share links (the token IS the credential)', recoverable: false },
  { prefix: 'shares:v1:', what: "the owner's index of share links", recoverable: false },
  { prefix: 'aicache:', what: 'cached routing, embeddings and judge results', recoverable: true },
  // `ratelimit:`, not `rl:`, and it covers the sign-in budget too: the key is
  // `ratelimit:<bucket key>:<window>`, and the gate's budget passes
  // `auth:<ip>` as that bucket key. Listed as `rl:` plus a separate `auth:`
  // family, neither ever matched, and every rate-limit key was reported as an
  // unrecognised prefix — which is exactly what the unrecognised bucket is for.
  { prefix: 'ratelimit:', what: 'rate-limit and sign-in budgets', recoverable: true },
]

interface KeyRow {
  name: string
}

async function listAll(prefix?: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const url = new URL(`${BASE}/keys`)
    url.searchParams.set('limit', '1000')
    if (prefix) url.searchParams.set('prefix', prefix)
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { headers: auth })
    const body = (await res.json()) as {
      success: boolean
      result?: KeyRow[]
      result_info?: { cursor?: string }
      errors?: { message: string }[]
    }
    if (!body.success) {
      throw new Error(`list failed: ${body.errors?.map((e) => e.message).join('; ') ?? res.status}`)
    }
    for (const row of body.result ?? []) keys.push(row.name)
    cursor = body.result_info?.cursor || undefined
  } while (cursor)
  return keys
}

/** Bulk delete, in the 10,000-key batches the API accepts. */
async function deleteKeys(keys: string[]): Promise<number> {
  let done = 0
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const res = await fetch(`${BASE}/bulk/delete`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
    const body = (await res.json()) as { success: boolean; errors?: { message: string }[] }
    if (!body.success) {
      throw new Error(`delete failed: ${body.errors?.map((e) => e.message).join('; ') ?? res.status}`)
    }
    done += batch.length
    process.stdout.write(`  deleted ${done}/${keys.length}\r`)
  }
  process.stdout.write('\n')
  return done
}

async function main(): Promise<void> {
  if (!ACCOUNT || !TOKEN || !NAMESPACE) {
    console.error(
      'CF_ACCOUNT_ID, CF_API_TOKEN and CF_KV_NAMESPACE_ID must be set (.env.local).',
    )
    process.exit(2)
  }

  const argv = process.argv.slice(2)
  const doDelete = argv.includes('--delete-all')
  const prefixArg = argv.indexOf('--prefix')
  const only = prefixArg > -1 ? argv[prefixArg + 1] : undefined

  const keys = await listAll(only)
  console.log(`\nNamespace ${NAMESPACE}`)
  console.log(`${keys.length} key${keys.length === 1 ? '' : 's'}${only ? ` under ${only}` : ''}\n`)

  const seen = new Set<string>()
  for (const family of FAMILIES) {
    const mine = keys.filter((k) => k.startsWith(family.prefix))
    for (const k of mine) seen.add(k)
    if (mine.length === 0) continue
    const flag = family.recoverable ? '   ' : ' ! '
    console.log(`${flag}${String(mine.length).padStart(4)}  ${family.prefix.padEnd(20)} ${family.what}`)
    // Names only for the families that are not reproducible, so an operator
    // can see what they are about to lose. Never values: a conversation holds
    // headlines about named directors.
    if (!family.recoverable) {
      for (const k of mine.slice(0, 12)) console.log(`          ${k}`)
      if (mine.length > 12) console.log(`          … and ${mine.length - 12} more`)
    }
  }
  const other = keys.filter((k) => !seen.has(k))
  if (other.length > 0) {
    console.log(`\n   ${String(other.length).padStart(4)}  (unrecognised prefix)`)
    for (const k of other.slice(0, 20)) console.log(`          ${k}`)
  }
  console.log('\n  ! = not reproducible; losing it loses something a person made.')

  if (!doDelete) {
    console.log('\nListed only. Pass --delete-all to delete these.\n')
    return
  }
  if (keys.length === 0) {
    console.log('\nNothing to delete.\n')
    return
  }
  console.log(`\nDeleting ${keys.length} keys…`)
  const done = await deleteKeys(keys)
  const left = await listAll(only)
  console.log(`Deleted ${done}. ${left.length} key${left.length === 1 ? '' : 's'} remain.\n`)
}

void main()
