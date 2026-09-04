import { cached, CACHE_TTL_SECONDS } from '@/lib/aicache'
import { getConfig } from '@/lib/config'
import { recordCall, recordFailure, usageFromResponse } from '@/lib/usage'
import type { Passage, SearchResult } from '@/lib/retrieval/search'

// The grounding judge.
//
// Retrieval ranks; this decides whether the ranked passages actually answer the
// question. It is a model call because no calibrated number can make that
// decision — see search.ts — and because a model judgement needs no calibration
// it is the only part of this that travels to another dataset unchanged.
//
// The model is told, explicitly, that refusing is a correct outcome. Left to
// infer it, a model handed five passages will summarise them whatever they say.

/**
 * 25 seconds, matching the router's budget for the same model.
 *
 * It was 12s, chosen when this call had no `max_tokens` and was therefore
 * capped at the provider's 256 output tokens — which is why it never
 * overran: it was being truncated long before it was slow. Giving the model
 * room to finish reasoning made the call take the time it actually needs, and
 * 12s then cut off the majority of questions.
 *
 * Measured end to end through /api/ask, not guessed: a question that succeeds
 * takes about 10.5s, which was already inside a whisker of the old cap, and
 * the broader questions were aborting at 12s. The router allows 25s for the
 * same model doing a comparable amount of thinking on a SMALLER prompt, so
 * this is the asymmetry being corrected rather than a number being raised
 * until things pass.
 */
const TIMEOUT_MS = 25_000

export interface GroundedAnswer {
  answered: boolean
  /** Prose answer when answered; the reason when not. */
  text: string
  /** Papers actually cited, in the order the model used them. */
  cited: { paperTitle: string; section: string; paperId: string }[]
  /** The passages behind those citations, so the answer can be checked against them. */
  citedPassages: Passage[]
}

function passageBlock(passages: Passage[]): string {
  return passages
    .map(
      (p, i) =>
        `[${i + 1}] ${p.paperTitle} — ${p.section}\n${p.text}`,
    )
    .join('\n\n')
}

function systemPrompt(missingTerms: string[]): string {
  const lines = [
    'You answer a company secretary\'s question using ONLY the numbered passages supplied.',
    'These passages are extracts from board papers. They are the only source you may use.',
    '',
    'Refusing is a correct answer, not a failure. The passages were selected because they',
    'are the closest available, NOT because they answer the question. A passage can be about',
    'the same subject and still not contain the fact being asked for. If the answer is not',
    'stated in the passages, say so plainly and say what they cover instead.',
    '',
    'But do not refuse an answer that is there. If the passages give the answer, whether in',
    'one sentence or spread across several, answer it. An explanation does not have to begin',
    '"because" to be an explanation. Refuse when the SUBJECT is absent, not when the wording',
    'is indirect.',
    '',
    'Never use knowledge from outside the passages.',
    '',
    'You may connect passages. If a question asks what recurs, what the papers have in',
    'common, or how one thing relates to another, comparing them is the answer, not an',
    'invention — say which passages show it. What you may not do is introduce a fact none',
    'of them contains.',
    '',
    'Do no arithmetic. Do not add, subtract, total, average or compare figures to produce a',
    'new one. Every number in your answer must appear verbatim in a passage. If a difference',
    'or a total is not written down, it is not available — say the figures you were given and',
    'stop. This matters more than being helpful: a number you calculated cannot be checked',
    'against the source.',
    '',
    'Set answered to true only when the passages state the answer. Then "text" quotes the',
    'specific figures or wording from them, in at most four sentences, and "cite" lists the',
    'numbers of the passages used.',
    '',
    'Set answered to false when they do not. Then "text" says, in one or two sentences, what',
    'is missing and what the passages cover instead, and "cite" is empty. Do not answer',
    '"Refusing" or similar — say what the papers do and do not contain.',
  ]
  if (missingTerms.length > 0) {
    lines.push(
      '',
      `Note: these words from the question do not appear in any retrieved passage: ${missingTerms.join(
        ', ',
      )}. That often means the papers do not cover the subject, though not always.`,
    )
  }
  return lines.join('\n')
}

interface ModelJudgement {
  answered?: unknown
  text?: unknown
  cite?: unknown
}

export async function answerFromPassages(
  question: string,
  search: SearchResult,
): Promise<GroundedAnswer | null> {
  const cfg = getConfig()
  if (!cfg.hasModelCredentials || search.passages.length === 0) return null

  // Keyed on the passages as well as the question, because the judgement is
  // about those passages: retrieval returning something different must not be
  // answered from the old set. The passage text is included rather than an id,
  // so re-ingesting a changed paper invalidates the entry by itself.
  return cached<GroundedAnswer>(
    'ground',
    [
      cfg.model,
      question,
      search.passages.map((p) => `${p.paperId}#${p.section}#${p.text}`).join(' :: '),
    ].join(' :: '),
    CACHE_TTL_SECONDS,
    () => judgeUncached(question, search),
  )
}

/**
 * The JSON object out of a reply that is not purely JSON.
 *
 * `@cf/openai/gpt-oss-120b` leaks its own channel format into `content` on
 * some questions, so the reply arrives as
 * `<|start|>assistant<|channel|>final <|constrain|>answer<|constrain|>{...}`
 * with the JSON intact inside it. `JSON.parse` on the whole string fails, the
 * judge returned null, and roughly half of all paper questions were refused
 * as unreadable while the other half answered — which is why this looked like
 * flakiness rather than a bug.
 *
 * Deliberately narrow: it takes the span from the FIRST `{` to the LAST `}`
 * and parses that. It cannot invent a field, because everything it returns
 * came from the model's own object; and it cannot rescue a reply that has no
 * object in it, which stays a failure. Stripping the markers by name was the
 * alternative and was rejected — a provider that changes its wrapper would
 * silently break it again, while braces are part of JSON itself.
 */
