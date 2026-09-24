# Worker 1 of 2 — export actual local revert deletion proofs

Model opencode-go/deepseek-v4.1-flash/high. Own ONLY src/legacy-deletion.ts (new), src/legacy-projection.ts, test/local-revert-transfer.test.ts (new), under D:/OpencodeHarness/modular/packages/adapters-opencode. Context attached; no exploration, commands/tests, Git, delegation, vendor or other edits. Return actual guarantees/uncertainties, no test-pass claims.

## Confirmed gap and native behavior

Native SessionProjector already deletes BOTH session_message rows with seq>boundary AND session_input rows with admitted_seq>boundary OR promoted_seq>boundary. Do not copy or replace that projector. Private/clean metadata cascades through existing native FKs/triggers. Current legacy-projection.export only reads cm_legacy_deletion populated by prior imports, so after an ACTUAL local native revert the V2/private compaction marker remains in history but the sidecar is gone and export fails incomplete-private-manifest.

Port the fork-owned deletion proof construction (attached SessionProjectionTransfer.deletionProof / messageIDOf / identity and fork-only SessionProjector.deletionCause) into a small pure helper in legacy-deletion.ts. Runtime imports only native exported schema helpers and owned legacy codecs, never packages/core fork files. Native deletion predicate is unchanged; the adapter only proves its already-committed effect.

The helper may choose an explicit input signature of history, actual current message identities/seqs, actual current input identities/admitted/promoted seqs and existing validated deletion records; it must return actual LegacyDeletion values or a typed LegacyProjectionError/LegacyBundleError. Keep the signature readable and dependencies synchronous. Derive identities with legacyDigest(event.data), not the spool's different canonicalization. Valid causes: compaction target.seq>boundary.seq => message-seq; input admittedSeq>boundary.seq => input-admitted-seq; otherwise input promotedSeq>boundary.seq => input-promoted-seq with the exact promotionEvent. A deleting Revert.Committed must follow the target/promotion, and boundary event must genuinely project the retained boundary message ID. Never treat missing/corrupt private state as deletion merely because the row is absent.

## Export integration

Inside existing export EventBoundary.transaction, inspect native inputs/messages and the ORIGINAL compatibility history (runtime/modelContextVersion metadata restored by readHistory). For each required private marker missing its native input/message, derive a valid deletion proof using recorded native revert history/current boundary messages. Preserve existing imported proof identities and detect conflicts/duplicates; do not rewrite prior receipts. A native row that still exists but lacks its private sidecar is corruption, NOT a deletion. Do not delete rows during export or synthesize provider snapshots. Return a complete bundle passing validateLegacyBundle and existing verifyManifest. If no valid proof exists, keep failing closed. Continue supporting retained-prefix imports, multiple later reverts and clean markers without treating them as private records.

Prefer deriving on export without another transcript table/projector. cm_legacy_deletion remains imported compatibility metadata. If persistence is genuinely necessary, explain it and keep it inside the owning transaction; do not add a native source hook. Correct the existing restore comment that incorrectly says native does not delete pending inputs: exact pin already performs the same admitted/promoted predicate. The additional explicit targeted delete is idempotent, not new source semantics.

## Tests

Use real createSessionRuntime, deterministic LLM replacements, native Session.prompt/revert.stage({files:false})/revert.commit and native SessionInput/SessionStore projection. No hand-built deletion proof as the test result. Establish a retained promoted boundary, create private inputs/checkpoint after it, perform an actual native revert, then export and restore into an independent native receiver. Exercise ALL THREE causes:
- admitted-only later input deleted by admitted_seq;
- input admitted before the boundary but promoted afterward (queue ordering) deleted by promoted_seq;
- private compaction message after boundary deleted by message seq.

For checkpoint creation use actual existing private compaction/persistCheckpoint helper and native event projection, not a duplicate runner. Relevant current fixtures and native APIs are attached. Verify private/clean cascades, exact event identity/hashes, no private bytes in public events/messages, bundle restore/export equality, no provider wakes on replay, and atomic rollback on tampered deletion relation. Add corruption case: manually missing private data with no corresponding native revert remains rejected. Add later-revert case so an earlier boundary disappearing does not manufacture invalid proofs. Ensure a frozen source snapshot can still continue after an appended valid revert using original normalizedBundle rules where applicable. Master runs targeted and full proof after return.

Effect beta.83: forkScoped with Scope/Effect.scoped, not Effect.fork; Fiber.interrupt returns void; Cause.findErrorOption. No any, aliases/star imports, unchecked casts, globalThis or sleeps.
