# Ask BoardServe

A chat interface for company secretaries to ask questions about board data in plain
English and get back **dynamically generated charts**, not fixed dashboards.

Sits alongside BoardServe's existing analytics section rather than replacing it: the
point is to answer the questions the fixed dashboard cannot.

## Status

Core, Complete, and four of the five Excellence items are done: chat over
fifteen tools with bar and line charts inline, one-sentence findings, refusals,
multi-turn refinement, retrieval over the board papers, a conversation rail,
pin-to-dashboard, shareable read-only links, PNG export, an eval harness whose
results are written into this file, provenance on every chart, a passcode gate,
rate limiting, and a Vercel deployment that works from a clean clone.

Outstanding: the second-dataset test, and a handover document.

**`CLAUDE.md` is the single source of truth** — what is built, what is
deliberately not, every measured limitation, and the mistakes worth not
repeating. Read it before changing anything. `PRODUCT.md` holds the product
truth (users, purpose, principles); `DESIGN.md` holds the visual system;
`docs/audit-prompt.md` is the brief for an external review.

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

**One dataset is committed, at `dataset/`, and the app works from a clean clone
with no configuration.** It holds board attendance, an action log, a skills
audit and three board papers for a fictional organisation — which is the only
reason it can be committed at all. Real board data would not be: attendance
names identifiable people and records whether each one turned up.

A second dataset is loaded by uploading a `.zip` in the Data view, which stores
it in KV and takes precedence over the committed one. `DATASET_PATH` points the
loader somewhere else if you want a third.

The committed dataset contains:

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
