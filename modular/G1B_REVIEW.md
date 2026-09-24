# Independent G1B review (bounded, read-only)

Reviewer: opencode-go/deepseek-v4.1-flash. Sources read only, no commands, no edits.

Evidence basis measured against CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md §§5–8 and
compat/G1B_INTEGRATION_DECISION.md. Execution evidence is the recorded artifact
compat/verification.json (`capturedAt` 2026-09-24T09:18:40.369Z): 482 pass / 1
Windows platform skip / 0 fail, adapters-opencode `bun test test` 415 pass
(lines 162–167), `sourceUnchanged: true` with identical before/after digest and
tree (lines 7–20). I did not re-execute; anything outside that recorded run is
marked authored/unverified. The in-flight `test/parent-tool-child.test.ts` does
not exist in the tree and is not counted as evidence (glob: no files found).

## 1. Acceptance matrix

Every row below is inside the recorded 415-test adapter run unless labelled
otherwise.

| Clause (plan / G1B decision) | Source | Executed test evidence |
| --- | --- | --- |
| Atomic admission: native projection + sidecar in one transaction | `session-facade.ts:90-96,98-146` | `session-facade.test.ts:68-94` |
| Exact retry reconciles before recall; no second freeze/wake | `session-facade.ts:172-233` | `session-facade.test.ts:96-110`; `readiness-admission.test.ts:372,397` |
| Authorization revalidated inside owning transaction | `session-facade.ts:90-96,113-115,173`; `application.ts:64-83` | `application.test.ts:285,311`; `input-compatibility.test.ts:322` |
| Readiness lease, explicit references, partial-proof rejection, expiry | `transfer-readiness.ts`; `session-facade.ts:287-291`; `application.ts:87` | `readiness-admission.test.ts:219,235,247,263,281,294,460` |
| Commit-wake deferred; wake only after commit, `resume:false` admit-only | `session-facade.ts:93`; `event-boundary.ts:169-178,120-135` | `event-boundary.test.ts:202`; `session-facade.test.ts:152-164`; `application.test.ts:151,229` |
| Policy cannot be bypassed by a bare native route | `session-facade.test.ts:112-125` (bare `SessionInput.admit` fails; no row) | executed |
| Private normal turn reconstruction against clean public history | `provider-context.ts:9-37`; `history.ts`; `runner.ts:111` | `input-compatibility.test.ts:234`; `provider-context.test.ts` |
| Private compaction (normal + overflow) with clean sentinel projection | `compaction.ts:18-61`; `runner.ts:108,148` | `provider-context.test.ts:67,112`; `runner.test.ts:182,252` |
| Atomic full bundle + epoch restore before notification | `projection.ts:118-207,193-205` | `projection.test.ts:43-61`; `legacy-projection.test.ts:98,233` |
| Failed restore rolls back with no premature public prefix | `event-boundary.ts:101-136` | `projection.test.ts:63-84`; `event-boundary.test.ts:14,29,72` |
| Deletion restore (native revert cascade) | `kernel.ts:64-67` + FK cascade `:45,53,58-60`; native `projector.ts:413-438` | `projection.test.ts:135-161`; `application-transfer.test.ts:218` |
| Durable + public visibility after commit only | `event-boundary.ts:77-99,143-165` | `event-boundary.test.ts:48,72,145,159,178,218,232` |
| Real-network paged transfer and durable receipt restart | `application-transfer.test.ts` | `application-transfer.test.ts:490,575,629`; `transfer-client.test.ts` |
| Child creation/admission in one transaction; immutable retry; shared pending drain | `child-runner.ts:158-197,223-234` | `child-runner.test.ts:290,318,340,378,427,487,534,585,650` |
| Representative fork upgrade experiment | `fork-session-copy.ts` | `fork-session-copy.test.ts:263,367,390,416,445,476` — partial, see §3.3 |
| Replacement inventory | `native-replacements.json`; `OWNED_RUNNER_DECISION.md` | Recorded; T06 "approved" not evidenced, see §3.2 |

## 2. Baseline admission entrypoint kinds

