import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { SENTINEL } from "./checkpoint"
import { EventBoundary } from "./event-boundary"
import { LegacyBundleError, validateLegacyBundle, type LegacyPublicEvent, type ValidatedLegacyBundle } from "./legacy-bundle"
import { decodeLegacyContext, legacyCanonical, legacyDigest, legacyReferenceHash, type LegacyJson } from "./legacy-context"
import { reconcileLocalDeletions } from "./legacy-deletion"
import { adaptLegacyEvent, LegacyEventError } from "./legacy-event"
import { PrivateRestoreContext } from "./restore-context"

export class LegacyProjectionError extends Schema.TaggedErrorClass<LegacyProjectionError>()("CyberMastery.LegacyProjection", {
  code: Schema.String,
}) {}

export type LegacyScope = {
  readonly sessionID: SessionSchema.ID
  readonly workspaceID?: string
  readonly ownerID: string
}

export const initializeLegacyProjection = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.transaction(() => Effect.gen(function* () {
    yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_migration (id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL)`)
    yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_legacy_event (
      event_id TEXT PRIMARY KEY REFERENCES event(id) ON DELETE CASCADE,
      aggregate_id TEXT NOT NULL, original_json TEXT NOT NULL, native_hash TEXT NOT NULL)`)
    yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_legacy_input (
      message_id TEXT PRIMARY KEY REFERENCES session_input(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, snapshot_json TEXT NOT NULL)`)
    yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_session_runtime (
      session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK(runtime IN ('legacy','v2','mixed')))`)
    yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_legacy_deletion (
      aggregate_id TEXT NOT NULL, target_kind TEXT NOT NULL, message_id TEXT NOT NULL, proof_json TEXT NOT NULL,
      PRIMARY KEY(aggregate_id,target_kind,message_id))`)
    yield* database.db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
      VALUES ('0004-legacy-projection', ${Date.now()})`)
  }))
})

const StoredEvent = Schema.Struct({
  id: Schema.String, type: Schema.String, seq: Schema.Number, aggregateID: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
})

/** Called after native admission returns, but before its owning transaction commits. */
export const recordLegacyInputEvent = (sessionID: SessionSchema.ID, messageID: string, seq: number) => Effect.gen(function* () {
  const database = yield* Database.Service
  const snapshot = yield* database.db.get<{ snapshot_json: string; request_hash: string }>(sql`
    SELECT l.snapshot_json, p.request_hash FROM cm_legacy_input l
    JOIN cm_private_input p ON p.message_id = l.message_id AND p.session_id = l.session_id
    WHERE l.message_id = ${messageID} AND l.session_id = ${sessionID}`)
  // A raced imported retry must keep its exact original field presence.
  if (!snapshot || snapshot.request_hash.startsWith("legacy:")) return
  const row = yield* database.db.get<{ id: string; type: string; seq: number; data: string }>(sql`
    SELECT id, type, seq, data FROM event WHERE aggregate_id = ${sessionID} AND seq = ${seq}`)
  if (!row) return yield* new LegacyProjectionError({ code: "input-relation" })
  const native = Schema.decodeUnknownSync(StoredEvent)({
    id: row.id, type: row.type, seq: row.seq, aggregateID: sessionID, data: parseJson(row.data),
  })
  const prompt = Schema.decodeUnknownSync(Prompt)(native.data.prompt)
  const context = decodeLegacyContext(parseJson(snapshot.snapshot_json), prompt.text)
  if (context.version !== 2) return
  if (native.data.messageID !== messageID) return yield* new LegacyProjectionError({ code: "input-relation" })
  const adapted = adaptLegacyEvent({ ...native, data: { ...native.data, modelContextVersion: 2 } })
  if (legacyCanonical(adapted.native) !== legacyCanonical(native))
    return yield* new LegacyProjectionError({ code: "event-hash-conflict" })
  const original = legacyCanonical(adapted.original)
  const nativeHash = legacyDigest(adapted.native)
  const existing = yield* database.db.get<{ aggregate_id: string; original_json: string; native_hash: string }>(sql`
    SELECT aggregate_id, original_json, native_hash FROM cm_legacy_event WHERE event_id = ${native.id}`)
  if (existing && (existing.aggregate_id !== sessionID || existing.original_json !== original || existing.native_hash !== nativeHash))
    return yield* new LegacyProjectionError({ code: "event-metadata-conflict" })
  if (!existing) yield* database.db.run(sql`INSERT INTO cm_legacy_event (event_id, aggregate_id, original_json, native_hash)
    VALUES (${native.id}, ${sessionID}, ${original}, ${nativeHash})`)
})

