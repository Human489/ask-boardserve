# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ask BoardServe** — a chat interface where company secretaries ask questions about
board data in plain English and get back dynamically generated charts. A companion
to BoardServe's existing analytics, not a replacement: the point is answering the
questions a fixed dashboard cannot.

A work-experience project on a fixed schedule (Core → Complete → Excellence).
`PRODUCT.md` holds the product record — users, purpose, constraints, and what is
deliberately absent from the data. Read it before designing anything.

## Working practice

**Use branches.** Every feature or fix gets its own branch off `main` and merges
back with `--no-ff`. `main` should read as a sequence of merges, one per piece of
work. Do not commit a feature directly to `main`, and do not let one branch
accumulate unrelated work — that happened once here and had to be untangled by
cherry-picking commits onto their own branches afterwards.

Commits are scoped (`feat(analytics):`, `fix(router):`) and explain the reasoning,
not the diff. If a fix exists because a specific thing went wrong, the message
says what went wrong.

**Verify before claiming.** Run the tests, the smoke suite, and where it is a UI
change, look at it in the browser. Several defects here passed every unit test and
were only found by using the thing.

## Commands

```bash
npm run dev          # dev server on :3000
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src tests scripts
npm test             # 394 unit tests (tsx --test tests/*.test.ts tests/*.test.tsx)
npm run smoke        # end-to-end checks against a RUNNING server
npm run eval         # the eval harness, against a RUNNING server
npm run predeploy    # typecheck + lint + tests + eval, and writes the README
```

**The eval harness needs the server started with `AI_CACHE=off`.** Otherwise
every repeat of a question is served from cache, so a flaky router reports as
perfectly stable and the harness becomes a slower smoke suite. It reads
`aiCacheDisabled` off `/api/usage` and prints a warning when it cannot trust
its own stability column, but the warning is not a substitute for setting it.

`npm run eval -- --runs 5 --write-readme` is the form the brief asks for:
results in the README. It exits non-zero only when a question NEVER passes —
an intermittent one is reported rather than used to block, because the flake is
a property of the model and blocking on it would mean never deploying.

Single file, and a single test by name:

```bash
npx tsx --test tests/analytics.test.ts
npx tsx --test --test-name-pattern "overdue" tests/analytics.test.ts
```

Scripts (all need `.env.local`):

```bash
node scripts/probe-router.mjs        # model routing accuracy, per question
node scripts/ingest-papers.mjs       # embed the board papers into Vectorize
node scripts/ingest-papers.mjs --dry-run
node scripts/calibrate-retrieval.mjs # measure the retrieval threshold
npx tsx scripts/probe-unseen.ts      # routing on 25 questions never used to tune it
npx tsx scripts/check-dataset.ts     # parse a dataset and print what it holds
npx tsx scripts/dump-chunks.ts       # what the chunker actually produced
```

`probe-unseen.ts` is the one worth re-running after any router change. The eval
harness runs the customer's own questions, which the router was built against,
so a good score there proves it does not regress — not that it generalises.
Last run: **24/25**, the miss being "How diverse is the board?" routing to
`skills_gaps`. That miss is now guarded in code (`guardUnmeasured`), not in the
prompt.

### Running this as an outside reviewer

Written because an external auditor has none of the credentials and would
otherwise report configuration as defects.

```bash
npm ci && npm run typecheck && npm run lint && npm test   # no credentials needed
```

**The unit tests need nothing.** No `.env.local`, no network, no model access.
`npm run dev` also works with no credentials at all: the dataset is committed,
and `router.ts` falls back to a deterministic keyword classifier when the
Cloudflare variables are missing, so questions still route and still answer.
What you lose without credentials is the model routing path, the board-paper
retrieval, and KV — pins and conversations fall back to per-process memory,
and uploading a dataset REFUSES rather than pretending to work.

**`npm run smoke` and `npm run eval` need a running server**, and the eval
needs it started with `AI_CACHE=off` or it measures its own cache. Both need
`APP_PASSCODE` set, because everything is behind the gate.

Three things that look like bugs and are not, each recorded in full below:

- **The passcode is a bot fence, not an access control.** No per-user identity,
  no idle timeout, revocation is all-or-nothing. Deliberate for a demo over a
  fictional dataset; see "The gate is a bot fence".
- **Rate limiting is approximate** and the write is not awaited. KV has no
  atomic increment and a write costs ~330ms.
- **Six of smoke's twelve structured questions are paraphrases**, not the
  spec's wording. Known, argued both ways, deliberately not changed.

**Stop the dev server before `npm run build`.** They share `.next`, and running
both corrupts it: the browser 404s on chunks and the page silently stops
responding to clicks. `rm -rf .next` and restart. This has happened three times.

## The dataset

**ONE DATASET IS NOW COMMITTED, and it is the only one.** `./dataset` holds
`attendance.json`, `actions.json`, `skills-audit.csv` and three `paper-*.md`
board papers, in the repo. It used to be ignored outright; the instruction that
changed it was "commit one dataset to the repo as the default so the deployed
app works for someone opening it cold, then upload becomes the way to swap
rather than the only way in." Before that, a first visit answered 409
`needsDataset` for every question.

**That is safe only because both organisations in this exercise are
FICTIONAL** — the dataset's own README says so. A real dataset goes straight
back behind the ignore: attendance names identifiable people and records
whether each turned up.

**The dataset's own README is still ignored**, because it describes both
organisations and names the second by sector. Committing it would put
dataset-b's identity in the repo.

**A committed dataset is not automatically a DEPLOYED one.** Next traces a
function's files by following imports, and the loader does not import the
dataset — it reads a path built at request time. `outputFileTracingIncludes`
in `next.config.ts` puts `./dataset/**` into every route; without it the files
are in the repo, absent from the bundle, and every test still passes.

`.gitignore` keeps `/dataset-*/`, anchored, so dataset-b cannot be committed by
accident. Anchoring matters: an unanchored `dataset/` also matches
`src/lib/dataset/`, which silently drops application code from commits.

Do not open `dataset-b` (a second organisation, for the zero-code-change test)
until that test is being run honestly. Reading it early spoils the only chance to
run it, and the value of the test is entirely in not knowing what is in there.

That includes second-hand knowledge. Working notes that described `dataset-b`'s
contents have been moved out of the repo rather than kept around, so nothing in
this tree carries its figures. If you find such notes, do not read them into
context — the test is only worth running blind.

