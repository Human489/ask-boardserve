# Ask BoardServe

A chat interface for company secretaries to ask questions about board data in plain
English and get back **dynamically generated charts**, not fixed dashboards.

Sits alongside BoardServe's existing analytics section rather than replacing it: the
point is to answer the questions the fixed dashboard cannot.

## Status

Pre-spec. See `docs/` for the spec and question set.

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
