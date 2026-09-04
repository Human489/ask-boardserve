# Ask BoardServe — Developer Handover

## 1. What the Product Does and Who For

Ask BoardServe is an analytical chat companion for company secretaries of mid-sized organisations. Secretaries consult it while preparing board packs or live during meetings when trustees ask direct questions. Rather than presenting fixed dashboard tiles, Ask BoardServe accepts plain-English questions across attendance records, action logs, skills matrices, and papers. It returns dynamically generated charts alongside an authoritative, single-sentence finding. The product delivers governance figures a secretary can copy directly into a board pack with confidence, and refuses to answer whenever records cannot support a factual conclusion.

## 2. Running the System

Running tests requires no credentials, network access, or environment file. Executing `npm ci && npm test` runs all 410 unit tests completely offline. The development server (`npm run dev`) also boots without configuration: a committed dataset (`./dataset`) answers queries on a clean checkout.

When Cloudflare credentials are unset, the router (`src/lib/router.ts`) falls back to a keyword classifier for structured queries. Without credentials, three capabilities are lost: model routing (`@cf/openai/gpt-oss-120b`), paper retrieval via Vectorize, and persistent KV storage. Pinned cards and saved chats use ephemeral memory, and dataset uploads refuse because Next.js route handlers cannot share state.

End-to-end checks (`npm run smoke` and `npm run eval`) require a running server, `APP_PASSCODE`, and Cloudflare credentials. For `npm run eval`, launch with `AI_CACHE=off`; otherwise, repeat runs hit the KV cache, masking model routing variance.

## 3. The Core Architectural Rule

The foundational rule is that tools compute and the model narrates. No figure reaching the screen is ever calculated by a language model.

Language models frequently produce plausible arithmetic hallucinations, such as subtracting two numbers in a retrieved paper to report an invented variance. In governance, an authoritative wrong figure presented to a board is worse than a system failure. Delegating data manipulation to deterministic TypeScript ensures written findings agree with rendered charts, and allows the system to refuse unanswerable enquiries honestly.

This rule is enforced at three boundaries:

First, in structured analytics (`src/lib/analytics/`), twelve deterministic tools compute figures from dataset records and format their own headline, table, chart, assumptions, and caveats. The model selects the tool and arguments, but computes no values.

Second, in paper retrieval (`src/lib/retrieval/verify.ts`), `verifyAgainstPassages` confirms that every currency, percentage, and multi-digit number in model output appears verbatim in cited excerpts, suppressing answers with fabricated figures.

Third, in routing guards (`src/lib/router.ts` and `src/lib/retrieval/scope.ts`), code filters intercept queries before dispatch: `guardUnmeasured` refuses unrecorded demographics (such as age or pay), and `guardBestAttendance` blocks ranking zero-miss records through absence-only tools.

## 4. Codebase Map

Read these seven files in order:

1. `src/lib/types.ts`: The domain contract defining `Dataset`, `ToolDefinition`, `ToolResult`, `AnswerResult`, and refusal structures.
2. `src/lib/dataset/loader.ts`: Parses and caches dataset files into a memory-resident `Dataset`, providing shared helpers like `pct` and `daysBetween`.
3. `src/lib/analytics/registry.ts`: Defines the fifteen tools, enforcing the split between the twelve synchronous analytics tools (`ANALYTICS_TOOLS`) and the three hybrid or retrieval tools (`TOOLS`).
4. `src/lib/router.ts`: Coordinates Cloudflare Workers AI tool calling, enforces heuristic query guards, and provides the offline keyword fallback.
5. `src/lib/retrieval/verify.ts`: Checks figures in narrative answers against source passages before text reaches the reader.
6. `src/app/api/ask/route.ts`: Orchestrates authentication, rate limiting, dataset resolution, query routing, tool execution, and response caching.
7. `src/components/Workspace.tsx`: Manages view switching between Chat, Dashboard, and Data, while coordinating the persistent left conversation rail.

## 5. Invariants and Their Verification

