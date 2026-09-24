# G1B T05/T06 acceptance evidence

Date: 2026-09-24. Official pin: b02acc1e30ef55f7f181fec8d2f241d26f022683. This is the paired private-admission/reconstruction/replay feasibility milestone, not complete modularization or production conversion.

**Status: passed for the bounded T05/T06 milestone.** The independent read-only reviewer appended a pass follow-up in `modular/G1B_REVIEW.md` after checking the executed parent-tool tests, measured replacement decision and recorded full proof.

## Executed checkpoint

`bun run verify:proof` from `modular` passed at **2026-09-24T09:41:58.276Z**:

- **486 passed, 1 POSIX-only skip, 0 failures**; adapter suite419.
- Eight package/app typechecks, production frontend build and real Edge LTR/RTL browser smoke passed.
- Official source pin/tree and all 6,626 tracked blobs retain digest `7fca9dad9348298ba49e92f331c1b251ed396f180f5753e5b6b65a619de7e1e1`.
- `parent-tool-child.test.ts` is included in this full run: four actual native parent-tool/child tests, not the previously in-flight source snapshot. The fixture's batch-shaped delegation probe exercises the execution seam; it is not a replacement for task_batch's product manifests/capture/archival.

## Acceptance matrix

| T05/T06 requirement | Implementation and executed evidence |
| --- | --- |
| Real native admission boundary; normalization and exact retry before recall | Native Session constructor decoration in session-facade; session-facade/session-access/input-compatibility/readiness-admission tests |
| Verified actor/recorded placement and mutable authority revalidation before commit | Application/SessionAccess/child guards, in-transaction projector and exact-retry checks; application/child/readiness/receiver tests |
| Complete-or-absent native input/private state, no premature wake | EventBoundary transaction, private/clean identities, private restore permit and afterCommit; event-boundary/projection/session-facade tests |
| Readiness and unsupported enrichment behavior | Same manager in actual host admission and private sync HTTP; leases drain through enclosing commit/rollback/cancellation; readiness-admission/transfer-http/application tests |
| Frozen normal provider request and real native compaction | Provider adapter and 62-line native-compactor composition; provider-context/runner tests include normal/overflow/failure and clean public sentinel |
| Native continuation/error/tool behavior and one execution owner | Stock/private conformance plus native coordinator composition; runner/session-execution/session-runtime tests |
| Direct child and parent/batch-tool execution seam | Owned child replacement over the selected graph; child-runner and parent-tool-child tests prove exact retries, external joining/interruption, parent cleanup and preservation of a pre-existing owner |
| Full private bundle/checkpoint/epoch/deletion consistency | Strict fork codecs and atomic native replay; legacy-projection/projection/local-revert-transfer/application-transfer tests cover all three revert deletion causes and retained prefixes |
| Durable/public visibility and rollback | Native storage/projectors with owned notification/read fence; nested rollback, durable subscribers, afterCommit wakes and malformed/late-failing restore tests |
| Bounded authenticated paged transfer and restart acknowledgement | Real source/receiver/client/peer HTTP, encryption, manifests/chunks/cursors/scopes, lifecycle limits, no redirect or private downgrade; application-transfer/transfer-* tests |
| Early representative fork-schema upgrade | Digest-bound serialized copied database, original fork native columns, actual target replay/reopen and clean/private retries; fork-session-copy tests preserve source/copy bytes and native+extension ledgers |
| Measured replacement burden and decision | OWNED_RUNNER_DECISION.md records physical line counts, delegated authority, reasons, ownership and exact-pin upgrade obligations; engineering decision accepts the bounded G1B replacements |

## Supported admission boundary disposition

1. Direct/embedded V2 callers use the actual selected `SessionV2.Service` with an explicit `PrivatePromptContext`, or the actor-aware SessionAccess facade. Caller-supplied actor bodies are not trusted by HTTP.
2. Native `/api/session` prompt ingress is intercepted by the owned overlay. Unknown owned prefixes cannot fall through to the raw native handler. Other native handlers use the same compiled graph and auth boundary.
3. Bare native `SessionInput.admit` on a managed Session is intentionally rejected by the projector. It is a tested non-bypass constraint, not a second public admission port. The historical standalone `admission.ts` proof helper is not the selected application route or a public package export.
4. The fork-only SubagentRunner boundary is deliberately replaced by public owned `./child-runner` composition over the selected services. Its parent tool can supply the verified actor/placement. No fake native SubagentRunner tag, copied loop, second mutex-based execution owner or import of the integrated fork is introduced.
5. Full task_batch feature registration, CtxPack capture/model manifests/partial retries/archival, OperatingChat legacy wrappers and the production CLI/TUI/desktop/embedded host conversion remain T10/T11/T13 work. The original integrated implementations remain available until those gates pass. This disposition does not count unported product features as implemented.

## Review findings and disposition

The initial independent review in `modular/G1B_REVIEW.md` was **partial** while the parent-tool proof was in flight and replacement evidence was stale. Its two literal G1B findings are addressed by the executed native parent-tool seam above and the explicit child/runner replacement decision. The follow-up changed the verdict to **pass**; the initial review is retained for traceability. The representative copy importer remains intentionally narrower than full T12 migration; it rejects unsupported deleted-target reconstruction rather than losing data. Transport deletion restoration is separately covered. The review's remaining README-currency recommendation has been addressed.

## Remaining release boundaries

G0 semantic inventory, complete descriptors/features, generated extension clients/native UI event integration, full copied product migration/rollback, Linux and all supported production host/live-provider/permission-UI acceptance, immutable build enforcement and the official-pin upgrade drill remain open. `release` stays blocked and `legacyRemovalAllowed` stays false. No integrated code may be removed on this checkpoint alone.