| # | Kind | Boundary | Selected-graph status | G1B vs later |
| --- | --- | --- | --- | --- |
| A | V2 `SessionV2.prompt` (direct/SDK/embedded) | native `session.ts:360-386` | Decorated by facade `session-facade.ts:235-292`; admission/retry/readiness proven | **G1B covered** |
| B | Native HTTP `POST /api/session/:id/prompt` | native `handlers/session.ts:144`; protocol `groups/session.ts:205` | Owned overlay intercepts the prefix (`session-http.ts:170-185`) and calls the decorated facade, so the raw native handler is unreachable | **G1B covered on the proof host**; full host parity T13 |
| C | Direct `SessionInput.admit` helper | native `session/input.ts:41-81` | Not decorated; fails closed for managed sessions (`session-facade.test.ts:120-122`) | Guard property proven; direct external callers are blocked, not served (design note §3.5) |
| D | Fork legacy `SessionPrompt.prompt` + `/session/:id/message`, `prompt_async` | `packages/opencode/src/session/prompt.ts:122,1090`; routes `handlers/session.ts:295-329` | Retained integrated; absent from `session-runtime.ts:65` root and replacements | Not G1B — **T10 conversion** |
| E | Fork V2 `SubagentRunner.run` | `packages/core/src/session/subagent-runner.ts:84` (direct `SessionInput.admit`) | Retained integrated; official native has no `subagent-runner.ts`; not in the selected graph. Owned `child-runner.ts` is a distinct, non-task_batch composition | **G1B-relevant gap**; fork conversion T11 |
| F | `task_batch` / MasterAgent | fork opencode `MasterAgentService` | Retained integrated; absent from selected graph | Not G1B — **T11 conversion** |
| G | `revert.stage/clear/commit` | native `session.ts:433-453` | Delegated unchanged (`session-facade.ts:293`); cascade tests present | **G1B covered** |
| H | CLI / TUI / desktop / embedded entrypoints | fork opencode, TUI, desktop | Retained integrated | Not G1B — **T13** |

## 3. Concrete defects / missing executable cases, ranked

1. **Child admission is not on the selected graph, and the owned child is not
   task_batch-registered (G1B-relevant).** The plan §6 requires testing "a
   batch-started child racing with external resume/interrupt" and T05 requires
   "every baseline entrypoint, including children." The only child path proven is
   the adapter's own `child-runner.ts:188-197`, which shares
   `PendingSessionExecution`; `child-runner.test.ts:487,534` cover a concurrent
   external resume and interrupt but not a batch-started child. `task_batch`
   wiring is explicitly pending (`native-replacements.json:108`; `README.md:85`),
   and the baseline `SubagentRunner` calls `SessionInput.admit` directly
   (`packages/core/src/session/subagent-runner.ts:84`), a path the facade does not
   decorate. Fix: wire `ChildRunner` behind the task boundary, or record a
   reviewed decision that the owned child is the replacement, then add the
   batch-started race case. This is the strongest reason the gate is not closed.

2. **T06 "replacement inventory approved" is not evidenced, and conformance is
   explicitly incomplete.** `OWNED_RUNNER_DECISION.md` and
   `native-replacements.json` record the owned `SessionRunner`/execution
   replacements and their rationale, but
   `RUNNER_CONFORMANCE.md:29` states the task-batch/provider matrix remains open
   and "G1B is partial". `native-replacements.json:59,71` list the same
   limitations. The owned runner reimplements provider-attempt and continuation
   orchestration (`runner.ts:86-225`) rather than decorating a narrow seam, so the
   plan's "significant runner replacement … architectural cost decision" applies.
   Fix: complete the measured responsibility review and permission/provider
   matrix and record the approval; do not treat inventory presence as approval.

3. **Representative fork upgrade is partial (T05 experiment; fully T12).**
   `fork-session-copy.test.ts:263-523` is an offline copied-database import; the
   worklog (:51) states deleted-target reconstruction is unsupported here and it
   is "representative offline Session migration, not complete product migration."
   No rehearsed upgrade + rollback on a copy of a real fork database exists
   (T12). Fix: run a copied/sanitized upgrade and a matching data rollback.

4. **Evidence/documentation currency defects (traceability, not code).**
   `compat/gates.json:8` and `README.md:87` still describe paged transfer/readiness
   as pending and cite 399 tests, while wave 11–14 implement and test them
   (`application-transfer.test.ts:490-692`; `verification.json:164`). Separately,
   `admission.ts:71-78` and `native-replacements.json:20` claim the admission
   facade "does not intercept stock `SessionV2.prompt`", but
   `session-facade.ts:235-292` does; that inventory entry points at the low-level
   proof helper and understates real coverage. Fix: reconcile docs/inventory so a
   gate reviewer is not misled in either direction.

