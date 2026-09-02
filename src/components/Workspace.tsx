'use client'

import { useEffect, useState } from 'react'
import Chat from './Chat'
import DatasetsView from './DatasetsView'
import Masthead, { type View } from './Masthead'
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

export default function Workspace({
  credential,
  onRejected,
}: {
  credential: string
  onRejected: () => void
}) {
  const [view, setView] = useState<View>('ask')
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

  return (
    <div className="shell">
      <Masthead
        view={view}
        onView={setView}
        pinCount={pins.pins.length}
        organisation={active?.organisation ?? (datasets.localAvailable ? null : null)}
      />
      <Chat
        credential={credential}
        onRejected={onRejected}
        pins={pins}
        hidden={view !== 'ask'}
        datasetKey={activeKey}
        needsDataset={datasets.needsDataset}
        onGoToData={() => setView('data')}
      />
      <PinnedDashboard pins={pins} hidden={view !== 'dashboard'} />
      <DatasetsView datasets={datasets} hidden={view !== 'data'} />
    </div>
  )
}
