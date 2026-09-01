export const metadata = { title: 'Ask BoardServe — sign in' }

interface Props {
  searchParams: Promise<{ next?: string; error?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const { next = '/', error } = await searchParams

  return (
    <main style={{ maxWidth: '22rem', margin: '4rem auto', padding: '0 1rem' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>Ask BoardServe</h1>
      <p style={{ marginTop: 0, color: '#555' }}>Enter the passcode to continue.</p>

      <form method="post" action="/api/login">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="passcode" style={{ display: 'block', marginBottom: '0.375rem' }}>
          Passcode
        </label>
        <input
          id="passcode"
          name="passcode"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          style={{ width: '100%', padding: '0.5rem', marginBottom: '0.75rem' }}
        />
        {error ? (
          <p role="alert" style={{ color: '#b00020', margin: '0 0 0.75rem' }}>
            That passcode was not recognised. Please try again.
          </p>
        ) : null}
        <button type="submit" style={{ width: '100%', padding: '0.5rem' }}>
          Sign in
        </button>
      </form>
    </main>
  )
}
