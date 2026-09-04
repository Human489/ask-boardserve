import { daysBetween, list, num } from '@/lib/dataset/loader'
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

  // Async with nothing awaited: ToolDefinition allows a tool to reach a service
  // and this one is grouped with the hybrids, so it keeps the async signature
  // the contract describes rather than the one this body happens to need.
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(dataset, args): Promise<AnswerResult> {
    const within = Math.round(num(args.within_days, 90))
    const asAt = dataset.asAt

    const due = dataset.actions.actions
      // Inclusive of the as-at date. Overdue is due_date < asAt, so an action
      // due exactly ON the as-at date was neither overdue nor upcoming — it
      // fell through both tools and appeared in no answer at all.
      .filter((a) => a.due_date >= asAt && daysBetween(asAt, a.due_date) <= within)
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
    const search = findCommitments(asPassages, 6, asAt)
    const commitments = search.commitments

    const describe = (a: BoardAction) => `${a.action_id} (${a.owner}, due ${a.due_date})`

    const headline =
      due.length === 0
        ? `Nothing in the action log falls due in the ${within} days after ${asAt}.` +
          (commitments.length > 0
            ? ` The papers separately state ${search.capped ? 'at least ' : ''}${
                commitments.length
              } thing${
                commitments.length === 1 ? '' : 's'
              } as coming, which is worth checking against the log by hand.`
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
            ? ` Separately, the papers state ${search.capped ? 'at least ' : ''}${
                commitments.length
              } thing${
                commitments.length === 1 ? '' : 's'
              } as coming, listed below and NOT matched against the log.`
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
        label: 'Stated in a paper',
        value: commitments.length,
        highlight: commitments.length > 0,
        detail: 'Stated as coming in a board paper; not matched against the log',
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
            'not matched against the log',
          ]),
        ],
      },
      assumptions: [
        `"Coming" means falling due within ${within} days of ${asAt}, the as-at date of the data.`,
        '"Not started" is the status recorded in the log, which is hand-typed and may lag the real position.',
        'Commitments are sentences in the papers promising something later, quoted as written rather than summarised.',
        'A commitment naming only a month earlier in the year than the as-at date is treated as already past and left out. The papers state months without years, so that is a reading of the prose rather than a date comparison.',
      ],
      caveats: [
        'There is no forward work plan in this data. This is assembled from action due dates and promises made in the papers, so anything agreed verbally and never written down is invisible to it.',
        ...(search.capped
          ? [
              `The scan stops after ${commitments.length} commitments, so this is a sample of what the papers state rather than a complete count.`,
            ]
          : []),
        ...(commitments.length > 0
          ? [
              // This caveat used to assert the opposite of the truth: that no
              // action in the log was tracking these. Nothing compares them —
              // findCommitments is given the passages and never the action log
              // — and on this dataset it was demonstrably false: an in-progress
              // action in the log tracked one of the promises it declared
              // untracked. A sentence stating a comparison the code never made
              // is the one thing this product must not do.
              'These sentences were read from the papers and NOT compared with the action log. Some may already be tracked as actions; check before chasing one.',
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
          `something still to come, and those were quoted verbatim. The two sets were ` +
          `NOT matched against each other.`,
      },
    }
  },
}
