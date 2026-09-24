import { createHmac, randomBytes } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary, type EventBoundaryInterface } from "./event-boundary"
import type { LegacyBundle } from "./legacy-bundle"
import { initializeLegacyProjection, LegacyProjectionError, makeLegacyProjection } from "./legacy-projection"
import {
  MAX_ACTIVE_TRANSFERS,
  MAX_SYNC_PAGE_BYTES,
  MAX_SYNC_PUBLIC_EVENTS,
  MAX_SYNC_RECORD_CHUNKS,
  MAX_TOTAL_SPOOL_BYTES,
  MAX_TRANSFER_BYTES,
  canonical,
  digest,
  manifestDigest,
  privateManifest,
  type ChunkSyncRecord,
  type CompleteSyncRecord,
  type SyncPage,
} from "./transfer-spool"
import {
  TransferError,
  TransferHistoryRequest,
  type TransferHistoryResponse,
  type TransferPolicy,
  type TransferScope,
} from "./transfer-protocol"

/** The bounded history endpoint surface. Every method already has its native services provided. */
export type TransferSource = {
  readonly history: (payload: unknown) => Effect.Effect<TransferHistoryResponse, TransferError>
  readonly required: Effect.Effect<boolean, TransferError>
  readonly dispose: Effect.Effect<void>
}

type TransferCode = "invalid" | "forbidden" | "conflict" | "restart" | "snapshot-advanced" | "version" | "too-large" | "busy" | "expired"

const MAX_SYNC_AGGREGATES = 128
const SNAPSHOT_TTL = 5 * 60 * 1000
const CHUNK_BYTES = 32 * 1024
const TRANSFER_CODES = new Set<TransferCode>([
  "invalid",
  "forbidden",
  "conflict",
  "restart",
  "snapshot-advanced",
  "version",
  "too-large",
  "busy",
  "expired",
])

type Manifest = ReturnType<typeof privateManifest>

type SourceSnapshot = {
  readonly token: string
  readonly binding: string
  readonly expiresAt: number
  readonly bytes: number
  readonly highWater: Record<string, number>
  readonly manifests: Manifest[]
  readonly manifestDigest: string
  readonly records: CompleteSyncRecord[]
  readonly frozen: Record<string, LegacyBundle>
  readonly discoveryCursor?: string
  /** Set once a terminal DATA page has been handed out; only completed snapshots are evictable. */
  completed: boolean
}

type SnapshotDeps = {
  readonly database: Database.Interface
  readonly boundary: EventBoundaryInterface
  readonly projection: ReturnType<typeof makeLegacyProjection>
  readonly scope: TransferScope
  readonly now: () => number
}

type PageOutcome =
  | { readonly ok: true; readonly page: SyncPage; readonly nextCursor?: string }
  | { readonly ok: false; readonly error: TransferError }

/**
 * Bounded source history transport. The trusted scope and authorization callback are detached and
 * frozen at construction; every returned method already carries the native database and event
 * boundary it needs, so a caller only resolves the constructor environment once.
 */
