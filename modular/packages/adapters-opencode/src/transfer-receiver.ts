import { randomBytes } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Option, Schema, Semaphore } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary } from "./event-boundary"
import { legacyDigest } from "./legacy-context"
import { LegacyProjectionError, makeLegacyProjection } from "./legacy-projection"
import {
  SessionContextTransferSpool,
  SyncTransferBusy,
  SyncTransferExpired,
  SyncTransferTooLarge,
  TRANSFER_ABSOLUTE_TTL,
  TRANSFER_IDLE_TTL,
  canonical,
  digest,
} from "./transfer-spool"
import {
  TransferError,
  TransferReplayRequest,
  type TransferPolicy,
  type TransferReplayResponse,
  type TransferScope,
} from "./transfer-protocol"

type BeginRequest = Extract<TransferReplayRequest, { readonly action: "begin" }>
type AppendRequest = Extract<TransferReplayRequest, { readonly action: "append" }>
type FinalizeRequest = Extract<TransferReplayRequest, { readonly action: "finalize" }>
type AbortRequest = Extract<TransferReplayRequest, { readonly action: "abort" }>

type RawBegin = {
  readonly workspaceID?: string
  readonly directory: string
  readonly clientTransferID: string
  readonly sourceSnapshotToken: string
  readonly highWater: Readonly<Record<string, number>>
  readonly manifestDigest: string
  readonly expiresAt: number
}

type BindingIdentity = {
  readonly handle: string
  readonly begin_key: string
  readonly begin_json: string
  readonly spool_client_id: string
  readonly expires_at: number
}

type BindingRow = BindingIdentity & { readonly scope_json: string; readonly status: string }

type Binding = {
  readonly handle: string
  readonly spoolHandle: string
  readonly beginKey: string
  readonly bindingJSON: string
  readonly spoolClientID: string
  readonly rawBegin: RawBegin
  readonly effectiveExpiresAt: number
  idleExpiresAt: number
  aborted: boolean
}

type ReceiptRow = {
  readonly handle: string
  readonly scope_json: string
  readonly begin_json: string
  readonly expected_page_count: number
  readonly manifest_digest: string
  readonly receipt: string
  readonly expires_at: number
}

type NormalizedBundle = {
  readonly aggregateID: string
  readonly bundle: {
    readonly version: 1
    readonly aggregateID: string
    readonly sourceSeq: number
    readonly events: ReadonlyArray<unknown>
    readonly contexts: ReadonlyArray<unknown>
    readonly deletions: ReadonlyArray<unknown>
    readonly epoch?: unknown
  }
}

const SpooledBundle = Schema.Struct({
  version: Schema.Literal(1),
  aggregateID: Schema.String,
  sourceSeq: Schema.Number,
  events: Schema.Array(Schema.Unknown),
  contexts: Schema.Array(Schema.Unknown),
  deletions: Schema.Array(Schema.Unknown),
  epoch: Schema.optional(Schema.Unknown),
})

const SpooledEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  seq: Schema.Number,
  aggregateID: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
})

const CreatedInfo = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  directory: Schema.String,
})

const decodeSpooledBundle = Schema.decodeUnknownOption(SpooledBundle, { onExcessProperty: "error" })
const decodeSpooledEvents = Schema.decodeUnknownOption(Schema.Array(SpooledEvent), { onExcessProperty: "error" })
const decodeCreatedInfo = Schema.decodeUnknownOption(CreatedInfo)
const decodeReplay = Schema.decodeUnknownOption(TransferReplayRequest, { onExcessProperty: "error" })

const forbiddenProjectionCodes = new Set([
  "missing-scope",
  "workspace-mismatch",
  "owner-mismatch",
  "missing-session-placement",
  "missing-project",
  "scope-mismatch",
  "created-definition",
  "deleted-definition",
  "epoch-replacement-scope",
])