## Dataset sources

Three ways in, resolved in this order by `resolveDataset()` in `src/lib/datasets.ts`:

1. **An uploaded dataset**, stored in KV and pointed at by `datasets:v1:active`.
2. **The local directory** (`DATASET_PATH`, else `./dataset`) — development and
   the whole test suite.
3. **Nothing**, which is a first run rather than a fault: `/api/ask` answers 409
   with `needsDataset` and the UI sends the reader to the Data view.

`POST /api/datasets` takes a `.zip`, extracts only the files a dataset is made
of (basename-matched, so zipping the folder works), parses it with the *same*
parser the local directory uses, and refuses anything that will not parse —
before storing it. What is stored is the file map, not the parsed dataset, so a
parser change applies to datasets already uploaded.

**Uploading requires KV, and refuses without it.** The in-memory fallback pins
use cannot serve this: each route handler is its own module instance, so a
dataset held in one route's memory is invisible to the route that answers
questions. Measured, not assumed — an upload with KV unconfigured reported
success and the next question was still answered from the local directory.

**Pins are stored per dataset** (`pins:v1:<datasetId>`). A pinned card refreshed
under a different dataset would recompute against another organisation and go on
showing the same question above different figures.

**Conversations are stored per dataset** (`conversations:v1:<datasetId>`), each
with its own history, in `src/lib/conversations.ts`. Before this the transcript
was a `Map` in `Chat.tsx` and lived exactly as long as the tab: a refresh
returned to an empty composer, and the reader could hold one line of enquiry at
a time.

Three things worth knowing:

- **This route stores what the CLIENT sends**, unlike `/api/pins`, which
  recomputes server-side and discards a client-supplied `result`. A transcript
  is a record of answers the reader already received; re-running them would
  produce a different record. So what is stored is the client's account of what
  it was shown, replayed into that reader's own transcript and nowhere else —
  never a dashboard figure, never fed to a tool. The size caps in the route are
  what stop that being a way to fill KV.
- **The active conversation id is swapped with the transcript** on a dataset
  change, in the same effect. Restoring one dataset's turns under another
  dataset's conversation id would save those turns over another organisation's
  conversation.
- **Titles are derived, not generated.** `titleFrom` trims the first question
  on a word boundary. A model call would be a round trip and a cost to restate
  a sentence the reader just typed, and could come back different each time.
  The title is fixed at the first question so a conversation cannot rename
  itself under the reader as they use it.

Only ANSWERED turns are persisted: a pending turn is in flight, and a failed
one is a network state rather than a record. A refresh therefore starts on an
empty composer with the history beside it, rather than restoring the last
conversation automatically — worth revisiting, but starting fresh is honest for
an app with no session.

**The transcript is kept per dataset, like pins.** Prior answers' headlines are
sent back to the model as routing context, so one shared transcript would route
a question about one organisation while the model reads a sentence about
another. Scoping rather than wiping means switching back restores the
conversation instead of destroying it, and the chat and dashboard then agree
about what a dataset "has". The swap logic is `swapTranscript` in `Chat.tsx`,
kept pure so it can be tested without a renderer; a question caught in flight is
marked failed rather than left on a skeleton for ever.

## Architecture

Question → router picks a tool → tool computes → UI renders.

**`src/lib/types.ts`** — the contracts everything speaks. Read this first.
`ToolDefinition` and `AnswerResult` are the whole design in one file. `run` is
async and may return a refusal, because retrieval needs both.

**`src/lib/dataset/loader.ts`** — parses once and caches. Also holds helpers used
by more than one analytics module: `daysBetween`, `committeesOf`, `membersOf`,
`allBodies`, `pct`.

**`src/lib/analytics/`** — the twelve deterministic tools (attendance, actions,
skills) plus two hybrids (`tenure.ts`, `upcoming.ts`). `registry.ts` exports
`ANALYTICS_TOOLS` (the twelve — synchronous, never refuse, produce every figure
the product shows) and `TOOLS` (all fifteen, including the three that read papers).
That split is load-bearing and tested.

**`src/lib/retrieval/`** — `chunk` → `vectorize` → `search` → `answer` (the
grounding judge) → `verify` (figures) → `tool` (the ToolDefinition). Plus
`scope.ts` (keeps structured questions out of the papers), `termlimit.ts` and
`commitments.ts` (facts read from prose by pattern), and `disagreement.ts`.

**`src/lib/router.ts`** — two paths. Primary is Cloudflare Workers AI tool-calling
via the AI Gateway. Falls back to a deterministic keyword classifier when
credentials are missing or the call fails, so the app works and stays testable with
no model access. Result carries `routedBy: 'model' | 'fallback'`.

**`src/app/api/ask/route.ts`** — auth → rate limit → validate → load → route → run
→ respond.

**The state layer**, all KV-backed and all keyed per dataset, because a value
that outlived a dataset swap would show one organisation's figures under
another's question:

| Module | Key | Holds |
| --- | --- | --- |
| `datasets.ts` | `datasets:v1:active` | which uploaded dataset is live |
| `pins.ts` | `pins:v1:<datasetId>` | the pinned dashboard |
| `conversations.ts` | `conversations:v1:<datasetId>` | saved chats, 20 max, 40 turns each |
| `shares.ts` | `share:v1:<token>` + `shares:v1:<datasetId>` | read-only links and the owner's index |
| `aicache.ts` | `aicache:v2:*` | routing, embedding and judge results |
| `ratelimit.ts` | `rl:*` | approximate per-IP buckets |

`conversations.ts` titles a chat with `titleFrom()` — deterministic, no model
call, because a title is not worth a neuron and a flaky one makes a list of
chats unrecognisable between visits.

**`src/lib/chartimage.ts`** — SVG → PNG for a single chart. Always exports the
LIGHT palette whatever is on screen, and always stamps
`<organisation> · Data as at <date>`. Font stacks inside it use single quotes:
a double quote malforms the XML attribute and the whole serialisation fails.

**`src/middleware.ts` + `session.ts` + `auth.ts`** — the passcode gate. The
matcher lists what to SKIP, so a new route is protected by default. Failed
credentials charge an `auth:<ip>` budget so the gate is not a passcode oracle
(measured: 40 attempts answered 200, then 429; now 20 then 429).