export function makeTransferSource(
  options: TransferPolicy & {
    readonly now?: () => number
    readonly maxSnapshots?: number
    readonly maxSnapshotBytes?: number
    readonly maxTotalSnapshotBytes?: number
  },
) {
  return Effect.gen(function* () {
    const scope: TransferScope = Object.freeze({ ...options.scope })
    if (!scope.principalID.trim() || !scope.ownerID.trim() || !scope.projectID.trim() || !scope.directory.trim())
      return yield* new TransferError({ code: "invalid", message: "missing transfer scope" })
    if (scope.workspaceID !== undefined && !scope.workspaceID.trim())
      return yield* new TransferError({ code: "invalid", message: "missing transfer workspace" })

    const now = options.now ?? Date.now
    const maxSnapshots = options.maxSnapshots ?? MAX_ACTIVE_TRANSFERS
    const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_TRANSFER_BYTES
    const maxTotalSnapshotBytes = options.maxTotalSnapshotBytes ?? MAX_TOTAL_SPOOL_BYTES
    // Instance-local key: a signed page cursor from another source can never validate here.
    const cursorKey = randomBytes(32)
    const snapshots = new Map<string, SourceSnapshot>()
    let disposed = false

    const database = yield* Database.Service
    const boundary = yield* EventBoundary
    yield* initializeLegacyProjection.pipe(Effect.mapError(toTransferError))

    const projection = makeLegacyProjection({
      authorize: () =>
        options.authorize(scope, "history").pipe(Effect.mapError((error) => new LegacyProjectionError({ code: error.code }))),
    })
    const deps: SnapshotDeps = { database, boundary, projection, scope, now }

    const requireActive = (): Effect.Effect<void, TransferError> =>
      disposed ? Effect.fail(new TransferError({ code: "conflict", message: "transfer source disposed" })) : Effect.void

    const cleanup = () => {
      const at = now()
      for (const [token, snapshot] of snapshots) if (snapshot.expiresAt <= at) snapshots.delete(token)
    }

    const totalBytes = () => [...snapshots.values()].reduce((sum, item) => sum + item.bytes, 0)
    /**
     * Bounded-cache policy: finished snapshots are disposable, unfinished ones never are. Map
     * iteration preserves insertion order, so the oldest completed snapshot is reclaimed first.
     */
    const evictCompleted = (satisfied: () => boolean) => {
      if (satisfied()) return
      for (const [token, snapshot] of [...snapshots]) {
        if (!snapshot.completed) continue
        snapshots.delete(token)
        if (satisfied()) return
      }
    }

    const history = (payload: unknown): Effect.Effect<TransferHistoryResponse, TransferError> =>
      Effect.gen(function* () {
        yield* requireActive()
        // Decode strictly, then detach before the first await so later caller mutation cannot
        // reach the trusted request graph.
        const decoded = Schema.decodeUnknownOption(TransferHistoryRequest, { onExcessProperty: "error" })(payload)
        if (Option.isNone(decoded)) return yield* new TransferError({ code: "invalid", message: "invalid history request" })
        const request = detach(decoded.value)
        yield* options.authorize(scope, "history")
        const binding = canonical({
          principalID: scope.principalID,
          ownerID: scope.ownerID,
          projectID: scope.projectID,
          workspaceID: scope.workspaceID ?? null,
          directory: scope.directory,
          aggregates: request.aggregates,
          discoveryCursor: request.discoveryCursor ?? null,
          repairCursor: request.repairCursor ?? null,
        })
        cleanup()
        const existing = request.sourceSnapshotToken === undefined ? undefined : snapshots.get(request.sourceSnapshotToken)
        if (request.pageCursor !== undefined && request.sourceSnapshotToken === undefined)
          return yield* new TransferError({ code: "invalid", message: "page cursor requires a snapshot token" })
        if (request.sourceSnapshotToken !== undefined && (existing === undefined || existing.binding !== binding))
          return yield* new TransferError({ code: "restart", message: "source snapshot expired or request changed" })
        if (existing === undefined) {
          // Finished snapshots are disposable; reclaim them before refusing admission.
          evictCompleted(() => snapshots.size < maxSnapshots)
          if (snapshots.size >= maxSnapshots)
            return yield* new TransferError({ code: "busy", message: "too many active source snapshots" })
        }
        const snapshot = existing ?? (yield* boundary.transaction(Effect.gen(function* () {
          yield* requireActive()
          yield* options.authorize(scope, "history")
          return yield* createSnapshot(deps, request, binding)
        })).pipe(Effect.mapError(toTransferError)))
        if (existing !== undefined) {
          yield* validateSnapshot(deps, existing)
          // Authorization and re-export may have been slow; never disclose an expired snapshot.
          if (existing.expiresAt <= now()) {
            snapshots.delete(existing.token)
            return yield* new TransferError({ code: "expired", message: "source snapshot expired" })
          }
        } else {
          yield* requireActive()
          cleanup()
          // Awaited export may have raced another admission: recheck count and bytes before storing.
          evictCompleted(() => snapshots.size < maxSnapshots)
          if (snapshots.size >= maxSnapshots)
            return yield* new TransferError({ code: "busy", message: "too many active source snapshots" })
          if (snapshot.bytes > maxSnapshotBytes)
            return yield* new TransferError({ code: "too-large", message: "source snapshot exceeds byte budget" })
          evictCompleted(() => totalBytes() + snapshot.bytes <= maxTotalSnapshotBytes)
          if (totalBytes() + snapshot.bytes > maxTotalSnapshotBytes)
            return yield* new TransferError({ code: "too-large", message: "source snapshots exceed total byte budget" })
          snapshots.set(snapshot.token, snapshot)
        }
        yield* requireActive()
        const base = {
          version: 1 as const,
          aggregates: snapshot.manifests,
          discoveryCursor: snapshot.discoveryCursor,
          sourceSnapshotToken: snapshot.token,
          manifestDigest: snapshot.manifestDigest,
          highWater: snapshot.highWater,
        }
        const position =
          request.pageCursor === undefined ? { record: 0, chunk: 0 } : decodeCursor(request.pageCursor, snapshot.token, cursorKey)
        if (position === undefined) return yield* new TransferError({ code: "restart", message: "invalid sync page cursor" })
        if (!withinBounds(snapshot, position))
          return yield* new TransferError({ code: "restart", message: "sync page cursor out of bounds" })
        if (request.capabilityOnly) {
          if (Buffer.byteLength(canonical({ ...base, page: { records: [] } })) > MAX_SYNC_PAGE_BYTES)
            return yield* new TransferError({ code: "too-large", message: "source manifest exceeds page budget" })
          return detach({ ...base, page: { records: [] } })
        }
        const page = makePage(snapshot, position, base, cursorKey)
        if (!page.ok) return yield* page.error
        // A terminal DATA page means the receiver can hold the full snapshot; it becomes evictable.
        if (page.nextCursor === undefined) snapshot.completed = true
        return detach({
          ...base,
          page: page.page,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        })
      }).pipe(
        Effect.provideService(EventBoundary, boundary),
        Effect.provideService(Database.Service, database),
        Effect.catchDefect(() => Effect.fail(new TransferError({ code: "conflict", message: "source history failed" }))),
      )

    const required: Effect.Effect<boolean, TransferError> = Effect.gen(function* () {
      yield* requireActive()
      yield* options.authorize(scope, "history")
      return yield* privateRequired(database, scope)
    }).pipe(Effect.mapError((error) => toTransferError(error)))

    const dispose = Effect.sync(() => {
      disposed = true
      snapshots.clear()
      cursorKey.fill(0)
    })

    return { history, required, dispose } satisfies TransferSource
  })
}

