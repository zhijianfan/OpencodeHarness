import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Effect, Option, Schema } from "effect"
import { SENTINEL } from "./checkpoint"
import { EventBoundary } from "./event-boundary"
import { adaptLegacyEvent, LegacyEventError } from "./legacy-event"
import { LegacyBundleError, validateLegacyBundle, type LegacyPublicEvent } from "./legacy-bundle"
import { legacyCanonical, legacyDigest } from "./legacy-context"
import { LegacyProjectionError, makeLegacyProjection, type LegacyScope } from "./legacy-projection"

/**
 * Representative offline fork-copy upgrade. This is deliberately not a full
 * product-data migration: only copied Session histories that already carry a
 * complete native private manifest are accepted, and source histories that
 * would need deleted-target reconstruction are rejected instead of guessed.
 */

const MAX_IMAGE_BYTES = 512 * 1024 * 1024
const MAX_SCOPES = 128
const DIGEST_PREFIX = "sha256:"
const admittedType = EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)
const compactionType = EventV2.versionedType(SessionEvent.Compaction.Ended.type, 1)

/** The declared fork schema. Any missing table/column fails the whole copy. */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: ["id", "runtime", "project_id", "workspace_id"],
  session_input: ["id", "session_id", "prompt", "delivery", "admitted_seq", "context_snapshot_json"],
  session_message: ["id", "session_id", "type", "seq", "data", "model_context_json"],
  event: ["id", "aggregate_id", "seq", "type", "data"],
  event_sequence: ["aggregate_id", "seq", "owner_id"],
  session_context_epoch: ["session_id", "baseline_seq", "baseline", "snapshot"],
}

const StoredEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  seq: Schema.Number,
  aggregateID: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
})
const decodeStoredEvent = Schema.decodeUnknownOption(StoredEvent)
const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeJsonValue = Schema.decodeUnknownOption(Schema.Json)

export type ForkSessionCopyResult = {
  readonly sessions: number
  readonly inputs: number
  readonly checkpoints: number
}

type ContextEnvelope = {
  readonly version: 1
  readonly eventID: string
  readonly aggregateID: string
  readonly seq: number
  readonly eventType: string
  readonly eventDataHash: string
  readonly messageID: string
  readonly kind: "input" | "compaction"
  readonly sidecarSchemaVersion: number
  readonly contentHash: string
  readonly payload: string
}

type EpochEnvelope = {
  readonly version: 1
  readonly kind: "context-epoch"
  readonly aggregateID: string
  readonly sourceSeq: number
  readonly baselineSeq: number
  readonly epochSchemaVersion: 1
  readonly contentHash: string
  readonly payload: string
}

type SourceBundle = {
  readonly bundle: unknown
  readonly sessionID: string
  readonly inputs: number
  readonly checkpoints: number
}

type SourceSessionRow = { readonly runtime: string; readonly workspace_id: string | null }
type SourceSequenceRow = { readonly seq: number; readonly owner_id: string | null }
type SourceEventRow = { readonly id: string; readonly aggregate_id: string; readonly seq: number; readonly type: string; readonly data: string }
type SourceInputRow = {
  readonly id: string
  readonly prompt: string
  readonly delivery: string
  readonly admitted_seq: number
  readonly context_snapshot_json: string | null
}
type SourceMessageRow = { readonly id: string; readonly type: string; readonly seq: number; readonly model_context_json: string | null }
type SourceEpochRow = { readonly baseline_seq: number; readonly baseline: string; readonly snapshot: string }

