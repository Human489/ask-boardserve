import { getConfig } from '@/lib/config'
import { recordCall, recordFailure, usageFromResponse } from '@/lib/usage'
import { checkClockAnchored, checkPapersScope } from '@/lib/retrieval/scope'
import type { Dataset, ToolDefinition } from '@/lib/types'

// Routing only. This file never computes a figure and never writes a headline:
// it decides which tool runs, with which arguments, or that nothing can answer.
//
// Two paths, same contract:
//   model    — Workers AI tool calling through the AI Gateway (probe-router.mjs)
//   fallback — a deterministic keyword classifier, used when there are no
//              credentials or the call fails. The app must work with neither.

export interface ToolRoute {
  kind: 'tool'
  name: string
  args: Record<string, unknown>
  routedBy: 'model' | 'fallback'
}

export interface RefusalRoute {
  kind: 'refusal'
  reason: string
  alternative?: string
  /**
   * Which path produced the refusal. A refusal the model chose is a different
   * signal from one the offline classifier matched by keyword, and the UI must
   * not report the first as the second.
   */
  routedBy: 'model' | 'fallback'
}

export type Route = ToolRoute | RefusalRoute

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

const TIMEOUT_MS = 8_000

// ------------------------------------------------------------------ prompt

const REFUSAL_RULES = [
  'There is no board-pack length, page count, circulation date or despatch date anywhere in the data, so pack size and notice periods cannot be answered.',
  'There are no minutes and no record of decisions: every board paper is a pre-meeting paper, so what was decided or what happened afterwards cannot be answered.',
  'The skills audit records self-assessed skill on a 1-5 scale, not professional qualifications, so questions about who is a qualified accountant, chartered surveyor or similar cannot be answered.',
  'Anything not present in the attendance records, the action log or the skills audit cannot be answered.',
]

function systemPrompt(tools: ToolDefinition[]): string {
  return [
    'You route company-secretary questions about board data to exactly one tool.',
    '',
    'These sources exist. Their fields are listed because a refusal that claims a field is',
    'absent when it is present tells the reader the product cannot do something it can, which',
    'is worse than a wrong number.',
    '- Attendance records: every meeting with its body, type and date; and one row per director',
    '  per meeting they were eligible for, with present/apologies/absent, minutes joined late,',
    '  and whether they attended remotely.',
    '- Action log: every action with its description, owner job title, owner type, the body that',
    '  raised it, due date, recorded status, completion date, times deferred, priority, and a',
    '  linked risk reference.',
    '- Skills audit: every director with their role, tenure in years, and a self-assessed score',
    '  for each skill area.',
    '- Board papers: the papers themselves, as prose.',
    '',
    'Prefer a structured tool whenever the answer is a number, a count, a date, a score or a',
    'ranking. Those live in the first three sources. search_board_papers is ONLY for what a',
    'paper says in words — a recommendation, a reason, an explanation, or a figure that exists',
    'nowhere but in the prose of a paper. A question about skill scores, tenure, meeting counts,',
    'attendance, risk references or action fields is never a papers question.',
    '',
    'Call exactly one tool. Never compute or state a number yourself; the tools produce every figure.',
    'Refuse by calling the refuse tool when the data cannot answer the question. Specifically:',
    ...REFUSAL_RULES.map((r) => `- ${r}`),
    'Questions about what the board papers say, recommend or explain go to search_board_papers. It reads the papers and will itself refuse if they do not cover the subject, so route there rather than refusing on their behalf.',
    `The tools you may call are: ${tools.map((t) => t.name).join(', ')}, refuse.`,
  ].join('\n')
}

