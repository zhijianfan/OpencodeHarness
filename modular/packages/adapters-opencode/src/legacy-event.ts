import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Option, Schema } from "effect"
import type { LegacyPublicEvent } from "./legacy-bundle"
import { legacyCanonical } from "./legacy-context"

export class LegacyEventError extends Error {
  readonly code: string

  constructor(code: string) {
    super("Invalid legacy event")
    this.name = "LegacyEventError"
    this.code = code
  }
}

export type LegacyEventMetadata = {
  readonly runtime?: "legacy" | "v2" | "mixed"
  readonly modelContextVersion?: 2
}

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const PublicEvent = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  seq: Schema.Number,
  aggregateID: SessionV1.SessionInfo.fields.id,
  data: JsonObject,
})
const Metadata = Schema.Struct({
  runtime: Schema.Literals(["legacy", "v2", "mixed"]).pipe(Schema.optional),
  modelContextVersion: Schema.Literal(2).pipe(Schema.optional),
})
const decodeEvent = Schema.decodeUnknownOption(PublicEvent, { onExcessProperty: "error" })
const decodeObject = Schema.decodeUnknownOption(JsonObject)
const decodeMetadata = Schema.decodeUnknownOption(Metadata, { onExcessProperty: "error" })
const admittedType = EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)
const sessionTypes = new Set<string>([
  SessionV1.Event.Created,
  SessionV1.Event.Updated,
  SessionV1.Event.Deleted,
].map((definition) => {
  if (!definition.durable) throw new LegacyEventError("unknown-durable-type")
  return EventV2.versionedType(definition.type, definition.durable.version)
}))

export function adaptLegacyEvent(event: LegacyPublicEvent): {
  readonly original: LegacyPublicEvent
  readonly native: EventV2.SerializedEvent
  readonly metadata: LegacyEventMetadata
} {
  // Canonicalization and codecs can throw errors containing input values. Keep
  // that information behind this boundary, including for malformed JS objects.
  try {
    const original = requireEnvelope(event)
    const projected = splitMetadata(original)
    const native = requireNative({ ...original, data: projected.data })
    return { original, native, metadata: projected.metadata }
  } catch (error) {
    if (error instanceof LegacyEventError) throw error
    throw new LegacyEventError("event-schema")
  }
}

export function restoreLegacyEvent(event: EventV2.SerializedEvent, metadata: LegacyEventMetadata): LegacyPublicEvent {
  try {
    // Do not adapt this input first: fork-only fields inside a purported native
    // payload must fail rather than being silently moved into new metadata.
    const native = requireNative(requireEnvelope(event))
    const bytes = legacyCanonical(metadata)
    const decoded = decodeMetadata(metadata)
    if (Option.isNone(decoded) || legacyCanonical(decoded.value) !== bytes)
      throw new LegacyEventError("metadata-schema")
    if ((decoded.value.modelContextVersion !== undefined && native.type !== admittedType) ||
      (decoded.value.runtime !== undefined && !sessionTypes.has(native.type)))
      throw new LegacyEventError("metadata-placement")

    const data = {
      ...native.data,
      ...(decoded.value.modelContextVersion === undefined ? {} : { modelContextVersion: decoded.value.modelContextVersion }),
      ...(decoded.value.runtime === undefined ? {} : {
        info: { ...requireJsonObject(native.data.info), runtime: decoded.value.runtime },
      }),
    }
    const restored = adaptLegacyEvent({ ...native, data })
    if (legacyCanonical(restored.native) !== legacyCanonical(native) || legacyCanonical(restored.metadata) !== bytes)
      throw new LegacyEventError("restore-roundtrip")
    return restored.original
  } catch (error) {
    if (error instanceof LegacyEventError) throw error
    throw new LegacyEventError("restore-schema")
  }
}

function requireEnvelope(value: unknown) {
  const bytes = legacyCanonical(value)
  const decoded = decodeEvent(value)
  if (Option.isNone(decoded)) throw new LegacyEventError("event-schema")
  if (!Number.isSafeInteger(decoded.value.seq) || decoded.value.seq < 0)
    throw new LegacyEventError("event-sequence")
  if (legacyCanonical(decoded.value) !== bytes) throw new LegacyEventError("lossy-event-schema")
  return structuredClone(decoded.value)
}

function splitMetadata(event: typeof PublicEvent.Type): {
  readonly data: typeof JsonObject.Type
  readonly metadata: LegacyEventMetadata
} {
  if (event.type === admittedType && Object.hasOwn(event.data, "modelContextVersion")) {
    if (event.data.modelContextVersion !== 2) throw new LegacyEventError("model-context-version")
    return { data: withoutField(event.data, "modelContextVersion"), metadata: { modelContextVersion: 2 } }
  }
  if (sessionTypes.has(event.type)) {
    const info = requireJsonObject(event.data.info)
    if (Object.hasOwn(info, "runtime")) {
      if (info.runtime !== "legacy" && info.runtime !== "v2" && info.runtime !== "mixed")
        throw new LegacyEventError("session-runtime")
      return {
        data: { ...event.data, info: withoutField(info, "runtime") },
        metadata: { runtime: info.runtime },
      }
    }
  }
  return { data: event.data, metadata: {} }
}

function requireNative(event: typeof PublicEvent.Type) {
  const definition = Durable.get(event.type)
  if (!definition?.durable) throw new LegacyEventError("unknown-durable-type")
  const decoded = Schema.decodeUnknownOption(definition.data)(event.data)
  if (Option.isNone(decoded)) throw new LegacyEventError("native-schema")
    const encoded = requireJsonObject(Schema.encodeUnknownSync(definition.data)(decoded.value))
  if (legacyCanonical(encoded) !== legacyCanonical(event.data)) throw new LegacyEventError("lossy-native-schema")
  const data: unknown = decoded.value
  if (!isRecord(data) || data[definition.durable.aggregate] !== event.aggregateID ||
    encoded[definition.durable.aggregate] !== event.aggregateID ||
    (Object.hasOwn(encoded, "sessionID") && encoded.sessionID !== event.aggregateID))
    throw new LegacyEventError("event-aggregate")
  if (sessionTypes.has(event.type) && requireJsonObject(encoded.info).id !== event.aggregateID)
    throw new LegacyEventError("session-info-identity")
  return { ...event, data: structuredClone(encoded) }
}

function requireJsonObject(value: unknown) {
  const bytes = legacyCanonical(value)
  const decoded = decodeObject(value)
  if (Option.isNone(decoded) || legacyCanonical(decoded.value) !== bytes)
    throw new LegacyEventError("event-json")
  return decoded.value
}

function withoutField(value: typeof JsonObject.Type, field: string) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
