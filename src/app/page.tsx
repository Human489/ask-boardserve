import Workspace from '@/components/Workspace'

// Middleware guarantees a session before this renders, so there is no gate
// here. The API routes still check the credential on every request — this page
// being reachable is not treated as proof of anything.

export default function Page() {
  return <Workspace />
}
