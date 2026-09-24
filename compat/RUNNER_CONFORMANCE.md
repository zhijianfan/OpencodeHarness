# Runner and execution conformance

Date: 2026-09-23. Baseline: `d8fdf95`. Official pin: `b02acc1e30ef55f7f181fec8d2f241d26f022683`. Effect: `4.0.0-beta.83`; Bun: `1.3.14`.

## Parallel work and integration

Two Astra High workers independently implemented the runner/test lane and runtime/test lane. The master reviewed both before running checks. Initial integration corrected a branded WorkspaceV2.ID mismatch in the runtime brief/fixture and strengthened interruption assertions. The new tests then exposed two actual pinned cancellation defects; the master implemented and verified the following explicit adaptations after the worker barrier.

## Corrections and counterexamples

| Finding | Adapter behavior | Evidence |
| --- | --- | --- |
| Interrupted Deferred completion iterates a live listener array. The first interrupted waiter removes itself, so another joined native resume can remain blocked. | `makeInterruptSafeCoordinator` supplies a masked, cause-boxing drain to the **native** coordinator factory. Each resume restores the original cause after leaving the native Deferred callback. `sessionExecutionNode` owns the small local routing/composition layer; the native coordinator still owns serialization, joining, wakes, successors and interruption. | `session-execution.test.ts` retains the pinned-native stranded-waiter counterexample, then verifies all joined waiters exit with the original failure/interruption. |
| Pinned FiberSet starts a tool synchronously before adding its fiber to the set. A same-process observer can interrupt the run before that registration, returning before tool cleanup. | The owned runner yields at the start of the child effect, before tool side effects, so FiberSet registration completes before observable tool startup. | `runner.test.ts` characterizes stock reentrant cancellation and verifies the owned runner waits for cleanup without a timing sleep. A separate stock/private comparison cancels after registration. |
| The runner repaired unfinished tool history before validating recorded placement. | `requireLocalSession` guards the first mutation and every provider attempt. Idle advisory runs remain no-ops. | Relocated Session regression checks interrupted exit, unchanged transcript/event sequence, still-pending input and zero provider/tool execution. |
| Ordinary tool-settlement failure cleanup preceded provider interruption cleanup in the owned loop. | Interruption cleanup wins before ordinary failure cleanup, matching the native order. | Deterministic stock/private case waits for a real tool-fiber defect, then interrupts the provider and checks the durable interruption result. |

The cause wrapper keeps typed-error object identity, defects and interruption causes; it does not turn interruption into successful execution. Cancelling a resume waiter does not cancel the native owner. Success/failure wake tests verify advisory coalescing and native successor behavior. No copied coordinator implementation, second Session owner, native patch or dependency rewrite was introduced.

The workaround replaces **local execution composition**, so the selected graph no longer directly installs `SessionExecutionLocal.node`. It remains exact-pin maintenance responsibility and must be reconsidered when the native/Effect pin changes. The stock counterexamples intentionally fail if those behaviors change on an upgrade.

## Proven scope

- Stock/private comparison: permission-decline/question-rejection error mapping through actual tools/registry; correction and blocked results; ordinary tool defects; provider-error events; raw typed provider failure; hosted-tool EOF/failure; local settlement before provider failure; partial text/reasoning/tool-input flushing; overflow after visible output.
- Native Session runtime: actual create/adopt, immutable placement on ID reuse, two real directory/workspace Locations, identical global Database/Event/SessionStore objects, private request and clean public history isolation.
- Native execution integration: simultaneously blocked provider attempts for different Sessions; joined resumes for one Session; interruption of A while B remains active; provider finalizer counts; queued admit-only input surviving interruption, exact retry and later explicit resume without re-freezing.
- Previous private admission, provider reconstruction, compaction and atomic restore proofs remain covered.

Permission-error mapping tests do not claim full live-provider or permission UI acceptance. Since wave4, the selected graph has gained real native/owned HTTP, readiness admission, complete private transfer, parent-tool/child/external-resume ownership proofs and a representative copied-fork Session upgrade. Production task_batch capture/manifests, all retained legacy feature/host conversions and complete product-data migration remain T10–T14 work. The explicit G1B maintenance decision is now recorded in OWNED_RUNNER_DECISION.md; final gate status follows the completed acceptance review, not this historical wave4 checkpoint.

### Later executed boundary evidence

- `child-runner.test.ts`: atomic native creation/admission, immutable configuration retry, no forced completed retry, shared child/resume interruption and independent children.
- `parent-tool-child.test.ts`: actual parent Location ToolRegistry invokes a batch-shaped delegation probe; external resume joins the child's native owner; parent cancellation cleans a tool-owned child without hijacking a pre-existing owner. Master replaced scheduler-count guesses with an observed real pending waiter and asserts interruption exit causes.
- `readiness-admission.test.ts`: no-lease clean identity, explicit-reference refusal, private lease scopes and release through enclosing commit/rollback/cancellation, imported clean/private retries.
- `application-transfer.test.ts`, `transfer-client.test.ts`, `local-revert-transfer.test.ts`: real network, source-to-receiver client, local native revert proofs, checkpoint/epoch transport, receipt restart, deadlines/authentication and bounded-cache behavior.
- `fork-session-copy.test.ts`: digest-bound serialized source image, native fork columns, target reopen and exact prompt retry, preserved native/extension migration ledgers, immutable source/copy bytes. This is the early representative experiment, not a claim that full T12 rollback/product migration is complete.

## Verification

Historical wave4 `bun run verify:proof` from `modular` completed successfully at `2026-09-23T10:20:25.984Z`:

- **192 pass, 1 POSIX-only skip, 0 fail**; adapter tests: **125 pass**.
- Eight modular package/app typechecks, production frontend build and real-browser LTR/RTL smoke passed.
- Runner/execution/runtime coverage: 30 runner tests, 8 coordinator-adapter tests and 3 full-runtime tests.
- Official before/after source digest: `7fca9dad9348298ba49e92f331c1b251ed396f180f5753e5b6b65a619de7e1e1`, 6,626 tracked entries; official gitlink unchanged and clean.

Machine-readable results: `verification.json`. Worker model/variant and file-boundary audit: `workers.json`. Remaining dependency-aware work: `PARALLEL_IMPLEMENTATION_PLAN.md`.
