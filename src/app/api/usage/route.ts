import { NextResponse } from 'next/server'
import { getConfig } from '@/lib/config'
import { snapshot } from '@/lib/usage'

export const runtime = 'nodejs'

// Development instrumentation. This is not a product surface: it is not linked
// from the UI, and it 404s in production so a deployment cannot expose usage
// figures or confirm the endpoint exists.
//
// It reports what THIS process spent since it started. It is not an
// account-level total — usage from anywhere else on the Cloudflare account is
// invisible here, and the counters reset with the server.

// Not async: nothing here awaits, and Next accepts a synchronous handler.
export function GET() {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 })
  }

  const usage = snapshot()
  const cfg = getConfig()

  return NextResponse.json({
    ...usage,
    model: cfg.model,
    modelCredentials: cfg.hasModelCredentials,
    note:
      'Counts only model calls made by this server process since it started, ' +
      'read from the usage block Workers AI returns on each response. Not an ' +
      'account total, and reset on restart. Cloudflare account analytics are ' +
      'not reachable with the current API token.',
  })
}