function createSnapshot(deps: SnapshotDeps, request: TransferHistoryRequest, binding: string) {
  return Effect.gen(function* () {
    const requested = Object.entries(request.aggregates)
    if (requested.length > MAX_SYNC_AGGREGATES)
      return yield* new TransferError({ code: "invalid", message: "too many requested aggregates" })
    const discovered =
      requested.length > 0
        ? requested.map(([aggregateID]) => aggregateID)
        : yield* discover(deps.database, deps.scope, request.discoveryCursor)
    const discoveredIDs = discovered.slice(0, MAX_SYNC_AGGREGATES)
    const decodedIDs = discoveredIDs.map(toSessionID)
    if (decodedIDs.some((id) => id === undefined))
      return yield* new TransferError({ code: "invalid", message: "invalid aggregate identity" })
    const aggregateIDs = decodedIDs.filter((id): id is SessionSchema.ID => id !== undefined)
    yield* authorizeExisting(deps.database, deps.scope, aggregateIDs)
    const repairID = request.repairCursor === undefined ? undefined : toSessionID(request.repairCursor)
    if (request.repairCursor !== undefined && !discoveredIDs.includes(request.repairCursor))
      return yield* new TransferError({ code: "invalid", message: "repair cursor outside discovery" })
    if (request.repairCursor !== undefined && repairID === undefined)
      return yield* new TransferError({ code: "invalid", message: "invalid repair cursor" })
    const selected = repairID !== undefined && requested.length === 0 ? [repairID] : aggregateIDs
    // One boundary transaction freezes high-water, canonical bundles and the record list together.
    const bundles = yield* deps.boundary.transaction(
      Effect.forEach(
        selected,
        (sessionID) =>
          deps.projection.export({ sessionID, workspaceID: deps.scope.workspaceID, ownerID: deps.scope.ownerID }),
        { concurrency: 1 },
      ),
    )
    const requestedMap = new Map(requested)
    for (const [aggregateID, cursor] of requested) {
      const sourceSeq = bundles.find((bundle) => bundle.aggregateID === aggregateID)?.sourceSeq
      if (sourceSeq === undefined)
        return yield* new TransferError({ code: "forbidden", message: "aggregate outside trusted scope" })
      if (cursor.cursor > sourceSeq)
        return yield* new TransferError({ code: "conflict", message: "receiver cursor ahead of source" })
    }
    const manifests = bundles.map(privateManifest)
    const records = bundles
      .flatMap((bundle) => recordsFor(bundle, requestedMap.get(bundle.aggregateID)?.cursor ?? -1))
      .sort(compareRecord)
    const frozen = Object.fromEntries(bundles.map((bundle) => [bundle.aggregateID, normalizedBundle(bundle, bundle.sourceSeq)]))
    const discoveryCursor =
      request.repairCursor === undefined && discovered.length > MAX_SYNC_AGGREGATES ? discoveredIDs.at(-1) : undefined
    return {
      token: randomBytes(24).toString("base64url"),
      binding,
      expiresAt: deps.now() + SNAPSHOT_TTL,
      bytes: Buffer.byteLength(canonical({ frozen, records })),
      highWater: Object.fromEntries(bundles.map((bundle) => [bundle.aggregateID, bundle.sourceSeq])),
      manifests,
      manifestDigest: manifestDigest(manifests.filter(hasManifest)),
      records,
      frozen,
      completed: false,
      ...(discoveryCursor === undefined ? {} : { discoveryCursor }),
    }
  }).pipe(Effect.mapError(toTransferError))

}

