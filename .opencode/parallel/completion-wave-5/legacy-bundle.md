# Worker 3 of 3 — legacy BundleV1 validation

Create only these files in D:\OpencodeHarness:
- modular/packages/adapters-opencode/src/legacy-bundle.ts
- modular/packages/adapters-opencode/test/legacy-bundle.test.ts

Use this brief and attached baseline source only. No exploration, commands/tests, Git, delegation, shared-file edits, vendor edits or imports from the integrated fork. Other workers supply the frozen context codec and authorized Session access independently. The master handles storage, authenticated transport and native replay after your return.

## Deliverable and API

Implement a synchronous, lossless schema/relationship validator for the original fork's SessionProjectionTransfer.BundleV1. The attached projection-transfer source is the exact format and relation specification; do not copy its Database layer or assume fork-only native APIs exist in official Core.

Export:
- `LegacyBundleError extends Error` with readonly `code:string`, constructor(code:string), generic non-private message.
- `validateLegacyBundle(value: unknown, retained?: readonly LegacyPublicEvent[]): ValidatedLegacyBundle`.
- `LegacyPublicEvent` matching original PublicEventV1, with data a JSON object preserving every field (including modelContextVersion and Session runtime classification).
- `ValidatedLegacyBundle` with `{ bundle, history, inputs, checkpoints, epoch? }`:
  - bundle: strictly decoded original BundleV1, preserving original event data and raw payload strings.
  - history: complete merged event history from retained + incoming, sorted by seq.
  - inputs: `{envelope, context:LegacyInputContext}[]` from validated input contexts.
  - checkpoints: `{envelope, context:PrivateCheckpoint}[]`.
  - epoch: `{envelope, payload:{baseline:string,snapshot:LegacyJson}}` when present.

Additional exported types may use inferred Schema types, but no any or unchecked casts. Return detached validated data so later caller mutations cannot invalidate stored validation assumptions.

## Frozen dependency implemented by worker 2

```ts
import { legacyCanonical, legacyDigest, decodeLegacyContext, type LegacyJson, type LegacyInputContext } from "./legacy-context"
// LegacyJson = null|boolean|number|string|readonly LegacyJson[]|{readonly[key:string]:LegacyJson}
// legacyCanonical(unknown): string — recursively sorted JSON, rejects invalid JSON/cycles
// legacyDigest(unknown): string — "sha256:" + SHA256(legacyCanonical(value))
// decodeLegacyContext(unknown,promptText:string): {
//   version:1|2,rendererVersion:1|2,snapshot:JSON object,
//   contextRequestHash:string,apiContent:string,apiContentHash:string
// }
import { decodeCheckpoint, type PrivateCheckpoint, SENTINEL } from "./checkpoint"
// decodeCheckpoint(unknown,messageID:string): PrivateCheckpoint; throws on invalid.
// Existing checkpoint source is attached in full.
```

Catch dependency decoder errors at the boundary and return a stable LegacyBundleError without exposing private contents. For untrusted JSON payload strings prefer the installed Effect Schema JSON decoder, then compare canonical bytes exactly to the supplied string before trusting a digest. Effects are not needed for synchronous parsing.

## Format (exact field names)

See attached original source lines 28-99 for full schemas. Summary:
- bundle `{version:1,aggregateID,sourceSeq,events:[],contexts:[],deletions:[],epoch?}`.
- public event `{id,type,seq,aggregateID,data}`.
- event identity `{eventID,aggregateID,seq,eventType,eventDataHash}`.
- context envelope `{version:1,eventID,aggregateID,seq,eventType,eventDataHash,messageID,kind:"input"|"compaction",sidecarSchemaVersion,contentHash,payload}`.
- epoch `{version:1,kind:"context-epoch",aggregateID,sourceSeq,baselineSeq,epochSchemaVersion:1,contentHash,payload}`.
- deletion `{version:1,kind:"reverted-target",aggregateID,targetMessageID,targetKind:"input"|"compaction",deletionCause:"message-seq"|"input-admitted-seq"|"input-promoted-seq",targetEvent,deletingEvent,boundaryMessageID,boundaryEvent,promotionEvent?}`.