/** Compatibility metadata never replaces the native event log as the authority. */
export function makeLegacyProjection(policy: {
  readonly authorize: (scope: LegacyScope) => Effect.Effect<void, LegacyProjectionError>
}) {
  const authorize = (scope: LegacyScope) => Effect.gen(function* () {
    if (!scope.ownerID.trim() || !scope.sessionID || (scope.workspaceID !== undefined && !scope.workspaceID.trim()))
      return yield* new LegacyProjectionError({ code: "missing-scope" })
    yield* policy.authorize(scope)
  })

  const restore = (input: {
    readonly bundle: unknown
    readonly scope: LegacyScope
    readonly expectedDigest: string
    readonly publish?: boolean
  }) => external(Effect.gen(function* () {
    // Detach before the first asynchronous boundary; the integrity check covers
    // exactly the raw BundleV1, not an untrusted embedded digest or normalized DTO.
    const bytes = legacyCanonical(input.bundle)
    const raw = parseJson(bytes)
    if (legacyDigest(raw) !== input.expectedDigest) return yield* new LegacyProjectionError({ code: "digest-mismatch" })
    const scope = { ...input.scope }
    yield* authorize(scope)
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* boundary.transaction(Effect.gen(function* () {
      yield* authorize(scope)
      yield* initializeLegacyProjection
      const retained = yield* readHistory(scope.sessionID)
      const prepared = validateLegacyBundle(raw, retained)
      if (prepared.bundle.aggregateID !== scope.sessionID) return yield* new LegacyProjectionError({ code: "scope-mismatch" })
      const incoming = prepared.bundle.events.map(adaptLegacyEvent)
      yield* requirePlacement(scope, incoming.map((event) => event.native))
      const latest = yield* EventV2.latestSequence(database.db, scope.sessionID)
      if (latest > prepared.bundle.sourceSeq) return yield* new LegacyProjectionError({ code: "receiver-ahead" })
      yield* checkEpochReplacement(scope, prepared, false)
      yield* events.replayAll(incoming.map((event) => event.native), {
        publish: input.publish, ownerID: scope.ownerID, strictOwner: true,
      }).pipe(Effect.provideService(PrivateRestoreContext, { sessionID: scope.sessionID, digest: input.expectedDigest }))
      for (const event of incoming) {
        const original = legacyCanonical(event.original)
        const nativeHash = legacyDigest(event.native)
        const existing = yield* database.db.get<{ aggregate_id: string; original_json: string; native_hash: string }>(sql`
          SELECT aggregate_id, original_json, native_hash FROM cm_legacy_event WHERE event_id = ${event.native.id}`)
        if (existing && (existing.aggregate_id !== scope.sessionID || existing.original_json !== original || existing.native_hash !== nativeHash))
          return yield* new LegacyProjectionError({ code: "event-metadata-conflict" })
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_legacy_event (event_id, aggregate_id, original_json, native_hash)
          VALUES (${event.native.id}, ${scope.sessionID}, ${original}, ${nativeHash})`)
      }
      for (const row of prepared.inputs) {
        yield* requireInputRelation(scope.sessionID, row.envelope.messageID, row.envelope.seq, prepared.history[row.envelope.seq])
        const existing = yield* database.db.get<InputProof>(sql`SELECT * FROM cm_private_input WHERE message_id = ${row.envelope.messageID}`)
        const snapshot = yield* database.db.get<{ session_id: string; snapshot_json: string }>(sql`
          SELECT session_id, snapshot_json FROM cm_legacy_input WHERE message_id = ${row.envelope.messageID}`)
        if (existing && !sameInput(existing, scope.sessionID, row.context, snapshot?.session_id === scope.sessionID ? snapshot.snapshot_json : undefined))
          return yield* new LegacyProjectionError({ code: "input-conflict" })
        if (snapshot && (snapshot.session_id !== scope.sessionID || snapshot.snapshot_json !== row.envelope.payload))
          return yield* new LegacyProjectionError({ code: "snapshot-conflict" })
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_private_input
          (message_id, session_id, request_hash, api_content, api_content_hash, renderer_version)
          VALUES (${row.envelope.messageID}, ${scope.sessionID}, ${"legacy:" + row.context.contextRequestHash},
            ${row.context.apiContent}, ${row.context.apiContentHash}, ${row.context.rendererVersion})`)
        if (!snapshot) yield* database.db.run(sql`INSERT INTO cm_legacy_input (message_id, session_id, snapshot_json)
          VALUES (${row.envelope.messageID}, ${scope.sessionID}, ${row.envelope.payload})`)
      }
      for (const row of prepared.checkpoints) {
        yield* requireCheckpointRelation(scope.sessionID, row.envelope.messageID, row.envelope.seq)
        const existing = yield* database.db.get<{ session_id: string; context_json: string }>(sql`
          SELECT session_id, context_json FROM cm_private_checkpoint WHERE message_id = ${row.envelope.messageID}`)
        if (existing && (existing.session_id !== scope.sessionID || legacyCanonical(parseJson(existing.context_json)) !== row.envelope.payload))
          return yield* new LegacyProjectionError({ code: "checkpoint-conflict" })
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_private_checkpoint (message_id, session_id, context_json)
          VALUES (${row.envelope.messageID}, ${scope.sessionID}, ${row.envelope.payload})`)
      }
      for (const row of prepared.bundle.contexts) {
        const existing = yield* database.db.get<{ session_id: string; kind: string }>(sql`
          SELECT session_id, kind FROM cm_private_requirement WHERE message_id = ${row.messageID}`)
        if (existing && (existing.session_id !== scope.sessionID || existing.kind !== row.kind))
          return yield* new LegacyProjectionError({ code: "requirement-conflict" })
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_private_requirement (message_id, session_id, kind)
          VALUES (${row.messageID}, ${scope.sessionID}, ${row.kind})`)
      }
      for (const proof of prepared.bundle.deletions) {
        const existing = yield* database.db.get<{ proof_json: string }>(sql`SELECT proof_json FROM cm_legacy_deletion
          WHERE aggregate_id = ${scope.sessionID} AND target_kind = ${proof.targetKind} AND message_id = ${proof.targetMessageID}`)
        if (existing && existing.proof_json !== legacyCanonical(proof))
          return yield* new LegacyProjectionError({ code: "deletion-conflict" })
        // The native revert projector already deletes pending inputs by the same
        // admitted/promoted predicate. This targeted delete is an idempotent
        // re-application fenced by the authenticated admission identity; never
        // sweep by sequence.
        if (proof.targetKind === "input") {
          const target = yield* database.db.get<{ session_id: string; admitted_seq: number }>(sql`
            SELECT session_id, admitted_seq FROM session_input WHERE id = ${proof.targetMessageID}`)
          if (target && (target.session_id !== scope.sessionID || target.admitted_seq !== proof.targetEvent.seq))
            return yield* new LegacyProjectionError({ code: "deletion-target-conflict" })
          yield* database.db.run(sql`DELETE FROM session_input WHERE id = ${proof.targetMessageID}
            AND session_id = ${scope.sessionID} AND admitted_seq = ${proof.targetEvent.seq}`)
        }
        if (!existing) yield* database.db.run(sql`INSERT INTO cm_legacy_deletion (aggregate_id, target_kind, message_id, proof_json)
          VALUES (${scope.sessionID}, ${proof.targetKind}, ${proof.targetMessageID}, ${legacyCanonical(proof)})`)
      }
      // Imported clean admissions carry no private context or requirement. Their
      // exact retries must reconcile without freezing, so register the same
      // non-actor legacy clean identity the imported retry convention uses.
      const promptAdmittedType = EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)
      const admittedInputs = yield* database.db.all<{ id: string; admitted_seq: number }>(sql`
        SELECT id, admitted_seq FROM session_input WHERE session_id = ${scope.sessionID}`)
      for (const row of admittedInputs) {
        const event = prepared.history.find((candidate) => candidate.seq === row.admitted_seq)
        // Only an actual native admission may synthesize a clean marker. A V2
        // marker, private context/requirement, deleted target or projected user
        // message without a PromptAdmitted event is never silently clean.
        if (!event || event.type !== promptAdmittedType || event.data.modelContextVersion === 2) continue
        const privateRow = yield* database.db.get<{ message_id: string }>(sql`
          SELECT message_id FROM cm_private_input WHERE message_id = ${row.id} AND session_id = ${scope.sessionID}`)
        if (privateRow) continue
        const requirement = yield* database.db.get<{ message_id: string }>(sql`
          SELECT message_id FROM cm_private_requirement WHERE message_id = ${row.id} AND session_id = ${scope.sessionID}`)
        if (requirement) continue
        yield* requireInputRelation(scope.sessionID, row.id, row.admitted_seq, event)
        // Never rewrite an existing local actor-inclusive clean identity.
        const existing = yield* database.db.get<{ request_hash: string }>(sql`
          SELECT request_hash FROM cm_clean_input WHERE message_id = ${row.id} AND session_id = ${scope.sessionID}`)
        if (existing) continue
        yield* database.db.run(sql`INSERT INTO cm_clean_input (message_id, session_id, request_hash)
          VALUES (${row.id}, ${scope.sessionID}, ${"legacy:" + legacyReferenceHash([])})`)
      }
      if ((yield* EventV2.latestSequence(database.db, scope.sessionID)) !== prepared.bundle.sourceSeq)
        return yield* new LegacyProjectionError({ code: "source-sequence-mismatch" })
      yield* requirePlacement(scope, prepared.history.map((event) => adaptLegacyEvent(event).native), true, true)
      yield* checkEpochReplacement(scope, prepared, true)
      if (prepared.epoch) {
        const epoch = prepared.epoch
        yield* database.db.run(sql`INSERT INTO session_context_epoch (session_id, baseline_seq, baseline, snapshot)
          VALUES (${scope.sessionID}, ${epoch.envelope.baselineSeq}, ${epoch.payload.baseline}, ${legacyCanonical(epoch.payload.snapshot)})
          ON CONFLICT(session_id) DO UPDATE SET baseline_seq = excluded.baseline_seq, baseline = excluded.baseline, snapshot = excluded.snapshot`)
      }
      yield* reconcileRuntime(scope.sessionID, prepared.history, true)
      const history = yield* readHistory(scope.sessionID)
      if (legacyCanonical(history) !== legacyCanonical(prepared.history))
        return yield* new LegacyProjectionError({ code: "event-history-conflict" })
      yield* verifyManifest(scope.sessionID, prepared)
    }))
  }))

  const exportBundle = (input: LegacyScope) => external(Effect.gen(function* () {
    const scope = { ...input }
    yield* authorize(scope)
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    return yield* boundary.transaction(Effect.gen(function* () {
      yield* authorize(scope)
      yield* initializeLegacyProjection
      const history = yield* readHistory(scope.sessionID)
      yield* requirePlacement(scope, history.map((event) => adaptLegacyEvent(event).native), true, true)
      const sourceSeq = yield* EventV2.latestSequence(database.db, scope.sessionID)
      if (sourceSeq < 0) return yield* new LegacyProjectionError({ code: "empty-history" })
      const unsupported = yield* database.db.get(sql`SELECT p.message_id FROM cm_private_input p
        LEFT JOIN cm_legacy_input l ON l.message_id = p.message_id AND l.session_id = p.session_id
        WHERE p.session_id = ${scope.sessionID} AND l.message_id IS NULL`)
      if (unsupported) return yield* new LegacyProjectionError({ code: "unsupported-private-origin" })
      const inputs = yield* database.db.all<{ message_id: string; snapshot_json: string; admitted_seq: number }>(sql`
        SELECT l.message_id, l.snapshot_json, i.admitted_seq FROM cm_legacy_input l
        JOIN session_input i ON i.id = l.message_id AND i.session_id = l.session_id
        WHERE l.session_id = ${scope.sessionID} ORDER BY i.admitted_seq`)
      const checkpoints = yield* database.db.all<{ message_id: string; context_json: string; seq: number }>(sql`
        SELECT p.message_id, p.context_json, m.seq FROM cm_private_checkpoint p
        JOIN session_message m ON m.id = p.message_id AND m.session_id = p.session_id
        WHERE p.session_id = ${scope.sessionID} ORDER BY m.seq`)
      const existingProofs = yield* database.db.all<{ proof_json: string }>(sql`SELECT proof_json FROM cm_legacy_deletion
        WHERE aggregate_id = ${scope.sessionID} ORDER BY json_extract(proof_json, '$.targetEvent.seq')`)
      const nativeInputs = yield* database.db.all<{ id: string; admitted_seq: number; promoted_seq: number | null }>(sql`
        SELECT id, admitted_seq, promoted_seq FROM session_input WHERE session_id = ${scope.sessionID}`)
      const nativeMessages = yield* database.db.all<{ id: string; seq: number }>(sql`
        SELECT id, seq FROM session_message WHERE session_id = ${scope.sessionID}`)
      // A committed native revert removes the row and cascades its private sidecar,
      // so the marker survives in history with no receipt. Derive the missing
      // proofs from that recorded revert effect instead of trusting row absence.
      const deletions = reconcileLocalDeletions({
        aggregateID: scope.sessionID,
        history,
        messages: nativeMessages,
        inputs: nativeInputs.map((row) => row.promoted_seq === null
          ? { id: row.id, admittedSeq: row.admitted_seq }
          : { id: row.id, admittedSeq: row.admitted_seq, promotedSeq: row.promoted_seq }),
        existingProofs: existingProofs.map((row) => row.proof_json),
      })
      const epoch = yield* database.db.get<EpochRow>(sql`SELECT baseline_seq, baseline, snapshot FROM session_context_epoch WHERE session_id = ${scope.sessionID}`)
      const payload = epoch ? { baseline: epoch.baseline, snapshot: parseJson(epoch.snapshot) } : undefined
      const prepared = validateLegacyBundle({
        version: 1, aggregateID: scope.sessionID, sourceSeq, events: history,
        contexts: [
          ...inputs.map((row) => envelope(history, row.admitted_seq, row.message_id, "input", row.snapshot_json)),
          ...checkpoints.map((row) => envelope(history, row.seq, row.message_id, "compaction", row.context_json)),
        ].sort((left, right) => left.seq - right.seq),
        deletions,
        ...(epoch && payload ? { epoch: {
          version: 1, kind: "context-epoch", aggregateID: scope.sessionID, sourceSeq,
          baselineSeq: epoch.baseline_seq, epochSchemaVersion: 1, contentHash: legacyDigest(payload), payload: legacyCanonical(payload),
        } } : {}),
      })
      yield* reconcileRuntime(scope.sessionID, history, false)
      // The compatibility deletion table is also the manifest verifyManifest
      // checks, so a proof derived from a committed native revert must be
      // recorded for the bundle to stay self-consistent. INSERT OR IGNORE keeps
      // every imported receipt byte-identical and only fills genuinely missing
      // rows; the whole write stays inside this owning transaction.
      for (const proof of deletions) {
        yield* database.db.run(sql`INSERT OR IGNORE INTO cm_legacy_deletion (aggregate_id, target_kind, message_id, proof_json)
          VALUES (${scope.sessionID}, ${proof.targetKind}, ${proof.targetMessageID}, ${legacyCanonical(proof)})`)
      }
      yield* verifyManifest(scope.sessionID, prepared)
      return prepared.bundle
    }))
  }))
  return { restore, export: exportBundle }
}