### The rule the product rests on

**Tools compute, the model narrates.** No number reaching the screen is produced by
a language model. Each tool writes its own `headline` deterministically from values
it just computed, so the sentence cannot disagree with the chart. The model chooses
the tool and its arguments; for document questions it also summarises retrieved
prose, and is forbidden from doing arithmetic on it.

A headline says the **notable thing**, not the axes. `ToolResult` also carries
`assumptions`, `caveats` and `provenance`. Assumptions and caveats are shown
without a disclosure, because they change how the figure reads. Provenance is
"a small note" one click away — the brief's own wording — because an audit
trail is consulted when checking, not when reading. The as-at date stays inline
wherever a figure appears, since every figure is measured from it.

### A prompt is a request; a check is a check

Three times an instruction to the model failed and a deterministic check
succeeded: the arithmetic ban that still produced an invented £132,000, the tool
description that still let structured questions reach the papers, and the refusal
wording that still claimed absent data existed. Where a rule matters, enforce it in
code. `verify.ts` and `scope.ts` exist for exactly this.

## Invariants — breaking these produces plausible wrong answers

Each has a test.

- **`apologies` is non-attendance.** Only `status === 'present'` counts.
- **Denominators differ per director** (9 to 15). Committee rows exist only for
  that committee's members. Our aggregation must reproduce `director_summary`.
- **Overdue is derived**, `due_date < asAt && status !== 'complete'`. Report the
  derived AND recorded counts, with the sentence generated from the actual set
  difference — it can run either way.
- **Use `dataset.asAt`, never `Date.now()`.** A test greps the analytics sources.
- **`owner` is a job title, not a director.** Say how many cannot be resolved.
- **Committee membership is inferred** from eligibility rows. Carry the caveat.
- **Skills are self-assessed.** Always report counts at 4+ and 2− beside the mean.
- **Nothing organisation-specific may be hard-coded** — no director, committee,
  skill or risk names, no counts. A test greps `src/lib` including comments, and
  has caught leaks in comments twice.
- **Small-n caveats are computed**, with the real n and the real point impact.
- **A nil result still needs its caveats**, or it reads as a figure needing no
  qualification.
- **Assumptions must describe what the code did.** A wrong assumption sentence is
  worse than none.
- **Out-of-scope questions refuse rather than reaching a plausible tool.**
- **Refusals must not claim data is absent when it is not.** Say what no *tool*
  computes, not what the *data* lacks.

## Testing

`tests/analytics.test.ts` pins values verified against the dataset, so it fails on
drift rather than only on throws.

`tests/routing-spec.test.ts` holds the spec questions verbatim. It exists because
the original routing tests were written in paraphrases tuned to the classifier and
passed 12/12 while real accuracy on the spec's wording was 3/12. **Route the
customer's wording, not your own paraphrases.**

`tests/sources.test.ts` greps for control characters. Regex `\b` escapes have been
mangled into literal backspaces three times by editing scripts — the pattern
compiles, builds, and can never match, which for a refusal rule means it silently
stops refusing.

`npm run smoke` needs a running server and covers auth, validation, all twelve
structured questions, five refusals, multi-turn, and rate limiting. It waits out
its own 429s.

## Project status

**The brief is the authority, and this section had drifted from it.** It claimed
deployment and pinning were outstanding when both had shipped, and described
two brief-compliance gaps that were already closed.

