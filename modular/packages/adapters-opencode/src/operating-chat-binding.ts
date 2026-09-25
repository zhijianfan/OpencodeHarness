import { normalize } from "node:path"
import type {
  OperatingChatBindingError,
  OperatingChatDescriptor,
  OperatingChatProfile,
} from "@cybermastery/contracts/operating-chat"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { sql, type SQL } from "drizzle-orm"
import { Effect, Option } from "effect"
import { EventBoundary } from "./event-boundary"
import { requireV2Session } from "./session-classification"

const MIGRATION_ID = "0010-operating-chat-binding"
const FUNCTIONALITY_ID = "builtin:operating-chat-session" as const

type BindingRow = {
  readonly workspace_id: string
  readonly block_id: string
  readonly instance_id: string
  readonly session_id: string
  readonly directory: string
  readonly workspace_name: string
  readonly operating_agent: string
  readonly generation: number
  readonly revision: number
  readonly deleted_at: number | null
}

export type OperatingChatAuthorizeInput = {
  readonly actor: { readonly userID: string; readonly workspaceID: string }
  readonly action: "bind" | "read" | "reset"
  readonly descriptor?: OperatingChatDescriptor
  readonly sessionID?: SessionSchema.ID
}

export type OperatingChatAuthorize = (
  input: OperatingChatAuthorizeInput,
) => Effect.Effect<void, OperatingChatBindingError>

export type OperatingChatBindingOptions = { readonly authorize: OperatingChatAuthorize }

export type OperatingChatBindInput = {
  readonly actor: { readonly userID: string; readonly workspaceID: string }
  readonly descriptor: OperatingChatDescriptor
  readonly sessionID: SessionSchema.ID
  readonly expectedRevision?: number
}

export type OperatingChatResetInput = {
  readonly actor: { readonly userID: string; readonly workspaceID: string }
  readonly sessionID: SessionSchema.ID
  readonly expectedRevision: number
}

export interface OperatingChatBindingInterface {
  readonly bind: (input: OperatingChatBindInput) => Effect.Effect<OperatingChatProfile, OperatingChatBindingError>
  readonly resolve: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<OperatingChatProfile | undefined, OperatingChatBindingError>
  readonly revalidate: (
    sessionID: SessionSchema.ID,
    profile: OperatingChatProfile,
  ) => Effect.Effect<void, OperatingChatBindingError>
  readonly reset: (input: OperatingChatResetInput) => Effect.Effect<void, OperatingChatBindingError>
}

/**
 * Trusted selected-host binding for a builtin OperatingChat session. It records
 * only the profile of an already-created native v2 Session; it never creates,
 * executes or deletes Sessions and never mutates native workspace/functionality
 * rows. Every write runs inside EventBoundary.transaction with an authorization
 * re-check and a fresh native read, and the revision is advanced with a SQL CAS
 * so competing connections cannot double-bind a block or a Session.
 */
