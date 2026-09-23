import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { NonNegativeInt, optional } from "@opencode-ai/schema/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary } from "./event-boundary"
import { decodeCheckpoint, SENTINEL } from "./checkpoint"

const InputRecord = Schema.Struct({
  messageID: SessionMessage.ID,
  admittedSeq: NonNegativeInt,
  requestHash: Schema.String,
  apiContent: Schema.String,
  apiContentHash: Schema.String,
  rendererVersion: Schema.Literal(1),
})
const CheckpointRecord = Schema.Struct({
  messageID: SessionMessage.ID,
  seq: NonNegativeInt,
  payload: Schema.Json,
})
const Requirement = Schema.Struct({ messageID: SessionMessage.ID, kind: Schema.Literals(["input", "compaction"]) })
const Body = Schema.Struct({
  format: Schema.Literal("cybermastery-private-projection/v1"),
  sessionID: SessionSchema.ID,
  workspaceID: Schema.String,
  ownerID: Schema.String,
  sourceSeq: NonNegativeInt,
  events: Schema.Array(Schema.Struct({
    id: EventV2.ID, type: Schema.String, seq: NonNegativeInt, aggregateID: SessionSchema.ID,
    data: Schema.Record(Schema.String, Schema.Json),
  })),
  inputs: Schema.Array(InputRecord),
  checkpoints: Schema.Array(CheckpointRecord),
  requirements: Schema.Array(Requirement),
  epoch: Schema.Struct({ baselineSeq: NonNegativeInt, baseline: Schema.String, snapshot: Schema.Json }).pipe(optional),
})
const Bundle = Schema.Struct({ body: Body, digest: Schema.String })
export type PrivateProjectionBundle = typeof Bundle.Type

export class ProjectionError extends Schema.TaggedErrorClass<ProjectionError>()("CyberMastery.Projection", {
  code: Schema.String,
}) {}

export type ProjectionScope = {
  readonly sessionID: SessionSchema.ID
  readonly workspaceID: string
  readonly ownerID: string
}

