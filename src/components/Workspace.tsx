'use client'

import { useEffect, useState } from 'react'
import Chat from './Chat'
import DatasetsView from './DatasetsView'
import Masthead, { type View } from './Masthead'
import { AnnouncerRegion, useAnnouncer } from './Announcer'
import PinnedDashboard from './PinnedDashboard'
import { useDatasets } from './useDatasets'
import { usePins } from './usePins'

// The authenticated container: it owns which view is showing, the pinned set,
// and which dataset is answering, because the three depend on one another.
//
// Both answer views stay mounted and one is hidden. Unmounting the chat on every
// switch would throw away the transcript, and with no session there is no way
// to get it back — switching to the dashboard to check something you pinned
// would cost you the conversation you were having.

const VIEW_NAMES: Record<View, string> = {
  ask: 'Ask',
  dashboard: 'Dashboard',
  data: 'Data',
}

export default function Workspace({
  credential,
  onRejected,
}: {
  credential: string
  onRejected: () => void
}) {
  const [view, setView] = useState<View>('ask')
  const announcer = useAnnouncer()
  const pins = usePins(credential, onRejected)
  const datasets = useDatasets(credential, onRejected)

  const activeKey = datasets.activeId ?? 'local'
  const active = datasets.datasets.find((d) => d.id === datasets.activeId)

  // Pins are stored per dataset, so the dashboard has to be re-read when the
  // dataset changes or it would show the previous organisation's cards.
  useEffect(() => {
    void pins.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload identity is stable
  }, [activeKey])

  // Nothing to answer from yet: send the reader where they can fix that,
  // rather than leaving them typing questions into a dead composer.
  useEffect(() => {
    if (datasets.needsDataset) setView('data')
  }, [datasets.needsDataset])

  // Switching view swaps the whole body of the page with no focus move and no
  // sound, so a screen-reader user had no confirmation the button did anything.
  const changeView = (next: View) => {
    setView(next)
    announcer.announce(`${VIEW_NAMES[next]} view.`)
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Masthead
        view={view}
        onView={changeView}
        pinCount={pins.pins.length}
        organisation={active?.organisation ?? (datasets.localAvailable ? null : null)}
      />
      {/* The live region sits outside every view, because a hidden view is
          removed from the accessibility tree and takes its region with it. */}
      <AnnouncerRegion message={announcer.message} />
      <main id="main-content" className="views" tabIndex={-1}>
        <Chat
          credential={credential}
          onRejected={onRejected}
          pins={pins}
          hidden={view !== 'ask'}
          datasetKey={activeKey}
          needsDataset={datasets.needsDataset}
          onGoToData={() => changeView('data')}
          announce={announcer.announce}
        />
        <PinnedDashboard
          pins={pins}
          hidden={view !== 'dashboard'}
          announce={announcer.announce}
        />
        <DatasetsView
          datasets={datasets}
          hidden={view !== 'data'}
          announce={announcer.announce}
        />
      </main>
    </div>
  )
}