function parseJson(text: string): LegacyJson {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(decoded)) throw new LegacyProjectionError({ code: "stored-json" })
  const json = Schema.decodeUnknownOption(Schema.Json)(decoded.value)
  if (Option.isNone(json)) throw new LegacyProjectionError({ code: "stored-json" })
  return json.value
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function external<A, E, R>(effect: Effect.Effect<A, E, R>) {
  // catchDefect does not turn interruption into an application error.
  return effect.pipe(Effect.catchDefect((error) => Effect.fail(sanitize(error))), Effect.mapError(sanitize))
}

function sanitize(error: unknown) {
  if (error instanceof LegacyProjectionError) return error
  if (error instanceof LegacyBundleError || error instanceof LegacyEventError)
    return new LegacyProjectionError({ code: error.code })
  return new LegacyProjectionError({ code: "projection-failed" })
}

const readHistory = (sessionID: SessionSchema.ID) => Effect.gen(function* () {
  const database = yield* Database.Service
  const rows = yield* database.db.all<{
    id: string; type: string; seq: number; aggregate_id: string; data: string;
    original_json: string | null; native_hash: string | null; metadata_aggregate: string | null;
  }>(sql`SELECT e.*, l.original_json, l.native_hash, l.aggregate_id AS metadata_aggregate FROM event e
    LEFT JOIN cm_legacy_event l ON l.event_id = e.id WHERE e.aggregate_id = ${sessionID} ORDER BY e.seq`)
  return rows.map((row) => {
    const decoded = Schema.decodeUnknownOption(StoredEvent)({
      id: row.id, type: row.type, seq: row.seq, aggregateID: row.aggregate_id, data: parseJson(row.data),
    })
    if (Option.isNone(decoded)) throw new LegacyProjectionError({ code: "stored-event" })
    const actual = adaptLegacyEvent(decoded.value)
    if (legacyCanonical(actual.native) !== legacyCanonical(decoded.value))
      throw new LegacyProjectionError({ code: "non-native-event" })
    if (row.original_json === null) return actual.original
    const original = Schema.decodeUnknownOption(StoredEvent)(parseJson(row.original_json))
    if (Option.isNone(original)) throw new LegacyProjectionError({ code: "stored-metadata" })
    const restored = adaptLegacyEvent(original.value)
    if (row.metadata_aggregate !== sessionID || row.native_hash !== legacyDigest(actual.native) ||
      legacyCanonical(restored.native) !== legacyCanonical(actual.native) || legacyCanonical(restored.original) !== row.original_json)
      throw new LegacyProjectionError({ code: "event-hash-conflict" })
    return restored.original
  })
})