export function makeOperatingChatBinding(
  options: OperatingChatBindingOptions,
): Effect.Effect<OperatingChatBindingInterface, never, Database.Service | SessionV2.Service | EventBoundary> {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const boundary = yield* EventBoundary

    const get = <T>(statement: SQL) =>
      database.db.get<T>(statement).pipe(Effect.mapError(() => bindingError("conflict")))
    const run = (statement: SQL) =>
      database.db.run(statement).pipe(Effect.mapError(() => bindingError("conflict")))

    const write = <A>(body: Effect.Effect<A, OperatingChatBindingError>) =>
      boundary.transaction(body).pipe(
        Effect.mapError((error) => (isBindingError(error) ? error : bindingError("conflict"))),
      )

    const classify = (sessionID: SessionSchema.ID) =>
      requireV2Session(sessionID).pipe(Effect.provideService(Database.Service, database), Effect.option)

    // A projected Session and its durable row must agree: neither a fabricated
    // placement nor a missing native Session can authorize this binding.
    const readNativeSession = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const native = yield* sessions.get(sessionID).pipe(Effect.mapError(() => bindingError("missing-session")))
        const row = yield* get<{ directory: string; workspace_id: string | null }>(sql`
          SELECT directory, workspace_id FROM session WHERE id = ${sessionID}`)
        if (!row) return yield* Effect.fail(bindingError("missing-session"))
        if (row.workspace_id === null) return yield* Effect.fail(bindingError("invalid"))
        if (normalize(native.location.directory) !== normalize(row.directory) ||
          native.location.workspaceID !== WorkspaceV2.ID.make(row.workspace_id))
          return yield* Effect.fail(bindingError("invalid"))
        return { directory: row.directory, workspaceID: WorkspaceV2.ID.make(row.workspace_id) }
      })

    const verifySession = (descriptor: OperatingChatDescriptor, sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const session = yield* readNativeSession(sessionID)
        if (session.workspaceID !== WorkspaceV2.ID.make(descriptor.workspaceID)) {
          return yield* Effect.fail(bindingError("unauthorized"))
        }
        if (session.directory !== descriptor.directory) return yield* Effect.fail(bindingError("invalid"))
        const classified = yield* classify(sessionID)
        if (Option.isNone(classified)) return yield* Effect.fail(bindingError("invalid"))
      })

    const readBinding = (workspaceID: string, blockID: string) =>
      get<BindingRow>(sql`
        SELECT workspace_id, block_id, instance_id, session_id, directory, workspace_name, operating_agent,
               generation, revision, deleted_at
        FROM cm_operating_chat_binding
        WHERE workspace_id = ${workspaceID} AND block_id = ${blockID}`)

    // The binding table lives in the selected native database. cm_migration is
    // the cybermastery ledger; the native drizzle ledger is never touched.
    const ensureSchema = Effect.gen(function* () {
      yield* run(sql`
        CREATE TABLE IF NOT EXISTS cm_operating_chat_binding (
          workspace_id TEXT NOT NULL,
          block_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          directory TEXT NOT NULL,
          workspace_name TEXT NOT NULL,
          operating_agent TEXT NOT NULL,
          generation INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          deleted_at INTEGER,
          PRIMARY KEY (workspace_id, block_id)
        )`)
      yield* run(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS cm_operating_chat_binding_active_session_idx
        ON cm_operating_chat_binding (session_id) WHERE deleted_at IS NULL`)
      yield* run(sql`CREATE TABLE IF NOT EXISTS cm_migration (id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL)`)
      yield* run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at) VALUES (${MIGRATION_ID}, ${Date.now()})`)
    })

    yield* write(ensureSchema).pipe(Effect.orDie)

    const verifyStoredBinding = (row: BindingRow) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(row.session_id)
        const session = yield* readNativeSession(sessionID)
        if (session.workspaceID !== WorkspaceV2.ID.make(row.workspace_id)) {
          return yield* Effect.fail(bindingError("stale"))
        }
        if (session.directory !== row.directory) return yield* Effect.fail(bindingError("stale"))
        const classified = yield* classify(sessionID)
        if (Option.isNone(classified)) return yield* Effect.fail(bindingError("stale"))
      })

    const resolve = (
      sessionID: SessionSchema.ID,
    ): Effect.Effect<OperatingChatProfile | undefined, OperatingChatBindingError> =>
      Effect.gen(function* () {
        const row = yield* get<BindingRow>(sql`
          SELECT workspace_id, block_id, instance_id, session_id, directory, workspace_name, operating_agent,
                 generation, revision, deleted_at
          FROM cm_operating_chat_binding
          WHERE session_id = ${sessionID} AND deleted_at IS NULL`)
        if (!row) return undefined
        const verified = yield* verifyStoredBinding(row).pipe(
          Effect.mapError(() => bindingError("stale")), Effect.option,
        )
        if (Option.isNone(verified)) return yield* Effect.fail(bindingError("stale"))
        return profileFromRow(row)
      })

    const revalidate = (
      sessionID: SessionSchema.ID,
      profile: OperatingChatProfile,
    ): Effect.Effect<void, OperatingChatBindingError> =>
      Effect.gen(function* () {
        const current = yield* resolve(sessionID)
        if (!current) return yield* Effect.fail(bindingError("stale"))
        if (!sameProfile(current, profile)) return yield* Effect.fail(bindingError("stale"))
      })

    const bind = (input: OperatingChatBindInput): Effect.Effect<OperatingChatProfile, OperatingChatBindingError> =>
      Effect.gen(function* () {
        const { actor, descriptor, sessionID, expectedRevision } = input
        if (
          !isNonEmpty(actor.userID) ||
          !isNonEmpty(actor.workspaceID) ||
          !isNonEmpty(descriptor.workspaceID) ||
          !isNonEmpty(descriptor.blockID) ||
          !isNonEmpty(descriptor.functionalityInstanceID) ||
          !isNonEmpty(descriptor.workspaceName) ||
          !isNonEmpty(descriptor.operatingAgent) ||
          !isNonEmpty(descriptor.directory) ||
          !isNonEmpty(sessionID) ||
          (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
        ) {
          return yield* Effect.fail(bindingError("invalid"))
        }
        if (descriptor.workspaceID !== actor.workspaceID) return yield* Effect.fail(bindingError("unauthorized"))
        yield* options.authorize({ actor, action: "bind", descriptor, sessionID })
        yield* verifySession(descriptor, sessionID)
        return yield* write(
          Effect.gen(function* () {
            yield* options.authorize({ actor, action: "bind", descriptor, sessionID })
            yield* verifySession(descriptor, sessionID)
            const duplicate = yield* get<{ workspace_id: string; block_id: string }>(sql`
              SELECT workspace_id, block_id FROM cm_operating_chat_binding
              WHERE session_id = ${sessionID} AND deleted_at IS NULL`)
            if (
              duplicate &&
              (duplicate.workspace_id !== descriptor.workspaceID || duplicate.block_id !== descriptor.blockID)
            ) {
              return yield* Effect.fail(bindingError("conflict"))
            }
            const existing = yield* readBinding(descriptor.workspaceID, descriptor.blockID)
            const active = existing && existing.deleted_at === null ? existing : undefined
            if (active) {
              if (expectedRevision === undefined) return yield* Effect.fail(bindingError("conflict"))
              if (active.revision !== expectedRevision) return yield* Effect.fail(bindingError("stale"))
              yield* run(sql`
                UPDATE cm_operating_chat_binding
                SET instance_id = ${descriptor.functionalityInstanceID},
                    session_id = ${sessionID},
                    directory = ${descriptor.directory},
                    workspace_name = ${descriptor.workspaceName},
                    operating_agent = ${descriptor.operatingAgent},
                    generation = ${active.generation + 1},
                    revision = ${active.revision + 1},
                    deleted_at = NULL
                WHERE workspace_id = ${descriptor.workspaceID} AND block_id = ${descriptor.blockID}
                  AND revision = ${expectedRevision} AND deleted_at IS NULL`)
              const updated = yield* readBinding(descriptor.workspaceID, descriptor.blockID)
              if (!updated || updated.deleted_at !== null || updated.revision !== expectedRevision + 1) {
                return yield* Effect.fail(bindingError("stale"))
              }
            } else {
              if (expectedRevision !== undefined) return yield* Effect.fail(bindingError("stale"))
              yield* run(sql`
                INSERT INTO cm_operating_chat_binding
                  (workspace_id, block_id, instance_id, session_id, directory, workspace_name, operating_agent,
                   generation, revision, deleted_at)
                VALUES (${descriptor.workspaceID}, ${descriptor.blockID}, ${descriptor.functionalityInstanceID},
                        ${sessionID}, ${descriptor.directory}, ${descriptor.workspaceName},
                        ${descriptor.operatingAgent}, ${existing ? existing.generation + 1 : 1},
                        ${existing ? existing.revision + 1 : 1}, NULL)
                ON CONFLICT(workspace_id, block_id) DO UPDATE SET
                  instance_id = excluded.instance_id,
                  session_id = excluded.session_id,
                  directory = excluded.directory,
                  workspace_name = excluded.workspace_name,
                  operating_agent = excluded.operating_agent,
                  generation = excluded.generation,
                  revision = excluded.revision,
                  deleted_at = NULL
                WHERE cm_operating_chat_binding.deleted_at IS NOT NULL`)
            }
            const stored = yield* readBinding(descriptor.workspaceID, descriptor.blockID)
            if (!stored || stored.deleted_at !== null) return yield* Effect.fail(bindingError("conflict"))
            return profileFromRow(stored)
          }),
        )
      })

    const reset = (input: OperatingChatResetInput): Effect.Effect<void, OperatingChatBindingError> =>
      Effect.gen(function* () {
        const { actor, sessionID, expectedRevision } = input
        if (!isNonEmpty(actor.userID) || !isNonEmpty(actor.workspaceID) || !isNonEmpty(sessionID) ||
          !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
          return yield* Effect.fail(bindingError("invalid"))
        }
        yield* options.authorize({ actor, action: "reset", sessionID })
        yield* write(
          Effect.gen(function* () {
            yield* options.authorize({ actor, action: "reset", sessionID })
            const row = yield* get<{ revision: number; workspace_id: string }>(sql`
              SELECT revision, workspace_id FROM cm_operating_chat_binding
              WHERE session_id = ${sessionID} AND deleted_at IS NULL`)
            if (!row) return yield* Effect.fail(bindingError("stale"))
            if (row.workspace_id !== actor.workspaceID) return yield* Effect.fail(bindingError("unauthorized"))
            if (row.revision !== expectedRevision) return yield* Effect.fail(bindingError("stale"))
            yield* run(sql`
              UPDATE cm_operating_chat_binding
              SET deleted_at = ${Date.now()}, revision = ${expectedRevision + 1}
              WHERE session_id = ${sessionID} AND workspace_id = ${actor.workspaceID}
                AND deleted_at IS NULL AND revision = ${expectedRevision}`)
            const revoked = yield* get<{ revision: number }>(sql`
              SELECT revision FROM cm_operating_chat_binding
              WHERE session_id = ${sessionID} AND deleted_at IS NULL`)
            if (revoked) return yield* Effect.fail(bindingError("stale"))
          }),
        )
      })

    return { bind, resolve, revalidate, reset }
  })
}