function validateSnapshot(deps: SnapshotDeps, snapshot: SourceSnapshot) {
  return deps.boundary
    .transaction(
      Effect.forEach(
        Object.entries(snapshot.highWater),
        ([aggregateID, sourceSeq]) =>
          authorizeExisting(deps.database, deps.scope, [SessionSchema.ID.make(aggregateID)]).pipe(Effect.andThen(deps.projection
            .export({ sessionID: SessionSchema.ID.make(aggregateID), workspaceID: deps.scope.workspaceID, ownerID: deps.scope.ownerID })
            .pipe(
              Effect.flatMap((bundle) =>
                canonical(normalizedBundle(bundle, sourceSeq, snapshot.frozen[aggregateID])) ===
                canonical(snapshot.frozen[aggregateID])
                  ? Effect.void
                  : Effect.fail(
                      new TransferError({ code: "snapshot-advanced", message: "source changed below the frozen high-water" }),
                    ),
              ),
            ))),
        { concurrency: 1 },
      ),
    )
    .pipe(Effect.mapError((error) => toSnapshotError(error)))
}

function privateRequired(database: Database.Interface, scope: TransferScope) {
  return Effect.gen(function* () {
    const directory = SessionTable.directory.mapToDriverValue(scope.directory)
    const workspace = scope.workspaceID === undefined ? sql`s.workspace_id IS NULL` : sql`s.workspace_id = ${scope.workspaceID}`
    // Proof-only private rows count even without a matching legacy snapshot.
    const requirement = yield* database.db.get<{ message_id: string }>(sql`
      SELECT r.message_id FROM cm_private_requirement r JOIN session s ON s.id = r.session_id
      WHERE s.project_id = ${scope.projectID} AND ${workspace} AND s.directory = ${directory} LIMIT 1`)
    if (requirement !== undefined) return true
    const input = yield* database.db.get<{ message_id: string }>(sql`
      SELECT p.message_id FROM cm_private_input p JOIN session s ON s.id = p.session_id
      WHERE s.project_id = ${scope.projectID} AND ${workspace} AND s.directory = ${directory} LIMIT 1`)
    if (input !== undefined) return true
    const checkpoint = yield* database.db.get<{ message_id: string }>(sql`
      SELECT c.message_id FROM cm_private_checkpoint c JOIN session s ON s.id = c.session_id
      WHERE s.project_id = ${scope.projectID} AND ${workspace} AND s.directory = ${directory} LIMIT 1`)
    if (checkpoint !== undefined) return true
    const epoch = yield* database.db.get<{ session_id: string }>(sql`
      SELECT e.session_id FROM session_context_epoch e JOIN session s ON s.id = e.session_id
      WHERE s.project_id = ${scope.projectID} AND ${workspace} AND s.directory = ${directory} LIMIT 1`)
    return epoch !== undefined
  })
}