export function makeForkSessionCopy(policy: {
  readonly authorize: (scope: LegacyScope) => Effect.Effect<void, LegacyProjectionError>
}): {
  readonly restore: (input: {
    readonly bytes: Uint8Array
    readonly expectedDigest: string
    readonly scopes: readonly LegacyScope[]
  }) => Effect.Effect<ForkSessionCopyResult, LegacyProjectionError, Database.Service | EventV2.Service | EventBoundary>
} {
  const projection = makeLegacyProjection(policy)

  const authorize = (scope: LegacyScope) => Effect.gen(function* () {
    if (!scope.ownerID.trim() || !scope.sessionID || (scope.workspaceID !== undefined && !scope.workspaceID.trim()))
      return yield* new LegacyProjectionError({ code: "missing-scope" })
    yield* policy.authorize(scope)
  })

  const restore = (input: {
    readonly bytes: Uint8Array
    readonly expectedDigest: string
    readonly scopes: readonly LegacyScope[]
  }) => Effect.gen(function* () {
    // Detach every caller-owned reference before the first asynchronous boundary.
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) return yield* new LegacyProjectionError({ code: "image-too-large" })
    const image = new Uint8Array(input.bytes)
    const expectedDigest = input.expectedDigest
    const bySession = new Map<string, LegacyScope>()
    for (const scope of input.scopes) {
      const existing = bySession.get(scope.sessionID)
      if (existing && (existing.ownerID !== scope.ownerID || existing.workspaceID !== scope.workspaceID))
        return yield* new LegacyProjectionError({ code: "conflicting-scope" })
      if (!existing) bySession.set(scope.sessionID, { ...scope })
    }
    const scopes = [...bySession.values()]
    if (scopes.length === 0) return yield* new LegacyProjectionError({ code: "missing-scope" })
    if (scopes.length > MAX_SCOPES) return yield* new LegacyProjectionError({ code: "too-many-scopes" })
    // The digest covers the exact copied bytes and is checked before the image
    // is opened or queried, so a mismatched copy never discloses any content.
    if (!expectedDigest.startsWith(DIGEST_PREFIX) || `${DIGEST_PREFIX}${sha256(image)}` !== expectedDigest)
      return yield* new LegacyProjectionError({ code: "digest-mismatch" })
    // No source byte is disclosed before every selected scope is authorized.
    for (const scope of scopes) yield* authorize(scope)
    const bundles = yield* Effect.tryPromise({
      try: () => readSourceImage(image, scopes),
      catch: sanitizeError,
    })
    const boundary = yield* EventBoundary
    const result = yield* boundary.transaction(Effect.gen(function* () {
      // Recheck authorization inside the single target boundary before commit.
      for (const scope of scopes) yield* authorize(scope)
      let inputs = 0
      let checkpoints = 0
      for (const [index, source] of bundles.entries()) {
        const scope = scopes[index]
        if (scope === undefined) return yield* new LegacyProjectionError({ code: "source-read" })
        yield* projection.restore({
          bundle: source.bundle,
          scope,
          expectedDigest: legacyDigest(source.bundle),
          publish: true,
        })
        inputs += source.inputs
        checkpoints += source.checkpoints
      }
      for (const scope of scopes) yield* authorize(scope)
      return { sessions: bundles.length, inputs, checkpoints }
    })).pipe(
      Effect.catchDefect((error) => Effect.fail(sanitizeError(error))),
      Effect.mapError(sanitizeError),
    )
    return result
  })

  return { restore }
}

async function readSourceImage(bytes: Uint8Array, scopes: readonly LegacyScope[]): Promise<readonly SourceBundle[]> {
  // The isolated reader owns a private binding so the imported native Database
  // namespace in the Effect function is never shadowed or aliased.
  const { Database } = await import("bun:sqlite")
  const image = Buffer.from(bytes)
  // Serialized WAL snapshots contain all pages, but SQLite's in-memory
  // deserializer cannot open a WAL journal. Adapt only the private reader's
  // header; the independently hashed source image remains byte-for-byte intact.
  if (image.subarray(0, 16).toString() === "SQLite format 3\0" && image[18] === 2 && image[19] === 2) {
    image[18] = 1
    image[19] = 1
  }
  const source = Database.deserialize(image)
  try {
    source.run("PRAGMA query_only = ON")
    for (const table of Object.keys(REQUIRED_COLUMNS)) {
      const required = REQUIRED_COLUMNS[table]
      const names = new Set(source.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((row) => row.name))
      if (required === undefined || required.some((column) => !names.has(column)))
        throw new LegacyProjectionError({ code: "unsupported-source-schema" })
    }
    return scopes.map((scope) => readSourceSession(source, scope))
  } finally {
    source.close(true)
  }
}

