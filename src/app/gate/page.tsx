import Masthead from '@/components/Masthead'
import PasscodeForm from '@/components/PasscodeForm'

// Served by middleware to anyone without a session. It carries the form and the
// masthead and nothing else: no dataset, no analytics, and none of the
// application's JavaScript, which used to be public because the gate was drawn
// inside the app rather than in front of it.

export default function GatePage() {
  return (
    <div className="shell">
      <Masthead />
      <main id="main-content" className="gate" tabIndex={-1}>
        <PasscodeForm />
      </main>
    </div>
  )
}