const requirePlacement = (scope: LegacyScope, incoming: readonly EventV2.SerializedEvent[], exactOwner = false, allowDeleted = false) => Effect.gen(function* () {
  const database = yield* Database.Service
  const session = yield* database.db.get<{ workspace_id: string | null }>(sql`SELECT workspace_id FROM session WHERE id = ${scope.sessionID}`)
  if (session && session.workspace_id !== (scope.workspaceID ?? null))
    return yield* new LegacyProjectionError({ code: "workspace-mismatch" })
  if (!session) {
    const definition = SessionV1.Event.Created
    if (!definition.durable) return yield* new LegacyProjectionError({ code: "created-definition" })
    const createdType = EventV2.versionedType(definition.type, definition.durable.version)
    const created = incoming.find((event) => event.type === createdType)
    const info = created?.data.info
    if (!object(info) || info.id !== scope.sessionID || (info.workspaceID ?? undefined) !== scope.workspaceID)
      return yield* new LegacyProjectionError({ code: "missing-session-placement" })
    if (allowDeleted) {
      const deleted = SessionV1.Event.Deleted
      if (!deleted.durable) return yield* new LegacyProjectionError({ code: "deleted-definition" })
      const deletedType = EventV2.versionedType(deleted.type, deleted.durable.version)
      const last = incoming.filter((event) => object(event.data.info)).at(-1)
      const lastInfo = last?.data.info
      if (last?.type !== deletedType || !object(lastInfo) || lastInfo.id !== scope.sessionID || (lastInfo.workspaceID ?? undefined) !== scope.workspaceID)
        return yield* new LegacyProjectionError({ code: "missing-session-placement" })
    }
    if (!allowDeleted) {
      if (typeof info.projectID !== "string") return yield* new LegacyProjectionError({ code: "missing-project" })
      const project = yield* database.db.get(sql`SELECT id FROM project WHERE id = ${info.projectID}`)
      if (!project) return yield* new LegacyProjectionError({ code: "missing-project" })
    }
    // Native replay also enforces the caller-provisioned Project FK.
  }
  const owner = yield* database.db.get<{ owner_id: string | null }>(sql`SELECT owner_id FROM event_sequence WHERE aggregate_id = ${scope.sessionID}`)
  if ((exactOwner || owner?.owner_id != null) && owner?.owner_id !== scope.ownerID)
    return yield* new LegacyProjectionError({ code: "owner-mismatch" })
})

