# Worker 1 of 2 — full snapshot persistence for new admissions

Own ONLY these files under D:/OpencodeHarness/modular/packages/adapters-opencode:
- src/context-renderer.ts (new)
- src/admission.ts
- src/session-facade.ts
- src/legacy-projection.ts
- test/context-renderer.test.ts (new)
- test/input-compatibility.test.ts (new)

Astra High. No exploration, commands/tests, Git, delegation or other edits. Supplied source snapshots are the entire context. Preserve already-working legacy retries and public/private separation. No native patches, any, aliased/star imports or new unchecked casts.

## Goal

Normal feature admission must retain the complete V2 private snapshot so it can later be exported using the original BundleV1 format. Current `cm_private_input` stores only apiContent/hash/renderer; imported rows additionally have cm_legacy_input, so newly admitted private rows cannot currently be exported. Complete that integration without inventing fragment content or weakening validation.

## Renderer

Create an owned pure renderer based on the attached custom fork context-sidecar.ts (do not import the fork). Export `ContextSidecarAttachment` with the exact explicit/automatic shapes from that source, and:
```ts
export function renderContextSnapshot(input: {
 readonly promptText:string;
 readonly attachments:readonly ContextSidecarAttachment[];
 readonly recall:{readonly policy:"disabled"|"operating-chat-v1";readonly status:"disabled"|"skipped-trivial"|"no-match"|"selected"|"unavailable"};
 readonly budget:{readonly maximumBytes:number;readonly maximumEstimatedTokens:number};
 readonly createdAt:number;
}): LegacyInputContext
```
Return `decodeLegacyContext`-validated detached data. Renderer property ordering, escaping, provenance, bare hashes, and rendererVersion=2 when tags are present must match the supplied producer exactly. Budget applies to the workspace-context envelope only; UTF-8 bytes and ceil(bytes/4). Default interactive budget is 32768 bytes / 6000 estimated tokens. Throw a typed owned error containing limit/current/maximum only for budget failure, never private content. Empty attachment snapshots preserve promptText with zero context bytes/tokens.

## Freeze contract extension

Add an exported type for the current freeze result `{apiContent:string,rendererVersion:number,context?:LegacyJsonObject}` and use it in AdmissionPolicy and PreparedInput. The optional `context` is a full original input snapshot, not user-provided raw prompt data. Existing proof policies without this field remain valid.

For new managed admissions:
- If explicit context is supplied, decode/verify it against the clean prompt and ensure apiContent/hash/renderer agree with the freeze result. Its explicit attachment request hash must agree with `legacyReferenceHash(request.references)` when applicable.
- If references are empty and apiContent equals the clean prompt, synthesize the valid empty V2 snapshot with the actual admission timestamp. This makes the default application's clean prompts exportable.
- If an older proof-only custom policy supplies arbitrary enriched apiContent without a full context, retain existing behavior and let legacy export fail with unsupported-private-origin; NEVER invent missing attachments/provenance.
- Persist complete snapshot JSON in cm_legacy_input atomically with new private admission, and retain private request identity for exact retry. Known renderer versions are 1/2.

## Atomic compatibility event metadata

The native Event implementation runs projectors/commit callbacks BEFORE inserting its Event row. Therefore cm_legacy_event's immediate FK cannot be written from those callbacks. The existing Session facade wraps native.prompt in EventBoundary.transaction. Write original event metadata only AFTER native.prompt returns but BEFORE that owning transaction commits, acknowledgement/wake or public notifications.

For a new full V2 snapshot, the compatibility public event adds modelContextVersion:2 out of band using adaptLegacyEvent/legacyDigest. Preserve the native row unchanged and store canonical original JSON/native hash in cm_legacy_event. Do not add private bodies to event data. Reconcile immutable duplicates/conflicts. Existing imported events retain their exact original field presence; do not overwrite their archive metadata on retry.

The facade's `commitPrompt` currently accepts an Effect validator. You may change its internal callback to receive the returned native Admitted record so it can locate the committed native event by session/seq; keep its exported/native API unchanged. Early exact-retry validation must remain read-only and before freeze. In-transaction retry authorization remains mandatory.

## Export/restore integration

Current legacy-projection's sameInput only accepts `request_hash = legacy:<contextRequestHash>`. That is correct for imported rows, but locally admitted rows retain the actor-inclusive privateRequestIdentity. Distinguish those origins without converting/resetting local retry identity. A locally stored snapshot can be exported when its API content/hash/renderer, native clean prompt/delivery and preserved snapshot agree. Do not claim a foreign bundle authenticates an actor-inclusive request hash; authorization remains separate. Preserve conflict detection on restore and exact existing private data; do not overwrite a local request hash with legacy:.

Do not modify kernel or session-runtime. The selected Session runtime already runs initializeExtension then initializeLegacyProjection before exposure. Any direct proof admission path lacking legacy tables must retain its former contract or explicitly initialize extension-owned tables; never open another database/runtime. The master handles shared bootstrap changes if needed.

## Tests

Use actual file-backed createSessionRuntime/native Session facade and real legacy projection. Prove: clean new admission exports/restores; tagged V2 snapshot from renderer reaches provider/private storage while public events/messages remain clean; exact retry avoids freeze and retains stored snapshot; changed references conflict; corrupted supplied snapshot/budget errors leave no public/private prefix; compatibility metadata writes roll back with the outer transaction; imported legacy retry still works; local origin hashes are not rewritten during export/restore reconciliation. The supplied runtime/projection tests show real fixtures and native APIs.

The existing LLMClient.Service.stream signature is `(request:LLMRequest)=>Stream<LLMEvent,LLMError>`; use contextual typing for cast-free test replacements. Bound service variables before calls, and use scoped resources/databaseCleanup. Master runs checks after both workers return. Report exact implementation/gaps.
