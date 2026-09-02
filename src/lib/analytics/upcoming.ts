import { daysBetween } from '@/lib/dataset/loader'
import { chunkPapers } from '@/lib/retrieval/chunk'
import { findCommitments } from '@/lib/retrieval/commitments'
import type { AnswerResult, BoardAction, DataPoint, ToolDefinition } from '@/lib/types'

// The second hybrid tool: what is coming, and what nobody has started.
//
// Two halves, from two sources, and the second half is the point. The action
// log answers what has a due date. The papers hold promises made in prose that
// never became actions — a paper due to a committee, a plan to be brought back
// — and those are precisely the things nobody is tracking, which is what
// "we have not started preparing for" actually means.
//
// There is no forward work plan anywhere in this data. That is stated in the
// answer rather than hidden, because a reader is entitled to know this was
// assembled rather than read off a schedule.

const NOT_STARTED = 'not started'

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function list(items: string[]): string {
  if (items.length === 0) return 'none'
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export const upcomingUnprepared: ToolDefinition = {
  name: 'upcoming_unprepared',
  description:
    'What falls due in the period ahead and how much of it has not been started, plus ' +
    'commitments the board papers make that never became actions. Use for "what is ' +
    'coming next quarter", "what have we not started preparing for", or "what is due ' +
    'soon". Combines the action log with promises stated in the papers.',
  parameters: {
    within_days: {
      type: 'number',
      description: 'How far ahead to look. Ninety days, a quarter, unless the question says otherwise.',
      default: 90,
      min: 7,
      max: 730,
    },
  },
  required: [],

  async run(dataset, args): Promise<AnswerResult> {
    const within = Math.round(num(args.within_days, 90))
    const asAt = dataset.asAt

    const due = dataset.actions.actions
      .filter((a) => a.due_date > asAt && daysBetween(asAt, a.due_date) <= within)
      .sort((a, b) => a.due_date.localeCompare(b.due_date))

    const notStarted = due.filter((a) => a.status === NOT_STARTED)
    const inFlight = due.filter((a) => a.status !== NOT_STARTED && a.status !== 'complete')

    // The papers half reads every paper rather than retrieving.
    //
    // Retrieval was tried first and found nothing: "what do the papers promise"
    // has no semantic anchor, so the nearest passages were about anything but
    // the promises. This is a pattern scan, not a meaning search — a sentence
    // either says something is still to come or it does not — so it reads the
    // whole corpus, which at a few thousand words costs no model call, no
    // network, and misses nothing.
    const asPassages = chunkPapers(dataset.papers).map((c) => ({
      score: 1,
      text: c.text,
      paperId: c.paperId,
      paperTitle: c.paperTitle,
      section: c.section,
    }))
    const commitments = findCommitments(asPassages)

    const describe = (a: BoardAction) => `${a.action_id} (${a.owner}, due ${a.due_date})`

    const headline =
      due.length === 0
        ? `Nothing in the action log falls due in the ${within} days after ${asAt}.` +
          (commitments.length > 0
            ? ` The papers do promise ${commitments.length} thing${
                commitments.length === 1 ? '' : 's'
              } with no action behind them.`
            : '')
        : `${due.length} action${due.length === 1 ? '' : 's'} fall${
            due.length === 1 ? 's' : ''
          } due in the ${within} days after ${asAt}, and ${
            notStarted.length === 0
              ? 'every one has been started'
              : `${notStarted.length} of them ${
                  notStarted.length === 1 ? 'has' : 'have'
                } not been started — ${list(notStarted.map(describe))}`
          }.` +
          (commitments.length > 0
            ? ` Separately, the papers promise ${commitments.length} thing${
                commitments.length === 1 ? '' : 's'
              } that never became an action, so nothing in the log is tracking ${
                commitments.length === 1 ? 'it' : 'them'
              }.`
            : '')

    const points: DataPoint[] = [
      {
        label: 'Not started',
        value: notStarted.length,
        highlight: notStarted.length > 0,
        detail: 'Due within the window with no work recorded against them',
      },
      {
        label: 'Under way',
        value: inFlight.length,
        detail: 'Due within the window and already in progress',
      },
      {
        label: 'Promised in a paper only',
        value: commitments.length,
        highlight: commitments.length > 0,
        detail: 'Stated in a board paper with no action in the log',
      },
    ]

    return {
      tool: 'upcoming_unprepared',
      headline,
      chart:
        due.length + commitments.length > 0
          ? {
              kind: 'bar',
              title: `What is coming in the next ${within} days`,
              xLabel: 'Status',
              yLabel: 'Items',
              unit: 'count',
              points,
              seriesLabel: 'Items',
            }
          : null,
      table: {
        columns: ['Source', 'Reference', 'Owner or paper', 'Due', 'Status'],
        rows: [
          ...due.map((a) => [
            'Action log',
            a.action_id,
            a.owner,
            a.due_date,
            a.status,
          ]),
          ...commitments.map((c) => [
            'Board paper',
            `${c.paperId} / ${c.section}`,
            c.sentence,
            'not dated as an action',
            'no action recorded',
          ]),
        ],
      },
      assumptions: [
        `"Coming" means falling due within ${within} days of ${asAt}, the as-at date of the data.`,
        '"Not started" is the status recorded in the log, which is hand-typed and may lag the real position.',
        'Commitments are sentences in the papers promising something later, quoted as written rather than summarised.',
      ],
      caveats: [
        'There is no forward work plan in this data. This is assembled from action due dates and promises made in the papers, so anything agreed verbally and never written down is invisible to it.',
        ...(commitments.length > 0
          ? [
              'A promise in a paper is not evidence that nobody is working on it, only that no action in the log is tracking it.',
            ]
          : []),
      ],
      provenance: {
        asAt,
        sources: ['actions.json', ...new Set(commitments.map((c) => `${c.paperId}.md`))],
        rowsConsidered: dataset.actions.actions.length,
        derivation:
          `Actions with a due date between ${asAt} and ${within} days later were counted and ` +
          `split by recorded status. Every paper was then read for sentences promising ` +
          `something still to come, and those were quoted verbatim.`,
      },
    }
  },
}
