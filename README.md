# Ask BoardServe

A chat interface for company secretaries to ask questions about board data in plain
English and get back **dynamically generated charts**, not fixed dashboards.

Sits alongside BoardServe's existing analytics section rather than replacing it: the
point is to answer the questions the fixed dashboard cannot.

## Status

Core and Complete are done: chat, twelve deterministic tools, bar and line
charts inline, one-sentence findings, passcode gate, Vercel deployment, rate
limiting, hybrid routing, retrieval over the board papers, refusals, multi-turn
refinement, and pinning to a dashboard.

`CLAUDE.md` holds the working record and the measured limitations. `PRODUCT.md`
holds the product truth. `DESIGN.md` holds the visual system.

## Eval results

A fixed set of the spec's own questions, each with an expected answer TYPE, run
against a live server several times per question and scored as a rate.

Run it with the server started with `AI_CACHE=off` — otherwise repeat runs are
served from cache and every question reports as perfectly stable:

```bash
npm run eval -- --runs 5 --write-readme
```

`npm run predeploy` runs typecheck, lint, the unit tests and this, and exits
non-zero if any question NEVER passes.

**Why a rate and not a pass.** Routing is a model call and is not deterministic
even at temperature 0. One question here was measured routing correctly four
times out of five and refusing on the fifth, so a single run reports it as a
pass 80% of the time. The unstable column is the honest reading; note that five
runs has roughly a two-in-three chance of catching a one-in-five flake, so a
clean column is evidence rather than proof.

<!-- eval:start -->

_Last run 2026-09-03 20:51 UTC, 5 runs per question against a live server._

| Category | Questions | Attempts | Passed | Rate | Unstable |
| --- | --- | --- | --- | --- | --- |
| structured | 12 | 60 | 60 | 100% | 0 |
| document | 3 | 15 | 15 | 100% | 0 |
| hybrid | 5 | 25 | 25 | 100% | 0 |
| refusal | 6 | 30 | 30 | 100% | 0 |
| **overall** | 26 | 130 | 130 | **100%** | 0 |

<!-- eval:end -->

## Stack

- Next.js (App Router, TypeScript)
- Cloudflare Workers AI (routing + narration), Vectorize (paper retrieval), KV
  (pinned dashboards, share tokens, rate limits, caching)
- Recharts for chart rendering
- Deployed to Vercel behind passcode middleware

## Principles

- **Tools compute, the model narrates.** No number in the UI is ever produced by
  the language model. Every figure comes from a deterministic tool call over the
  dataset, and the model only writes the one-sentence takeaway around it.
- **One sentence per chart, and it says the notable thing.** "Three directors are
  below 75% attendance, all on Audit" - not "this chart shows attendance by director".
- **Refuse rather than guess.** If the data cannot answer the question, say so and
  say why.
- **No dataset-specific hard-coding.** A second organisation's data should load
  with no code changes.

## Data

**The dataset is deliberately not in this repository.** It contains board
attendance, action logs, skills audits and board papers, and is `.gitignore`d.

To run locally, place the dataset folder at `dataset/`:

```
dataset/
  attendance.json          12 months of board + committee attendance, 10 directors
  skills-audit.csv         10 directors x 10 skills, self-assessed 1-5
  actions.json             ~40 action items with owners, due dates, statuses
  paper-01-*.md            board papers - the retrieval corpus
  paper-02-*.md
  paper-03-*.md
```

The "as at" date for anything time-dependent is **taken from the data**
(`as_at` / `generated`), never from the system clock. Tests will start failing
next month otherwise.

### Two traps the data sets deliberately

1. **Attendance denominators.** Committee rows in `records[]` only exist for that
   committee's members, so each director's denominator differs. And `apologies`
   means advance notice was given - it is still non-attendance. Counting it as
   attendance gives a plausible wrong answer.
2. **Recorded vs derived overdue.** `status` is hand-typed by the secretariat and
   is not always right. Overdue must be derived as `due_date < as_at AND status !=
   "complete"`, which returns more rows than `status == "overdue"`. The right
   answer reports both numbers and says which is which.

## Environment

Copy `.env.example` to `.env.local` and fill it in. Never commit real values.

## Development

```bash
npm install
npm run dev
```
