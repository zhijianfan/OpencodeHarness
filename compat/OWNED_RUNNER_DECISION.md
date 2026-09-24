# Explicit owned SessionRunner integration

Date: 2026-09-24. Pin: `b02acc1e30ef55f7f181fec8d2f241d26f022683`.

The direct history/compaction imports in the pinned native runner do not expose a narrower injection point. The external adapter now supplies `privateRunnerNode` at the existing Location-scoped `SessionRunner.Service` boundary. This is an explicitly maintained runtime replacement, not a claim of unchanged native behavior.

The owned orchestration delegates native inbox promotion, history selection, System Context/Epoch logic, agent/model selection, event publication/projection, tool registry/settlement, output bounding and filesystem snapshots. The native `SessionRunCoordinator.make` remains the process-global execution authority. Provider request enrichment and private checkpoint persistence are external adapters.

The implementation is organized around provider attempts and durable continuation state; it does not import, transform or shadow the native runner module. The original runner node is used only as the replacement key and as the clean-mode comparison in tests.

The admission integration wraps the actual native Session constructor from its exported LayerNode implementation. Native MIME normalization and message identity reconciliation stay native. Create is decorated with atomic fresh runtime classification and an optional explicitly configured replay-owner claim; prompt adds authenticated clean/private admission identities, snapshots, readiness and deferred wake. Other methods delegate unchanged. A projector guard rejects managed admissions lacking prepared scope; verified private replay receives a scoped internal permit. This is source-package API coupling and must be rechecked on every pin upgrade.

`createSessionRuntime` assembles these nodes and protects their replacement keys. Startup initializes extension tables in the same native database before exposing the runtime. The native Location service map receives the runner replacement through `AppNodeBuilder` propagation. The pinned hoister required an explicit canonical self-replacement for SessionStore after dependency rewriting; the integration test checks actual object identity across the root and Location graph rather than relying only on paths or versions.

Wave 4 exposed a pinned Effect beta.83 interruption fan-out defect: native completion can strand a joined resume waiter. `session-execution.ts` now explicitly owns local execution composition instead of directly installing `SessionExecutionLocal.node`. It delegates ownership, joining, wake coalescing and successors to one unchanged native coordinator, transporting drain causes as masked typed failures and restoring the original cause outside each native completion callback. Typed failures, defects, external/internal interruption, disconnected waiters and advisory successors have executable coverage. This additional replacement is inventoried, rather than presented as unchanged local execution.

The runner also checks placement before repairing interrupted tools and yields before starting a local tool so the pinned FiberSet registers it before observers can cancel reentrantly. Ordinary tool-failure cleanup follows interruption cleanup, matching native precedence. Counterexamples and fixes are recorded in `RUNNER_CONFORMANCE.md`.

## Measured responsibility review and engineering decision

Measured with `rg --count '^'` on 2026-09-24 (physical lines, including blanks/comments):

| Owned surface | Lines | Responsibility / delegated authority |
| --- | ---: | --- |
| runner.ts | 252 | Provider-attempt/continuation composition and private adapter calls; native history, publisher, model, tools, epochs and snapshots delegated |
| session-execution.ts | 167 | Pending/forced admission views and cause transport; ONE unchanged native coordinator owns drains |
| session-facade.ts | 320 | Decorates actual native constructor/create/prompt; native normalization, retry projection and all other methods delegated |
| event-boundary.ts | 193 | Owning transaction/read barrier/notifications/wakes/release hooks; native storage, sequencing, replay ownership and projectors delegated |
| compaction.ts | 62 | Private selection and clean projection; actual native compactor performs its provider call and failure handling |
| child-runner.ts | 239 | Explicit actor/parent/configuration checks and native child Created/admission composition; shared pending execution, never a second runner |

The corresponding pinned native runner is 439 lines and local execution composition 46. These figures measure maintenance surfaces, not equivalent replacement percentages or an overall port-size claim. The six owned modules total 1,233 lines; codecs, transfer, tests and domain extensions are separate responsibilities.

**Engineering decision for the bounded T05/T06 G1B milestone: accept these explicit maintained replacements.** This is the implementation master's recorded technical decision under the user's authorized continuation, not a claim of a separate human approval or production release. There is no narrower exported private-history/compaction seam at this pin; raw LLM decoration cannot cover pre-stream compaction. Requiring one guarded facade is preferred to allowing unmanaged admissions into a private Session. The native coordinator/Database/Event persistence/SessionStore remain authoritative. Stock counterexamples and conformance cases make the divergence observable and upgrade-checkable.

### Child boundary decision

`child-runner.ts` is the selected graph's explicit replacement composition for the fork-only V2 SubagentRunner boundary. Official upstream exports no SubagentRunner service, so fabricating an upstream tag or importing the fork implementation would misrepresent the seam. The public adapter `./child-runner` captures the selected graph's actual services. A tool/batch composition supplies the verified actor and its parent-Location authorization; bare native SessionInput admission remains rejected for managed Sessions.

`parent-tool-child.test.ts` registers a batch-shaped `delegation_probe` in the ACTUAL parent's native Location ToolRegistry, then drives the parent's provider through that tool. The proof covers child/external resume/interrupt, parent cancellation of tool-owned work, preservation of an independently owned child's drain, and completed-child exact retry. This closes the execution-boundary question; it does not pretend that the probe is the full task_batch product tool. Retained task_batch manifests, model pinning, CtxPack capture, partial retries and archival still belong to T11 extraction and must not be removed.

The replica/replay owner is explicitly separate from execution ownership. Unfinished transfer staging is process-local and must restart after loss; committed receipts are durable. Neither mechanism authorizes a post-crash provider retry.

### Upgrade and release responsibilities

CyberMastery adapter maintainers own these six surfaces and the exact-pin import inventory. On any native/Effect pin change: recheck exported constructor requirements/hoisting, rerun stock/private provider/tool/permission-error and cancellation cases, verify the one-graph identity tests and full transfer/admission/copy proof, and retire workarounds only after their counterexamples change. Full live-provider/permission UI coverage, legacy feature/host conversion, complete copied product migration and the pin-upgrade drill remain later acceptance gates (T10–T14). Release and integrated-source removal stay blocked.
