# Worker 2 of 2 — transactional legacy projection adapter

Create only:
- modular/packages/adapters-opencode/src/legacy-projection.ts
- modular/packages/adapters-opencode/test/legacy-projection.test.ts

Workspace D:\OpencodeHarness, Astra High. All context is this brief and supplied source snapshots. No exploration, commands/tests, Git, delegation, existing shared-file edits or vendor changes. Do not import integrated fork modules; their original source is a format/semantic reference only.

## API

Export `LegacyProjectionError` (stable code only), `initializeLegacyProjection` (Effect requiring Database.Service), and `makeLegacyProjection(policy)`:
```ts
type LegacyScope = {
 readonly sessionID: SessionSchema.ID;
 readonly workspaceID?: string;
 readonly ownerID: string;
}
// policy.authorize(scope): Effect<void, LegacyProjectionError>, mandatory.
// returned methods:
restore({bundle:unknown,scope:LegacyScope,expectedDigest:string,publish?:boolean}) // Effect<void,...,Database|Event|EventBoundary>
export(scope:LegacyScope) // Effect<LegacyBundle,...,Database|EventBoundary>
```
The separately supplied expectedDigest must equal legacyDigest of the supplied raw BundleV1; do not trust a digest from the bundle itself. Policy authenticates actor/topology/owner separately; hash is only integrity. No live transfer protocol/spool/lease is implemented in this module.

## Existing verified collaborators

- validateLegacyBundle(raw, retainedHistory?) validates the complete merged history, original event/context/deletion/epoch identities and inner snapshot/checkpoint hashes. Its full source/types are attached.
- adaptLegacyEvent(original) returns `{original,native,metadata}` and restoreLegacyEvent(native,metadata) reconstructs the original. Known fork fields are modelContextVersion:2 and SessionInfo.runtime legacy/v2/mixed; all other lossy data rejects. Sources attached.
- legacyCanonical/legacyDigest/decodeLegacyContext preserve exact fork canonical JSON behavior; transfer digests are prefixed sha256:, inner API hashes bare hex.
- EventBoundary.transaction(effect) buffers notifications and fences durable readers until commit. Native events.replayAll must run INSIDE that boundary, not a plain outer SQL transaction. Existing projection.ts demonstrates it.
- During replay provide PrivateRestoreContext `{sessionID,digest}` so the installed private admission guard permits only this validated replay. Its source is attached.
- Native Database.db has `run/get<T>/all<T>(sql\`...\`)`, transaction; EventV2.latestSequence; EventV2.replayAll(serialized,{publish,ownerID,strictOwner:true}). Native Event table raw columns id,type,seq,aggregate_id,data (JSON text). Native Session/SessionInput/SessionMessage/ContextEpoch and private proof tables are shown in attached kernel/projection sources.

## Extension persistence (your initializer)

Create idempotently, with a separate cm_migration entry:
- `cm_legacy_event(event_id TEXT PRIMARY KEY REFERENCES event(id) ON DELETE CASCADE, aggregate_id TEXT NOT NULL, original_json TEXT NOT NULL, native_hash TEXT NOT NULL)`. This is compatibility metadata, not a second event authority. Store canonical original full event and digest of canonical native full event.
- `cm_legacy_input(message_id TEXT PRIMARY KEY REFERENCES session_input(id) ON DELETE CASCADE, session_id TEXT NOT NULL, snapshot_json TEXT NOT NULL)`. Preserve original complete V1/V2 snapshot bytes/metadata, including tags/fragments.
- `cm_session_runtime(session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, runtime TEXT NOT NULL CHECK(runtime IN ('legacy','v2','mixed')))`. Preserve explicit runtime classification from lifecycle events without editing native schema.
- `cm_legacy_deletion(aggregate_id TEXT NOT NULL, target_kind TEXT NOT NULL, message_id TEXT NOT NULL, proof_json TEXT NOT NULL, PRIMARY KEY(aggregate_id,target_kind,message_id))` for original authenticated deletion proofs. Do not put a Session FK on retained historical event/deletion metadata that must outlive deleted projection rows.

The master later registers initializer at host bootstrap. Your methods may call it after authorization for standalone tests. Never create native migration entries or change vendor migrations.

