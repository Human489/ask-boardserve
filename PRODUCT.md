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
- Every answer carries its assumptions, its caveats, and its provenance. The
  as-at date is always on the face of the card, because every figure is
  measured from it. The rest — assumptions, caveats, sources, rows considered,
  derivation — sits behind one disclosure whose LABEL COUNTS WHAT IS INSIDE
  ("2 assumptions and 1 thing worth knowing"), so a reader who never opens it
  still knows the figure is qualified. An answer that hid qualification
  entirely, or behind an unlabelled "Details", would not be an honest answer.
- Refusal is a first-class outcome, including when two sources disagree: both
  figures are reported with their origins rather than one silently winning.
- Bar and line charts only.
- The dataset is a dated snapshot. Every date is measured from the as-at date in
  the data, never from the system clock, so a question anchored to the reader's
  own calendar cannot be answered and says so.
- Nothing organisation-specific is hard-coded; a second organisation's data must
  load without a code change.
- Access is by a single shared passcode. It IS persisted, in a signed cookie
  lasting a week, so a refresh does not send the reader back to the gate —
  which is why conversations are worth saving at all. The passcode is a fence
  against a shared link being used by a stranger, not an access control: there
  is no per-person identity and so no record of who read what.
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
- A second organisation's dataset exists for a zero-code-change test. It is not
  to be opened until that test is run, and the test is only meaningful run
  blind.
- Measured results held in `CLAUDE.md`: routing accuracy, retrieval calibration,
  and the checks that were built, measured and rejected.

Absent, and not to be invented: minutes, board pack lengths or circulation dates,
director ages or pay, appointment dates, and any forward work plan. Several
questions are unanswerable because the record genuinely does not exist, and saying
so is the correct behaviour.

## Product Principles

1. **A wrong answer is worse than no answer.** Refusing is a correct outcome, and
   a refusal must say precisely what is missing rather than shrug.
2. **Show the working, and say how much of it there is.** Assumptions, caveats
   and provenance travel with every figure, because the reader is accountable
   for what they repeat. What must be *visible* is the as-at date, since every
   figure is measured from it, and the COUNT of the qualification: the
   disclosure is labelled "2 assumptions and 1 thing worth knowing" rather than
   "Details", so nobody can repeat a figure without knowing it is qualified.

   This has now been narrowed twice, and both narrowings are worth keeping in
   view. It first said the qualification itself was "always visible", which was
   stricter than the brief and was once defended as if the client had asked for
   it — a 131px block under every answer is not the "small note" the brief
   asks for, and on a dashboard it made three cards 3,534px tall. It then said
   caveats stay on the face of the card in the chat, which was overruled
   deliberately in favour of one collapsed disclosure. What survives is the
   distinction between SIGNALLING qualification and DISPLAYING it. The figures
   themselves never fold: a table is the answer, not a caveat.
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