function discover(database: Database.Interface, scope: TransferScope, cursor?: string) {
  return Effect.gen(function* () {
    const workspace = scope.workspaceID === undefined ? sql`workspace_id IS NULL` : sql`workspace_id = ${scope.workspaceID}`
    const after = cursor === undefined ? sql`1 = 1` : sql`id > ${cursor}`
    const rows = yield* database.db.all<{ id: string }>(sql`
      SELECT id FROM session
      WHERE project_id = ${scope.projectID} AND ${workspace} AND directory = ${SessionTable.directory.mapToDriverValue(scope.directory)} AND ${after}
        AND (EXISTS (SELECT 1 FROM event_sequence WHERE aggregate_id = session.id AND seq >= 0)
          OR EXISTS (SELECT 1 FROM cm_private_requirement WHERE session_id = session.id)
          OR EXISTS (SELECT 1 FROM cm_private_input WHERE session_id = session.id)
          OR EXISTS (SELECT 1 FROM cm_private_checkpoint WHERE session_id = session.id)
          OR EXISTS (SELECT 1 FROM session_context_epoch WHERE session_id = session.id))
      ORDER BY id LIMIT ${MAX_SYNC_AGGREGATES + 1}`)
    return rows.map((row) => row.id)
  })
}

function authorizeExisting(database: Database.Interface, scope: TransferScope, aggregateIDs: readonly SessionSchema.ID[]) {
  return Effect.gen(function* () {
    for (const sessionID of aggregateIDs) {
      const row = yield* database.db.get<{ project_id: string; workspace_id: string | null; directory: string }>(sql`
        SELECT project_id, workspace_id, directory FROM session WHERE id = ${sessionID}`)
      if (
        row === undefined ||
        row.project_id !== scope.projectID ||
        row.workspace_id !== (scope.workspaceID ?? null) ||
        SessionTable.directory.mapFromDriverValue(row.directory) !== scope.directory
      )
        return yield* new TransferError({ code: "forbidden", message: "aggregate outside trusted scope" })
    }
  })
}

function recordsFor(bundle: LegacyBundle, cursor: number) {
  const records: CompleteSyncRecord[] = [
    ...bundle.events.filter((event) => event.seq > cursor).map((event) => record("event", bundle, event.seq, event.id, event)),
    ...bundle.deletions.map((item) => record("deletion", bundle, item.targetEvent.seq, `${item.targetKind}:${item.targetMessageID}`, item)),
    ...bundle.contexts.map((item) => record("context", bundle, item.seq, `${item.kind}:${item.messageID}`, item)),
  ]
  if (bundle.epoch !== undefined) records.push(record("epoch", bundle, bundle.epoch.sourceSeq, bundle.aggregateID, bundle.epoch))
  return records
}

function record(kind: CompleteSyncRecord["kind"], bundle: LegacyBundle, sequence: number, identity: string, value: unknown): CompleteSyncRecord {
  return { kind, aggregateID: bundle.aggregateID, sourceSeq: bundle.sourceSeq, sequence, identity, value }
}

