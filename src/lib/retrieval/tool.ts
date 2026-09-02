import { answerFromPassages } from '@/lib/retrieval/answer'
import { searchPapers } from '@/lib/retrieval/search'
import type { AnswerResult, ToolDefinition } from '@/lib/types'

// The board-paper retrieval tool.
//
// The only tool that returns prose rather than a chart, because the papers are
// prose: there is nothing to compute, and quoting them IS the answer. It is
// also the only tool that can refuse, since whether a passage answers a
// question is a judgement no aggregation can make.
//
// "Tools compute, the model narrates" still holds. The model here summarises
// text it was handed and is forbidden from doing arithmetic on it — an early
// version reported an overspend of £132,000 that appeared nowhere in the
// papers, having subtracted two figures it had been given.

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export const searchBoardPapers: ToolDefinition = {
  name: 'search_board_papers',
  description:
    'Search the board papers and answer from what they say, with the paper and ' +
    'section cited. Use for any question about what a paper states, recommends, ' +
    'explains or discusses — reasons, narrative, context, risks, or a figure ' +
    'quoted in a paper. Not for figures held in the attendance records, the ' +
    'action log or the skills audit, which the other tools compute.',
  parameters: {
    question: {
      type: 'string',
      description:
        'The question to search the papers for. Pass the user\'s own wording; do not summarise it.',
    },
  },
  required: [],

  async run(dataset, args): Promise<AnswerResult> {
    const question = str(args.question, '')
    if (!question) {
      return {
        tool: 'refusal',
        headline: 'This question cannot be answered from the data available.',
        reason: 'No question was supplied to search the board papers for.',
      }
    }

    const search = await searchPapers(dataset, question)

    // The index is per-organisation. Answering one board's question from
    // another's papers is the worst failure this product could have, so a
    // mismatch stops here rather than being reported as an answer.
    if (search.datasetMismatch) {
      return {
        tool: 'refusal',
        headline: 'The board papers available do not belong to this organisation.',
        reason:
          `The loaded dataset is ${dataset.organisation}, but the paper index holds ` +
          `papers for ${search.datasetMismatch}. Answering from them would attribute ` +
          `another organisation's board papers to this one.`,
        alternative:
          'The attendance records, action log and skills audit are unaffected and can still be queried.',
      }
    }

    // Nothing cleared the corpus's own floor: the question is not about this
    // corpus at all. Refused without a model call.
    if (search.offDomain) {
      return {
        tool: 'refusal',
        headline: 'This question cannot be answered from the data available.',
        reason:
          `Nothing in the ${dataset.papers.length} board papers is on this subject. The ` +
          `closest passage scored ${search.topScore.toFixed(2)}, below the ${search.floor} ` +
          `that this corpus itself sets as the point where a passage stops being related.`,
        alternative:
          'The attendance records, action log and skills audit cover different ground and may hold it.',
      }
    }

    const grounded = await answerFromPassages(question, search)
    if (!grounded) {
      return {
        tool: 'refusal',
        headline: 'The board papers could not be read for this question.',
        reason:
          'Passages were found, but the service that reads them and decides whether they ' +
          'answer the question did not respond. No answer is better than a guess at what ' +
          'they say.',
        alternative: 'Try again shortly, or ask about attendance, actions or skills instead.',
      }
    }

    if (!grounded.answered) {
      return {
        tool: 'refusal',
        headline: 'The board papers do not answer this.',
        reason: grounded.text,
        alternative:
          search.missingTerms.length > 0
            ? `No paper mentions ${search.missingTerms.slice(0, 4).join(', ')}. The subject may ` +
              'exist elsewhere in the data — the action log covers items the papers never went to.'
            : 'The attendance records, action log and skills audit may cover it instead.',
      }
    }

    const papersCited = grounded.cited.length > 0 ? grounded.cited : []
    const sources = [...new Set(papersCited.map((c) => `${c.paperId}.md`))]

    return {
      tool: 'search_board_papers',
      headline: grounded.text,
      chart: null,
      table:
        papersCited.length > 0
          ? {
              columns: ['Paper', 'Section'],
              rows: papersCited.map((c) => [c.paperTitle, c.section]),
            }
          : null,
      assumptions: [
        'Answered only from the board papers. Figures held in the attendance records, action log or skills audit are not consulted here.',
        `The ${search.passages.length} closest passages were read, out of ${dataset.papers.length} papers.`,
      ],
      caveats: [
        'These are extracts, not whole papers. A paper may qualify elsewhere something an extract states plainly.',
        'Every figure above is quoted from a paper, not computed. Where a paper is itself wrong or out of date, so is this.',
        ...(papersCited.length === 0
          ? ['The answer cites no specific section, so it is harder to check against the source.']
          : []),
      ],
      provenance: {
        asAt: dataset.asAt,
        sources: sources.length > 0 ? sources : dataset.papers.map((p) => p.filename),
        rowsConsidered: search.passages.length,
        derivation:
          `The question was embedded and matched against passages of the board papers. The ` +
          `closest ${search.passages.length} scored ${search.passages[0].score.toFixed(2)} down ` +
          `to ${search.passages[search.passages.length - 1].score.toFixed(2)} and were read to ` +
          `produce this answer.`,
      },
    }
  },
}