/** Tool schemas are generated from the registry, so a new tool needs no edit here. */
function toOpenAiTools(tools: ToolDefinition[]) {
  const generated = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, p]) => [
            k,
            p.enum
              ? { type: p.type, description: p.description, enum: p.enum }
              : { type: p.type, description: p.description },
          ]),
        ),
        required: t.required,
      },
    },
  }))
  generated.push({
    type: 'function',
    function: {
      name: 'refuse',
      description:
        'Call this only when NO source above holds the subject at all. Not when a tool ' +
        'happens not to compute the exact figure asked for: if the underlying field exists, ' +
        'pick the closest structured tool instead and let it answer what it can. Never state ' +
        'that a field is absent unless it truly is — the reader will believe you.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'Why this cannot be answered. Word it as what no TOOL computes, not as what the ' +
              'DATA lacks — say "no tool works out the busiest committee" rather than "the data ' +
              'does not record meetings", because the second is usually false and the reader ' +
              'will believe it. Name the closest thing that is held.',
          },
        },
        required: ['reason'],
      },
    },
  })
  return generated
}

// ------------------------------------------------------------------ fallback
//
// Deterministic classifier. Refusal patterns are checked first, in an order that
// matters: "what do the papers say about CQC readiness" is a retrieval question,
// not a qualifications one, so retrieval is tested before qualifications.

const PACK_PATTERNS =
  /\b(board )?pack(s)?\b|\bnotice period\b|\benough notice\b|\bcirculat|\bdespatch|\bdispatch|\bpage count\b|\bhow long are our\b/

const MINUTES_PATTERNS =
  /\bminute(s)?\b|\bresolved\b|\bresolution(s)?\b|\bwhat did we decide\b|\bwhat was decided\b|\bdecided\b|\bdecision(s) (taken|made)\b/

const RETRIEVAL_PATTERNS =
  /\bboard paper(s)?\b|\bpaper(s)?\b|\bdocument(s)?\b|\bcorpus\b|\bwhat do the .*say\b/

const QUALIFICATION_PATTERNS =
  /\bqualified\b|\bqualification(s)?\b|\baccountant(s)?\b|\bchartered\b|\bdegree(s)?\b|\bacca\b|\bicaew\b/

/**
 * Attributes nothing in the dataset measures at all. Distinct from the
 * qualification case: the skills audit is at least adjacent to "is this
 * director an accountant", whereas nothing here is adjacent to an IQ score.
 * Giving these the qualification wording would be a wrong explanation of a
 * right refusal.
 */
const UNMEASURED_PATTERNS = /\biq\b|\bintelligence\b|\bpersonality\b|\bage(s)?\b|\bsalary\b|\bpay\b/

/**
 * Tenure and term-limit questions. These read as structured questions but are
 * not: there is no appointment date or term-expiry field anywhere in the data,
 * and the nine-year limit exists only as prose in a board paper. Without this
 * the keyword scorer matched "months", or "committee" plus "coverage", and
 * returned a real chart about something else entirely — a confidently wrong
 * answer, which is worse than a visible failure.
 */
const TENURE_PATTERNS =
  /\bterm limits?\b|\btimes? out\b|\btiming out\b|\btenure\b|\bterm expir|\bsteps? down\b|\brotates? off\b|\bre-?appoint|\byears? on the board\b|\bserved\b[^.?]*\byears?\b|\b(?:\d+|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ]years?\b[^.?]*\b(?:limit|maximum|term)\b/

/**
 * Per-tool keyword scoring for the offline path.
 *
 * An earlier version scored three broad CATEGORIES (attendance / actions /
 * skills) and then took the first tool in the winning category. With twelve
 * tools and three categories that can only ever return three distinct answers,
 * so nine of the twelve tools were unreachable. Scoring must therefore
 * discriminate between tools, not between subject areas.
 *
 * Each entry is a list of term GROUPS. A group scores only if every term in it
 * appears, and it scores its own length — so co-occurrence ("committee" AND
 * "skill") outranks a single loose keyword, which is what separates sibling
 * tools that share a subject area.
 *
 * Terms are matched as substrings, so "skill" covers "skills" and "defer"
 * covers "deferred". Nothing here is organisation-specific: these are tool
 * names and English question words, not directors, committees or skills.
 */
