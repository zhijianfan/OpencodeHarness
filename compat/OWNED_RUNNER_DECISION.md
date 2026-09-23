# Explicit owned SessionRunner integration

Date: 2026-09-23. Pin: `b02acc1e30ef55f7f181fec8d2f241d26f022683`.

The direct history/compaction imports in the pinned native runner do not expose a narrower injection point. The external adapter now supplies `privateRunnerNode` at the existing Location-scoped `SessionRunner.Service` boundary. This is an explicitly maintained runtime replacement, not a claim of unchanged native behavior.

The owned orchestration delegates native inbox promotion, history selection, System Context/Epoch logic, agent/model selection, event publication/projection, tool registry/settlement, output bounding and filesystem snapshots. `SessionExecutionLocal` and its process-global coordinator remain native. Provider request enrichment and private checkpoint persistence are external adapters.

The implementation is organized around provider attempts and durable continuation state; it does not import, transform or shadow the native runner module. The original runner node is used only as the replacement key and as the clean-mode comparison in tests.

The admission integration wraps the actual native Session constructor from its exported LayerNode implementation. Native MIME normalization, message identity reconciliation and all non-prompt methods are delegated. A projector guard rejects managed admissions lacking prepared private context; verified private replay receives a scoped internal permit. This is source-package API coupling and must be rechecked on every pin upgrade.

`createSessionRuntime` assembles these nodes and protects their replacement keys. Startup initializes extension tables in the same native database before exposing the runtime. The native Location service map receives the runner replacement through `AppNodeBuilder` propagation. The pinned hoister required an explicit canonical self-replacement for SessionStore after dependency rewriting; the integration test checks actual object identity across the root and Location graph rather than relying only on paths or versions.

Acceptance remains incremental: clean request comparison, private request reconstruction, native compaction, local tools/step bounds, queue/steer timing, one overflow recovery and native coordinator interruption have direct tests. The complete permission/provider/failure matrix, full host entrypoints, child ownership, fork schema migration and the existing paged transfer protocol still require broader parity evidence. Keep release and legacy removal gated until those checks pass.