5. **Design constraint to record, not a bug.** Any caller that reaches
   `SessionInput.admit`/`SessionV2.prompt` without `PrivatePromptContext` on a
   managed session fails closed (`session-facade.test.ts:112-125`). That is the
   intended non-bypass property, but it means the decorated facade is a required
   mediation port; a future host/tool/plugin must use it. State this explicitly
   in the replacement inventory.

## 4. Verdict: partial

The feasibility/reconstruction/replay mechanism is genuinely proven on the
selected official-native graph: atomic admission with private sidecars and
exact-retry reconciliation, authorization revalidation, readiness gating,
commit-deferred wake, private normal turns and real native compaction with clean
public projection, managed Event replay with durable/public visibility, atomic
full bundle/epoch/restore with native-revert deletion cascades, real-network
paged transfer with restart-durable receipts, and owned child execution —
recorded at 482 pass / 1 platform skip / 0 fail.

It cannot be closed as **pass** without weakening the gate. Two literal clauses
remain open:

- T05 "every baseline entrypoint, including children" — direct/task_batch child
  admission is not implemented on the selected graph or proven through a
  batch-started race (§3.1).
- T06 "replacement inventory approved" — inventory is recorded but approval and
  the owned-runner conformance matrix are incomplete (§3.2).

It is not **blocked** either: no upstream boundary is missing for the proven
mechanism, and the failure modes are exposed by executed tests rather than
hidden. The remaining T07–T14 work (legacy/CLI/TUI/desktop/embedded entrypoints,
CtxPack/skills/relay, full fork migration/rollback, production topology) is real
but is a different gate; `compat/RUNNER_CONFORMANCE.md:29` and
`compat/gates.json:8` already draw that line.

I do not claim complete modularization and I do not authorize removal of the
integrated packages (`gates.json:14`). Residual uncertainty: I relied on the
recorded verification artifact and could not independently confirm the per-test
composition of the 415-run beyond the recorded pass count and source digest.

---

## Follow-up review — 2026-09-24 (re-check of the two literal G1B findings)

Preserved above: the initial **partial** report and its reasoning. This follow-up
re-checks only whether the two literal G1B findings still block, against the new
executed checkpoint. Read-only; no commands or edits beyond this file.

### New executed evidence

`compat/verification.json` now records `capturedAt` **2026-09-24T09:41:58.276Z**,
`success: true`, `sourceUnchanged: true` (identical commit/tree/digest,
lines 7–20), and adapters-opencode `bun test test` = **419 pass / 0 fail**
(lines 163–167). Summing the recorded results (contracts 25 + canvas 18 + compat
8 (+1 POSIX-only skip) + client 13 + adapters 419 + host 2 + web smoke 1) gives
**486 pass / 1 skip / 0 fail**, matching `compat/G1B_ACCEPTANCE.md:7-11`. The +4
adapter tests are the now-present `parent-tool-child.test.ts` (470 lines), which I
read in full. As before I did not re-execute; I treat the artifact as the recorded
evidence and did not verify per-test composition beyond the recorded counts.

### Finding 1 (child admission / batch-started race) — resolved

My initial §3.1 concern was that the baseline child seam calls `SessionInput.admit`
directly (`packages/core/src/session/subagent-runner.ts:84`) and that no
batch-started child race existed. Two changes close the G1B execution-boundary
clause:

- `compat/OWNED_RUNNER_DECISION.md:36-40` explicitly declares `child-runner.ts`
  the selected graph's replacement for the fork-only `SubagentRunner` boundary and
  records that official upstream exports no `SubagentRunner` service, so no fake
  native tag or fork import is introduced. This is the plan-required ownership
  decision, not a silent substitution.
- `parent-tool-child.test.ts` registers a batch-shaped `delegation_probe`
  (`tasks: NonEmptyArray`, line 94-96) into the **actual parent Location
  `ToolRegistry`** (`ToolRegistry.Service` via `locations.get(parent.location)`,
  lines 176-177, 250-251, 352-353, 430-431) and drives the parent provider through
  that tool. It then exercises the real `SessionExecution` coordinator
  (`execution.resume/interrupt/active`): external resume joins the child's native
  owner and child interrupt settles both (lines 184-205); parent interruption
  finalizes a tool-owned child while an unrelated Session stays independent
  (lines 259-287); a pre-existing independent owner survives the tool waiter's
  cancellation (lines 364-391); and an exact completed child/prompt retry makes no
  extra provider call and no second freeze (lines 438-454). The master's change to
  observe the real pending waiter (lines 343-351) rather than guess yields is the
  right kind of evidence.