const TOOL_HINTS: Record<string, string[][]> = {
  attendance_below_threshold: [
    ['below', 'threshold'],
    ['threshold'],
    ['who', 'below'],
    ['under', 'attendance'],
    ['poor', 'attend'],
  ],
  attendance_by_meeting: [
    ['meeting', 'attendance'],
    ['unusually', 'low'],
    ['when'],
    ['trend'],
    ['over the year'],
    ['month'],
    ['dip'],
  ],
  attendance_by_committee: [
    ['committee', 'attendance'],
    ['committee', 'lowest'],
    ['which committee', 'attend'],
  ],
  meetings_missed: [
    ['missed', 'meeting'],
    ['missed', 'most'],
    ['eligible'],
    ['absent'],
    ['apolog'],
  ],
  overdue_actions: [
    ['action', 'overdue'],
    ['overdue', 'own'],
    ['what', 'overdue'],
  ],
  longest_overdue: [
    ['longest'],
    ['outstanding', 'longest'],
    ['overdue', 'longest'],
    ['oldest'],
  ],
  unresolved_by_committee: [
    ['unresolved'],
    ['committee', 'unresolved'],
    ['carrying'],
    ['committee', 'work'],
  ],
  actions_distribution: [
    ['distribut'],
    ['action', 'distribut'],
    ['outstanding', 'distribut'],
    ['across', 'owner'],
    ['concentrated'],
    ['spread'],
  ],
  deferred_more_than_once: [
    ['defer'],
    ['defer', 'once'],
    ['more than once'],
    ['twice'],
    ['pushed back'],
  ],
  skills_gaps: [
    ['skill', 'gap'],
    ['biggest', 'skill'],
    ['weakest'],
    ['strongest', 'weakest'],
    // The audit's own vocabulary: "4 or above" and "2 or below" are the counts
    // this tool reports, so a question phrased in them belongs here even when
    // it also says "coverage".
    ['skill', 'fewest'],
    ['4 or above'],
    ['2 or below'],
  ],
  gap_coverage: [
    ['coverage'],
    ['cover', 'gap'],
    ['director', 'coverage'],
    ['who', 'cover'],
  ],
  // The two hybrid tools. Their terms are deliberately narrow: "due" alone
  // belongs to the overdue tools, and "skills" alone to the skills tools, so
  // both entries require a word that only a forward-looking or tenure question
  // would use.
  upcoming_unprepared: [
    ['not started'],
    ['preparing'],
    ['prepare'],
    ['coming', 'quarter'],
    ['coming up'],
    ['upcoming'],
    ['due', 'soon'],
    ['next quarter'],
    ['falls due'],
  ],
  tenure_and_skills_impact: [
    ['times out'],
    ['term limit'],
    ['tenure'],
    ['step down'],
    ['served', 'years'],
  ],
  committee_skills_gaps: [
    ['committee', 'skill'],
    ['committee', 'gap'],
  ],
}

/**
 * Falls back to the tool's own name and description when it has no hint entry,
 * so a newly registered tool is reachable without editing this file.
 */
function genericScore(q: string, tool: ToolDefinition): number {
  const words = new Set(
    `${tool.name.replace(/_/g, ' ')} ${tool.description}`
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 4),
  )
  let n = 0
  for (const w of words) if (q.includes(w)) n += 0.25
  return n
}

