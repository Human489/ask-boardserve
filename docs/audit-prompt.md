# External audit prompt

Paste the block below into a fresh session (Claude Code, or any agent with
repo access) pointed at a clean clone. Everything it needs to run is in the
repo; no credentials are required for the parts that matter most.

---

You are auditing **Ask BoardServe**, a Next.js app where company secretaries
ask questions about board governance data in plain English and get back
generated charts. Assume nothing in its documentation is true until you have
checked it.

**Read `CLAUDE.md` first.** It is unusually detailed and it is the thing under
audit as much as the code: it makes specific, checkable claims about what was
measured, what is deliberately not fixed, and why. Treat every claim in it as a
hypothesis. A documented limitation that is worse than documented, or a
"verified" number that does not reproduce, is a more valuable finding than a
style nit.

Then verify, in this order:

1. **Does it stand up?** `npm ci && npm run typecheck && npm run lint && npm test`.
   These need no credentials. Report anything that fails, is skipped silently,
   or takes an implausibly short time for what it claims to cover.

2. **Do the tests test anything?** This project has been bitten three times by
   tests that passed while asserting nothing, or while asserting the bug. Look
   specifically for: assertions against empty strings; tests that would still
   pass with the feature deleted; regexes built from template literals, where
   `\b` is a backspace rather than a word boundary; and guards applied to a
   test-only export rather than to the real code path. Try deleting a guard and
   confirming its test actually goes red.

3. **The rule the product rests on.** The claim is *tools compute, the model
   narrates* — no number reaching the screen is produced by a language model.
   Try to break it. Find any path where a figure, percentage, count or date in
   the UI could originate from a model response rather than from deterministic
   code over the dataset.

4. **The invariants.** `CLAUDE.md` lists them under "Invariants — breaking these
   produces plausible wrong answers", each claiming a test. Check that each
   test exists and would actually catch a violation. The analytics values in
   `tests/analytics.test.ts` are pinned to a committed dataset, so you can
   recompute them independently and compare.

5. **Refusal behaviour.** The product's first principle is that a wrong answer
   is worse than no answer. Check that out-of-scope questions refuse rather
   than reaching a plausible-looking tool, and that a refusal never claims the
   DATA is missing when only the TOOL is — asking for a median is the case to
   try.

6. **Security and data protection.** One shared passcode, a middleware gate
   whose matcher lists what to SKIP, an unauthenticated tokened share route
   serving named directors' attendance, and KV state keyed per dataset. Look
   for routes reachable without the gate, tokens that are guessable or leak
   information by differing failure modes, personal data in URLs or logs, and
   any state that could outlive a dataset swap and show one organisation's
   figures under another's question.
   `CLAUDE.md` states the gate is deliberately a bot fence rather than an
   access control. Judge whether that is defensible for what it holds, and say
   so either way — but do not report the documented design as if it were an
   undiscovered flaw.

7. **Accessibility.** The stated bar is WCAG 2.2 AA, and one commitment is
   specific: chart colour may never be the only carrier of meaning. Check
   contrast in BOTH themes, keyboard operability of every control, focus that
   survives an element being removed by its own action, and whether the
   flagged-mark hatch actually reaches the rendered SVG.

8. **What is NOT covered.** Rendered SVG is asserted nowhere. Say what else a
   green suite would not catch.

Rules of engagement:

- **Do not open `dataset-b/` if present.** It is reserved for a
  zero-code-change test that is only meaningful run blind, and reading it
  spends the single run that is worth anything.
- Distinguish clearly between: a real defect; a documented limitation you think
  is under-weighted; and a preference. Rank by what would put a wrong figure in
  front of a board.
- For each finding give the file and line, what breaks, and the input or state
  that triggers it. If you cannot reproduce it, say so and mark it as
  unverified.
- Say plainly what you checked and could not fault. A finding-free area is
  information.