function bindingError(code: OperatingChatBindingError["code"]): OperatingChatBindingError {
  return { _tag: "OperatingChatBinding.Error", code }
}

function isBindingError(error: unknown): error is OperatingChatBindingError {
  if (typeof error !== "object" || error === null) return false
  if (!("_tag" in error)) return false
  return error._tag === "OperatingChatBinding.Error"
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function profileFromRow(row: BindingRow): OperatingChatProfile {
  return {
    kind: "operating-chat",
    workspaceID: row.workspace_id,
    workspaceName: row.workspace_name,
    blockID: row.block_id,
    functionalityID: FUNCTIONALITY_ID,
    functionalityInstanceID: row.instance_id,
    generation: row.generation,
    revision: row.revision,
    directory: row.directory,
    operatingAgent: row.operating_agent,
  }
}

function sameProfile(current: OperatingChatProfile, expected: OperatingChatProfile): boolean {
  return (
    current.kind === expected.kind &&
    current.workspaceID === expected.workspaceID &&
    current.workspaceName === expected.workspaceName &&
    current.blockID === expected.blockID &&
    current.functionalityID === expected.functionalityID &&
    current.functionalityInstanceID === expected.functionalityInstanceID &&
    current.generation === expected.generation &&
    current.revision === expected.revision &&
    current.directory === expected.directory &&
    current.operatingAgent === expected.operatingAgent
  )
}