export function extractJudgement(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const open = trimmed.indexOf('{')
    const close = trimmed.lastIndexOf('}')
    if (open === -1 || close <= open) return null
    try {
      return JSON.parse(trimmed.slice(open, close + 1))
    } catch {
      return null
    }
  }
}

async function judgeUncached(
  question: string,
  search: SearchResult,
): Promise<GroundedAnswer | null> {
  const cfg = getConfig()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflareAccountId}/ai/run/${cfg.model}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cfg.cloudflareApiToken}`,
          'Content-Type': 'application/json',
          'cf-aig-gateway-id': cfg.aiGatewayId,
        },
        body: JSON.stringify({
          temperature: 0,
          // WITHOUT THIS, NO PAPER QUESTION COULD EVER BE ANSWERED.
          //
          // The provider's default output cap is 256 tokens. The router sets
          // 1024 and works; this call set nothing, and the model is a
          // REASONING model — it spends output tokens thinking before it
          // answers. Measured on a real question: finish_reason "length",
          // completion_tokens exactly 256, `content` null and the whole budget
          // consumed by `reasoning`. So the judge returned nothing, the tool
          // reported the passages as unreadable, and every question about the
          // board papers was refused in production while routing looked fine.
          //
          // Matched to the router's budget rather than guessed: the reply is a
          // sentence or two of JSON, and what needs the headroom is the
          // thinking in front of it.
          max_tokens: 1024,
          // Enforced server-side, so the reply cannot arrive as prose. Parsing a
          // free-form answer was tried first and failed on most questions.
          response_format: {
            type: 'json_schema',
            json_schema: {
              type: 'object',
              properties: {
                answered: { type: 'boolean' },
                text: { type: 'string' },
                cite: { type: 'array', items: { type: 'number' } },
              },
              required: ['answered', 'text', 'cite'],
            },
          },
          messages: [
            { role: 'system', content: systemPrompt(search.missingTerms) },
            {
              role: 'user',
              content: `Question: ${question}\n\nPassages:\n\n${passageBlock(search.passages)}`,
            },
          ],
        }),
      },
    )
    if (!res.ok) {
      recordFailure()
      console.error(`[retrieval] grounding call returned ${res.status}`)
      return null
    }

    const body = (await res.json()) as {
      result?: {
        response?: unknown
        choices?: { message?: { content?: unknown } }[]
      }
    }
    const usage = usageFromResponse(body)
    if (usage) recordCall(usage)

    // Two shapes: the flat one under result.response, and the OpenAI-style one
    // under result.choices[0].message.content. The router already handles both;
    // this did not, so every grounding call returned null and the answer was
    // withheld as unreadable.
    const response: unknown =
      body.result?.choices?.[0]?.message?.content ?? body.result?.response
    let parsed: ModelJudgement
    if (response && typeof response === 'object') {
      parsed = response
    } else {
      // Only a string can be parsed. Anything else stringifies to
      // "[object Object]", which then fails JSON.parse and is reported as a
      // shape error — the right outcome, but by accident rather than by check.
      if (typeof response !== 'string') {
        // A TRUNCATED REPLY IS NOT A SHAPE PROBLEM, and calling it one sent me
        // looking in the wrong place for an hour. `finish_reason: "length"`
        // with a null content means the model ran out of output budget while
        // reasoning, which is a cap to raise rather than a payload to parse.
        const finish = (body.result as { choices?: { finish_reason?: unknown }[] })?.choices?.[0]
          ?.finish_reason
        if (finish === 'length') {
          console.error(
            '[retrieval] the grounding model ran out of output tokens before it answered ' +
              '(finish_reason: length) — raise max_tokens',
          )
        } else {
          console.error('[retrieval] grounding call did not return the requested shape')
        }
        return null
      }
      const extracted = extractJudgement(response)
      if (!extracted || typeof extracted !== 'object') {
        console.error('[retrieval] grounding call did not return the requested shape')
        return null
      }
      parsed = extracted
    }

    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    if (!text) return null

    const answered = parsed.answered === true || parsed.answered === 'true'
    const citeIndexes = Array.isArray(parsed.cite)
      ? parsed.cite
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= search.passages.length)
      : []

    // Deduplicate by paper and section: two windows of the same section are one
    // citation to a reader.
    const seen = new Set<string>()
    const cited: GroundedAnswer['cited'] = []
    const citedPassages: Passage[] = []
    for (const i of citeIndexes) {
      const p = search.passages[i - 1]
      const key = `${p.paperId}#${p.section}`
      if (seen.has(key)) continue
      seen.add(key)
      cited.push({ paperTitle: p.paperTitle, section: p.section, paperId: p.paperId })
      citedPassages.push(p)
    }

    return {
      answered,
      text,
      cited: answered ? cited : [],
      citedPassages: answered ? citedPassages : [],
    }
  } catch (e) {
    recordFailure()
    const reason = (e as Error)?.name === 'AbortError' ? 'timed out' : String(e)
    console.error(`[retrieval] grounding call failed (${reason})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
