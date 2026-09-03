import { NextResponse } from 'next/server'
import { rejectUnauthorised } from '@/lib/apiauth'
import { getConfig } from '@/lib/config'
import { cacheDisabled } from '@/lib/aicache'
import { snapshot } from '@/lib/usage'

export const runtime = 'nodejs'

// Development instrumentation. This is not a product surface: it is not linked
// from the UI, and it 404s in production so a deployment cannot expose usage
// figures or confirm the endpoint exists.
//
// It reports what THIS process spent since it started. It is not an
// account-level total — usage from anywhere else on the Cloudflare account is
// invisible here, and the counters reset with the server.

export async function GET(req: Request) {
  // The only route besides /api/login that did not check for itself. It was
  // covered by middleware, which contradicted middleware's own comment that
  // every route checks again — and middleware now passes API requests through
  // so their handlers can charge the guessing budget.
  const denied = await rejectUnauthorised(req)
  if (denied) return denied

  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 })
  }

  const usage = snapshot()
  const cfg = getConfig()

  return NextResponse.json({
    ...usage,
    model: cfg.model,
    modelCredentials: cfg.hasModelCredentials,
    // Read by the eval harness, which cannot otherwise know whether its
    // stability figures mean anything: with the cache on, every repeat of a
    // question returns the first answer, so a flaky router reports as
    // perfectly stable.
    aiCacheDisabled: cacheDisabled(),
    note:
      'Counts only model calls made by this server process since it started, ' +
      'read from the usage block Workers AI returns on each response. Not an ' +
      'account total, and reset on restart. Cloudflare account analytics are ' +
      'not reachable with the current API token.',
  })
}
