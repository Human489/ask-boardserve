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

const TIMEOUT_MS = 12_000

export interface GroundedAnswer {
  answered: boolean
  /** Prose answer when answered; the reason when not. */
  text: string
  /** Papers actually cited, in the order the model used them. */
  cited: { paperTitle: string; section: string; paperId: string }[]
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

    const body = (await res.json()) as { result?: { response?: unknown } }
    const usage = usageFromResponse(body)
    if (usage) recordCall(usage)

    const response = body.result?.response
    let parsed: ModelJudgement
    if (response && typeof response === 'object') {
      parsed = response as ModelJudgement
    } else {
      try {
        parsed = JSON.parse(String(response ?? '')) as ModelJudgement
      } catch {
        console.error('[retrieval] grounding call did not return the requested shape')
        return null
      }
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
    for (const i of citeIndexes) {
      const p = search.passages[i - 1]
      const key = `${p.paperId}#${p.section}`
      if (seen.has(key)) continue
      seen.add(key)
      cited.push({ paperTitle: p.paperTitle, section: p.section, paperId: p.paperId })
    }

    return { answered, text, cited: answered ? cited : [] }
  } catch (e) {
    recordFailure()
    const reason = (e as Error)?.name === 'AbortError' ? 'timed out' : String(e)
    console.error(`[retrieval] grounding call failed (${reason})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