Breaking any of these domain invariants produces plausible but incorrect governance answers:

1. Apologies represent non-attendance; only `status === 'present'` counts. Tested in `tests/analytics.test.ts`.
2. Attendance denominators vary by director because committee rows exist only for members. Computations must match `director_summary`. Tested in `tests/analytics.test.ts`.
3. Overdue actions are derived as `due_date < asAt && status !== 'complete'`, rather than trusting recorded `status`. Both counts and set differences must be reported. Tested in `tests/analytics.test.ts` and `tests/disagreement.test.ts`.
4. Time calculations anchor to `dataset.asAt`, never `Date.now()`. Tested in `tests/sources.test.ts` and `tests/analytics.test.ts`.
5. Action owners are job titles, not directors; shared roles must not resolve to an arbitrary director. Tested in `tests/analytics.test.ts`.
6. No organisation-specific entities (directors, committees, skills, risks) may be hard-coded. Tested in `tests/analytics.test.ts` and proven by loading `dataset-b` (Volta Grid Networks plc) without code changes.
7. Contradictions between paper prose and the skills audit must be reported as findings rather than silently reconciled. Tested in `tests/disagreement.test.ts`.
8. Term limit extraction must distinguish appointment terms from lifetime caps; 'three terms of three years' must not yield a three-year cap. Tested in `tests/termlimit.test.ts`.
9. Refusals must explain what tools do not compute, rather than claiming data is absent when rows exist. Tested in `tests/sources.test.ts`.

## 6. What Was Deliberately Not Built

Several architectural decisions were made against obvious alternatives:

The passcode gate is a bot fence, not access control. The obvious choice was full user accounts with role-based permissions. That was rejected because this demo uses fictional data; building authentication would have displaced core analytical work. The passcode prevents bots from burning Cloudflare AI credits, but provides no individual identity or audit trail.

Automatic data retention was omitted. The obvious choice was time-to-live expiration on KV records. That was rejected because evicting a saved chat or pinned dashboard during an active demonstration causes silent data loss. Records persist until manually purged with `scripts/wipe-kv.ts`.

Prose faithfulness verification remains unsolved. The obvious choice was an LLM evaluator to check narrative faithfulness against source papers. A prototype claim-and-quote check was tested, but rejected one in three faithful answers due to quoting quirks. Suppressing sound answers to catch rare phrasing inaccuracies was worse than the problem, so the check was dropped. Figures are strictly verified; prose carries caveats.

A persistent left rail replaced a collapsible history bar. An earlier design hid past chats behind a toggle, but secretaries comparing consecutive queries needed immediate visibility of prior questions without extra clicks.

The refresh button on pinned cards was removed. Because datasets are static dated snapshots, re-running a query yielded identical figures; retaining the button falsely implied live streaming data.

## 7. What to Do First

Before deploying this software with real board records, essential data-protection work is required. First, replace the shared passcode with individual authentication, session timeouts, and role-based permissions; attendance and skills records constitute identifiable personal data under UK GDPR. Second, convert open bearer share links into authenticated, recipient-scoped access with audit logging. Third, implement personal data erasure and rectification mechanisms, as individual directors cannot be amended or deleted without re-uploading an entire dataset. Fourth, establish data residency controls and execute Data Processing Agreements with Cloudflare and Vercel, as KV currently replicates globally. Fifth, delimit retrieved paper text to defend against prompt injection embedded in documents.

Once data protection is established, several enhancements are ready for implementation. The most impactful is proactive push insights: running automated audits on dataset upload (flagging derived overdue discrepancies or attendance anomalies) rather than waiting for user queries. For document retrieval, generation-time schema constraints requiring claim-and-quote pairings should replace post-hoc checks to eliminate prose hallucinations cleanly. Furthermore, extending date range parameters (`from_date` and `to_date`) to action log tools would enable queries such as actions slipped in a particular quarter. Finally, exported charts would benefit from organisation logo uploads rather than the standard text stamp.
