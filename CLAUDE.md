# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ask BoardServe** — a chat interface where company secretaries ask questions about
board data in plain English and get back dynamically generated charts. It sits
alongside BoardServe's existing analytics section, not as a replacement: the point
is answering the questions a fixed dashboard cannot.

Built for a work-experience project with a fixed schedule (Core → Complete →
Excellence). See "Project status" at the bottom for what is done and what is next.

## Commands

```bash
npm run dev          # dev server on :3000
npm run build        # production build — run before claiming anything works
npm run typecheck    # tsc --noEmit
npm test             # all tests (tsx --test tests/*.test.ts)
```

Single test file, and a single test by name:

```bash
npx tsx --test tests/analytics.test.ts
npx tsx --test --test-name-pattern "overdue" tests/analytics.test.ts
```

Probe the live model router (needs `.env.local`; prints per-question accuracy):

```bash
node scripts/probe-router.mjs
```

If `.next` gets into a bad state after mixing `npm run build` with a running dev
server, the browser will 404 on chunks and the page will silently stop responding
to clicks. `rm -rf .next` and restart.

## The dataset

**Not in the repo — it is gitignored and must never be committed.** Place it at
`./dataset` or set `DATASET_PATH`. It holds `attendance.json`, `actions.json`,
`skills-audit.csv` and three `paper-*.md` board papers.

Note `.gitignore` uses `/dataset/`, anchored. An unanchored `dataset/` also matches
`src/lib/dataset/`, which silently drops application code from commits.

## Architecture

Question → router picks a tool → tool computes → UI renders. Four layers:

**`src/lib/types.ts`** — the contracts everything speaks. Read this first.
`ToolDefinition` and `ToolResult` are the whole design in one file.

**`src/lib/dataset/loader.ts`** — parses the files once and caches. Also holds
helpers used by more than one analytics module: `daysBetween`, `committeesOf`,
`membersOf`, `allBodies`, `pct`.

**`src/lib/analytics/*.ts`** — twelve tools across attendance, actions and skills,
each implementing `ToolDefinition`. `registry.ts` exports `TOOLS` and `getTool`.
The registry is the single source the router generates its schemas from, so
**adding a tool requires no router change.**

**`src/lib/router.ts`** — two paths. Primary is Cloudflare Workers AI tool-calling
through the AI Gateway (header `cf-aig-gateway-id` is required on every call), with
an explicit `refuse` pseudo-tool so the model does not have to invent a refusal.
Falls back to a deterministic keyword classifier when credentials are missing or
the call fails or times out, so the app works and stays testable with no model
access. The result carries `routedBy: 'model' | 'fallback'` — including on
refusals — and the UI surfaces it.

**`src/app/api/ask/route.ts`** — rate limit → validate → load → route → run →
respond. `src/components/` renders it.

### The rule the product rests on

**Tools compute, the model narrates.** No number reaching the screen is ever
produced by a language model. Each tool writes its own `headline` deterministically
by interpolating values it just computed, so the sentence can never disagree with
the chart. The model's only job is choosing the tool and its arguments.

A headline must say the **notable thing**, not describe the axes. "Three directors
are below 80% attendance, all on Audit" — not "this chart shows attendance by
director".

`ToolResult` also carries `assumptions`, `caveats` and `provenance`, and the UI
shows all three without a disclosure. An answer without them is not an honest
answer.

## Invariants — breaking these produces plausible wrong answers

These are the traps the dataset sets on purpose. Each has a test.

- **`apologies` is non-attendance.** It means advance notice was given. Only
  `status === 'present'` counts toward a rate.
- **Denominators differ per director** (9 to 15 here). Committee rows exist only
  for that committee's members. Never divide by the total meeting count. The
  regression check: our aggregation must reproduce `director_summary` exactly.
- **Overdue must be derived**, as `due_date < asAt && status !== 'complete'`. The
  log's `status` is hand-typed and wrong for some rows. Report the derived and
  recorded counts and say which is which — and generate that sentence from the
  actual set difference, which can run in either direction.