All sequence/count/version numeric fields are nonnegative safe integers. IDs/type/hash/payload fields are strings, Session IDs use the existing ses prefix. Strictly reject extra fields in envelope/identity/bundle structures, but event.data is an arbitrary valid JSON object whose fork fields MUST survive; the later native adaptation validates/projects its own supported event codecs. Do not call native Durable.decode here and strip/reject known fork additions.

## Validation rules

1. Bundle identity must agree across all events, contexts, deletions and epoch. Incoming events contiguous and ordered, no repeated IDs/seq. Merge retained public events by sequence; exact duplicate identities/data are allowed, conflicting seq or event ID reuse is rejected. Merged history must cover 0..sourceSeq exactly (retained prefix supports incremental export). No events beyond sourceSeq.
2. Context and epoch payload strings must already equal legacyCanonical(parsedPayload), with contentHash equal legacyDigest(parsedPayload). All eventDataHash fields are legacyDigest(event.data). Hashes alone do not grant authorization; this module does not implement authorization.
3. Each context envelope identity must match exactly one history event including event ID/type/seq/aggregate/data hash. No duplicate kind/message or contradictory envelopes. Envelope messageID must equal event.data.messageID.
4. Input contexts must target PromptAdmitted v1 and pass decodeLegacyContext(payload, event.data.prompt.text), with envelope sidecarSchemaVersion equal context.version. Compaction contexts must target Compaction.Ended v1 with event.data.text === SENTINEL and pass decodeCheckpoint.
5. Every history PromptAdmitted with modelContextVersion===2 and every private-sentinel Compaction.Ended must have exactly one context OR a validated deletion proof. A target may not be both live and deleted. Missing/duplicate/forged manifests fail. Contexts with no matching event fail. Do not add partial-replay fallback; full merged history is supplied explicitly.
6. Deletion identities must all match history. Target message/kind, deleting Revert.Committed event, boundary message and optional promotion must agree. deleting.seq must exceed promotion.seq if supplied, otherwise target.seq. Boundary event must actually project the stated boundary message. Compute deletion cause with the exact function below. promotionEvent is required iff cause is input-promoted-seq, and must be Prompted for the target input.
7. Epoch payload exactly `{baseline:string,snapshot:<native SystemContext.Snapshot JSON>}`. Validate snapshot with native `SystemContext.Snapshot`, re-encode and compare canonical bytes to prevent lossy decode. baselineSeq <= sourceSeq; envelope sourceSeq matches bundle.sourceSeq. Native epoch replacement/owner checks belong to the later transaction adapter, not this codec.

Exact deletion cause:
```ts
if (target.kind === "compaction") return target.seq > boundarySeq ? "message-seq" : undefined
if (target.admittedSeq > boundarySeq) return "input-admitted-seq"
return target.promotedSeq !== undefined && target.promotedSeq > boundarySeq ? "input-promoted-seq" : undefined
```

Use native `EventV2.versionedType(definition.type, version)` and `SessionEvent` named namespace imported from official Schema for exact event version strings. These native definitions exist: PromptAdmitted, Prompted, Compaction.Ended, RevertEvent.Committed, Step.Started, AgentSwitched, ModelSwitched, ContextUpdated, Synthetic, Shell.Started. `messageIDOf` for Step.Started uses assistantMessageID, other projecting events above use messageID; admission itself is not a visible boundary message. The original attached function lists the exact projection types.

Native imports allowed in this adapter: `EventV2` from @opencode-ai/core/event, `SessionEvent` from @opencode-ai/schema/session-event, `SystemContext` from @opencode-ai/core/system-context, and Effect's Schema/Option. No integrated Core imports, SQL or runtime construction.

## Tests

Full and incremental/retained history; lossless modelContextVersion/runtime fields; valid V1/V2 input payloads and private checkpoints; epoch roundtrip; correct input-admitted/input-promoted/compaction deletion cases; tampered canonical payload/digest/event identity/sequence/duplicate ID; missing manifest and invalid/contradictory deletion proof. Use schema-generated native epoch fixtures if possible; SystemContext.empty snapshot shapes are not guessed (an actual epoch example is in the attached projection test). The test can import the worker-2 helpers but must not edit that worker's files.

No commands or tests by worker. Master will run adapter typecheck, both codec tests, then integration. Return files changed, implemented validation, and any missing/uncertain contracts. Do not claim storage/migration/readiness/transfer completion.
