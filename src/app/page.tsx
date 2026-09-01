import Chat from '@/components/Chat'

export default function Page() {
  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead-inner">
          <h1 className="wordmark">Ask BoardServe</h1>
          <p className="positioning">
            A companion to BoardServe&rsquo;s analytics, not a replacement — for the
            questions a fixed dashboard was never built to answer.
          </p>
        </div>
      </header>
      <Chat />
    </div>
  )
}