function scoreTools(q: string, tools: ToolDefinition[]): { tool: ToolDefinition; score: number }[] {
  return tools
    .map((tool) => {
      const groups = TOOL_HINTS[tool.name] ?? []
      let score = 0
      for (const group of groups) {
        if (group.every((term) => q.includes(term))) score += group.length
      }
      return { tool, score: score + genericScore(q, tool) }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * Arguments are inferred from the tool's own enums: pick the enum value whose
 * words appear in the question, else the declared default, else the first value.
 * Nothing about any particular tool is assumed.
 */
function inferArgs(tool: ToolDefinition, q: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [name, param] of Object.entries(tool.parameters)) {
    const required = tool.required.includes(name)
    if (param.enum && param.enum.length > 0) {
      const hit = param.enum.find((v) =>
        v
          .toLowerCase()
          .split('_')
          .filter((w) => w.length > 2)
          .some((w) => q.includes(w)),
      )
      if (hit) args[name] = hit
      else if (param.default !== undefined) args[name] = param.default
      else if (required) args[name] = param.enum[0]
    } else if (param.default !== undefined) {
      args[name] = param.default
    }
  }
  return args
}

/**
 * The model returns arguments as JSON with loose types — a numeric parameter
 * commonly comes back as the string "10", and a boolean as "true". Coerce each
 * value to the type the tool declared, and drop anything the tool does not
 * declare at all, so a hallucinated argument cannot reach a tool.
 */
/** Retained name for the tests that assert the bounds behaviour. */
export function coerceArgsForTest(
  tool: ToolDefinition,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return coerceArgs(tool, raw)
}

/**
 * Exported because arguments arrive from outside the router too. Pinning a
 * chart posts a tool name and arguments, and running those unvalidated would
 * put every declared bound, enum and default on the honour system — an
 * out-of-range value would reach a tool and be reported as a finding.
 */
export function coerceArgs(
  tool: ToolDefinition,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw)) {
    const param = tool.parameters[name]
    if (!param) continue
    if (param.type === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      // Out of range is dropped rather than clamped: clamping 0 to 1 would
      // still answer a question the user did not ask, whereas dropping it
      // falls back to the tool's documented default.
      const inRange =
        Number.isFinite(n) &&
        (param.min === undefined || n >= param.min) &&
        (param.max === undefined || n <= param.max)
      if (inRange) out[name] = n
    } else if (param.type === 'boolean') {
      out[name] = typeof value === 'boolean' ? value : String(value).trim() === 'true'
    } else {
      const str = String(value)
      // Reject an enum value the tool does not offer rather than passing it on.
      if (param.enum && !param.enum.includes(str)) continue
      out[name] = str
    }
  }
  return out
}

export function fallbackRoute(question: string, tools: ToolDefinition[]): Route {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ')} `

  if (PACK_PATTERNS.test(q)) {
    return {
      kind: 'refusal',
      routedBy: 'fallback',
      reason:
        'The data records only meeting id, body, type and date. There is no page count, word count, circulation date or despatch date, so pack length and notice periods cannot be computed.',
      alternative:
        'The attendance records can show which meetings were held and when, if that helps.',
    }
  }

  if (MINUTES_PATTERNS.test(q)) {
    return {
      kind: 'refusal',
      routedBy: 'fallback',
      reason:
        'There are no minutes in this dataset. Every board paper is a pre-meeting paper asking the board to decide, so no record of what was decided or what followed exists.',
      alternative:
        'The action log can evidence what was actually completed after each meeting.',
    }
  }

  // Document questions now have a tool. The patterns still run here, ahead of
  // the keyword scorer, because "what do the papers say about X" would
  // otherwise score against whichever structured tool shares a word with X.
  if (RETRIEVAL_PATTERNS.test(q)) {
    const papers = tools.find((t) => t.name === 'search_board_papers')
    if (papers) {
      return {
        kind: 'tool',
        name: papers.name,
        args: { question },
        routedBy: 'fallback',
      }
    }
  }

  // Tenure questions used to refuse here, because answering them needs a term
  // limit that exists only as prose and there was no tool to read it. There is
  // now, so they route to it. It refuses on its own account if no paper states
  // a limit.
  if (TENURE_PATTERNS.test(q)) {
    const tenure = tools.find((t) => t.name === 'tenure_and_skills_impact')
    if (tenure) {
      return {
        kind: 'tool',
        name: tenure.name,
        args: inferArgs(tenure, q),
        routedBy: 'fallback',
      }
    }
  }

  if (UNMEASURED_PATTERNS.test(q)) {
    return {
      kind: 'refusal',
      routedBy: 'fallback',
      reason:
        'Nothing in the attendance records, action log or skills audit measures that. The dataset covers meeting attendance, board actions and a self-assessed skills audit, and nothing else about individual directors.',
      alternative:
        'It can answer questions about attendance, outstanding actions, or self-assessed skill by area.',
    }
  }

  if (QUALIFICATION_PATTERNS.test(q)) {
    return {
      kind: 'refusal',
      routedBy: 'fallback',
      reason:
        'The skills audit records self-assessed skill on a 1-5 scale, not professional qualifications or credentials, so it cannot say who holds any given qualification.',
      alternative:
        'It can show self-assessed strength by skill area, which is a different claim and should be read as one.',
    }
  }

  const ranked = scoreTools(q, tools)
  const best = ranked[0]
  if (!best || best.score < 1) {
    return {
      kind: 'refusal',
      routedBy: 'fallback',
      reason:
        'Nothing in the attendance records, action log or skills audit answers this question.',
      alternative:
        'Try asking about attendance, outstanding or overdue actions, or the board skills audit.',
    }
  }

  return { kind: 'tool', name: best.tool.name, args: inferArgs(best.tool, q), routedBy: 'fallback' }
}

