'use client'

import { useEffect, useState } from 'react'
import Chat from './Chat'
import DatasetsView from './DatasetsView'
import Masthead, { type View } from './Masthead'
import { AnnouncerRegion, useAnnouncer } from './Announcer'
import PinnedDashboard from './PinnedDashboard'
import { useDatasets } from './useDatasets'
import { useConversations } from './useConversations'
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

/**
 * A rejected request means the cookie is gone or no longer valid — the passcode
 * changed on the server, or the week ran out. There is nothing this view can do
 * about it, so it hands the reader back to the gate, which is the same thing
 * middleware would do on the next navigation.
 */
function onRejected() {
  window.location.assign('/gate')
}

export default function Workspace() {
  const [view, setView] = useState<View>('ask')
  const announcer = useAnnouncer()
  const pins = usePins(onRejected)
  const datasets = useDatasets(onRejected)

  const activeKey = datasets.activeId ?? 'local'
  // Owned here rather than inside Chat so the list survives a view switch,
  // which unmounts nothing but does re-run effects in the hidden view.
  const conversations = useConversations(activeKey, onRejected)
  const active = datasets.datasets.find((d) => d.id === datasets.activeId)
  // One value for the masthead and for the exported chart's stamp, so a reader
  // cannot see one organisation on screen and another in the file they saved.
  const organisation = active?.organisation ?? null

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
        organisation={organisation}
        announce={announcer.announce}
      />
      {/* The live region sits outside every view, because a hidden view is
          removed from the accessibility tree and takes its region with it. */}
      <AnnouncerRegion message={announcer.message} />
      <main id="main-content" className="views" tabIndex={-1}>
        <Chat
          onRejected={onRejected}
          pins={pins}
          conversations={conversations}
          hidden={view !== 'ask'}
          datasetKey={activeKey}
          needsDataset={datasets.needsDataset}
          onGoToData={() => changeView('data')}
          organisation={organisation}
          announce={announcer.announce}
        />
        <PinnedDashboard
          pins={pins}
          organisation={organisation}
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