function readSourceSession(source: InstanceType<(typeof import("bun:sqlite"))["Database"]>, scope: LegacyScope): SourceBundle {
  const session = source.query<SourceSessionRow, [string]>(
    "SELECT runtime, workspace_id FROM session WHERE id = ?").all(scope.sessionID)[0]
  if (!session) throw new LegacyProjectionError({ code: "missing-source-session" })
  if (session.runtime !== "legacy" && session.runtime !== "v2" && session.runtime !== "mixed")
    throw new LegacyProjectionError({ code: "unsupported-runtime" })
  if (session.workspace_id !== (scope.workspaceID ?? null))
    throw new LegacyProjectionError({ code: "workspace-mismatch" })

  const sequence = source.query<SourceSequenceRow, [string]>(
    "SELECT seq, owner_id FROM event_sequence WHERE aggregate_id = ?").all(scope.sessionID)[0]
  if (!sequence) throw new LegacyProjectionError({ code: "missing-source-sequence" })
  if (sequence.owner_id !== scope.ownerID) throw new LegacyProjectionError({ code: "owner-mismatch" })
  if (!Number.isSafeInteger(sequence.seq) || sequence.seq < 0)
    throw new LegacyProjectionError({ code: "incomplete-history" })

  const history = source.query<SourceEventRow, [string]>(
    "SELECT id, aggregate_id, seq, type, data FROM event WHERE aggregate_id = ? ORDER BY seq")
    .all(scope.sessionID).map(decodeSourceEvent)
  if (history.length !== sequence.seq + 1 || history.some((event, index) => event.seq !== index))
    throw new LegacyProjectionError({ code: "incomplete-history" })

  const inputs = source.query<SourceInputRow, [string]>(
    "SELECT id, prompt, delivery, admitted_seq, context_snapshot_json FROM session_input WHERE session_id = ? ORDER BY admitted_seq")
    .all(scope.sessionID)
  const messages = source.query<SourceMessageRow, [string]>(
    "SELECT id, type, seq, model_context_json FROM session_message WHERE session_id = ? ORDER BY seq")
    .all(scope.sessionID)
  const epochs = source.query<SourceEpochRow, [string]>(
    "SELECT baseline_seq, baseline, snapshot FROM session_context_epoch WHERE session_id = ?").all(scope.sessionID)

  requireRuntime(session.runtime, history)

  const inputBySequence = new Map(inputs.map((row) => [row.admitted_seq, row]))
  const messageByID = new Map(messages.map((row) => [row.id, row]))
  const claimedInputs = new Set<string>()
  const claimedMessages = new Set<string>()
  const contexts: ContextEnvelope[] = []

  for (const event of history) {
    if (event.type === admittedType) {
      const input = inputBySequence.get(event.seq)
      const marker = event.data.modelContextVersion === 2
      const snapshotText = input?.context_snapshot_json ?? null
      if (!marker && snapshotText === null) continue
      // A private admission without its copied private row needs deleted-target
      // reconstruction, which this representative importer refuses to invent.
      if (!input) throw new LegacyProjectionError({ code: "unsupported-deleted-target" })
      if (snapshotText === null) throw new LegacyProjectionError({ code: "unsupported-missing-context" })
      const snapshot = parseJson(snapshotText)
      if (isPendingContext(snapshot)) throw new LegacyProjectionError({ code: "unsupported-pending-context" })
      contexts.push(contextEnvelope(event, input.id, "input", requireVersion(snapshot), snapshot))
      claimedInputs.add(input.id)
      continue
    }
    if (event.type === compactionType && event.data.text === SENTINEL) {
      const messageID = event.data.messageID
      if (typeof messageID !== "string") throw new LegacyProjectionError({ code: "stored-event" })
      const message = messageByID.get(messageID)
      if (!message) throw new LegacyProjectionError({ code: "unsupported-deleted-target" })
      if (message.model_context_json === null)
        throw new LegacyProjectionError({ code: "unsupported-missing-checkpoint" })
      const checkpoint = parseJson(message.model_context_json)
      contexts.push(contextEnvelope(event, messageID, "compaction", requireVersion(checkpoint), checkpoint))
      claimedMessages.add(messageID)
    }
  }

  // Every copied private row must be accounted for by a copied public event.
  for (const input of inputs) {
    if (input.context_snapshot_json !== null && !claimedInputs.has(input.id))
      throw new LegacyProjectionError({ code: "orphan-private-context" })
  }
  for (const message of messages) {
    if (message.type === "compaction" && message.model_context_json !== null && !claimedMessages.has(message.id))
      throw new LegacyProjectionError({ code: "orphan-private-context" })
  }

  // Clean native inputs must still match their public admission exactly.
  for (const input of inputs) {
    const event = history.find((candidate) => candidate.seq === input.admitted_seq)
    if (!event || event.type !== admittedType) throw new LegacyProjectionError({ code: "input-relation" })
    if (event.data.messageID !== input.id || legacyCanonical(parseJson(input.prompt)) !== legacyCanonical(event.data.prompt) ||
      input.delivery !== event.data.delivery)
      throw new LegacyProjectionError({ code: "input-relation" })
  }

  const epoch = makeEpoch(scope.sessionID, sequence.seq, epochs[0])
  const bundle = {
    version: 1,
    aggregateID: scope.sessionID,
    sourceSeq: sequence.seq,
    events: history,
    contexts,
    deletions: [],
    ...(epoch === undefined ? {} : { epoch }),
  }
  try {
    validateLegacyBundle(bundle)
  } catch (error) {
    throw sanitizeError(error)
  }
  return { bundle, sessionID: scope.sessionID, inputs: claimedInputs.size, checkpoints: claimedMessages.size }
}