type InputProof = {
  message_id: string; session_id: string; request_hash: string; api_content: string; api_content_hash: string; renderer_version: number;
}
type EpochRow = { baseline_seq: number; baseline: string; snapshot: string }

function sameInput(row: InputProof, sessionID: string, context: ValidatedLegacyBundle["inputs"][number]["context"], snapshot: string | undefined) {
  // A foreign bundle cannot authenticate an actor-inclusive local hash. Local
  // reconciliation instead requires the already-preserved exact snapshot and
  // native prompt/delivery relation, with authorization enforced separately.
  const identity = row.request_hash.startsWith("legacy:")
    ? row.request_hash === "legacy:" + context.contextRequestHash
    : /^[a-f0-9]{64}$/.test(row.request_hash) && snapshot === legacyCanonical(context.snapshot)
  return row.session_id === sessionID && identity &&
    row.api_content === context.apiContent && row.api_content_hash === context.apiContentHash && row.renderer_version === context.rendererVersion
}

const requireInputRelation = (sessionID: string, messageID: string, seq: number, event: LegacyPublicEvent | undefined) => Effect.gen(function* () {
  const database = yield* Database.Service
  const row = yield* SessionInput.find(database.db, SessionMessage.ID.make(messageID))
  if (!row || row.sessionID !== sessionID || row.admittedSeq !== seq || !event)
    return yield* new LegacyProjectionError({ code: "input-relation" })
  const prompt = Schema.decodeUnknownOption(Prompt)(event.data.prompt)
  const delivery = event.data.delivery
  if (Option.isNone(prompt) || (delivery !== "steer" && delivery !== "queue") ||
    !SessionInput.equivalent(row, { sessionID: SessionSchema.ID.make(sessionID), prompt: prompt.value, delivery }))
    return yield* new LegacyProjectionError({ code: "input-relation" })
})

