import type { Metadata } from 'next'
import ChartCard from '@/components/ChartCard'
import { readShare } from '@/lib/shares'

// The one page in this app with no passcode in front of it.
//
// It is a SNAPSHOT and it is READ-ONLY. Nothing here can ask a question, pin a
// chart, switch a dataset or reach the rest of the app: the page renders what
// was copied at share time and offers no route inwards. There is no composer,
// no navigation, and the API is never called from here.
//
// Everything reaching this page comes from `readShare`, which rejects a
// malformed token before it is used as a key, validates the record's shape,
// and checks the expiry itself rather than trusting the store's TTL.

export const runtime = 'nodejs'
// Always fresh: a revoked link must stop working immediately, and a cached
// render would keep serving board data after it was pulled.
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Keeps the page out of search results.
 *
 * Belt and braces with the X-Robots-Tag set in middleware: a link pasted into
 * anything that follows URLs must not end up indexed, and a crawler that
 * ignores one may honour the other.
 */
export const metadata: Metadata = {
  title: 'Shared dashboard',
  robots: { index: false, follow: false, nocache: true },
}

function formatExpiry(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default async function SharedDashboard({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const outcome = await readShare(token)

  if (!outcome.ok) {
    // One message for every failure. Distinguishing "expired" from "never
    // existed" would tell someone holding a guessed token that they had
    // guessed a real one.
    return (
      <main className="share-shell">
        <div className="share-gone">
          <h1>This link is not available</h1>
          <p>
            A shared dashboard link expires, and can be withdrawn at any time by whoever
            created it. Ask them for a new one.
          </p>
        </div>
      </main>
    )
  }

  const { share } = outcome

  return (
    <main className="share-shell">
      <header className="share-head">
        <p className="share-label">Shared dashboard · read only</p>
        <h1 className="share-title">{share.organisation}</h1>
        <p className="share-note">
          {share.pins.length} {share.pins.length === 1 ? 'chart' : 'charts'}, as they were when
          this link was created. The figures do not update, and this link stops working on{' '}
          {formatExpiry(share.expiresAt)}.
        </p>
      </header>

      {share.pins.map((pin) => (
        <section className="share-pinned" key={pin.id}>
          <h2 className="pinned-question">{pin.question}</h2>
          <ChartCard
            result={pin.result}
            routedBy={pin.routedBy}
            headingLevel={3}
            compact
            organisation={share.organisation}
          />
        </section>
      ))}

      <footer className="share-foot">
        <p>
          Every figure here was computed from the organisation&rsquo;s own records, not written
          by a language model. Open a card&rsquo;s working to see the assumptions behind it and
          where it came from.
        </p>
      </footer>
    </main>
  )
}
