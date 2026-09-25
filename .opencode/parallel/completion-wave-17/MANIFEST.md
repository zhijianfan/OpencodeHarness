# T08 wave17 — capsule store and usage-admission ledger

Base e5d66cd pushed; wave16 CtxPack catalog/content local and full proof 554 pass/1 skip at 2026-09-24T11:07:47.975Z. Model opencode-go/deepseek-v4.1-flash/high, cap131072. Distinct ownership: Worker1 capsule persistence, Worker2 admitted-use ledger. Master frozen contract `modular/packages/contracts/src/ctxpack-capsule.ts`; no worker edits it or catalog. Tests/typecheck after BOTH return; no worker commands/exploration/native edits.

| Worker | Owned adapter files | Acceptance |
| --- | --- | --- |
| 1 | src/ctxpack-capsule.ts; test/ctxpack-capsule.test.ts | Immutable durable capsule with exact schema/createdBy/budget, audience/expiry/workspace and bounded requested-ref materialization |
| 2 | src/ctxpack-usage.ts; test/ctxpack-usage.test.ts | One native DB admission-use ledger, atomic multi-pack increments, exact idempotent retries and postcommit used hints |

Materializer composition into a real catalog/Session freeze is a dependent next wave. Original fork feature data is retained. This wave alone does not pass T08/G2.

## Outcome

- Capsule session ses_f2c9980d8ffe9Py0QBfPq8Y9fv; usage session ses_f2c99809bffeB0z8Xk31XYf8mE. Both selected model/high, exclusive successful file edits, no commands/exploration.
- Master fixed fixture import, JSON-only persisted capsule bodies, native row/body identity checks and independent native identifier import; usage uses the exact contract error guard. Focused capsule/usage/catalog 36 pass; subsequent full proof after materializer/HTTP passed 607 / 1 skip (2026-09-24T13:13:28.187Z).