const canonical = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, Schema.Json>)[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const projectionDigest = (body: PrivateProjectionBundle["body"]) => hash(canonical(Schema.encodeSync(Body)(body)))
const parseJson = (value: string) => {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (Option.isNone(parsed)) throw new ProjectionError({ code: "invalid-stored-json" })
  return parsed.value
}

/** Full-snapshot proof transport; intentionally not a claim of legacy fork BundleV1 compatibility. */
export function makePrivateProjection(policy: {
  readonly authorize: (scope: ProjectionScope) => Effect.Effect<void, ProjectionError>
}) {
  const requirePlacement = (scope: ProjectionScope) => Effect.gen(function* () {
    if (!scope.workspaceID || !scope.ownerID) return yield* new ProjectionError({ code: "missing-scope" })
    yield* policy.authorize(scope)
    const database = yield* Database.Service
    const session = yield* database.db.get<{ workspace_id: string | null }>(sql`SELECT workspace_id FROM session WHERE id = ${scope.sessionID}`)
    if (!session || session.workspace_id !== scope.workspaceID) return yield* new ProjectionError({ code: "workspace-mismatch" })
    const owner = yield* database.db.get<{ owner_id: string | null }>(sql`SELECT owner_id FROM event_sequence WHERE aggregate_id = ${scope.sessionID}`)
    if (owner?.owner_id && owner.owner_id !== scope.ownerID) return yield* new ProjectionError({ code: "owner-mismatch" })
  })

  const exportBundle = Effect.fn("CyberMastery.exportPrivateProjection")(function* (scope: ProjectionScope) {
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    return yield* boundary.transaction(Effect.gen(function* () {
      yield* requirePlacement(scope)
      const events = yield* database.db.all<{ id: string; type: string; seq: number; data: string }>(sql`
        SELECT id, type, seq, data FROM event WHERE aggregate_id = ${scope.sessionID} ORDER BY seq`)
      if (events.length === 0) return yield* new ProjectionError({ code: "empty-history" })
      const inputs = yield* database.db.all<{
        message_id: string; admitted_seq: number; request_hash: string; api_content: string; api_content_hash: string; renderer_version: number
      }>(sql`SELECT p.*, i.admitted_seq FROM cm_private_input p JOIN session_input i ON i.id = p.message_id
        WHERE p.session_id = ${scope.sessionID} ORDER BY i.admitted_seq`)
      const checkpoints = yield* database.db.all<{ message_id: string; seq: number; context_json: string }>(sql`
        SELECT p.*, m.seq FROM cm_private_checkpoint p JOIN session_message m ON m.id = p.message_id
        WHERE p.session_id = ${scope.sessionID} ORDER BY m.seq`)
      const requirements = yield* database.db.all<{ message_id: string; kind: string }>(sql`
        SELECT message_id, kind FROM cm_private_requirement WHERE session_id = ${scope.sessionID} ORDER BY message_id`)
      const epoch = yield* database.db.get<{ baseline_seq: number; baseline: string; snapshot: string }>(sql`
        SELECT baseline_seq, baseline, snapshot FROM session_context_epoch WHERE session_id = ${scope.sessionID}`)
      const body = yield* Schema.decodeUnknownEffect(Body)({
        format: "cybermastery-private-projection/v1", ...scope, sourceSeq: events.at(-1)?.seq,
        events: events.map((event) => ({ ...event, aggregateID: scope.sessionID, data: parseJson(event.data) })),
        inputs: inputs.map((row) => ({ messageID: row.message_id, admittedSeq: row.admitted_seq, requestHash: row.request_hash, apiContent: row.api_content, apiContentHash: row.api_content_hash, rendererVersion: row.renderer_version })),
        checkpoints: checkpoints.map((row) => ({ messageID: row.message_id, seq: row.seq, payload: parseJson(row.context_json) })),
        requirements: requirements.map((row) => ({ messageID: row.message_id, kind: row.kind })),
        ...(epoch ? { epoch: { baselineSeq: epoch.baseline_seq, baseline: epoch.baseline, snapshot: parseJson(epoch.snapshot) } } : {}),
      }).pipe(Effect.mapError(() => new ProjectionError({ code: "invalid-stored-projection" })))
      yield* validateBody(body)
      return { body, digest: projectionDigest(body) }
    }))
  })

  const restore = Effect.fn("CyberMastery.restorePrivateProjection")(function* (input: {
    readonly bundle: unknown
    readonly scope: ProjectionScope
    /** Supplied by authenticated transfer negotiation, not trusted from the bundle itself. */
    readonly expectedDigest: string
    readonly publish?: boolean
  }) {
    const bundle = yield* Schema.decodeUnknownEffect(Bundle)(input.bundle).pipe(
      Effect.mapError(() => new ProjectionError({ code: "invalid-bundle" })),
    )
    if (bundle.body.sessionID !== input.scope.sessionID || bundle.body.workspaceID !== input.scope.workspaceID || bundle.body.ownerID !== input.scope.ownerID) {
      return yield* new ProjectionError({ code: "scope-mismatch" })
    }
    if (bundle.digest !== input.expectedDigest || projectionDigest(bundle.body) !== bundle.digest) {
      return yield* new ProjectionError({ code: "digest-mismatch" })
    }
    yield* validateBody(bundle.body)
    const boundary = yield* EventBoundary
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    return yield* boundary.transaction(Effect.gen(function* () {
      yield* requirePlacement(input.scope)
      const latest = yield* EventV2.latestSequence(database.db, input.scope.sessionID)
      // This proof accepts full snapshots only. It cannot overwrite a receiver
      // that has advanced or masquerade as the paged legacy transfer protocol.
      if (latest > bundle.body.sourceSeq) return yield* new ProjectionError({ code: "receiver-ahead" })
      yield* events.replayAll(bundle.body.events.map((event) => ({ ...event, data: { ...event.data } })), {
        publish: input.publish, ownerID: input.scope.ownerID, strictOwner: true,
      })
      for (const row of bundle.body.inputs) {
        const visible = yield* database.db.get<{ admitted_seq: number }>(sql`SELECT admitted_seq FROM session_input
          WHERE id = ${row.messageID} AND session_id = ${input.scope.sessionID}`)
        if (visible?.admitted_seq !== row.admittedSeq) return yield* new ProjectionError({ code: "input-relation" })
        const existing = yield* database.db.get<{ request_hash: string; api_content: string; api_content_hash: string; renderer_version: number }>(sql`
          SELECT request_hash, api_content, api_content_hash, renderer_version FROM cm_private_input WHERE message_id = ${row.messageID}`)
        if (existing && (existing.request_hash !== row.requestHash || existing.api_content !== row.apiContent || existing.api_content_hash !== row.apiContentHash || existing.renderer_version !== row.rendererVersion)) {
          return yield* new ProjectionError({ code: "input-conflict" })
        }
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_private_input
          (message_id, session_id, request_hash, api_content, api_content_hash, renderer_version)
          VALUES (${row.messageID}, ${input.scope.sessionID}, ${row.requestHash}, ${row.apiContent}, ${row.apiContentHash}, ${row.rendererVersion})`)
      }
      for (const row of bundle.body.checkpoints) {
        const visible = yield* database.db.get<{ seq: number; summary: string }>(sql`SELECT seq, json_extract(data, '$.summary') AS summary
          FROM session_message WHERE id = ${row.messageID} AND session_id = ${input.scope.sessionID} AND type = 'compaction'`)
        if (visible?.seq !== row.seq || visible.summary !== SENTINEL) return yield* new ProjectionError({ code: "checkpoint-relation" })
        const expected = decodeCheckpoint(row.payload, row.messageID)
        const existing = yield* database.db.get<{ context_json: string }>(sql`SELECT context_json FROM cm_private_checkpoint WHERE message_id = ${row.messageID}`)
        if (existing && canonical(Schema.decodeUnknownSync(Schema.Json)(decodeCheckpoint(existing.context_json, row.messageID))) !== canonical(row.payload)) {
          return yield* new ProjectionError({ code: "checkpoint-conflict" })
        }
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_private_checkpoint (message_id, session_id, context_json)
          VALUES (${row.messageID}, ${input.scope.sessionID}, ${JSON.stringify(expected)})`)
      }
      for (const row of bundle.body.requirements) {
        const existing = yield* database.db.get<{ kind: string; session_id: string }>(sql`SELECT kind, session_id FROM cm_private_requirement WHERE message_id = ${row.messageID}`)
        if (existing && (existing.kind !== row.kind || existing.session_id !== input.scope.sessionID)) return yield* new ProjectionError({ code: "requirement-conflict" })
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_private_requirement (message_id, session_id, kind)
          VALUES (${row.messageID}, ${input.scope.sessionID}, ${row.kind})`)
      }
      const storedRequirements = yield* database.db.all<{ message_id: string; kind: string }>(sql`
        SELECT message_id, kind FROM cm_private_requirement WHERE session_id = ${input.scope.sessionID}`)
      const expectedRequirements = new Set(bundle.body.requirements.map((row) => `${row.kind}:${row.messageID}`))
      if (storedRequirements.length !== expectedRequirements.size || storedRequirements.some((row) => !expectedRequirements.has(`${row.kind}:${row.message_id}`))) {
        return yield* new ProjectionError({ code: "private-manifest-conflict" })
      }
      const storedInputs = yield* database.db.all<{ message_id: string }>(sql`SELECT message_id FROM cm_private_input WHERE session_id = ${input.scope.sessionID}`)
      const storedCheckpoints = yield* database.db.all<{ message_id: string }>(sql`SELECT message_id FROM cm_private_checkpoint WHERE session_id = ${input.scope.sessionID}`)
      if (storedInputs.length !== bundle.body.inputs.length || storedCheckpoints.length !== bundle.body.checkpoints.length) {
        return yield* new ProjectionError({ code: "private-manifest-conflict" })
      }
      const orphan = yield* database.db.get(sql`SELECT id FROM session_message m WHERE m.session_id = ${input.scope.sessionID}
        AND m.type = 'compaction' AND json_extract(m.data, '$.summary') = ${SENTINEL}
        AND NOT EXISTS (SELECT 1 FROM cm_private_checkpoint c WHERE c.message_id = m.id AND c.session_id = m.session_id)`)
      if (orphan) return yield* new ProjectionError({ code: "missing-private-checkpoint" })
      if (bundle.body.epoch) {
        const epoch = bundle.body.epoch
        const existing = yield* database.db.get<{ baseline_seq: number; baseline: string; snapshot: string }>(sql`
          SELECT baseline_seq, baseline, snapshot FROM session_context_epoch WHERE session_id = ${input.scope.sessionID}`)
        if (existing && (existing.baseline_seq !== epoch.baselineSeq || existing.baseline !== epoch.baseline || canonical(Schema.decodeUnknownSync(Schema.Json)(parseJson(existing.snapshot))) !== canonical(epoch.snapshot))) {
          return yield* new ProjectionError({ code: "epoch-conflict" })
        }
        if (!existing) yield* database.db.run(sql`INSERT INTO session_context_epoch (session_id, baseline_seq, baseline, snapshot)
          VALUES (${input.scope.sessionID}, ${epoch.baselineSeq}, ${epoch.baseline}, ${JSON.stringify(epoch.snapshot)})`)
      } else {
        const epoch = yield* database.db.get(sql`SELECT session_id FROM session_context_epoch WHERE session_id = ${input.scope.sessionID}`)
        if (epoch) return yield* new ProjectionError({ code: "epoch-conflict" })
      }
    }))
  })
  return { export: exportBundle, restore }
}

const validateBody = Effect.fn("CyberMastery.validatePrivateProjection")(function* (body: PrivateProjectionBundle["body"]) {
  if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024 * 1024) return yield* new ProjectionError({ code: "transfer-too-large" })
  if (body.events.length !== body.sourceSeq + 1 || new Set(body.events.map((event) => event.id)).size !== body.events.length) {
    return yield* new ProjectionError({ code: "invalid-sequence" })
  }
  for (const [index, event] of body.events.entries()) {
    if (event.seq !== index || event.aggregateID !== body.sessionID) return yield* new ProjectionError({ code: "invalid-sequence" })
    const definition = Durable.get(event.type)
    if (!definition?.durable) return yield* new ProjectionError({ code: "unsupported-event" })
    const decoded = yield* Schema.decodeUnknownEffect(definition.data)(event.data).pipe(Effect.mapError(() => new ProjectionError({ code: "invalid-event" })))
    const encoded = Schema.encodeUnknownSync(definition.data)(decoded)
    if (canonical(Schema.decodeUnknownSync(Schema.Json)(encoded)) !== canonical(event.data)) return yield* new ProjectionError({ code: "lossy-native-codec" })
  }
  const kinds = new Map<string, string>()
  for (const row of body.requirements) {
    if (kinds.has(row.messageID)) return yield* new ProjectionError({ code: "duplicate-requirement" })
    kinds.set(row.messageID, row.kind)
  }
  const payloads = new Set<string>()
  for (const row of body.inputs) {
    if (payloads.has(row.messageID) || kinds.get(row.messageID) !== "input") return yield* new ProjectionError({ code: "input-manifest" })
    if (hash(row.apiContent) !== row.apiContentHash || row.admittedSeq > body.sourceSeq) return yield* new ProjectionError({ code: "input-integrity" })
    const event = body.events[row.admittedSeq]
    if (event?.data.messageID !== row.messageID || !event.type.startsWith("session.next.prompt.admitted")) return yield* new ProjectionError({ code: "input-event" })
    payloads.add(row.messageID)
  }
  for (const row of body.checkpoints) {
    if (payloads.has(row.messageID) || kinds.get(row.messageID) !== "compaction") return yield* new ProjectionError({ code: "checkpoint-manifest" })
    const event = body.events[row.seq]
    if (event?.data.messageID !== row.messageID || event.data.text !== SENTINEL || !event.type.startsWith("session.next.compaction.ended")) return yield* new ProjectionError({ code: "checkpoint-event" })
    yield* Effect.try({ try: () => decodeCheckpoint(row.payload, row.messageID), catch: () => new ProjectionError({ code: "checkpoint-integrity" }) })
    payloads.add(row.messageID)
  }
  if (payloads.size !== kinds.size) return yield* new ProjectionError({ code: "missing-private-context" })
  if (body.epoch) {
    if (body.epoch.baselineSeq > body.sourceSeq) return yield* new ProjectionError({ code: "epoch-sequence" })
    const decoded = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(body.epoch.snapshot).pipe(Effect.mapError(() => new ProjectionError({ code: "invalid-epoch" })))
    if (canonical(Schema.encodeSync(SystemContext.Snapshot)(decoded)) !== canonical(body.epoch.snapshot)) {
      return yield* new ProjectionError({ code: "lossy-epoch-codec" })
    }
  }
})