// ------------------------------------------------------------------ model

async function modelRoute(
  question: string,
  tools: ToolDefinition[],
  history: HistoryTurn[],
): Promise<Route | null> {
  const cfg = getConfig()
  // The Workers AI REST endpoint, with the gateway applied via the
  // cf-aig-gateway-id header. The gateway.ai.cloudflare.com/{account}/{gateway}
  // URL form was tried first and returns 401 on this account: it requires a
  // gateway to already exist under that exact name. The header form routes
  // through the gateway without depending on that, and is what the brief asks
  // for.
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflareAccountId}/ai/run/${cfg.model}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.cloudflareApiToken}`,
        'Content-Type': 'application/json',
        'cf-aig-gateway-id': cfg.aiGatewayId,
      },
      body: JSON.stringify({
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt(tools) },
          // History gives pronouns something to resolve against ("and by committee?").
          ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: question },
        ],
        tools: toOpenAiTools(tools),
      }),
    })
    if (!res.ok) {
      // Log loudly. Falling back silently means a broken gateway looks exactly
      // like no credentials at all, and the only visible symptom is that every
      // answer says it was routed by the offline classifier.
      recordFailure()
      const detail = await res.text().catch(() => '')
      console.error(
        `[router] AI Gateway returned ${res.status}. Falling back to the offline ` +
          `classifier. ${detail.slice(0, 300)}`,
      )
      return null
    }

    // This endpoint wraps everything in `result`, and returns tool calls in two
    // shapes: an OpenAI-style one under choices[], and a flatter one at the top
    // level whose `arguments` is already an object rather than a JSON string.
    // Read either.
    const body = (await res.json()) as {
      result?: {
        usage?: Record<string, unknown>
        tool_calls?: { name?: string; arguments?: unknown }[]
        choices?: {
          message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }
        }[]
      }
    }
    // Workers AI reports token counts and the Neuron cost of this call on every
    // response. Recording them here is the only usage visibility available:
    // the account analytics API refuses this token.
    const usage = usageFromResponse(body)
    if (usage) {
      recordCall(usage)
      if (process.env.NODE_ENV !== 'production') {
        console.info(
          `[usage] ${usage.promptTokens} in / ${usage.completionTokens} out, ` +
            `${usage.neurons.toFixed(2)} neurons`,
        )
      }
    }

    const result = body.result
    const fn =
      result?.choices?.[0]?.message?.tool_calls?.[0]?.function ?? result?.tool_calls?.[0]
    if (!fn?.name) return null

    let args: Record<string, unknown> = {}
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>
      } catch {
        args = {}
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>
    }

    if (fn.name === 'refuse') {
      const reason =
        typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim()
          : 'The available data cannot answer this question.'
      return { kind: 'refusal', reason, routedBy: 'model' }
    }

    const chosen = tools.find((t) => t.name === fn.name)
    if (!chosen) return null

    // Fill any argument the model omitted, so a tool never runs under-specified.
    const filled = { ...inferArgs(chosen, ` ${question.toLowerCase()} `), ...coerceArgs(chosen, args) }
    return { kind: 'tool', name: chosen.name, args: filled, routedBy: 'model' }
  } catch (e) {
    recordFailure()
    const reason = (e as Error)?.name === 'AbortError' ? 'timed out' : String(e)
    console.error(`[router] model routing failed (${reason}); using the offline classifier.`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function routeQuestion(
  question: string,
  tools: ToolDefinition[],
  history: HistoryTurn[] = [],
  dataset?: Dataset,
): Promise<Route> {
  // A question anchored to the reader's clock cannot be answered by a dated
  // snapshot, whichever tool it reaches. Decided before routing so the answer is
  // not a real chart about a different period.
  if (dataset) {
    const clock = checkClockAnchored(question)
    if (clock.anchored) {
      const meetings = dataset.attendance.meetings
      const latest = meetings.map((m) => m.date).sort().at(-1)
      return {
        kind: 'refusal',
        routedBy: 'fallback',
        reason:
          `This asks about "${clock.phrase}", which is a moment on your calendar rather than ` +
          `in the data. These figures are a snapshot as at ${dataset.asAt}` +
          (latest ? `, and the most recent meeting in them was on ${latest}` : '') +
          `, so nothing here can speak to it.`,
        alternative: latest
          ? `Asking about the meeting on ${latest}, or about the year as a whole, is answerable.`
          : 'Asking about the period the data covers is answerable.',
      }
    }
  }

  if (getConfig().hasModelCredentials) {
    const routed = await modelRoute(question, tools, history)
    if (routed) return guardPapersRoute(routed, question, tools, dataset)
    console.warn('[router] model routing unavailable; using the deterministic fallback')
  }
  return guardPapersRoute(fallbackRoute(question, tools), question, tools, dataset)
}

/**
 * Refuses to send a structured question to the board papers.
 *
 * The model was told not to, in the papers tool's own description, and did it
 * anyway — the same reason the figure verifier exists. Telling a model
 * something is a request; checking is a check.
 *
 * With no dataset the check cannot run, so the route passes through unchanged
 * rather than being blocked on a guess.
 */
function guardPapersRoute(
  route: Route,
  question: string,
  tools: ToolDefinition[],
  dataset?: Dataset,
): Route {
  // Only the papers tool is guarded. The tenure tool deliberately reads a paper
  // AND computes, so naming structured data is expected of it, not a mistake.
  if (route.kind !== 'tool' || route.name !== 'search_board_papers' || !dataset) return route

  const scope = checkPapersScope(question, dataset)
  if (!scope.belongsToStructuredData) return route

  console.warn(
    `[router] question names structured data (${scope.matched.join(', ')}); ` +
      'not routing it to the board papers',
  )

  // Try the deterministic classifier for a structured tool. If it also lands on
  // the papers, or refuses, say plainly that no tool computes this rather than
  // asking the papers a question they cannot hold the answer to.
  const retry = fallbackRoute(question, tools)
  if (retry.kind === 'tool' && retry.name !== 'search_board_papers') return retry

  return {
    kind: 'refusal',
    routedBy: route.routedBy,
    reason:
      `This asks about ${scope.matched.slice(0, 3).join(', ')}, which is held in the ` +
      `attendance records, action log or skills audit rather than in the board papers. ` +
      `No tool computes exactly this, so there is nothing to show — the data is there, the ` +
      `analysis is not.`,
    alternative:
      'Asking it a different way often reaches a tool that can: by committee, by director, or by what is overdue.',
  }
}
