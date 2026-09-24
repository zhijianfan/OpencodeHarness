# Worker 1 of 2 — transfer readiness and topology

Create ONLY these files under D:/OpencodeHarness/modular/packages/adapters-opencode:
- src/transfer-readiness.ts
- src/transfer-topology.ts
- test/transfer-readiness.test.ts
- test/transfer-topology.test.ts

Use the two attached fork-added source modules as behavior specifications, not runtime imports. Astra High, no exploration, commands/tests, Git, delegation or other edits. Master wires admission/HTTP/control surfaces after the barrier.

## Required exports and behavior

transfer-readiness.ts exports the original Mode union (`v1-local-explicit`, `v1-clean-only`, `v2-enriched`), RequestProof/LeaseInput/LeaseAck, LeaseConflict, LEASE_DURATION_MS=30000, and makeRequestProof. Use plain string optional workspaceID or the official WorkspaceV2.ID brand consistently; do not import the nonexistent official readiness module.

Provide a factory `makeTransferReadiness(options?: {readonly mode?:Mode|"managed"; readonly now?:Effect.Effect<number>})` returning an Effect of a plain `{withPermit,grant,revoke}` object. In fixed local modes withPermit delegates that mode. Managed semantics are those in the attached source: proof/workspace/revision/token match, 30-second maximum lease, expiration stops new permits, active permits remain fenced, revoke/expired replacement waits for active permits to drain, conflicting identity rejected, no new enrichment before all old holders release. Permit release must run on success/failure/defect/interruption. No module-global lease/proof map; each factory is independent. Do not invent a second durable execution owner.

Use one shared semaphore per manager and do not hold it while waiting for drained permits. Snapshot mutable request/lease input fields when admitted so callers cannot mutate an identity after validation. Invalid/past lease requests reject. The original source is attached in full, including the exact grant/revoke behavior.

transfer-topology.ts exports TOPOLOGY_HEADER=`x-opencode-session-context-topology`, LEASE_HEADER=`x-opencode-session-context-lease`, Peer, TopologyError, `makeReadinessCoordinator()` (instance-local proof/activate/clear), `makeOrchestrator`, PrivateTransportError, PrivateRedirectError, validateTarget and executePrivate. Replace the original module-global proofs Map with factory-owned state; no global actor/proof leakage across hosts. Preserve revision hashing (sorted workspace\0endpoint\0version), token reuse on matching topology, probe/grant/renew/revoke ordering, rollback of acknowledged peers on grant failure, proof clearing before topology mutation, and best-effort revocation after failure.

The orchestrator accepts the original injected `now?:Effect<number>` and `token?:()=>string` for deterministic testing, plus the coordinator object. Use the new local readiness types instead of fork-only Core imports. Lease duration stays 30 seconds. Target rules: confidential target explicitly permitted, otherwise HTTPS or numeric loopback HTTP only (127/8 or ::1); do not widen to arbitrary plain HTTP. executePrivate uses the official Effect HttpClient API with redirect:"manual" and rejects all 3xx without following them.

The existing selected runtime uses Effect 4.0.0-beta.83. `Effect.gen`, `Effect.acquireUseRelease`, `Semaphore.makeUnsafe(1).withPermit`, `Deferred.make`, `Deferred.await/succeed`, `Effect.forkScoped`, `Fiber.await/interrupt`, Clock.currentTimeMillis and Context.Service are available. No fork/forkDaemon/unsandbox APIs. Tests should use actual Effects/scoped fibers and injected clock, no timing sleeps/globalThis. A Deferred success releases multiple waiters normally; avoid importing native execution internals.

## Tests

Missing/wrong proof returns clean-only; correct proof grants enriched only while valid; workspace/revision/token isolation; renewal/cap; revoke blocks until a held permit completes; interruption releases permits; expired active lease replacement waits then succeeds; two factories isolated. Topology probes, grant rollback, renewal failure clears proofs, beforeMutation revokes and reports transferRequired, matching revision reuses token. Validate private target URL cases and manual redirect policy using a deterministic HttpClient layer or local ephemeral server with no live external requests.

Keep errors free of token/private payload contents. Do not infer runtime verification: master runs typecheck/tests after both workers finish. Return implementation/gaps.
