# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Company secretaries of a mid-sized board, primarily at their desk preparing for a
meeting — assembling a pack, checking the action log, working out what has slipped.
The desk is the primary scene, but the interface must survive being opened live in
a meeting when a question is put to the secretary and the board is waiting.

Those two situations pull in opposite directions and the resolution matters: depth
and evidence are the default, but the single most important sentence has to be
legible at a glance, without scrolling or interpretation.

Chairs and trustees are not confirmed users.

## Product Purpose

Answer questions about board data asked in plain English, and return a chart with
a written finding rather than a table or a paragraph.

It exists because a fixed dashboard shows the same charts to every organisation.
The questions a secretary actually has — who is drifting below the attendance
threshold, what has been deferred twice, what did we promise in a paper and never
start — are not on any dashboard, and each one is a different shape.

Success is a secretary getting an answer they can put in front of a board without
checking it first, and knowing when the data cannot answer them.

## Positioning

A companion to BoardServe's existing analytics, not a replacement. The analytics
section answers the questions someone anticipated. This answers the ones they did
not.

The mechanism a neighbouring product could not truthfully copy: **tools compute,
the model narrates.** No figure on screen is produced by a language model. Each
answer is computed by deterministic code that also writes its own one-sentence
finding, so the sentence cannot disagree with the chart. The model only chooses
which tool to run.

That is also why it can refuse. A system that generates figures cannot tell you it
does not know.

## Operating Context

Board and committee meetings on a monthly-to-quarterly cycle. The secretary works
from three kinds of record that never join up on their own:

- attendance across the board and its committees, where eligibility differs per
  director;
- an action log whose recorded status is hand-typed and not always right;
- a self-assessed skills audit;
- and board papers as prose, which restate figures from the other three and
  sometimes restate them wrongly.

Questions routinely cross those sources. The term limit that decides who must step
down exists only as a sentence in a paper; the tenure it applies to is a spreadsheet
column.

Answers are read on screen, and figures are copied into board papers by hand.

## Capabilities and Constraints

- Fifteen tools: twelve deterministic ones over the structured records, one that
  retrieves from the board papers, two hybrid ones that read a fact from a paper
  and compute the consequences.
- Every answer carries its assumptions, its caveats, and its provenance, shown
  without a disclosure. An answer without them is not an honest answer.
- Refusal is a first-class outcome, including when two sources disagree: both
  figures are reported with their origins rather than one silently winning.
- Bar and line charts only.
- The dataset is a dated snapshot. Every date is measured from the as-at date in
  the data, never from the system clock, so a question anchored to the reader's
  own calendar cannot be answered and says so.
- Nothing organisation-specific is hard-coded; a second organisation's data must
  load without a code change.
- Access is by a single shared passcode with no persisted session: a refresh
  returns to the passcode screen.
- Undecided: no attendance threshold is defined anywhere in the data. 80% is used
  and always stated in the answer.

## Brand Commitments

The name **Ask BoardServe**, and the positioning as a companion rather than a
replacement.

No visual identity is binding. BoardServe's own analytics uses recharts bar charts
with a radar and line chart in a demo view, but the user has confirmed there are no
constraints to match — the visual direction is a proposal, to be judged on its own
merits.

## Evidence on Hand

- A real dataset of one fictional organisation: twelve months of attendance for ten
  directors, around forty actions, a ten-by-ten skills audit, and three board
  papers. It is gitignored and must never be committed.
- A second organisation's dataset exists for a zero-code-change test and has
  deliberately not been opened.
- Measured results held in `CLAUDE.md`: routing accuracy, retrieval calibration,
  and the checks that were built, measured and rejected.

Absent, and not to be invented: minutes, board pack lengths or circulation dates,
director ages or pay, appointment dates, and any forward work plan. Several
questions are unanswerable because the record genuinely does not exist, and saying
so is the correct behaviour.

## Product Principles

1. **A wrong answer is worse than no answer.** Refusing is a correct outcome, and
   a refusal must say precisely what is missing rather than shrug.
2. **Show the working.** Assumptions, caveats and provenance travel with every
   figure, always visible, because the reader is accountable for what they repeat.
3. **Say the notable thing.** One sentence that states the finding, never a
   description of the axes.
4. **Trust nothing that cannot be checked** — including the model. Where a rule
   matters, enforce it in code rather than asking politely.
5. **Surface disagreement rather than resolving it quietly.** When a paper and the
   data conflict, that conflict is itself the finding.

## Accessibility & Inclusion

**WCAG 2.2 AA.** Confirmed as the required standard.

The consequences that bite here: chart colour can never be the only carrier of
meaning, so a flagged bar needs a second signal; contrast ratios must hold in both
light and dark, which the palette is already validated against; and every control
including the composer and the passcode field must be reachable and operable by
keyboard with a visible focus state.
