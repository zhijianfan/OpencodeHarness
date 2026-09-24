# Worker 2 of 2 — readiness-gated admission through the owning transaction

Model opencode-go/deepseek-v4.1-flash/high. Own ONLY the following adapter files under D:/OpencodeHarness/modular/packages/adapters-opencode:
- src/admission.ts, src/session-facade.ts, src/session-runtime.ts
- src/session-access.ts, src/session-http.ts
- src/kernel.ts, src/legacy-projection.ts
- src/event-boundary.ts, src/transfer-readiness.ts
- test/readiness-admission.test.ts (new)

All context is attached. No exploration, commands/tests, Git, delegation, vendor or other edits. This is ONE connected admission/transaction change. Preserve exported signatures except backward-compatible optional fields described below. If source APIs are missing, report uncertainty, don't invent them. No any, alias/star imports, unsafe assertions or non-null assertions. Produce the implementation within the response budget.

## Frozen additions

- SessionRuntimeOptions gains optional readiness: Effect.Success<ReturnType<typeof makeTransferReadiness>>; makeSessionGraph passes it as optional third argument to makeSessionFacadeNode(boundary,policy,readiness?). Absent readiness preserves today's behavior and all current proof fixtures.
- PrivatePromptRequest gains optional proof: RequestProof (from transfer-readiness).
- SessionAccess.prompt's extension input gains contextTransferProof?: RequestProof. Strip it from native input and provide it as PrivatePromptContext.proof.
- Session HTTP prompt extracts x-opencode-session-context-topology and x-opencode-session-context-lease headers ONLY (never body proof/actor). Both present => makeRequestProof({topologyRevision,requestToken}); pass contextTransferProof to SessionAccess. Both absent => no proof; partial/malformed proof must not grant enrichment. Preserve existing request/response normalization, conflict409 and sanitized AdmissionError mapping.
- AdmissionRequest gains optional mode: Mode. It is a preparation hint, NOT part of privateRequestIdentity. AdmissionError gains code transfer-unavailable. Existing standalone admit behavior unchanged.
- EventBoundary gains afterTransaction:(release:Effect.Effect<void>)=>Effect.Effect<void>. It schedules a release in the OWNING outer transaction on BOTH commit and rollback, or runs immediately when no batch exists. Preserve owning-fiber/kernel checks; do not discard these releases on nested rollback. Run once after SQL boundary completes, even on cancellation/defect or notification failure. Existing afterCommit semantics remain unchanged.
- makeTransferReadiness.withPermit gains an OPTIONAL third argument deferRelease:(release:Effect.Effect<void>)=>Effect.Effect<void>. Apply it only to releasing an acquired lease (default immediate release), not acquiring or deciding the mode. This lets the facade pass boundary.afterTransaction. Existing grant/revoke/withPermit two-argument behavior must remain unchanged. No extra owner map/coordinator or detached release fibers.

## Admission behavior

Use the attached fork SessionInput.admit / CtxPackSessionContext mode behavior as references, not runtime imports. For managed NEW prompts, readiness.withPermit uses actual recorded Session.location.workspaceID plus scope.proof, not caller actor workspace as placement. Hold the permit across preparation, native admission and the ACTUAL outer EventBoundary commit/rollback using afterTransaction; child runner already encloses Session.prompt in an outer transaction. Revocation must reject new enrichment and wait for this outer transaction to settle, including rollback.

No readiness supplied: preserve today's private snapshot path, including empty V2 compatibility snapshots and arbitrary proof-only enriched strings.

Managed readiness selects v1-clean-only when absent/invalid/expired proof. NEW clean-only requests with explicit references fail AdmissionError transfer-unavailable BEFORE policy.freeze or native mutation. Empty-reference clean-only requests skip freeze/recall and admit clean native text with no cm_private_input/requirement/legacy snapshot, no modelContextVersion:2 and no private checkpoint. Maintain an explicit clean admission identity in cm_clean_input(message_id PK FK session_input(id) ON DELETE CASCADE, session_id, request_hash) so a missing private row can never be silently treated as clean. Register that extension table in initializeExtension with its own cm_migration id. Prepared projector scope must distinguish clean/private, reauthorize in-transaction, and write only the corresponding identity/snapshot records. Existing managed direct-publication guard stays fail closed.

v2-enriched invokes existing freeze with request.mode and preserves full snapshot/private validation. v1-local-explicit passes mode to freeze and rejects snapshots with automatic selections (do not silently allow recall); existing V1 explicit snapshots remain valid. Do not discard explicit contexts to make a request succeed.

EXACT retries reconcile existing native immutable input BEFORE readiness/freeze, as the fork does: no new freeze, no implicit downgrade, no repeated recall. Private retries still require original private identity/snapshot; explicit clean-row retries compare native prompt/delivery plus request identity, reject supplied references/conflicting actor, and reauthorize inside the transaction before acknowledging/waking. Presence of both clean/private metadata is corruption, not a fallback. Missing private context with a private requirement or V2 event marker never becomes clean. No metadata rewriting on retries.

## Imported clean inputs

Legacy restoration of a clean PromptAdmitted input needs a clean marker too, otherwise exact retry in the managed facade fails after transfer. Extend legacy-projection.restore inside its existing transaction to register cm_clean_input ONLY for actual native admitted inputs with no private context/requirement and no V2 marker. Use request_hash='legacy:'+legacyReferenceHash([]), matching the existing imported retry convention; actor still comes from authenticated authorization. Validate native Session/prompt/delivery identity as existing code does. Keep an existing local actor-inclusive clean hash unchanged when reconciling an exact restored bundle. No synthetic clean row for missing/corrupt V2 snapshots, deleted targets or historical projected user messages without native admission. Full export does not add clean markers to private contexts/manifests. Existing new-admission compatibility and retained-history behavior must continue passing.

## Tests

Real createSessionRuntime + deterministic LLM + Deferred barriers. Cover clean-only prompt skips freeze, remains publicly clean, runs through native provider, stores only clean identity, and source.required is false before any private state; explicit refs rejected without rows/events; valid lease permits enriched freeze/body stored privately; wrong token/workspace/revision or expiry cannot enrich; revoke blocks while freeze/admission active, remains blocked AFTER nested Session.prompt returns but enclosing transaction is held, then settles on commit AND rollback; cancellation doesn't strand a permit; new enrichments refused while revoke drains. Exact enriched retry after lease revocation doesn't freeze/downgrade; clean retry doesn't start acquiring a new lease; changed content/delivery/actor/refs conflict; imported clean retry succeeds without freeze and corrupted missing-private snapshot fails. Test HTTP header plumbing against real Session HTTP/manager if possible using supplied fixtures; no polls/sleeps or duplicate orchestration.

Do not change child-runner or application assembly; master wires the same manager instance into the host and transfer HTTP after both workers return. Child calls without proofs naturally remain clean when a managed manager is configured. New tests should verify pending-only execution remains intact. Return changed files and unresolved details; master runs typecheck/full proof after barrier.
