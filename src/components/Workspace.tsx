'use client'

import { useState } from 'react'
import Chat from './Chat'
import Masthead, { type View } from './Masthead'
import PinnedDashboard from './PinnedDashboard'
import { usePins } from './usePins'

// The authenticated container: it owns which view is showing and the pinned
// set, because both views need the pinned set and would otherwise disagree
// about it.
//
// Both views stay mounted and one is hidden. Unmounting the chat on every
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

  return (
    <div className="shell">
      <Masthead view={view} onView={setView} pinCount={pins.pins.length} />
      <Chat
        credential={credential}
        onRejected={onRejected}
        pins={pins}
        hidden={view !== 'ask'}
      />
      <PinnedDashboard pins={pins} hidden={view !== 'dashboard'} />
    </div>
  )
}
