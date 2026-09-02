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
npm test             # 147 unit tests (tsx --test tests/*.test.ts)
npm run smoke        # 30 end-to-end checks against a RUNNING server
```

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
```

**Stop the dev server before `npm run build`.** They share `.next`, and running
both corrupts it: the browser 404s on chunks and the page silently stops
responding to clicks. `rm -rf .next` and restart. This has happened three times.

## The dataset

**Not in the repo — gitignored, and must never be committed.** Place it at
`./dataset` or set `DATASET_PATH`. It holds `attendance.json`, `actions.json`,
`skills-audit.csv` and three `paper-*.md` board papers.

`.gitignore` uses `/dataset/`, anchored. An unanchored `dataset/` also matches
`src/lib/dataset/`, which silently drops application code from commits.

Do not open `dataset-b` (a second organisation, for the zero-code-change test)
until that test is being run honestly. Reading it early spoils the only chance to
run it, and the value of the test is entirely in not knowing what is in there.

That includes second-hand knowledge. Working notes that described `dataset-b`'s
contents have been moved out of the repo rather than kept around, so nothing in
this tree carries its figures. If you find such notes, do not read them into
context — the test is only worth running blind.

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

### The rule the product rests on

**Tools compute, the model narrates.** No number reaching the screen is produced by
a language model. Each tool writes its own `headline` deterministically from values
it just computed, so the sentence cannot disagree with the chart. The model chooses
the tool and its arguments; for document questions it also summarises retrieved
prose, and is forbidden from doing arithmetic on it.

A headline says the **notable thing**, not the axes. `ToolResult` also carries
`assumptions`, `caveats` and `provenance`, all shown without a disclosure.

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

### Core — done, except deployment

Chat, twelve structured questions, bar and line charts, one-sentence insights,
passcode, rate limiting, loading and error states. **Vercel deployment is not
done** and is the one outstanding Core item.

### Complete — done, except pinning

Structured/document/hybrid routing, RAG over the board papers, refusal behaviour
including source disagreement, and multi-turn refinement all work. All 16 spec
questions answer; all 5 refusals refuse.

**Pinning charts to a dashboard is the remaining item.** KV is already wired, so
storage is solved; the work is UI plus a route.

### Excellence — not started

Eval harness, provenance as a chart affordance, image export, shareable read-only
dashboard links, second-dataset load.

## Limitations, and why they are limitations

**Prose faithfulness is unsolved.** `verify.ts` checks every figure against the
cited passages; nothing checks wording. A run once answered that a lease break
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

**There is no session.** The passcode is sent with every request and a refresh
returns to the gate. That was asked for, and it is what makes the app stateless —
but it also means no revocation short of changing `APP_PASSCODE`, and no expiry.

**The corpus is thin, and that is the data's fault.** Three papers covering 2 of 6
board meetings, no committee papers, and nine action-log topics with no paper at
all. Several reasonable document questions are unanswerable because the document
does not exist. Say so; do not paper over it.

**The offline classifier cannot spot a document question that names no document.**
"Why did the hospice close the Ashcombe unit?" gives no clue in its wording, and
the giveaway would be matching the organisation's own vocabulary — the hard-coding
that breaks dataset-agnosticism. It fails safe, refusing rather than misrouting.

**The CQC refusal now passes for the right reason** (no paper covers it), having
previously passed only because retrieval was unbuilt.

### Recorded, not fixed

Found by audit, judged not worth fixing. None affects a user.

- `unresolvedByCommittee` and `actionsDistribution` compute percentages inline
  rather than via the canonical `pct()`.
- `list()`, `num()` and `str()` are duplicated across the analytics modules.
- `Chat.tsx`'s `run()` does not enforce single-flight itself; the UI guards do.
- `bearerCredential`'s regex accepts a broad token shape.
- The usage meter is dev-only and resets with the server; `/api/usage` 404s in
  production.
- **`recharts` is on 2.15.4, which upstream has deprecated** — the 1.x and 2.x
  branches get no further fixes. `npm ci` prints a deprecation notice; nothing
  fails. Deliberately not upgraded: v3 is a breaking major, and the parts it
  reworked are precisely the ones `BoardChart` leans on — the per-point `dot`
  render prop that draws the flagged diamond, and the custom axis tick elements.
  If a dot renderer stopped receiving `payload`, the flagged marker would simply
  stop being drawn, with every unit test still passing, because nothing here
  asserts on rendered SVG. Migrate on its own branch with a visual pass over one
  bar chart and one line chart, both with a flagged point. Not as a way to
  silence an install warning before a deploy.

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
`RATE_LIMIT_PER_MINUTE`.

Model calls go to the Workers AI REST endpoint with the `cf-aig-gateway-id`
header. The `gateway.ai.cloudflare.com/{account}/{gateway}` URL form returns 401
on this account — it needs a gateway to exist under that exact name.

A missing `APP_PASSCODE` returns 503 in production rather than serving the app
unprotected. On deployment, every variable above must be set in Vercel too.
