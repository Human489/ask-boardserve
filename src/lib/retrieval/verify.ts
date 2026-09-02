import type { Passage } from '@/lib/retrieval/search'

// Deterministic fact-check over a generated answer.
//
// The prompt already forbids arithmetic and outside knowledge. It is not
// enough: an earlier version reported "an overspend of £132,000", a figure
// appearing nowhere in the papers, arrived at by subtracting two figures it had
// been given. It read as a helpful sentence and would have gone into a board
// pack.
//
// A prompt is a request. This is a check. Every number in an answer must appear
// in a passage the model was shown, or the answer does not go out.
//
// Deliberately narrow: it verifies NUMBERS, not prose. Whether a summary is
// faithful is a judgement; whether £132,000 appears in the source is a fact,
// and facts are what this project cannot afford to get wrong.

export interface Verification {
  ok: boolean
  /** Numbers in the answer that appear in no passage. */
  unsupported: string[]
}

/**
 * Pulls numeric tokens out of text, keeping the forms a board paper uses:
 * £4.61m, 11.4, 14 per cent, 2026, £412,000.
 */
function numericTokens(text: string): string[] {
  const raw = text.match(/\d[\d,.]*\s*(?:m\b|k\b|bn\b)?/gi) ?? []
  // A figure ending a sentence captures the full stop: "£412,000." normalised
  // to "412000." and matched nothing, rejecting a correct, sourced answer.
  // Trailing separators are punctuation, never part of the number.
  return raw.map((token) => token.replace(/[.,\s]+$/, '')).filter(Boolean)
}

/** Comparable form: digits only, so £412,000 and 412000 match. */
function normalise(token: string): string {
  return token.toLowerCase().replace(/[,\s]/g, '')
}

/**
 * Ordinals, dates and small counts restated in words are not claims about the
 * data, and demanding they appear verbatim would reject sound answers. A number
 * is only checked when it looks like a figure: four or more digits, a decimal,
 * or an explicit magnitude suffix.
 */
function isFigure(token: string): boolean {
  const digits = token.replace(/[^\d]/g, '')
  return digits.length >= 4 || /[.]/.test(token) || /[mk]|bn/i.test(token)
}

export function verifyAgainstPassages(answer: string, passages: Passage[]): Verification {
  const haystack = normalise(passages.map((p) => p.text).join(' '))
  const unsupported: string[] = []

  for (const token of numericTokens(answer)) {
    if (!isFigure(token)) continue
    const needle = normalise(token)
    if (needle.length === 0) continue
    if (!haystack.includes(needle)) unsupported.push(token.trim())
  }

  return { ok: unsupported.length === 0, unsupported: [...new Set(unsupported)] }
}