function compareRecord(left: CompleteSyncRecord, right: CompleteSyncRecord) {
  if (left.kind === "epoch" && right.kind !== "epoch") return 1
  if (left.kind !== "epoch" && right.kind === "epoch") return -1
  return (
    left.aggregateID.localeCompare(right.aggregateID) ||
    left.sequence - right.sequence ||
    recordKindRank(left.kind) - recordKindRank(right.kind) ||
    left.identity.localeCompare(right.identity)
  )
}

function recordKindRank(kind: CompleteSyncRecord["kind"]) {
  return kind === "event" ? 0 : kind === "deletion" ? 1 : kind === "context" ? 2 : 3
}

/**
 * Append-only events above the frozen high-water stay admissible; later proven reverts may restore
 * the frozen original contexts and later epochs may retain the frozen baseline. Anything mutated at
 * or below the frozen boundary fails snapshot-advanced.
 */
function normalizedBundle(bundle: LegacyBundle, sourceSeq: number, frozen?: LegacyBundle): LegacyBundle {
  const laterDeletions = bundle.deletions.filter((item) => item.deletingEvent.seq > sourceSeq)
  const restoredContexts =
    frozen?.contexts.filter((context) =>
      laterDeletions.some(
        (deletion) => deletion.targetKind === context.kind && deletion.targetMessageID === context.messageID,
      ),
    ) ?? []
  const epoch = bundle.epoch !== undefined && bundle.epoch.baselineSeq <= sourceSeq ? { ...bundle.epoch, sourceSeq } : frozen?.epoch
  return {
    version: 1,
    aggregateID: bundle.aggregateID,
    sourceSeq,
    events: bundle.events.filter((event) => event.seq <= sourceSeq),
    contexts: [...bundle.contexts.filter((context) => context.seq <= sourceSeq), ...restoredContexts].sort(
      (left, right) => left.seq - right.seq || left.messageID.localeCompare(right.messageID),
    ),
    deletions: bundle.deletions
      .filter((item) => item.deletingEvent.seq <= sourceSeq)
      .sort((left, right) => left.targetEvent.seq - right.targetEvent.seq),
    ...(epoch === undefined ? {} : { epoch }),
  }
}

function hasManifest(manifest: Manifest) {
  return manifest.privateCount > 0 || manifest.deletionCount > 0 || manifest.epochDigest !== undefined
}

function makePage(
  snapshot: SourceSnapshot,
  start: { readonly record: number; readonly chunk: number },
  base: Record<string, unknown>,
  cursorKey: Buffer,
): PageOutcome {
  const records: (CompleteSyncRecord | ChunkSyncRecord)[] = []
  let recordIndex = start.record
  let chunkIndex = start.chunk
  let completePublic = 0
  while (recordIndex < snapshot.records.length) {
    const current = snapshot.records[recordIndex]
    if (current === undefined) break
    const bytes = Buffer.from(canonical(current.value))
    const oversized = Buffer.byteLength(canonical({ ...base, page: { records: [current] } })) > MAX_SYNC_PAGE_BYTES
    if (!oversized && chunkIndex === 0) {
      const nextPublic = completePublic + (current.kind === "event" || current.kind === "deletion" ? 1 : 0)
      if (nextPublic > MAX_SYNC_PUBLIC_EVENTS) break
      if (
        Buffer.byteLength(canonical({ ...base, page: { records: [...records, current] }, nextCursor: "x".repeat(256) })) >
        MAX_SYNC_PAGE_BYTES
      )
        break
      records.push(current)
      completePublic = nextPublic
      recordIndex++
      continue
    }
    if (records.length > 0) break
    const chunks = Array.from({ length: Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES)) }, (_, index) =>
      bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
    )
    while (chunkIndex < chunks.length && records.length < MAX_SYNC_RECORD_CHUNKS) {
      const part = chunks[chunkIndex]
      if (part === undefined) break
      const chunk: ChunkSyncRecord = {
        kind: "chunk",
        recordKind: current.kind,
        aggregateID: current.aggregateID,
        sourceSeq: current.sourceSeq,
        sequence: current.sequence,
        identity: current.identity,
        chunkIndex,
        chunkCount: chunks.length,
        byteLength: bytes.byteLength,
        contentHash: digest(bytes),
        data: part.toString("base64"),
      }
      if (
        Buffer.byteLength(canonical({ ...base, page: { records: [...records, chunk] }, nextCursor: "x".repeat(256) })) >
        MAX_SYNC_PAGE_BYTES
      )
        break
      records.push(chunk)
      chunkIndex++
    }
    if (chunkIndex === chunks.length) {
      recordIndex++
      chunkIndex = 0
    }
    break
  }
  if (snapshot.records.length > 0 && records.length === 0)
    return { ok: false, error: new TransferError({ code: "too-large", message: "record exceeds page budget" }) }
  const nextCursor =
    recordIndex < snapshot.records.length
      ? encodeCursor(snapshot.token, { record: recordIndex, chunk: chunkIndex }, cursorKey)
      : undefined
  const result = { page: { records }, nextCursor }
  if (Buffer.byteLength(canonical({ ...base, ...result })) > MAX_SYNC_PAGE_BYTES)
    return { ok: false, error: new TransferError({ code: "too-large", message: "page exceeds budget" }) }
  return { ok: true, page: result.page, nextCursor: result.nextCursor }
}

