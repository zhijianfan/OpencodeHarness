# Worker 3 of 3 — reversible legacy-to-native event adaptation

Create only `modular/packages/adapters-opencode/src/legacy-event.ts` and `modular/packages/adapters-opencode/test/legacy-event.test.ts` in D:\OpencodeHarness. Astra High. No exploration, commands/tests, Git, delegation, other edits or integrated-fork imports. Source snapshots are context only.

## Frozen API

```ts
import type { LegacyPublicEvent } from "./legacy-bundle"
import type { EventV2 } from "@opencode-ai/core/event"
export class LegacyEventError extends Error { readonly code:string; constructor(code:string) }
export type LegacyEventMetadata = {
  readonly runtime?: "legacy" | "v2" | "mixed"
  readonly modelContextVersion?: 2
}
export function adaptLegacyEvent(event: LegacyPublicEvent): {
  readonly original: LegacyPublicEvent
  readonly native: EventV2.SerializedEvent
  readonly metadata: LegacyEventMetadata
}
export function restoreLegacyEvent(event: EventV2.SerializedEvent, metadata: LegacyEventMetadata): LegacyPublicEvent
```

This is a pure deterministic codec boundary, not storage/replay/authentication. The master will persist original events/metadata atomically with native replay. Reject unsupported/lossy input rather than silently dropping fields. Return detached values; never mutate callers.

## Source facts and rules

Official native `Durable` is exported from @opencode-ai/schema/durable-event-manifest and supports `.get(versionedType)` returning a definition with `.data` codec and `.durable.aggregate/.version` metadata. `EventV2.SerializedEvent = {id:EventV2.ID,type:string,seq:number,aggregateID:string,data:Record<string,unknown>}`. The attached core/event excerpt shows exact decode behavior. Use `EventV2.ID` and SessionSchema.ID codecs to validate IDs; nonnegative safe seq; valid JSON object data and aggregate identity agreement are mandatory.

Native codecs must roundtrip ALL projected fields exactly. Use `Schema.decodeUnknownOption(definition.data)` and `Schema.encodeUnknownSync(definition.data)` with canonical comparison. `legacyCanonical`/`legacyDigest` come from ./legacy-context. Canonicalization matches the fork's sorted-object-then-JSON.stringify behavior, including JS numeric-key enumeration. Unknown durable types or unknown/excess fields that native codecs would lose fail.

Only these explicitly owned additions may be removed into metadata before native decoding:
1. For `EventV2.versionedType(SessionEvent.PromptAdmitted.type,1)`, `data.modelContextVersion` may be exactly 2. Retain it in metadata and remove only that property. Other values (including 1/null) are unsupported; omission stays omitted.
2. For native `SessionV1.Event.Created`, `.Updated`, `.Deleted` at their declared durable version, `data.info.runtime` may be exactly `legacy`, `v2`, or `mixed`. Retain it in metadata and remove only that property. The native info.id must agree with event aggregate/session ID. Omission stays omitted (do not materialize the historical legacy default into the original event).

Native SessionV1 namespace is exported from @opencode-ai/core/v1/session; `Event` and `SessionInfo` are re-exported there. The schema source snapshot gives their exact fields. Session runtime classification is fork-only; do not call a nonexistent official runtime module. The allowed enum includes mixed.

For all other event types, metadata must be empty and payload must already roundtrip the native codec. Do not remove a field merely because it has one of the same names at another path or event kind. Do not accept an arbitrary metadata JSON passthrough that could override a native payload field.

`restoreLegacyEvent` must validate the native event and metadata placement/type, apply only these additions, and verify that re-adapting it yields the same native event. Restore exact original field presence/value; no private snapshot bodies enter public event data. Unknown metadata properties must fail. Generic errors contain stable codes, not event contents.

## Existing codec signatures

Attached legacy-bundle.ts defines LegacyPublicEvent with readonly JSON data; legacy-context.ts defines:
```ts
legacyCanonical(value:unknown):string
legacyDigest(value:unknown):string
```

`Schema.decodeUnknownOption(Schema.Json)` and `Schema.UnknownFromJsonString` are available. No unsafe cast from unknown to data records. Native schema definition generic types can be bridged by encoding to unknown and validating Json/record shape, as existing projection.ts does. Simple synchronous helpers must not return Effects.

## Tests

- Native PromptAdmitted roundtrip and same event with modelContextVersion:2; original metadata preserved, native payload clean; malformed value rejected.
- Native Created/Updated/Deleted roundtrip with each runtime value, and absent runtime remains absent. Use complete native SessionInfo fixtures based on the attached source (id,slug,projectID,directory,title,version,time; optional fields only as specified).
- Unrelated event using a similarly named field must fail if native codec would drop it.
- Unknown type/version, invalid ID/seq, aggregate or info.id mismatch, wrong runtime type, unknown metadata and mutated native fields fail.
- Rehydration is lossless, inputs remain untouched, and no injected/private extra fields are admitted.

Use actual native codecs/definitions. No vendor modifications or package changes. Master runs typecheck/tests and then persistence integration after the three-worker barrier. Report actual edits and precise uncertainties.