function decodeSourceEvent(row: SourceEventRow): LegacyPublicEvent {
  const decoded = decodeStoredEvent({
    id: row.id,
    type: row.type,
    seq: row.seq,
    aggregateID: row.aggregate_id,
    data: parseJson(row.data),
  })
  if (Option.isNone(decoded)) throw new LegacyProjectionError({ code: "stored-event" })
  return decoded.value
}

function parseJson(text: string): unknown {
  const decoded = decodeJsonString(text)
  if (Option.isNone(decoded)) throw new LegacyProjectionError({ code: "stored-json" })
  const json = decodeJsonValue(decoded.value)
  if (Option.isNone(json)) throw new LegacyProjectionError({ code: "stored-json" })
  return json.value
}

function requireRuntime(declared: string, history: readonly LegacyPublicEvent[]): void {
  const classifications = new Set<string>()
  for (const event of history) {
    let runtime: string | undefined
    try {
      runtime = adaptLegacyEvent(event).metadata.runtime
    } catch {
      throw new LegacyProjectionError({ code: "event-metadata" })
    }
    if (runtime !== undefined) classifications.add(runtime)
  }
  // A missing or ambiguous classification is never inferred from the column.
  if (classifications.size === 0) throw new LegacyProjectionError({ code: "missing-runtime" })
  if (classifications.size > 1) throw new LegacyProjectionError({ code: "runtime-conflict" })
  if ([...classifications][0] !== declared) throw new LegacyProjectionError({ code: "runtime-conflict" })
}

function contextEnvelope(
  event: LegacyPublicEvent,
  messageID: string,
  kind: "input" | "compaction",
  sidecarSchemaVersion: number,
  payload: unknown,
): ContextEnvelope {
  return {
    version: 1,
    eventID: event.id,
    aggregateID: event.aggregateID,
    seq: event.seq,
    eventType: event.type,
    eventDataHash: legacyDigest(event.data),
    messageID,
    kind,
    sidecarSchemaVersion,
    contentHash: legacyDigest(payload),
    payload: legacyCanonical(payload),
  }
}

function makeEpoch(sessionID: string, sourceSeq: number, row: SourceEpochRow | undefined): EpochEnvelope | undefined {
  if (row === undefined) return undefined
  if (!Number.isSafeInteger(row.baseline_seq) || row.baseline_seq < 0 || row.baseline_seq > sourceSeq)
    throw new LegacyProjectionError({ code: "epoch-identity" })
  const payload = { baseline: row.baseline, snapshot: parseJson(row.snapshot) }
  return {
    version: 1,
    kind: "context-epoch",
    aggregateID: sessionID,
    sourceSeq,
    baselineSeq: row.baseline_seq,
    epochSchemaVersion: 1,
    contentHash: legacyDigest(payload),
    payload: legacyCanonical(payload),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireVersion(value: unknown): number {
  if (!isRecord(value)) throw new LegacyProjectionError({ code: "context-schema" })
  const version = value.version
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
    throw new LegacyProjectionError({ code: "context-schema" })
  return version
}

function isPendingContext(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.state === "pending" && value.version === 2 && Object.keys(value).length === 2
}

function sanitizeError(error: unknown): LegacyProjectionError {
  if (error instanceof LegacyProjectionError) return error
  if (error instanceof LegacyBundleError || error instanceof LegacyEventError)
    return new LegacyProjectionError({ code: error.code })
  return new LegacyProjectionError({ code: "source-read" })
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