function withinBounds(snapshot: SourceSnapshot, position: { readonly record: number; readonly chunk: number }) {
  if (position.record > snapshot.records.length) return false
  if (position.record === snapshot.records.length) return position.chunk === 0
  const current = snapshot.records[position.record]
  if (current === undefined) return false
  return position.chunk < Math.max(1, Math.ceil(Buffer.byteLength(canonical(current.value)) / CHUNK_BYTES))
}

function encodeCursor(token: string, position: { readonly record: number; readonly chunk: number }, key: Buffer) {
  const payload = Buffer.from(canonical(position)).toString("base64url")
  const signature = createHmac("sha256", key).update(`${token}.${payload}`).digest("base64url")
  return `${payload}.${signature}`
}

function decodeCursor(value: string, token: string, key: Buffer): { readonly record: number; readonly chunk: number } | undefined {
  const [payload, signature, extra] = value.split(".")
  if (!payload || !signature || extra) return undefined
  if (createHmac("sha256", key).update(`${token}.${payload}`).digest("base64url") !== signature) return undefined
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(payload, "base64url").toString("utf8"))
  if (Option.isNone(parsed)) return undefined
  const raw = parsed.value
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const item = Object.fromEntries(Object.entries(raw as Record<string, unknown>))
  if (typeof item.record !== "number" || typeof item.chunk !== "number") return undefined
  if (!Number.isSafeInteger(item.record) || !Number.isSafeInteger(item.chunk)) return undefined
  if (item.record < 0 || item.chunk < 0) return undefined
  return { record: item.record, chunk: item.chunk }
}

function toSessionID(value: string): SessionSchema.ID | undefined {
  if (value.length === 0 || value.length > 256) return undefined
  const decoded = Schema.decodeUnknownOption(SessionSchema.ID)(value)
  return Option.isNone(decoded) ? undefined : decoded.value
}

function detach<T>(value: T): T {
  return structuredClone(value)
}

function toSnapshotError(error: unknown): TransferError {
  return error instanceof TransferError
    ? error
    : new TransferError({ code: "snapshot-advanced", message: "source snapshot invalid" })
}

function toTransferError(error: unknown): TransferError {
  if (error instanceof TransferError) return error
  if (error instanceof LegacyProjectionError) {
    if (TRANSFER_CODES.has(error.code as TransferCode))
      return new TransferError({ code: error.code as TransferCode, message: error.code })
    if (
      error.code === "owner-mismatch" ||
      error.code === "workspace-mismatch" ||
      error.code === "missing-scope" ||
      error.code === "scope-mismatch"
    )
      return new TransferError({ code: "forbidden", message: error.code })
    return new TransferError({ code: "conflict", message: error.code })
  }
  return new TransferError({ code: "conflict", message: "source history failed" })
}