/** Constructs a scoped receiver over one dedicated spool. Owns that spool's disposal. */
export function makeTransferReceiver(options: TransferPolicy & {
  readonly spool: SessionContextTransferSpool
  readonly now?: () => number
}) {
  return Effect.gen(function* () {
    const trusted = options.scope
    if (
      !trusted.principalID.trim() || !trusted.ownerID.trim() || !trusted.projectID.trim() || !trusted.directory.trim() ||
      (trusted.workspaceID !== undefined && !trusted.workspaceID.trim())
    ) return yield* Effect.fail(new TransferError({ code: "invalid", message: "invalid trusted scope" }))
    const scope: TransferScope = trusted.workspaceID === undefined
      ? {
          principalID: trusted.principalID,
          ownerID: trusted.ownerID,
          projectID: trusted.projectID,
          directory: trusted.directory,
        }
      : {
          principalID: trusted.principalID,
          ownerID: trusted.ownerID,
          projectID: trusted.projectID,
          directory: trusted.directory,
          workspaceID: trusted.workspaceID,
        }
    Object.freeze(scope)
    const scopeJSON = canonical(scope)
    // The spool admits by workspace+clientTransferID, so internal identities are
    // namespaced by frozen trusted scope plus this receiver instance. External
    // request/begin_json identity is preserved verbatim in cm_transfer_binding.
    const scopeHash = digest(scopeJSON)
    const instanceID = randomBytes(16).toString("hex")
    const now = options.now ?? Date.now
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const gate = yield* Semaphore.make(1)
    const projection = makeLegacyProjection({ authorize: () => Effect.void })

    const bindings = new Map<string, Binding>()
    const begins = new Map<string, string>()
    let disposed = false

    const namespaceSpoolID = (clientTransferID: string) => `${scopeHash}:${instanceID}:${clientTransferID}`
    const spoolBeginInput = (raw: RawBegin, spoolClientID: string) => ({
      directory: raw.directory,
      clientTransferID: spoolClientID,
      sourceSnapshotToken: raw.sourceSnapshotToken,
      highWater: { ...raw.highWater },
      manifestDigest: raw.manifestDigest,
      expiresAt: raw.expiresAt,
      ...(raw.workspaceID === undefined ? {} : { workspaceID: raw.workspaceID }),
    })

    yield* database.db.transaction(() => Effect.gen(function* () {
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_migration (
        id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL)`)
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_transfer_receipt (
        handle TEXT PRIMARY KEY NOT NULL,
        scope_json TEXT NOT NULL,
        begin_json TEXT NOT NULL,
        expected_page_count INTEGER NOT NULL,
        manifest_digest TEXT NOT NULL,
        receipt TEXT NOT NULL,
        expires_at INTEGER NOT NULL)`)
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_transfer_binding (
        handle TEXT PRIMARY KEY NOT NULL,
        scope_json TEXT NOT NULL,
        begin_key TEXT NOT NULL,
         begin_json TEXT NOT NULL,
         spool_client_id TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active',
        expires_at INTEGER NOT NULL)`)
      const columns = yield* database.db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('cm_transfer_binding')`)
      const names = new Set(columns.map((column) => column.name))
      if (!names.has("begin_key"))
        yield* database.db.run(sql`ALTER TABLE cm_transfer_binding ADD COLUMN begin_key TEXT NOT NULL DEFAULT ''`)
      if (!names.has("begin_json"))
        yield* database.db.run(sql`ALTER TABLE cm_transfer_binding ADD COLUMN begin_json TEXT NOT NULL DEFAULT ''`)
      if (!names.has("spool_client_id"))
        yield* database.db.run(sql`ALTER TABLE cm_transfer_binding ADD COLUMN spool_client_id TEXT NOT NULL DEFAULT ''`)
      if (!names.has("status"))
        yield* database.db.run(sql`ALTER TABLE cm_transfer_binding ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
      yield* database.db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS cm_transfer_binding_identity
        ON cm_transfer_binding(scope_json, begin_key) WHERE begin_key <> ''`)
      yield* database.db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
        VALUES ('0006-transfer-control', ${Date.now()})`)
    })).pipe(Effect.mapError(() => new TransferError({ code: "conflict", message: "transfer ledger unavailable" })))

    const authorizeReplay = () => options.authorize(scope, "replay")

    const live = (binding: Binding) => now() < binding.effectiveExpiresAt && now() < binding.idleExpiresAt

    const ensureLive = (binding: Binding): Effect.Effect<void, TransferError> =>
      live(binding)
        ? Effect.void
        : Effect.fail(new TransferError({ code: "expired", message: "transfer expired" }))

    const touch = (binding: Binding) => {
      binding.idleExpiresAt = Math.min(now() + TRANSFER_IDLE_TTL, binding.effectiveExpiresAt)
    }

    const releaseMemory = (handle: string) => {
      const binding = bindings.get(handle)
      if (binding === undefined) return
      bindings.delete(handle)
      if (begins.get(binding.beginKey) === handle) begins.delete(binding.beginKey)
    }

    const forgetBinding = (handle: string) => Effect.gen(function* () {
      releaseMemory(handle)
      yield* database.db.run(sql`DELETE FROM cm_transfer_binding WHERE handle = ${handle}`).pipe(Effect.catch(() => Effect.void))
    })

    const abortSpool = (spoolHandle: string) => Effect.tryPromise({
      try: () => options.spool.abort(spoolHandle),
      catch: mapSpoolError,
    }).pipe(Effect.catch(() => Effect.void))

    const invalidate = (binding: Binding) => Effect.gen(function* () {
      yield* abortSpool(binding.spoolHandle)
      releaseMemory(binding.handle)
      yield* database.db.run(sql`UPDATE cm_transfer_binding SET status = 'aborted', begin_json = '', spool_client_id = ''
        WHERE handle = ${binding.handle} AND scope_json = ${scopeJSON}`)
    }).pipe(Effect.orDie)

    const sweep = () => Effect.gen(function* () {
      const current = now()
      for (const [handle, binding] of [...bindings]) {
        if (current >= binding.effectiveExpiresAt) releaseMemory(handle)
      }
      yield* database.db.run(sql`DELETE FROM cm_transfer_receipt WHERE expires_at <= ${current}`)
      yield* database.db.run(sql`DELETE FROM cm_transfer_binding WHERE expires_at <= ${current}`)
    })

    const readReceipt = (handle: string) => Effect.gen(function* () {
      const row = yield* database.db.get<ReceiptRow>(sql`
        SELECT handle, scope_json, begin_json, expected_page_count, manifest_digest, receipt, expires_at
        FROM cm_transfer_receipt WHERE handle = ${handle}`)
      if (!row) return undefined
      if (row.scope_json !== scopeJSON)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "receipt scope mismatch" }))
      if (row.expires_at <= now()) {
        yield* database.db.run(sql`DELETE FROM cm_transfer_receipt WHERE handle = ${handle}`)
        return undefined
      }
      return row
    })

    const checkReceipt = (row: ReceiptRow, request: FinalizeRequest): Effect.Effect<string, TransferError> => {
      if (row.expected_page_count !== request.expectedPageCount || row.manifest_digest !== request.manifestDigest)
        return Effect.fail(new TransferError({ code: "conflict", message: "receipt mismatch" }))
      return Effect.succeed(row.receipt)
    }

    const requireExistingSession = (aggregateID: string) => Effect.gen(function* () {
      const session = yield* database.db.get<{ project_id: string; directory: string | null; workspace_id: string | null }>(sql`
        SELECT project_id, directory, workspace_id FROM session WHERE id = ${aggregateID}`)
      if (session && (
        session.project_id !== scope.projectID || session.directory === null || SessionTable.directory.mapFromDriverValue(session.directory) !== scope.directory ||
        session.workspace_id !== (scope.workspaceID ?? null)
      )) return yield* Effect.fail(new TransferError({ code: "forbidden", message: "session placement mismatch" }))
      const owner = yield* database.db.get<{ owner_id: string | null }>(sql`
        SELECT owner_id FROM event_sequence WHERE aggregate_id = ${aggregateID}`)
      if (owner && owner.owner_id !== null && owner.owner_id !== scope.ownerID)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "session owner mismatch" }))
    })

    const normalizeBundle = (raw: unknown): Effect.Effect<NormalizedBundle, TransferError> => Effect.gen(function* () {
      const decoded = decodeSpooledBundle(raw)
      if (Option.isNone(decoded))
        return yield* Effect.fail(new TransferError({ code: "conflict", message: "invalid spooled bundle" }))
      const value = decoded.value
      const bundle = value.epoch === undefined
        ? {
            version: 1 as const,
            aggregateID: value.aggregateID,
            sourceSeq: value.sourceSeq,
            events: value.events,
            contexts: value.contexts,
            deletions: value.deletions,
          }
        : {
            version: 1 as const,
            aggregateID: value.aggregateID,
            sourceSeq: value.sourceSeq,
            events: value.events,
            contexts: value.contexts,
            deletions: value.deletions,
            epoch: value.epoch,
          }
      return { aggregateID: value.aggregateID, bundle }
    })

    const requireCreatedPlacement = (aggregateID: string, normalized: NormalizedBundle) => Effect.gen(function* () {
      const decoded = decodeSpooledEvents(normalized.bundle.events)
      if (Option.isNone(decoded))
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "invalid created placement" }))
      const definition = SessionV1.Event.Created
      if (!definition.durable)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "unknown created definition" }))
      const createdType = EventV2.versionedType(definition.type, definition.durable.version)
      const created = decoded.value.find((event) => event.type === createdType)
      if (!created)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "missing created placement" }))
      const info = decodeCreatedInfo(created.data.info)
      if (Option.isNone(info))
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "invalid created placement" }))
      if (
        info.value.id !== aggregateID || info.value.projectID !== scope.projectID ||
        (info.value.workspaceID ?? undefined) !== (scope.workspaceID ?? undefined) ||
        info.value.directory !== scope.directory
      ) return yield* Effect.fail(new TransferError({ code: "forbidden", message: "created placement mismatch" }))
      const project = yield* database.db.get(sql`SELECT id FROM project WHERE id = ${scope.projectID}`)
      if (!project) return yield* Effect.fail(new TransferError({ code: "forbidden", message: "missing project" }))
    })

    const resolveBinding = (handle: string) => Effect.gen(function* () {
      const cached = bindings.get(handle)
      if (cached !== undefined && !cached.aborted) return cached
      const row = yield* database.db.get<BindingRow>(sql`
        SELECT handle, scope_json, begin_key, begin_json, spool_client_id, expires_at, status
        FROM cm_transfer_binding WHERE handle = ${handle}`)
      if (row === undefined) return undefined
      if (row.scope_json !== scopeJSON)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "transfer handle owned by another scope" }))
      if (row.expires_at <= now()) {
        yield* forgetBinding(handle)
        return undefined
      }
      // Uncommitted encrypted pages/keys are process-local. Never recreate a
      // fresh spool behind an old handle or reset an expired idle deadline.
      return yield* new TransferError({ code: "restart", message: "restart staged transfer with a new client identity" })
    })

    const begin = (request: BeginRequest) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (request.directory !== scope.directory)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "directory mismatch" }))
      const entries = Object.entries(request.highWater)
      if (entries.length > 128 || entries.some(([aggregateID]) => aggregateID.length === 0))
        return yield* Effect.fail(new TransferError({ code: "too-large", message: "invalid high-water" }))
      if (entries.some(([aggregateID]) => !Schema.is(SessionSchema.ID)(aggregateID)) ||
        !request.clientTransferID.trim() || !request.sourceSnapshotToken.trim())
        return yield* new TransferError({ code: "invalid", message: "invalid transfer identity" })
      const current = now()
      if (Math.min(request.expiresAt, current + TRANSFER_ABSOLUTE_TTL) <= current)
        return yield* Effect.fail(new TransferError({ code: "expired", message: "transfer expired" }))
      const project = yield* restore(database.db.get(sql`SELECT id FROM project WHERE id = ${scope.projectID}`))
      if (!project) return yield* Effect.fail(new TransferError({ code: "forbidden", message: "missing project" }))
      for (const [aggregateID] of entries) yield* restore(requireExistingSession(aggregateID))
      const rawBegin: RawBegin = {
        directory: request.directory,
        clientTransferID: request.clientTransferID,
        sourceSnapshotToken: request.sourceSnapshotToken,
        highWater: { ...request.highWater },
        manifestDigest: request.manifestDigest,
        expiresAt: request.expiresAt,
        ...(scope.workspaceID === undefined ? {} : { workspaceID: scope.workspaceID }),
      }
      const bindingJSON = canonical(rawBegin)
      const beginKey = digest(canonical({ workspaceID: scope.workspaceID, clientTransferID: request.clientTransferID }))

      const completed = yield* database.db.get<ReceiptRow>(sql`SELECT * FROM cm_transfer_receipt
        WHERE scope_json = ${scopeJSON} AND json_extract(begin_json, '$.clientTransferID') = ${request.clientTransferID}`)
      if (completed) {
        if (completed.begin_json !== bindingJSON)
          return yield* new TransferError({ code: "conflict", message: "conflicting completed begin retry" })
        return { version: 1 as const, action: "begin" as const, transferHandle: completed.handle, expiresAt: completed.expires_at }
      }

      const priorHandle = begins.get(beginKey)
      if (priorHandle !== undefined) {
        const prior = bindings.get(priorHandle)
        if (prior !== undefined && !prior.aborted && live(prior)) {
          if (prior.bindingJSON === bindingJSON) {
            const refreshed = yield* Effect.tryPromise({
              try: () => options.spool.begin(spoolBeginInput(prior.rawBegin, prior.spoolClientID)),
              catch: mapSpoolError,
            })
            if (refreshed.handle !== prior.spoolHandle) {
              yield* abortSpool(refreshed.handle)
              yield* invalidate(prior)
              return yield* new TransferError({ code: "restart", message: "staged transfer expired" })
            }
            yield* ensureLive(prior)
            touch(prior)
            return {
              version: 1 as const,
              action: "begin" as const,
              transferHandle: priorHandle,
              expiresAt: prior.effectiveExpiresAt,
            }
          }
          return yield* Effect.fail(new TransferError({ code: "conflict", message: "conflicting begin retry" }))
        }
        if (prior) yield* invalidate(prior)
      }

      const durable = yield* database.db.get<BindingRow>(sql`
        SELECT handle, scope_json, begin_key, begin_json, spool_client_id, expires_at, status
        FROM cm_transfer_binding WHERE scope_json = ${scopeJSON} AND begin_key = ${beginKey}`)
      if (durable !== undefined) {
        if (durable.expires_at <= now()) {
          yield* forgetBinding(durable.handle)
        } else {
          if (durable.status === "active" && durable.begin_json !== bindingJSON)
            return yield* Effect.fail(new TransferError({ code: "conflict", message: "conflicting begin retry" }))
          return yield* new TransferError({ code: "restart", message: "restart staged transfer with a new client identity" })
        }
      }

      const spoolClientID = namespaceSpoolID(request.clientTransferID)
      const result = yield* Effect.tryPromise({
        try: () => options.spool.begin(spoolBeginInput(rawBegin, spoolClientID)),
        catch: mapSpoolError,
      })
      const binding = yield* Effect.gen(function* () {
        yield* database.db.run(sql`INSERT INTO cm_transfer_binding
          (handle, scope_json, begin_key, begin_json, spool_client_id, expires_at)
          VALUES (${result.handle}, ${scopeJSON}, ${beginKey}, ${bindingJSON}, ${spoolClientID}, ${result.expiresAt})`)
        const owner = yield* database.db.get<{ scope_json: string; begin_json: string }>(sql`
          SELECT scope_json, begin_json FROM cm_transfer_binding WHERE handle = ${result.handle}`)
        if (!owner || owner.scope_json !== scopeJSON)
          return yield* Effect.fail(new TransferError({ code: "forbidden", message: "transfer handle owned by another scope" }))
        if (owner.begin_json !== bindingJSON)
          return yield* Effect.fail(new TransferError({ code: "conflict", message: "conflicting begin retry" }))
        const created: Binding = {
          handle: result.handle,
          spoolHandle: result.handle,
          beginKey,
          bindingJSON,
          spoolClientID,
          rawBegin,
          effectiveExpiresAt: result.expiresAt,
          idleExpiresAt: Math.min(current + TRANSFER_IDLE_TTL, result.expiresAt),
          aborted: false,
        }
        bindings.set(created.handle, created)
        begins.set(beginKey, created.handle)
        yield* restore(Effect.void)
        return created
      }).pipe(Effect.onExit((exit) => exit._tag === "Success"
        ? Effect.void
        : Effect.gen(function* () {
            releaseMemory(result.handle)
            yield* database.db.run(sql`DELETE FROM cm_transfer_binding WHERE handle = ${result.handle}`)
              .pipe(Effect.catch(() => Effect.void))
            yield* abortSpool(result.handle)
          })))
      return {
        version: 1 as const,
        action: "begin" as const,
        transferHandle: binding.handle,
        expiresAt: binding.effectiveExpiresAt,
      }
    }))

    const append = (request: AppendRequest) => Effect.gen(function* () {
      const binding = yield* resolveBinding(request.transferHandle)
      if (binding === undefined || binding.aborted)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "unknown transfer handle" }))
      yield* ensureLive(binding)
      const result = yield* Effect.tryPromise({
        try: () => options.spool.append({
          handle: binding.spoolHandle,
          pageIndex: request.pageIndex,
          pageHash: request.pageHash,
          page: request.page,
        }),
        catch: mapSpoolError,
      }).pipe(Effect.onExit((exit) => exit._tag === "Success" ? Effect.void : invalidate(binding)))
      yield* ensureLive(binding)
      touch(binding)
      return {
        version: 1 as const,
        action: "append" as const,
        transferHandle: binding.handle,
        nextPageIndex: result.nextPageIndex,
      }
    })

    const commitReady = (
      binding: Binding,
      request: FinalizeRequest,
      receipt: string,
      bundles: ReadonlyArray<unknown>,
    ): Effect.Effect<string, TransferError> => boundary.transaction(Effect.gen(function* () {
      yield* authorizeReplay()
      yield* ensureLive(binding)
      const existing = yield* readReceipt(binding.handle)
      if (existing !== undefined) return yield* checkReceipt(existing, request)
      const decoded = new Map<string, NormalizedBundle>()
      for (const raw of bundles) {
        const normalized = yield* normalizeBundle(raw)
        decoded.set(normalized.aggregateID, normalized)
      }
      for (const [aggregateID] of Object.entries(binding.rawBegin.highWater)) {
        const normalized = decoded.get(aggregateID)
        if (normalized === undefined)
          return yield* Effect.fail(new TransferError({ code: "conflict", message: "missing aggregate bundle" }))
        const session = yield* database.db.get(sql`SELECT id FROM session WHERE id = ${aggregateID}`)
        if (session) yield* requireExistingSession(aggregateID)
        else yield* requireCreatedPlacement(aggregateID, normalized)
      }
      for (const normalized of decoded.values()) {
        const legacyScope = scope.workspaceID === undefined
          ? { sessionID: SessionSchema.ID.make(normalized.aggregateID), ownerID: scope.ownerID }
          : { sessionID: SessionSchema.ID.make(normalized.aggregateID), ownerID: scope.ownerID, workspaceID: scope.workspaceID }
        yield* projection.restore({
          bundle: normalized.bundle,
          scope: legacyScope,
          expectedDigest: legacyDigest(normalized.bundle),
          publish: true,
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.provideService(EventV2.Service, events),
          Effect.provideService(EventBoundary, boundary),
        )
      }
      yield* authorizeReplay()
      yield* ensureLive(binding)
      for (const [aggregateID] of Object.entries(binding.rawBegin.highWater)) yield* requireExistingSession(aggregateID)
      yield* database.db.run(sql`INSERT INTO cm_transfer_receipt
        (handle, scope_json, begin_json, expected_page_count, manifest_digest, receipt, expires_at)
        VALUES (${binding.handle}, ${scopeJSON}, ${binding.bindingJSON}, ${request.expectedPageCount},
          ${request.manifestDigest}, ${receipt}, ${binding.effectiveExpiresAt})`)
      yield* ensureLive(binding)
      return receipt
    })).pipe(Effect.mapError(toTransferError))

    const finishCommitted = (handle: string, receipt: string, spoolHandle: string | undefined) => Effect.gen(function* () {
      if (spoolHandle !== undefined) {
        yield* Effect.tryPromise({
          try: () => options.spool.complete(spoolHandle, receipt),
          catch: mapSpoolError,
        }).pipe(Effect.catch(() => Effect.void))
      }
      yield* forgetBinding(handle)
    })

    const finalize = (request: FinalizeRequest) => Effect.gen(function* () {
      const existing = yield* readReceipt(request.transferHandle)
      if (existing !== undefined) {
        const receipt = yield* checkReceipt(existing, request)
        yield* finishCommitted(request.transferHandle, receipt, request.transferHandle)
        return { version: 1 as const, action: "finalize" as const, manifestReceipt: receipt }
      }
      const binding = yield* resolveBinding(request.transferHandle)
      if (binding === undefined || binding.aborted)
        return yield* Effect.fail(new TransferError({ code: "forbidden", message: "unknown transfer handle" }))
      yield* ensureLive(binding)
      if (request.manifestDigest !== binding.rawBegin.manifestDigest)
        return yield* Effect.fail(new TransferError({ code: "conflict", message: "manifest mismatch" }))
      const ready = yield* Effect.tryPromise({
        try: () => options.spool.finalize({
          handle: binding.spoolHandle,
          expectedPageCount: request.expectedPageCount,
          manifestDigest: request.manifestDigest,
        }),
        catch: mapSpoolError,
      }).pipe(Effect.onExit((exit) => exit._tag === "Success" ? Effect.void : invalidate(binding)))
      if (ready.status === "complete")
        return yield* Effect.fail(new TransferError({ code: "conflict", message: "completed transfer without durable receipt" }))
      yield* ensureLive(binding)
      const receipt = yield* commitReady(binding, request, ready.receipt, ready.bundles).pipe(
        Effect.onExit((exit) => exit._tag === "Failure"
          ? Effect.gen(function* () {
              yield* invalidate(binding)
            })
          : Effect.void),
      )
      yield* finishCommitted(binding.handle, receipt, binding.spoolHandle)
      return { version: 1 as const, action: "finalize" as const, manifestReceipt: receipt }
    })

    const abort = (request: AbortRequest) => Effect.gen(function* () {
      const existing = yield* readReceipt(request.transferHandle)
      if (existing !== undefined) {
        // A committed receipt is the durable authority. Acknowledgements may
        // release active state but never erase the receipt.
        yield* finishCommitted(request.transferHandle, existing.receipt, request.transferHandle)
        return { version: 1 as const, action: "abort" as const, transferHandle: request.transferHandle }
      }
      const binding = bindings.get(request.transferHandle)
      if (binding) yield* invalidate(binding)
      if (!binding) {
        const tombstone = yield* database.db.get<{ scope_json: string }>(sql`
          SELECT scope_json FROM cm_transfer_binding WHERE handle = ${request.transferHandle}`)
        if (!tombstone || tombstone.scope_json !== scopeJSON)
          return yield* new TransferError({ code: "forbidden", message: "unknown transfer handle" })
        yield* abortSpool(request.transferHandle)
        yield* database.db.run(sql`UPDATE cm_transfer_binding SET status = 'aborted', begin_json = '', spool_client_id = ''
          WHERE handle = ${request.transferHandle}`)
      }
      return { version: 1 as const, action: "abort" as const, transferHandle: request.transferHandle }
    })

    const run = (request: TransferReplayRequest): Effect.Effect<TransferReplayResponse, TransferError> => Effect.gen(function* () {
      yield* authorizeReplay()
      yield* sweep()
      switch (request.action) {
        case "begin": return yield* begin(request)
        case "append": return yield* append(request)
        case "finalize": return yield* finalize(request)
        case "abort": return yield* abort(request)
        default: return yield* Effect.fail(new TransferError({ code: "invalid", message: "unsupported action" }))
      }
    }).pipe(Effect.mapError(toTransferError))

    const dispatch = (request: TransferReplayRequest): Effect.Effect<TransferReplayResponse, TransferError> =>
      Effect.suspend(() =>
        disposed
          ? Effect.fail(new TransferError({ code: "conflict", message: "receiver disposed" }))
          : run(request))

    const replay = (payload: unknown): Effect.Effect<TransferReplayResponse, TransferError> => {
      const decoded = decodeReplay(payload)
      if (Option.isNone(decoded))
        return Effect.fail(new TransferError({ code: "invalid", message: "invalid replay request" }))
      return gate.withPermit(dispatch(structuredClone(decoded.value))).pipe(
        Effect.catchDefect(() => Effect.fail(new TransferError({ code: "conflict", message: "transfer operation failed" }))),
      )
    }

    const dispose: Effect.Effect<void, TransferError> = gate.withPermit(Effect.gen(function* () {
      if (disposed) return
      disposed = true
      bindings.clear()
      begins.clear()
      yield* Effect.tryPromise({
        try: () => options.spool.dispose(),
        catch: () => new TransferError({ code: "conflict", message: "transfer spool disposal failed" }),
      })
    }))

    return { replay, dispose }
  })
}

function mapSpoolError(error: unknown): TransferError {
  if (error instanceof SyncTransferBusy) return new TransferError({ code: "busy", message: "transfer busy" })
  if (error instanceof SyncTransferTooLarge) return new TransferError({ code: "too-large", message: "transfer too large" })
  if (error instanceof SyncTransferExpired) return new TransferError({ code: "expired", message: "transfer expired" })
  return new TransferError({ code: "conflict", message: "transfer conflict" })
}

function toTransferError(error: unknown): TransferError {
  if (error instanceof TransferError) return error
  if (error instanceof LegacyProjectionError)
    return new TransferError({
      code: forbiddenProjectionCodes.has(error.code) ? "forbidden" : "conflict",
      message: "restore rejected",
    })
  return mapSpoolError(error)
}