**There are two scope lists, and conflating them caused a mistake worth
recording.** The client's brief lists four Excellence items. `docs/`'s
one-pager — this project's own spec, which the brief explicitly invites
("you're also very welcome to propose your own features... we'll say yes or
park it") — adds **image export**. That is a PROPOSED item, not an invented
one, and it was briefly written up here as drift on the assumption it had come
from nowhere. It came from the spec.

So: the four below are the client's. **Image export is a fifth that this
project proposed and that Hamada approved, to sit in Excellence** — so it is
scope, not a pending change request. Recorded here because the approval
happened in conversation and nothing in this repo carried it, which is what let
it be written up first as invented work and then as un-approved. Check both
against
`https://gai-work-experience-8x2r4t.vercel.app/project-yahya` and
`docs/ask-boardserve-one-pager.html` rather than trusting this file.

### Core — done

Chat answers structured questions through tools; bar and line charts render in
the chat as tool output; deployed on Vercel behind the passcode gate. Plus
one-sentence insights, rate limiting, loading and error states.

### Complete — done

Hybrid routing (the agent chooses between tools and retrieval, and gets it
right); refusal behaviour on unanswerable questions; pin to dashboard with state
in KV; multi-turn refinement. All 16 spec questions answer; all 5 refusals
refuse.

### Excellence — five items, four done

The brief's list verbatim, since paraphrasing it is what introduced a fifth:

1. **An eval harness** — "a fixed set of questions with expected answer types,
   run before every deploy, **results in your README**". **Done**:
   `scripts/eval.ts`, `npm run eval`, gated by `npm run predeploy`, results
   written between the markers in README.md. Reports a RATE over repeated runs
   rather than a pass, because routing is a model call. First real run:
   130/130 over 5 runs each, nothing unstable.
2. **Provenance on every chart** — "a small note showing which rows or passages
   produced it". **Done.** `provenance` is non-optional on `ToolResult`, so a
   tool cannot ship without it; 12/12 tools populate as-at, sources, rows
   considered and derivation, verified by running them. Rows come from
   `rowsConsidered` and `derivation`; passages come from `sources` plus the
   "Drawn from" citation list on a paper answer. It became *a small note* when
   the dashboard work put it behind a "Where this came from" disclosure with
   the as-at date left inline.
3. **A shareable read-only dashboard link (tokened URL)** — **done**.
   `src/lib/shares.ts` and `/share/[token]`. The five conditions recorded under
   "Data protection" were met before it shipped, not after: 256-bit CSPRNG
   token, mandatory expiry checked on read as well as set as a TTL, immediate
   revocation, `noindex` and `no-store`, and no personal data in the path. It
   is a snapshot rather than a live view, and every failure returns the same
   page so a guessed token cannot be confirmed.
4. **A second dataset loads with no code changes** — not run. Worth running
   exactly once, blind. See the `dataset-b` rules above.
5. **Image export for individual charts** — ours, approved by Hamada for
   Excellence. **Done**: `src/lib/chartimage.ts` and the "Save chart" button on
   every answer and pinned card. Three decisions in it, each with a wrong
   answer that looks fine until the image is somewhere you cannot correct it:

   - **The stamp is not optional.** The PNG always carries
     `<organisation> · Data as at <date>`. A bare-chart option was designed,
     mocked and dropped as scope: the safe choice should not be the opt-in one,
     and every figure here is measured from the as-at date, so an undated
     attendance percentage in a board pack is the exact failure the product
     exists to avoid. "As at" is kept because it is the governance register and
     names the DATA's date; "Data as at" removes the only real ambiguity, which
     is whether it means the export time.
   - **It always exports light**, whatever theme is on screen, because a dark
     chart in a board pack is wrong in a way the exporter cannot undo.
     Verified: app surface `#1a1816` on screen, PNG corner `rgb(255,255,255)`.
   - **Nothing of ours is branded onto it.** The stamp names the organisation
     whose data it is. **Their own logo would be better and is not built** —
     it needs somewhere to upload one, which is a feature rather than a detail.
     Worth proposing as a change request rather than assuming.

   No webfonts are embedded: the chart's text is system-ui on screen already,
   so nothing can silently fall back — the failure the gate's fonts already
   demonstrated once. The footer takes a system mono for the same reason.

### Deliberately out of scope, for later

- **Refreshing a pinned card.** Built and then removed. A dataset here is a
  dated snapshot — every figure is measured from `dataset.asAt` — so re-running
  a pinned analysis against the same dataset can only ever produce the same
  figures. The control did nothing a reader could see, and keeping it implied
  live data the demo does not have. Worth adding when this sits inside the main
  BoardServe app against data that actually moves; the pin already stores its
  `tool` and `args` for exactly that, so re-adding it is a route and a button
  rather than a redesign. The removed version re-ran the recorded tool and
  arguments and never re-routed the question, because a refresh that changes
  which tool answered is not a refresh — keep that property.

### Deliverables — one not started

The brief's Friday list is "your deployed link, repo, README, and handover
doc". Deployed link and repo are live; the README carries eval results between
`<!-- eval:start -->` / `<!-- eval:end -->`, written by the harness rather than
by hand so they cannot drift from the last run.

- **A handover doc does not exist.** This is the only outstanding deliverable.

### A deviation from the brief, recorded on purpose

The brief says "Chat interface (**AI Elements**, like Tuesday)". This is a
custom chat instead. The outcome the brief asks for is met — questions in plain
English, charts as tool output — but the named library was not used, and that
is a choice to be able to defend rather than discover.

## The audit, and the state it left things in

Three rounds of audit ran over everything built, at the instruction "test that
every feature works, test potential edge cases, and then we test questions and
their accuracy, even outside our current set of questions". Every finding is
fixed and merged. **The bug backlog is empty**, and the only known problems are
the ones under "Known, and not easily fixable" below, each of which has been
looked at properly and left alone for a stated reason.

Verified state at the last merge: **392 tests, smoke 62/62, eval 130/130 over 5
runs with nothing unstable, typecheck, lint and production build clean, the
hard-coding detector at 0 findings.** Branches: `main` only, everything merged
with `--no-ff`.

The eval figure is the one number here NOT re-measured since; it predates the
recharts upgrade, which touched no routing code. Re-run it before quoting it.

The failures worth carrying forward, because each is a CLASS rather than a
one-off:

- **A template literal eats a backslash escape.** `` new RegExp(`\b${w}\b`) ``
  builds a pattern containing BACKSPACE, which compiles, runs, and matches
  nothing for ever. `tests/sources.test.ts` cannot see it — the source holds a
  valid two-character escape — so it has a separate guard, proven by planting a
  violation. Use `String.raw`, a literal regex, or compare words.
- **A check that is too strict is a bug, not caution.** `verify.ts` read the
  hyphen in "82-96%" as a minus sign and withheld a correctly-sourced answer.
  Widening a check that already withholds answers has to be measured in BOTH
  directions.
- **Writing the test found the worse half.** In that same range the lower bound
  parsed as a bare integer, which is deliberately not treated as a claim — so an
  answer could widen a range downwards and only its upper bound was ever
  verified. Nobody had listed that; the test for the visible bug exposed it.
- **A test that asserts the bug passes.** Found three times. One asserted a
  token signed under one passcode DID validate under another, and passed only
  because the test above it restored an env var with `= undefined`, storing the
  string `"undefined"`.
- **Patching a test-only seam.** A router guard was applied to
  `guardPapersRouteForTest` and not to the two real exits. Every unit test
  passed, because with no credentials they take the fallback path where the
  guard already worked. **Only the live check caught it.**
- **`aria-disabled` keeps a control focusable; it does not survive removal from
  the tree.** Five places dropped focus to `<body>` when the focused element was
  unmounted by its own action — including the first example question anyone
  clicks, under a comment claiming the reader "keeps their place".
- **The AI cache freezes routing flakes rather than hiding them.** A cached
  refusal is served for ever. Refusals are no longer written to it
  (`worthKeeping`), and the key namespace was bumped to `aicache:v2` to drop
  what was already stored.
- **Real identifiers in comments, four times.** The hard-coding grep scans
  comments for exactly this reason and has now caught it six times in total.
- **Not every red result is a bug.** Three smoke failures were my own leftover
  pins colliding with the duplicate check; two "layout bugs" were the browser
  pane collapsed to a zero-width viewport, proven by walking the ancestor chain
  to a 0-wide `<body>`.

### What is left

1. **The second dataset, blind.** The last Excellence item and the last piece of
   work. The rules under "The dataset" above are not decoration: nothing in this
   tree may carry `dataset-b`'s figures, and reading it early spends the only
   run of the test that is worth anything. **The user runs this one.**
2. **The handover doc**, the one outstanding brief deliverable.
3. Optional, judged and not done: 6 of the 12 structured smoke questions are
   paraphrases rather than the spec's wording, which is the exact habit
   `tests/routing-spec.test.ts` exists to prevent. The measured ~20-33% routing
   flake lives in a smoke paraphrase, not in the spec wording.

## The external audit

An independent audit ran against `docs/audit-prompt.md`. It confirmed the
invariants by recomputing every governance figure from the committed dataset
and getting 100% agreement, and found **four real defects, all now fixed**, plus
two documentation drifts. Two further findings were judged already-documented
and NOT acted on; both are named below so the next reader does not re-open them.

**One process note, because it cost an hour.** The audit ran in this working
tree while a dev server was running, and `npm run build` corrupted `.next` for
both — the failure this file already warns about three times. An auditor gets a
clone of their own.

### What it found, and what it was right about

- **`tenure.ts` ignored `datasetMismatch`.** The worst finding, and the one this
  file should have predicted. `search.ts` computes the mismatch and its own
  comment calls answering from another organisation's papers "the worst
  possible failure for board data"; `retrieval/tool.ts` refuses on it. The
  hybrid tenure tool read the passages anyway — so with dataset-B active and
  the index still holding dataset-A's papers, it would take THAT board's term
  limit, apply it to THIS board's tenures, and produce a plausible retirement
  schedule belonging to someone else. **Directly in the path of the
  second-dataset test**, which is when it would first have been seen. Same
  shape as the guard once applied to a test-only export and not to the two real
  exits: a rule enforced at one of the places that needed it.

- **`guardUnmeasured` was covered by nothing.** Short-circuiting it to return
  its input left all 392 tests passing. Every question a unit test asks takes
  the offline fallback, which carries its own keyword check, so the guard —
  which exists precisely for the MODEL path — was never executed. It now has a
  test that drives it with the argument only a model produces, and that test
  was proven by bypassing the guard again.

  **Writing it found two holes the audit did not.** "How much are we paying our
  directors?" matched nothing: the clause needed "paid" or "earn", and "paying"
  is neither. "What is the average age of our board?" matched nothing either,
  because the pattern allowed only "the" between "of" and "board", not "our".
  Both were refused in practice ONLY because the offline classifier catches
  them by another route; on the model path they would have been answered.
  Widened and measured in both directions — nine unmeasured questions refuse,
  fourteen answerable ones still pass, including "How much did we pay for the
  new system?", which is a legitimate question for a finance paper and must not
  be caught.

- **Director names were written to the server log.** `scope.matched` is built
  from the dataset's own vocabulary and includes every director name, and two
  `console.warn` calls joined it into a line — on Vercel, into a third-party
  log drain with no retention control. The data-protection section below
  already said "worth checking none carries a director's name". Nobody checked.
  Now logs the count, which is what the line was for. The refusal REASON still
  names the matched terms, and that is correct: it is shown to an authorised
  reader about their own question.

- **`tests/sources.test.ts` had two blind spots**, both in the file whose whole
  job is catching silently-dead guards. It scanned single-quoted strings only,
  so banned refusal copy in a double-quoted string or a template literal was
  invisible — and refusal copy here is routinely a template literal, because it
  interpolates the organisation name. And the template-literal escape scan ran
  over `src` only, while the file's own header says a mangled escape hiding in
  a TEST is the worst case because the test still reports success. Both fixed
  and both proven by planting a violation.

### What was rejected, and why

- **Small integers and word-numbers bypass `verify.ts`.** True, documented, and
  the tradeoff was measured in both directions: demanding that "the 3 papers"
  appear verbatim rejects sound answers, and the previous over-strict version
  of this check is what withheld a correctly-sourced answer. The audit's
  sharpening is worth keeping though — in governance a small integer is often a
  vote count or a number of directors, so "14 grievances across 3 meetings"
  passes unchecked. Recorded as a risk, not fixed, for the same reason as
  before: widening a check that already withholds answers has to be measured,
  and nobody has the corpus to measure this one on.

- **The share link is a bearer credential over named attendance.** The audit
  confirmed every condition set for it is met and called it defensible for a
  fictional dataset and not for real governance data. That is exactly what this
  file already says. No change.

- **Smoke's six paraphrases** were reported as spec drift. The paraphrases stay
  — the measured routing flake lives in one of them, which makes them a useful
  second set. What was actually wrong was the COMMENT above them claiming they
  were "exactly as the specification writes them". The comment was the lie, and
  it has been corrected rather than the questions.

## Limitations, and why they are limitations

**`verify.ts` settles presence, not attribution.** It checks that a figure
appears in a cited passage. It does not check that the passage attaches it to
the same subject, so a passage reading "income was £4.61m" supports an answer
saying "the deficit was £4.61m". That is a reading of prose, not a fact, and it
is the same unsolved problem as prose faithfulness below. The answer's caveat
says so in as many words — it used to claim every figure had been "checked",
which promised more than the code delivers.

Two holes in it were found by audit and closed. It only examined numbers with
four or more digits, a decimal, or a magnitude suffix, so **every percentage
went unchecked** — and a percentage is exactly what a model computes from two
numbers it has been shown; "attendance fell by 14 per cent" verified clean
against passages saying 96% and 82%. And matching was a digit-substring test
against the concatenated passages, so "£12,000" verified against a passage
reading "£112,000". Money and percentages are now checked at any size, figures
are compared as whole values, and bare small integers are still skipped, because
"the 3 papers" is not a finding and demanding it appear verbatim would reject
sound answers. Measured after the change: six real paper questions, four
answered, zero withheld on figures, the two refusals both from retrieval.

**Prose faithfulness is unsolved.** Nothing checks wording. A run once answered that a lease break
notice "can be withdrawn by agreement if the clinical case is not supported" when
the paper says "if the Board does not approve" — a fabricated condition inside a
correctly-cited answer.

A claim-and-quote check was built and measured: it caught 3 of 3 injected
fabrications, but withheld 3 of 9 faithful answers, because the model quoting its
own sources returns truncated or empty quotes about a third of the time. The
fabrication itself could not be reproduced in ~30 natural runs. Blocking one good
answer in three to catch something that rare is worse than the disease; as a
caveat instead it fired on answers quoting figures verbatim, which teaches readers
to ignore warnings. **Not shipped, deliberately.** Worth trying next: constrain
the answer to claim-plus-quote pairs at generation time, so a fabrication has
nowhere to live.

**A cross-encoder reranker measured worse than plain cosine** (−0.817 separation
against −0.043). It ranks relevance, not answerability, and on a corpus where
everything is board governance those differ.

**No similarity threshold can gate answerability here.** "What was the board's
average IQ" scores higher than five of eight genuinely answerable questions,
because it *is* about board composition. More documents made separation worse, not
better. Hence the design: cosine ranks, a model call judges, and a junk floor
derived at ingest from the corpus's own 5th-percentile self-similarity catches
genuinely off-domain questions for free.

**`x-forwarded-for` is trusted as-is.** Correct on Vercel, which sets it. Anywhere
it is passed through from the client, a caller rotates the header for a fresh
bucket.

**Rate limiting is approximate by design.** KV has no atomic increment and a write
costs ~330ms, so the write is not awaited. Two simultaneous requests can both see
the older count. Approximate and shared beats exact and per-instance.

**The gate is a bot fence, not an access control, and that is the intent.**
The passcode exists so that a link handed round in a demo cannot be used by a
stranger to burn Workers AI credits — not to establish who anybody is. Judged
correct for this project and recorded so it is defended rather than discovered:
a demo whose data is a fictional dataset does not need per-user identity, and
building one would have cost an Excellence item. What follows is therefore a
list of what the gate deliberately does NOT do, not a list of defects. Every
line of it changes the moment real board data goes behind it.

**Sessions do not expire on their own**, beyond the cookie's own week. There is
no idle timeout and no server-side session store to revoke one from. Consistent
with the above: an expiry protects a shared machine from the next person to sit
at it, which is a real risk for a governance tool and not one a demo carries.

**Revocation is all-or-nothing, and `SESSION_SECRET` is not optional to know
about.** One shared passcode means revoking anyone revokes everyone. Rotating
`APP_PASSCODE` invalidates live session cookies, and so does rotating
`SESSION_SECRET` — both are in the signing material.

That second part was briefly false and is worth remembering: with a secret
configured, the cookie was signed with the secret INSTEAD of the passcode, so
changing `APP_PASSCODE` revoked nothing for the remaining week of a cookie's
life. Two files documented the opposite, and a test asserted the broken
behaviour while its own name described the correct one — it passed only because
an `= undefined` env restore left the string "undefined" configured.

**The corpus is thin, and that is the data's fault.** Three papers covering 2 of 6
board meetings, no committee papers, and nine action-log topics with no paper at
all. Several reasonable document questions are unanswerable because the document
does not exist. Say so; do not paper over it.

**The flake is in a PARAPHRASE, not in the spec's wording.** Building the eval
harness settled where the ~20% flake below actually lives. The harness runs the
spec's questions verbatim from `tests/spec-questions.ts` and measured
**130/130 over 5 runs each, nothing unstable**. The question that flakes —
"Which meetings had unusually low attendance, and when?" — is a shortened
paraphrase that exists only in `scripts/smoke-api.mjs`. The spec's own wording
for that tool is a much longer sentence about whether a movement is bigger than
one meeting's noise, and it routed 5/5.

Measured: **6 of smoke's 12 structured questions are paraphrases**, not the
customer's wording. That is the exact fault `tests/spec-questions.ts` was
created to fix — its header even quotes this paraphrase as the offending
example — and it was fixed in the two routing suites and never in smoke.

Two honest readings, and they do not cancel out. Smoke's paraphrases are not
worthless: real readers paraphrase too, and a wording that flakes at 20% is
worth knowing about. But smoke presents them as the spec's twelve questions,
which they are not, so "12/12" reads as more than it is. Worth deciding
deliberately rather than drifting: either point smoke at the shared list like
the tests do, or keep the paraphrases and label them as a second, harder set.

**The cache did not hide the flake, it FROZE it — now fixed.** Worse than
hiding: whichever answer the first caller happened to get was written to KV and
served to everyone for the full hour. Measured on the paraphrase below: six
identical refusals in a row, zero live model calls, looking entirely
deterministic, for a question the dataset answers.

Two changes. `cached()` now takes a `worthKeeping` predicate, and `router.ts`
passes one that refuses to store a refusal — a cached GOOD route is harmless
because the model would have chosen it again, but a cached refusal is a wrong
answer with a one-hour lease. And the key namespace went `aicache:v1` →
`aicache:v2`, because entries written under the old rule were still live: after
the code fix alone, six more calls returned the stale refusal and made zero
model calls. A caching rule change needs the namespace bump or it does not
apply to the very questions it was written for.

Verified after both: refusal, then a live re-ask that routed correctly, then
four cache hits on the good route — two live calls instead of six. The cost is
one model call per refusal rather than per question.

**Routing is not deterministic, and the cache hides it.** Measured with
`AI_CACHE=off`: "Which meetings had unusually low attendance, and when?" routed
to `attendance_by_meeting` four times and to a REFUSAL on the fifth — a ~20%
flake on one spec question. `temperature` is already 0 in `router.ts`, so this
is the provider, not a parameter: `@cf/openai/gpt-oss-120b` is a
mixture-of-experts model served at scale and gives no determinism guarantee.

The dangerous part is that it is invisible in normal use. A warm AI cache
serves the first good route for ever, so `npm run smoke` reports "routed by
model: 12/12" from ONE live call and eleven cache hits — the assertion passes
while the live path is untested. A cold run (31 model calls) is the only honest
measurement.

This is the exact failure the brief warns about ("routing failures are
silent"), and it is why the eval harness needs to run each question several
times and report a rate rather than a pass. Do not "fix" the flake by relaxing
refusal behaviour until the harness can measure both directions: the five spec
refusals must still refuse.

**The offline classifier cannot spot a document question that names no document.**
"Why did the hospice close the Ashcombe unit?" gives no clue in its wording, and
the giveaway would be matching the organisation's own vocabulary — the hard-coding
that breaks dataset-agnosticism. It fails safe, refusing rather than misrouting.

**The CQC refusal now passes for the right reason** (no paper covers it), having
previously passed only because retrieval was unbuilt.

### Known, and not easily fixable

These are the ones an audit keeps re-finding. Each has been looked at properly
and left alone for a stated reason, so the next person does not spend a day
rediscovering why.

- **Prose faithfulness is unsolved** — see the Limitations section above. A
  claim-and-quote check caught 3 of 3 injected fabrications and withheld 3 of 9
  faithful answers. Not shipped. The route worth trying is constraining the
  answer to claim-plus-quote pairs at generation time.
- **`verify.ts` settles presence, not attribution.** Same underlying problem.
  The caveat says so in as many words.
- **`verify.ts` cannot see numbers written as words.** "nine hundred thousand"
  bypasses the figure check entirely. Tractable, but widening a check that
  already withholds answers needs measuring in both directions — over-strictness
  is what killed the previous version of this check.
- **The corpus is not guarded against prompt injection.** Retrieved passages are
  put in front of the model as trusted text, so a board paper containing
  instructions is one. Mitigable (delimit passages, instruct the model to treat
  them as data) but not solvable, and mitigation must not be described as a fix.
  The blast radius is bounded by the rule that no figure comes from a model, and
  by `verify.ts` — an injected instruction cannot invent a number that passes.
- **Model refusal reasons are shown verbatim**, and the guard cannot see them.
  `tests/sources.test.ts` enforces "say what no TOOL computes, not what the DATA
  lacks" by grepping the strings in our source. A model-authored reason is not
  in the source, so a refusal can tell the reader "there is no attendance data
  for that" while the dataset holds every figure and only the particular cut is
  uncomputed — asking for a median is exactly that case. Not observed in the
  wild, and it is one sentence rather than a wrong number. Mapping them to
  deterministic wording needs the real refusals collected first, or the
  replacement wording is guesswork.
- **The hard-coding scan cannot cover paper section headings.** They read
  "Income", "Risks", "Recommendation" — generic governance English that
  `src/lib` legitimately contains (`verify.ts` matches "income" to spot a money
  question). Banning them makes the guard unsatisfiable rather than catching
  anything; the organisation-specific part of a heading is a proper noun inside
  it, which needs entity extraction, not a word list. `role`, paper titles and
  filename stems ARE now banned.
- **`pinKey` does not normalise defaulted arguments.** `{}` and
  `{ threshold: 80 }` key differently when 80 is the default, so one chart can
  be pinned twice. Fixing it means reading defaults out of the tool
  definitions. The `undefined`/`null` half is fixed and tested.
- **Scroll position is lost on view switch — and this is NOT a defect.**
  Switching Chat → Data → Chat lands at the top rather than where you were. It
  was listed as an outstanding bug and it is a preference: nothing is wrong, no
  state is lost, and the reader's place in a transcript they are about to add
  to is not obviously worth preserving. It is recorded here only because a
  `content-visibility` fix was written, could not be verified, and was reverted
  — and unexplained reverted code invites the next person to try it again. If
  it is ever wanted, it needs a browser pass, not more code.
- ~~**`recharts` is on a deprecated 2.x.**~~ **Upgraded to 3.10.1.** The
  predicted silent failure did happen, but in a different place than expected —
  see "The recharts 3 upgrade" below.

### Recorded, not fixed

Found by audit, judged not worth fixing. None affects a user.

- `Chat.tsx`'s `run()` does not enforce single-flight itself; the UI guards do.
- The usage meter is dev-only and resets with the server; `/api/usage` 404s in
  production. Intended, not a defect: it is auth-checked, unlinked from the UI,
  and 404s so a deployment cannot confirm the endpoint exists.
- `bearerCredential`'s regex accepts a broad token shape.
- **`recharts` was on 2.15.4 and is now on 3.10.1.** Kept here because the
  REASONING was right even though the conclusion changed: the danger was never
  that the upgrade would fail loudly, it was that a dot renderer could stop
  receiving `payload`, the flagged marker would stop being drawn, and every
  test would still pass because nothing here asserts on rendered SVG. That is
  exactly what happened, one level up — see below.

### The recharts 3 upgrade, and what it cost

Done on its own branch with a live before-and-after, because the suite cannot
see a chart that stops being drawn.

**The charts themselves came through unchanged.** A fingerprint taken under
2.15.4 and again under 3.10.1 matched exactly: 15 circles plus 3 rects rotated
45 degrees filled `#8f1d1d`, one curve path, 24 tick labels, the hatch pattern
on every flagged bar, both dashed reference lines with their labels, tick
geometry identical to the pixel. The PNG export was checked at pixel level too,
since `chartimage.ts` serialises that same SVG.

**What broke was a whole view, in silence.** Workspace keeps all three views
mounted and hides the inactive ones so the transcript survives a switch, so the
dashboard's cards mount inside a `display: none` subtree on every page load.
recharts 3 measures its container on mount, gets zero there, and never draws;
2.x recovered when the view was shown. **Every pinned chart rendered blank and
all 389 tests passed.** A chart mounted while VISIBLE is fine, including across
later hides, so the fix is a latch on the `hidden` prop `PinnedDashboard`
already receives.

**Do not replace that latch with an observer.** An IntersectionObserver version
was written first and could not be verified: neither IntersectionObserver nor
ResizeObserver delivers a single callback in the browser pane available here,
which is very likely why v3 fails in it at all. A fix whose mechanism cannot be
exercised, for a bug that IS that class of API, only works on the machine that
wrote it.

**recharts 3 renders nothing server-side.** `renderToStaticMarkup` returns an
empty wrapper div, which killed two assertions in `tests/chart-hatch.test.tsx`
— and one of them asserted a pattern was ABSENT, which an empty string
satisfies perfectly. The upgrade turned a real guard into a test that passed
while measuring nothing. Charts are now rendered into a jsdom
(`tests/jsdom-setup.ts`, imported FIRST because the globals must exist before
recharts is evaluated).

**One footgun is gone upstream:** v3 KEEPS a component-wrapped `defs`, which
2.x dropped. That drop is what made the hatch ship invisible in the first
place. The rule to keep those defs as raw elements stays as belt and braces.

**Cost:** first-load JS on `/` went 224 kB to 237 kB.

**Two false alarms, both indistinguishable from the real bug.** Everything
appeared not to render — the pane had collapsed to zero width, `innerWidth: 0`,
the same artefact that produced two phantom layout bugs here before. Then every
dot and tick appeared to have vanished — that was v2-shaped selectors, since v3
restructures the SVG into `recharts-zIndex-layer` groups. **Check `innerWidth`
before believing a rendering bug in that pane.**

**Still not asserted anywhere: rendered SVG.** The new dashboard test pins the
latch, not recharts. A future upgrade needs the same live before-and-after.

## Deployment

Vercel builds `main`. Two things that were learned the hard way:

- **Vercel gates the build on Next's version**, not just on `npm audit`. A
  vulnerable Next fails the build outright with "Vulnerable version of Next.js
  detected" before any code is compiled.
- **`postcss` is pinned by Next 15 at a vulnerable version**, and npm's only
  offered fix is Next 16. The `overrides` entry in `package.json` moves it
  forward inside 8.x instead, so the framework upgrade stays a decision rather
  than something an audit forces.
- **`allowScripts` records that esbuild's postinstall was reviewed.** npm 12
  will block unreviewed install scripts rather than warn, so removing that field
  turns a warning into a failed install. It is pinned to the reviewed version on
  purpose.

To reproduce a Vercel build exactly, with no `.env.local` and no dataset:

```bash
git archive main | tar -x -C /tmp/vercel-repro && cd /tmp/vercel-repro && npm ci && npm run build
```

## Data protection — noted, not implemented

Mostly not built, and recorded because the demo persists real-shaped board
data. The share link below IS built, and its conditions were met — the rest of
this section is still outstanding.

**What is stored is personal data.** Attendance names identifiable directors and
records whether each one turned up; the skills audit records self-assessed
competence per person. Under UK GDPR that is personal data and arguably
performance data, held about people who are not the users of this app. Nothing
here is special-category today, but a board paper mentioning a director's health
or absence reason would make it so.

**A tokened share link is an unauthenticated route to it — and it is now
BUILT.** `src/lib/shares.ts`, `/api/shares`, and the public page at
`/share/[token]`. Every condition set here before it was written is met, and
each is tested:

- **High-entropy token.** 32 bytes from the platform CSPRNG, base64url — 256
  bits, derived from nothing, so there is no enumeration and no clock to infer.
- **Expiry**, mandatory, defaulting to 7 days and capped at 30. Written as a KV
  TTL *and* checked on read, because a TTL is a promise about eviction rather
  than about correctness, and this is the one route with no passcode.
- **Revocation**, immediate. The record is deleted BEFORE the owner's index is
  updated: if only one write lands, the link must be the half that stops
  working.
- **`noindex`**, from both the page metadata and an `X-Robots-Tag` in
  middleware, plus `no-store` so a revoked link cannot be served from a cache.
- **No personal data in the URL.** The path carries the token alone.

Two further decisions worth keeping. It is a **snapshot, not a live view**: a
link that followed the dashboard would silently widen as new charts were
pinned, so what you shared is what they see. And a bad token, an expired one
and a revoked one all return the SAME page, because distinguishing them would
confirm to someone holding a guessed token that they had guessed a real one.

**What is still true: this is a hole in the gate, on purpose.** Board data with
named directors, reachable by anyone holding a URL. Before real data it wants a
per-link audit of who opened it, and probably a named recipient rather than a
bearer token.

**Retention.** Datasets, pins and transcripts are written to KV with no TTL,
deliberately — a pin that expired on its own would be a silent loss. That is
right for a demo and wrong for real data: there is no retention period and
nothing deletes anything on a schedule.

**Access control is one shared passcode.** No per-user identity, so no record of
who read what, no way to revoke one person, and no audit trail. For board
attendance and skills data that is thin, and it is the first thing to change
before real data.

**No erasure or rectification path.** A director cannot be removed or corrected
except by re-uploading the whole dataset.

**Residency and processors.** KV replicates globally; a UK charity may require
UK or EU residency. Cloudflare and Vercel are processors and would need a DPA.
Errors are logged server-side — worth checking none carries a director's name.

**Minimisation.** Transcripts store headlines, and headlines contain figures
about named people. Storing conversations indefinitely keeps more than answering
a question requires.

## Brief compliance — both former gaps closed

Kept as a record of what was wrong, because both were closed by work that is
easy to undo by accident.

- **"A simple middleware check protecting every page and API route."** Now
  `src/middleware.ts`, with 9 tests. Every API route still checks per-request
  as well: middleware is a gate, not a guarantee, and on a platform where a
  mistyped matcher silently stops running it must never be the only check.
  The matcher lists what to SKIP, so a new route is protected by default —
  and the things it skips have twice been the bug. See the fonts and the app
  icon in `tests/middleware.test.ts`.
- **"Cache expensive AI results so the same request doesn't cost twice."** Now
  `src/lib/aicache.ts`, wired into all three model call sites: routing
  (`router.ts`), embeddings (`retrieval/vectorize.ts`) and the grounding judge
  (`retrieval/answer.ts`). Nothing derived from the dataset is cached — every
  figure is recomputed on every request, which is the rule the product rests
  on. `AI_CACHE=off` bypasses it, and the smoke suite needs that: a cached
  route reports `routedBy: 'model'` quite correctly, so the assertion that
  catches a dead AI Gateway could otherwise be satisfied from cache.

Also confirmed against the brief: rate limit defaults to 20 per minute per IP
(its stated "sensible default"), and `cf-aig-gateway-id` is `default`.

## Open decisions

- **No attendance threshold exists in the data.** Defaults to 80%, always stated.
- **Body names differ between files** — `attendance.json` says "Finance and Audit
  Committee", `actions.json` says "Finance and Audit". Nothing joins across them,
  but the UI shows both spellings.
- **"Which committees have the greatest skills gaps" depends on the metric** — by
  mean it is People Committee, by single weakest skill it is Clinical Governance.
  Ranks by mean, shows the weakest skill as a second series.

## Environment

`.env.local`, gitignored. `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_AI_GATEWAY_ID`,
`CF_VECTORIZE_INDEX`, `CF_KV_NAMESPACE_ID`, `APP_PASSCODE`, `DATASET_PATH`,
`RATE_LIMIT_PER_MINUTE`, `SESSION_SECRET`, `AI_CACHE`.

`SESSION_SECRET` was missing from this list until an audit asked why the
session behaved differently with it set. Optional: without it the session
cookie is signed with the passcode alone, which is weaker because a passcode is
short and human-chosen and a cookie ends up in proxy logs. Set it in any real
deployment. Either it or `APP_PASSCODE` revokes every live session when
rotated.

`AI_CACHE=off` bypasses the model cache. The eval harness needs it, or repeat
runs are served from cache and a flaky router reports as perfectly stable.

Model calls go to the Workers AI REST endpoint with the `cf-aig-gateway-id`
header. The `gateway.ai.cloudflare.com/{account}/{gateway}` URL form returns 401
on this account — it needs a gateway to exist under that exact name.

A missing `APP_PASSCODE` returns 503 in production rather than serving the app
unprotected. On deployment, every variable above must be set in Vercel too.