const requireCheckpointRelation = (sessionID: string, messageID: string, seq: number) => Effect.gen(function* () {
  const database = yield* Database.Service
  const row = yield* database.db.get<{ seq: number; summary: string }>(sql`SELECT seq, json_extract(data, '$.summary') AS summary FROM session_message
    WHERE id = ${messageID} AND session_id = ${sessionID} AND type = 'compaction'`)
  if (row?.seq !== seq || row.summary !== SENTINEL) return yield* new LegacyProjectionError({ code: "checkpoint-relation" })
})

const checkEpochReplacement = (scope: LegacyScope, prepared: ValidatedLegacyBundle, final: boolean) => Effect.gen(function* () {
  const database = yield* Database.Service
  const stored = yield* database.db.get<EpochRow>(sql`SELECT baseline_seq, baseline, snapshot FROM session_context_epoch WHERE session_id = ${scope.sessionID}`)
  if (!stored) return
  const epoch = prepared.epoch
  // No source epoch is not a tombstone. Fail without erasing receiver state.
  if (!epoch) return yield* new LegacyProjectionError({ code: "absent-source-epoch" })
  if (stored.baseline_seq === epoch.envelope.baselineSeq && stored.baseline === epoch.payload.baseline &&
    legacyCanonical(parseJson(stored.snapshot)) === legacyCanonical(epoch.payload.snapshot)) return
  if (scope.workspaceID === undefined) return yield* new LegacyProjectionError({ code: "epoch-replacement-scope" })
  yield* requirePlacement(scope, [], true)
  const latest = yield* EventV2.latestSequence(database.db, scope.sessionID)
  if (latest > prepared.bundle.sourceSeq || (final && latest !== prepared.bundle.sourceSeq))
    return yield* new LegacyProjectionError({ code: "epoch-replacement-sequence" })
})

