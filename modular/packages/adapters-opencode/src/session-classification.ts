import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { adaptLegacyEvent } from "./legacy-event"
import { legacyCanonical, legacyDigest } from "./legacy-context"

export class RuntimeClassificationError extends Schema.TaggedErrorClass<RuntimeClassificationError>()(
  "CyberMastery.RuntimeClassification",
  {
    sessionID: SessionSchema.ID,
    code: Schema.String,
  },
) {}

const StoredEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  seq: Schema.Number,
  aggregateID: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
})

const createdType = (() => {
  const definition = SessionV1.Event.Created
  if (!definition.durable) throw new Error("Session Created definition is not durable")
  return EventV2.versionedType(definition.type, definition.durable.version)
})()

type CreatedEventRow = {
  readonly id: string
  readonly type: string
  readonly seq: number
  readonly aggregate_id: string
  readonly data: string
}

/**
 * Records the v2 runtime classification for a freshly published native Created
 * event. Callers must invoke this inside the EventBoundary.transaction that
 * published the event; it never adds native events or rewrites event.data.
 */
export const recordV2SessionCreated = (sessionID: SessionSchema.ID) =>
  guarded(sessionID, Effect.gen(function* () {
    const database = yield* Database.Service
    const session = yield* database.db.get<{ workspace_id: string | null }>(sql`
      SELECT workspace_id FROM session WHERE id = ${sessionID}`)
    if (!session) return yield* new RuntimeClassificationError({ sessionID, code: "session-missing" })
    const row = yield* database.db.get<CreatedEventRow>(sql`
      SELECT id, type, seq, aggregate_id, data FROM event
      WHERE aggregate_id = ${sessionID} AND type = ${createdType}`)
    if (!row) return yield* new RuntimeClassificationError({ sessionID, code: "created-event-missing" })
    const metadata = yield* Effect.try({
      try: () => readCreatedMetadata(sessionID, row, session.workspace_id),
      catch: (error: unknown) => error instanceof RuntimeClassificationError
        ? error
        : new RuntimeClassificationError({ sessionID, code: "created-event-schema" }),
    })
    const stored = yield* database.db.get<{ runtime: string }>(sql`
      SELECT runtime FROM cm_session_runtime WHERE session_id = ${sessionID}`)
    if (stored && stored.runtime !== "v2")
      return yield* new RuntimeClassificationError({ sessionID, code: "runtime-conflict" })
    const existing = yield* database.db.get<{ aggregate_id: string; original_json: string; native_hash: string }>(sql`
      SELECT aggregate_id, original_json, native_hash FROM cm_legacy_event WHERE event_id = ${metadata.eventID}`)
    if (existing && (existing.aggregate_id !== sessionID || existing.original_json !== metadata.original ||
      existing.native_hash !== metadata.nativeHash))
      return yield* new RuntimeClassificationError({ sessionID, code: "event-metadata-conflict" })
    if (!stored) yield* database.db.run(sql`
      INSERT INTO cm_session_runtime (session_id, runtime) VALUES (${sessionID}, 'v2')`)
    if (!existing) yield* database.db.run(sql`
      INSERT INTO cm_legacy_event (event_id, aggregate_id, original_json, native_hash)
      VALUES (${metadata.eventID}, ${sessionID}, ${metadata.original}, ${metadata.nativeHash})`)
  }))

/** Reads the durable classification without writing or inferring a runtime. */
export const requireV2Session = (sessionID: SessionSchema.ID) =>
  guarded(sessionID, Effect.gen(function* () {
    const database = yield* Database.Service
    const stored = yield* database.db.get<{ runtime: string }>(sql`
      SELECT runtime FROM cm_session_runtime WHERE session_id = ${sessionID}`)
    if (!stored) return yield* new RuntimeClassificationError({ sessionID, code: "missing-runtime" })
    if (stored.runtime === "v2") return
    if (stored.runtime === "legacy") return yield* new RuntimeClassificationError({ sessionID, code: "legacy-runtime" })
    return yield* new RuntimeClassificationError({ sessionID, code: "mixed-runtime" })
  }))

function readCreatedMetadata(sessionID: SessionSchema.ID, row: CreatedEventRow, workspaceID: string | null) {
  const native = Schema.decodeUnknownSync(StoredEvent)({
    id: row.id,
    type: row.type,
    seq: row.seq,
    aggregateID: row.aggregate_id,
    data: parseStoredJson(row.data),
  })
  if (native.type !== createdType) throw new RuntimeClassificationError({ sessionID, code: "created-event-type" })
  if (native.aggregateID !== sessionID)
    throw new RuntimeClassificationError({ sessionID, code: "created-event-relation" })
  const info = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(native.data.info)
  if (info.id !== sessionID) throw new RuntimeClassificationError({ sessionID, code: "created-event-relation" })
  if ((info.workspaceID ?? null) !== workspaceID)
    throw new RuntimeClassificationError({ sessionID, code: "created-event-relation" })
  // Reconstruct the legacy-only info.runtime field, then prove the round trip
  // leaves the stored native serialization byte-for-byte canonical.
  const adapted = adaptLegacyEvent({ ...native, data: { ...native.data, info: { ...info, runtime: "v2" } } })
  if (adapted.metadata.runtime !== "v2")
    throw new RuntimeClassificationError({ sessionID, code: "created-event-schema" })
  if (legacyCanonical(adapted.native) !== legacyCanonical(native))
    throw new RuntimeClassificationError({ sessionID, code: "created-event-hash-conflict" })
  return {
    eventID: native.id,
    original: legacyCanonical(adapted.original),
    nativeHash: legacyDigest(adapted.native),
  }
}

function parseStoredJson(text: string) {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(decoded)) throw new Error("invalid stored event json")
  const json = Schema.decodeUnknownOption(Schema.Json)(decoded.value)
  if (Option.isNone(json)) throw new Error("invalid stored event json")
  return json.value
}

function guarded<A, E>(
  sessionID: SessionSchema.ID,
  effect: Effect.Effect<A, E, Database.Service>,
) {
  return effect.pipe(
    Effect.catchDefect((error) => Effect.fail(sanitize(sessionID, error))),
    Effect.mapError((error) => sanitize(sessionID, error)),
  )
}

function sanitize(sessionID: SessionSchema.ID, error: unknown): RuntimeClassificationError {
  if (error instanceof RuntimeClassificationError) return error
  return new RuntimeClassificationError({ sessionID, code: "classification-failed" })
}