This addresses the plan §6 warning that "a module-local batch mutex does not alone
cover all Session entrypoints": the proof uses the real native registry and the
one native coordinator, not a module-local scheduler. Full `task_batch` product
manifests, CtxPack capture, model pinning, partial retries and archival remain
explicitly T11 (`native-replacements.json:109`; `G1B_ACCEPTANCE.md:37`) and are not
counted here. The clause "test a batch-started child racing with external
resume/interrupt before finalizing the mediation implementation" is satisfied.

### Finding 2 (replacement inventory approved) — resolved for the bounded milestone

`compat/OWNED_RUNNER_DECISION.md:19-34` now contains a measured responsibility
review: physical line counts for the six owned surfaces (runner 252,
session-execution 167, session-facade 320, event-boundary 193, compaction 62,
child-runner 239; 1,233 total), the pinned native runner (439) and local execution
(46) as non-equivalence context, delegated authority per module, upgrade
obligations, and an explicit **engineering decision to accept these maintained
replacements for the bounded T05/T06 G1B milestone**. `native-replacements.json:5`
adds an `engineeringReview` block with `decision:
accept-explicit-maintained-replacements` and `productionReleaseApproved: false`;
`gates.json:8` reflects `partial-final-review`; `RUNNER_CONFORMANCE.md:29,34`
updates the scope. This satisfies T06's "replacement inventory approved" evidence
for the bounded milestone. I note plainly that it is the implementation master's
recorded decision under authorized continuation, **not** an independent or human
production approval, and it does not authorize production or legacy removal. I do
not treat that caveat as a G1B blocker, because the plan asks for a reviewed
explicit replacement and measured burden, both of which are now recorded.

### Findings 3–5 disposition

- **§3.3 representative fork upgrade:** unchanged in substance and correctly
  scoped. `G1B_ACCEPTANCE.md:28,41` and `RUNNER_CONFORMANCE.md:37` present
  `fork-session-copy.test.ts` as the early representative experiment, with
  deleted-target reconstruction rejected and full product migration/rollback left
  to T12. T05's "early representative fork-schema upgrade experiment" is met; the
  rest is T12, not G1B.
- **§3.4 doc currency:** inventories, gates and `RUNNER_CONFORMANCE.md` are
  reconciled, and `native-replacements.json:21` now correctly scopes the
  `admission.ts` helper as historical/non-public. **One bounded cleanup remains,
  non-blocking:** `modular/README.md` is still stale — line 77 still calls paged
  transport/readiness "pending", line 85 still says "Full task_batch/parent
  ownership wiring is still pending", and line 87 still cites the 399-test
  06:11:30 checkpoint. Update those to the 09:41:58 proof and the parent-tool
  result so a gate reader is not misled.
- **§3.5 design constraint:** now recorded at `G1B_ACCEPTANCE.md:35` and
  `OWNED_RUNNER_DECISION.md:38` (bare native admission remains a tested
  non-bypass; the historical helper is not a public port). Resolved.

### Verdict change: pass for the bounded T05/T06 G1B milestone

Both literal findings are addressed by executed, source-backed evidence, and no
remaining G1B clause is unmet:

- T05: admission/retry/authorization/readiness/wake, private normal and
  compaction turns, and a real batch-shaped parent-tool child race with external
  resume/interrupt are covered.
- T06: atomic full bundle/epoch/deletion restore, durable/public visibility,
  failed-restore rollback, unchanged source attestation, and a recorded measured
  replacement decision are covered.

I therefore change my verdict from **partial** to **pass** for the bounded
feasibility milestone only. This is not a rubber stamp: it is scoped, and it
explicitly does **not** claim full modularization, production parity, or permission
to remove integrated code (`gates.json:4,14`). Full `task_batch` capture/manifests
and T10–T14 conversion remain honestly open (`G1B_ACCEPTANCE.md:37,43-45`). Only
the `modular/README.md` refresh above is recommended as bounded cleanup; it does
not block G1B. Residual uncertainty is unchanged: I relied on the recorded
verification artifact and did not independently re-run the 486-test proof.