- **Use `dataset.asAt`, never `Date.now()` or `new Date()`.** Reading the clock
  makes every date-dependent test rot as the month turns. A test greps the sources
  for both.
- **`owner` is a job title, not a director.** Most owners cannot be resolved to a
  named person; say how many.
- **Committee membership is inferred** from eligibility rows — no roster field
  exists. Any tool relying on it carries that caveat.
- **Skills are self-assessed.** A bare mean is a weak answer: always also report
  the counts at 4-or-above and 2-or-below.
- **Nothing organisation-specific may be hard-coded** — no director, committee,
  skill or risk names, no meeting counts. Skill columns come from
  `dataset.skillNames`. A second organisation's data must load with no code change.
- **Small-n caveats must be computed, not asserted**, with the real n and the real
  percentage-point impact of one more absence.

## Testing

`tests/analytics.test.ts` pins values verified against the dataset during the
question audit, so it fails on drift rather than only on throws.

`tests/routing-spec.test.ts` exists because of a specific failure worth not
repeating: the original routing tests were written in paraphrases tuned to the
classifier, and passed 12/12 while the classifier scored only three subject areas
and returned the first tool in each — nine of twelve tools were unreachable, and
real accuracy on the specification's wording was 3/12.

**Route the customer's wording, not your own paraphrases.** That file holds the
spec questions verbatim and asserts every registered tool is reachable from at
least one of them.

## Project status

### Core — done

Chat interface, twelve structured questions answered through tools, bar and line
charts inline, one-sentence insight per chart, passcode middleware, rate limiting
(20/min per IP, in-memory), loading and error states. 74 tests pass; build clean;
routing, chart, refusal and provenance paths exercised in the browser in both
themes.

**Unverified:** the live model path has never run. `.env.local` exists but the
`CF_*` values are blank, so all routing so far has come from the offline
classifier. Filling those in and running `scripts/probe-router.mjs` is the
highest-value next action, because if the model routes worse than the keyword
fallback that changes the design.

### Complete — not started

- Correct structured / document / hybrid routing
- Board-paper retrieval through RAG (Vectorize; `CF_VECTORIZE_INDEX` is read into
  config but not wired). Document questions currently route to a refusal that says
  retrieval is not built — deliberately, rather than stubbing a fake RAG.
- Refusal behaviour — the five refusal cases pass already, but they are all
  *absence* refusals. There is no test for the case where sources disagree: the
  skills paper's numbers contradict the CSV.
- Multi-turn refinement — history is plumbed through the API but no tool consumes it
- Pinning charts to a dashboard (KV)

### Excellence — not started

Eval harness over structured/document/hybrid/refusal cases; provenance surfaced as
a chart affordance rather than only as text; image export for individual charts;
shareable read-only dashboard links; second dataset loading with no code changes.

### Open decisions

- **No attendance threshold exists in the data.** Currently defaults to 80% and is
  always stated in the answer.
- **The nine-year term limit is prose in `paper-03`**, not a field — so "who times
  out in the next 12 months" is genuinely a hybrid question, not a structured one.
- **`paper-03`'s numbers contradict `skills-audit.csv`.** Proposed rule: structured
  data wins on numbers, papers supply context. Not yet confirmed with the client.
- **Body names differ between files** — `attendance.json` says "Finance and Audit
  Committee", `actions.json` says "Finance and Audit". Nothing joins across them
  today, but the UI shows both spellings.
- **"Which committees have the greatest skills gaps" depends on the metric** —
  by mean across all skills it is People Committee, by single weakest skill it is
  Clinical Governance. Currently ranks by mean, showing the weakest skill as a
  second series.

### Conventions

Commits are scoped (`feat(analytics):`, `fix(router):`) and explain the reasoning,
not the diff. Features beyond Core go on their own branch off `main` and merge with
`--no-ff`. `docs/question-set.md` is deliberately untracked planning material.

Do not open `dataset-b` (a second organisation, for the zero-code-change test)
until that test is being run honestly — reading it early spoils the only chance to
run it.
