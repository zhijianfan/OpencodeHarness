# Worker 1 of 2 — atomic fresh Session classification

Use ONLY attached source snapshots and this brief. Your model is opencode-go/deepseek-v4.1-flash/high. Edit only these exact files under D:/OpencodeHarness/modular/packages/adapters-opencode:
- src/session-classification.ts (new)
- src/session-facade.ts
- test/session-classification.test.ts (new)

No read/glob/grep/commands/tests/Git/delegation or other edits. Master validates after both workers return. No vendor patches or copied native Session engine. No any, alias/star imports, non-null assertions. Effect 4.0.0-beta.83 APIs follow supplied examples. If context is missing, report it, do not invent APIs.

## Frozen contract (worker 2 consumes exactly this)

New src/session-classification.ts exports:
- RuntimeClassificationError: Schema.TaggedErrorClass with tag CyberMastery.RuntimeClassification and fields sessionID: SessionSchema.ID, code: Schema.String.
- recordV2SessionCreated(sessionID: SessionSchema.ID): Effect.Effect<void, RuntimeClassificationError, Database.Service>
- requireV2Session(sessionID: SessionSchema.ID): Effect.Effect<void, RuntimeClassificationError, Database.Service>

recordV2SessionCreated is ONLY called after a freshly published native SessionV1.Event.Created has returned and INSIDE its owning EventBoundary.transaction, never on historical adoption. It records cm_session_runtime='v2' plus cm_legacy_event metadata reconstructing info.runtime='v2' for legacy export. It must validate the durable Created event/Session relationship and exact canonical native hash; repeat identical recording is idempotent, conflicting runtime/metadata fails. SQL/decoding failures become sanitized RuntimeClassificationError codes. This function does not add a second native event or alter native event.data. requireV2Session checks that cm_session_runtime contains exactly 'v2', rejects missing/legacy/mixed and never writes or infers runtime. Neither helper opens a separate event boundary or creates tables.

## Task

The facade currently decorates prompt only, so normal SessionV2.create produces native Sessions without runtime classification. Add a create decoration that generates the native branded ID once, wraps native get/adopt/create and metadata recording in the SAME EventBoundary.transaction, and calls the helper only if there was no existing Session. Capture/provide Database.Service explicitly as the facade layer captures its dependencies. Preserve native create/adopt return behavior: existing IDs are adopted without silently classifying historical rows, including legacy/mixed/unclassified rows. No mutation of native Info codecs. SQL failure must roll back creation, event row, runtime row, metadata and publication together. Native Interface.create has no typed errors; use Effect.orDie at that boundary. Delegate all other methods unchanged. Update facade's comment to reflect the creation decoration.

The cm_session_runtime and cm_legacy_event tables are already initialized by initializeExtension; see attached legacy-projection for DDL and recordLegacyInputEvent pattern. Native Event projectors run BEFORE Event row insert; metadata must be written after native.create returns. Legacy export's reconcileRuntime compares all lifecycle metadata to cm_session_runtime, so writing only the classification row breaks export. Do not modify legacy-projection; use adaptLegacyEvent/legacyCanonical/legacyDigest from attached modules to construct compatible metadata. Native durable type is derived from SessionV1.Event.Created.durable.version and EventV2.versionedType. Event SQL columns: id, type, seq, aggregate_id, data (JSON string). Decode strictly with Schema; no unsafe casts. The helper must preserve exact native serialization and fail on mismatch.

## Tests

Use real createSessionRuntime and native Database/Event/Session service, temporary file database, databaseCleanup, disposal in finally, supplied input-compatibility fixture patterns. Cover: fresh creation classifies atomically; native public Created data has no runtime field; legacy export (after explicit event_sequence owner claim) has runtime v2; idempotent create does not create another event; existing native rows with missing/legacy/mixed classification are adopted without reclassification; requireV2Session rejects each incompatible state without writes; mismatched metadata fails and an outer EventBoundary transaction rolls back everything (including listener notification). Use actual effect service signatures and Schema error helpers from attached examples. Avoid large copied test fixtures if a small real runtime suffices.

Return owned files changed, guarantees, and uncertainties. Do not report tests as run.
