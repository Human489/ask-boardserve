// Model usage meter — development instrumentation, not a product feature.
//
// Why this exists: Cloudflare reports cumulative usage through the dashboard
// and the GraphQL analytics API, and this project's API token is authorised
// for Workers AI but NOT for account analytics ("not authorized for that
// account"), so neither is reachable. What IS reachable is the usage block
// Workers AI returns on every single response — token counts and the Neuron
// cost of that call. Accumulating those gives an accurate picture of what THIS
// app spent, without any dashboard access.
//
// Two honest limits. It counts only calls this process made, so usage from
// anywhere else on the account is invisible. And it lives in memory, so it
// resets when the server restarts. That is fine for watching a dev session;
// it is not an account-level bill.

export interface CallUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  neurons: number
}

export interface UsageSnapshot {
  since: string
  calls: number
  failedCalls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  neurons: number
  /** Neurons per day, so a daily allowance can be read against it. */
  byDay: Record<string, { calls: number; neurons: number }>
  averagePromptTokens: number
  averageNeurons: number
}

// State lives on globalThis, not in module scope.
//
// Next bundles each route separately, so /api/ask and /api/usage can end up
// with their own instance of this module. Module-level counters then read zero
// from one route while the other has been incrementing — a meter reporting no
// model calls after twelve of them, which is worse than no meter. This is the
// same fault that made session tokens fail across a cold start, and the fix
// there was to remove the state; here the state is the point, so it is pinned
// somewhere both bundles can see.

interface UsageStore {
  startedAt: string
  calls: number
  failedCalls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  neurons: number
  byDay: Map<string, { calls: number; neurons: number }>
}

const GLOBAL_KEY = Symbol.for('ask-boardserve.usage')

function store(): UsageStore {
  const holder = globalThis as unknown as Record<symbol, UsageStore | undefined>
  const existing = holder[GLOBAL_KEY]
  if (existing) return existing
  const fresh: UsageStore = {
    startedAt: new Date().toISOString(),
    calls: 0,
    failedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    neurons: 0,
    byDay: new Map(),
  }
  holder[GLOBAL_KEY] = fresh
  return fresh
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function recordCall(usage: CallUsage): void {
  const s = store()
  s.calls++
  s.promptTokens += usage.promptTokens
  s.completionTokens += usage.completionTokens
  s.cachedTokens += usage.cachedTokens
  s.neurons += usage.neurons

  const day = today()
  const entry = s.byDay.get(day) ?? { calls: 0, neurons: 0 }
  entry.calls++
  entry.neurons += usage.neurons
  s.byDay.set(day, entry)
}

/** A model call that was attempted but produced nothing usable. */
export function recordFailure(): void {
  store().failedCalls++
}

/**
 * Reads the usage block Workers AI returns. Shapes differ slightly between the
 * REST and OpenAI-compatible responses, so both are accepted, and anything
 * missing counts as zero rather than NaN.
 */
export function usageFromResponse(body: unknown): CallUsage | null {
  const result = (body as { result?: Record<string, unknown> })?.result
  const raw = (result?.usage ?? (body as { usage?: unknown })?.usage) as
    | Record<string, unknown>
    | undefined
  if (!raw) return null

  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const details = raw.prompt_tokens_details as { cached_tokens?: unknown } | undefined

  return {
    promptTokens: n(raw.prompt_tokens),
    completionTokens: n(raw.completion_tokens),
    cachedTokens: n(details?.cached_tokens),
    neurons: n(raw.neurons),
  }
}

export function snapshot(): UsageSnapshot {
  const s = store()
  return {
    since: s.startedAt,
    calls: s.calls,
    failedCalls: s.failedCalls,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    cachedTokens: s.cachedTokens,
    neurons: Math.round(s.neurons * 100) / 100,
    byDay: Object.fromEntries(
      [...s.byDay.entries()].map(([d, v]) => [
        d,
        { calls: v.calls, neurons: Math.round(v.neurons * 100) / 100 },
      ]),
    ),
    averagePromptTokens: s.calls === 0 ? 0 : Math.round(s.promptTokens / s.calls),
    averageNeurons: s.calls === 0 ? 0 : Math.round((s.neurons / s.calls) * 100) / 100,
  }
}

export function resetUsage(): void {
  const holder = globalThis as unknown as Record<symbol, UsageStore | undefined>
  holder[GLOBAL_KEY] = undefined
}