const reconcileRuntime = (sessionID: SessionSchema.ID, history: readonly LegacyPublicEvent[], write: boolean) => Effect.gen(function* () {
  const database = yield* Database.Service
  const classifications = new Set(history.flatMap((event) => {
    const runtime = adaptLegacyEvent(event).metadata.runtime
    return runtime === undefined ? [] : [runtime]
  }))
  if (classifications.size > 1) return yield* new LegacyProjectionError({ code: "runtime-conflict" })
  const runtime = [...classifications][0]
  const stored = yield* database.db.get<{ runtime: string }>(sql`SELECT runtime FROM cm_session_runtime WHERE session_id = ${sessionID}`)
  if (stored && stored.runtime !== runtime) return yield* new LegacyProjectionError({ code: "runtime-conflict" })
  if (runtime !== undefined && !stored) {
    const session = yield* database.db.get(sql`SELECT id FROM session WHERE id = ${sessionID}`)
    // Deleted projections have no runtime row; their authenticated lifecycle
    // events retain the classification without adding a historical Session FK.
    if (!session) return
    if (!write) return yield* new LegacyProjectionError({ code: "missing-runtime" })
    yield* database.db.run(sql`INSERT INTO cm_session_runtime (session_id, runtime) VALUES (${sessionID}, ${runtime})`)
  }
})

function envelope(history: readonly LegacyPublicEvent[], seq: number, messageID: string, kind: "input" | "compaction", bytes: string) {
  const event = history.find((event) => event.seq === seq)
  const payload = parseJson(bytes)
  if (!event || !object(payload) || typeof payload.version !== "number") throw new LegacyProjectionError({ code: "context-relation" })
  return {
    version: 1, eventID: event.id, aggregateID: event.aggregateID, seq, eventType: event.type, eventDataHash: legacyDigest(event.data),
    messageID, kind, sidecarSchemaVersion: payload.version, contentHash: legacyDigest(payload), payload: legacyCanonical(payload),
  }
}