## Restore algorithm / acceptance

1. Validate scope/expected digest and policy before mutations. Reject blank owner ID. Read retained native events and rehydrate original data from cm_legacy_event, checking native_hash against actual stored native rows. Do not trust stale/corrupt metadata.
2. Enter one EventBoundary.transaction and revalidate policy, placement and replay owner there. Reject receiver ahead of source high-water. Existing Session workspace must equal scope.workspaceID (null corresponds to undefined). For a missing Session, require a valid incoming native Created event whose info workspace matches scope; the caller must have provisioned its native Project row. Do not fabricate project identity. An absent required project must roll back cleanly.
3. Merge/validate full history using validateLegacyBundle before exposing any replay. Adapt incoming events with adaptLegacyEvent. Reject conflicting original metadata even if the stripped native payload would match.
4. Replay native converted events through EventBoundary with strict owner and PrivateRestoreContext. Preserve original events and native hashes in the same transaction, reconciling exact duplicates only.
5. Persist live input snapshots in cm_legacy_input and corresponding cm_private_input rows. Use `request_hash = "legacy:" + context.contextRequestHash`, verified apiContent/apiContentHash and rendererVersion 1 or 2. Add cm_private_requirement kind input. Verify native session_input's session/id/admitted_seq and clean prompt relation before writing. Existing conflicting rows or snapshots fail; do not overwrite them. V1 model content is public prompt while the complete private snapshot remains preserved.
6. Persist checkpoint contexts in cm_private_checkpoint plus cm_private_requirement, checking native compaction message/session/seq/sentinel. Exact duplicate contexts are allowed, conflicts fail.
7. Apply only validated deletion proofs, preserving proof JSON. Native replay/projectors remain primary; if fork-specific pending-input deletion semantics leave a proven target row, remove precisely that validated target within the same event transaction and document this projection augmentation. Never delete an unproven target. Ensure deleted private records/requirements are absent; retain historical original events/proofs.
8. Restore native Context Epoch into the existing native table, never a new epoch owner. Match original replacement fencing: replacement requires explicit matching workspace/owner, no receiver-ahead state, and final native event sequence equal sourceSeq. Exact existing epoch is idempotent. Preserve absent-source behavior without silently erasing receiver state; report an unresolved semantic case rather than inventing data.
9. Recheck final live/private manifest against validated history and classify explicit runtime metadata consistently. Conflicting runtime reclassification fails. Any error rolls back native rows, private rows, metadata and notifications together. No provider wake or model execution from restore.

## Export

Within one consistent managed transaction, authorize and verify placement/owner, read native events and rehydrate original event data with hash checks, collect preserved input snapshot envelopes, checkpoints, deletion proofs and native epoch into exact original BundleV1. Canonical payload/hash and eventDataHash use legacy helpers. Include current full native history, sourceSeq and all required live/deleted manifests; validate the output before returning.

Imported private rows have preserved snapshots. New proof-only cm_private_input rows may lack a representable legacy snapshot: fail with `unsupported-private-origin` rather than fabricate attachments or drop private context. The master will integrate full snapshot persistence for normal feature admission. Existing native-format projection.ts remains available; do not edit it.

Source methods should preserve public native transcript text and return no private content through events. Raw original public metadata can be exposed only through explicitly authorized compatibility export, never mixed with input snapshot bodies.

## Tests

Real file-backed mediated native graph; initializeExtension then your initializer. Existing fixture source is attached and may be adapted to use `wrk_...` IDs. Test full and retained-prefix import/export, exact duplicate, renderer2 tags/private input hashes, checkpoint/epoch, original runtime/modelContextVersion preservation, strict owner/workspace/digest rejection, event/hash conflicts, all three deletion causes, and injected SQL failure after public replay proving no rows/notifications escape. At least one test installs the real managed Session facade guard, using the supplied Session-runtime fixture pattern. Caller project provisioning must be explicit for a missing-Session import.

The master owns follow-up recognition of `legacy:` retry hashes in admission and registering your initializer. Do not weaken native guards. Native Query errors may remain typed internally; sanitize arbitrary failures only at the external error boundary while preserving interruption. No any/aliases/star imports or unsupported native APIs. Report precise coverage/gaps; master verifies after both workers return.