const verifyManifest = (sessionID: SessionSchema.ID, prepared: ValidatedLegacyBundle) => Effect.gen(function* () {
  const database = yield* Database.Service
  const requirements = yield* database.db.all<{ message_id: string; kind: string }>(sql`SELECT message_id, kind FROM cm_private_requirement WHERE session_id = ${sessionID}`)
  const expected = new Set(prepared.bundle.contexts.map((row) => `${row.kind}:${row.messageID}`))
  if (requirements.length !== expected.size || requirements.some((row) => !expected.has(`${row.kind}:${row.message_id}`)))
    return yield* new LegacyProjectionError({ code: "private-manifest-conflict" })
  const inputs = yield* database.db.all<InputProof>(sql`SELECT * FROM cm_private_input WHERE session_id = ${sessionID}`)
  const snapshots = yield* database.db.all<{ message_id: string; snapshot_json: string }>(sql`SELECT message_id, snapshot_json FROM cm_legacy_input WHERE session_id = ${sessionID}`)
  const checkpoints = yield* database.db.all<{ message_id: string; context_json: string }>(sql`SELECT message_id, context_json FROM cm_private_checkpoint WHERE session_id = ${sessionID}`)
  if (inputs.length !== prepared.inputs.length || snapshots.length !== prepared.inputs.length || checkpoints.length !== prepared.checkpoints.length)
    return yield* new LegacyProjectionError({ code: "private-manifest-conflict" })
  for (const row of prepared.inputs) {
    yield* requireInputRelation(sessionID, row.envelope.messageID, row.envelope.seq, prepared.history[row.envelope.seq])
    const input = inputs.find((input) => input.message_id === row.envelope.messageID)
    const snapshot = snapshots.find((snapshot) => snapshot.message_id === row.envelope.messageID)?.snapshot_json
    if (!input || !sameInput(input, sessionID, row.context, snapshot) || snapshot !== row.envelope.payload)
      return yield* new LegacyProjectionError({ code: "input-conflict" })
  }
  for (const row of prepared.checkpoints) {
    yield* requireCheckpointRelation(sessionID, row.envelope.messageID, row.envelope.seq)
    const checkpoint = checkpoints.find((checkpoint) => checkpoint.message_id === row.envelope.messageID)
    if (!checkpoint || legacyCanonical(parseJson(checkpoint.context_json)) !== row.envelope.payload)
      return yield* new LegacyProjectionError({ code: "checkpoint-conflict" })
  }
  const orphan = yield* database.db.get(sql`SELECT id FROM session_message m WHERE m.session_id = ${sessionID}
    AND m.type = 'compaction' AND json_extract(m.data, '$.summary') = ${SENTINEL}
    AND NOT EXISTS (SELECT 1 FROM cm_private_checkpoint c WHERE c.message_id = m.id AND c.session_id = m.session_id)`)
  if (orphan) return yield* new LegacyProjectionError({ code: "missing-private-checkpoint" })
  const proofs = yield* database.db.all<{ target_kind: string; message_id: string; proof_json: string }>(sql`
    SELECT target_kind, message_id, proof_json FROM cm_legacy_deletion WHERE aggregate_id = ${sessionID}`)
  if (proofs.length !== prepared.bundle.deletions.length || proofs.some((row) => !prepared.bundle.deletions.some((proof) =>
    proof.targetKind === row.target_kind && proof.targetMessageID === row.message_id && legacyCanonical(proof) === row.proof_json)))
    return yield* new LegacyProjectionError({ code: "deletion-manifest-conflict" })
  for (const proof of prepared.bundle.deletions) {
    const remaining = proof.targetKind === "input"
      ? yield* database.db.get(sql`SELECT id FROM session_input WHERE id = ${proof.targetMessageID}
          UNION ALL SELECT id FROM session_message WHERE id = ${proof.targetMessageID}`)
      : yield* database.db.get(sql`SELECT id FROM session_message WHERE id = ${proof.targetMessageID}`)
    const privateRow = yield* database.db.get(sql`SELECT message_id FROM cm_private_requirement WHERE message_id = ${proof.targetMessageID}
      UNION ALL SELECT message_id FROM cm_private_input WHERE message_id = ${proof.targetMessageID}
      UNION ALL SELECT message_id FROM cm_private_checkpoint WHERE message_id = ${proof.targetMessageID}
      UNION ALL SELECT message_id FROM cm_legacy_input WHERE message_id = ${proof.targetMessageID}`)
    if (remaining || privateRow) return yield* new LegacyProjectionError({ code: "deleted-target-present" })
  }
})
