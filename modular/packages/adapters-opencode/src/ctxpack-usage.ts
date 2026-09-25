// CtxPack admitted-use ledger adapter.
//
// Records durable, verified pack attachments against the SAME selected native
// database as the host kernel and the authorized CtxPack catalog. This module
// owns exactly one extension table, `cm_ctx_pack_usage_admission`, bootstrapped
// under `cm_migration` id `0009-ctxpack-usage`:
//
//   cm_ctx_pack_usage_admission (ctx_pack_id, session_input_id, time_recorded)
//
// It composes the existing catalog for pack visibility and never opens a second
// catalog or provider loop. Every mutation for one admission runs inside a
// single `EventBoundary.transaction`, so change hints are delivered only after
// the owning transaction commits and are dropped when it rolls back. The
// database stays authoritative; hints carry only identifiers and revision
// metadata.
//
// Selected-host security boundary: unlike the baseline generic ledger, an
// admission is recorded only when the caller-supplied `sessionInputID` is a
// native `session_input` row whose owning `session.workspace_id` matches the
// caller's workspace. Unverified identifiers never reach the ledger, the pack
// counters, or the event stream. The caller supplies the actor and the already
// verified admitted input id explicitly; a session input may be admitted before
// promotion and no provider execution is required.

import type {
  CtxPackAccess,
  CtxPackActor,
  CtxPackChanged,
  CtxPackError,
} from "@cybermastery/contracts/ctxpack"
import { Database } from "@opencode-ai/core/database/database"
import { sql } from "drizzle-orm"
import { Cause, Effect } from "effect"
import { isCtxPackError } from "@cybermastery/domain/ctxpack-content"
import type { CtxPackCatalog } from "./ctxpack-catalog"
import { EventBoundary } from "./event-boundary"

type Db = Database.Interface["db"]

export interface CtxPackUsageOptions {
  readonly catalog: CtxPackCatalog
  readonly authorize: (request: CtxPackAccess) => Effect.Effect<void, CtxPackError>
  readonly publish?: (event: CtxPackChanged) => Effect.Effect<void>
  readonly now?: () => number
}

export interface CtxPackAdmittedUseInput {
  readonly workspaceID: string
  readonly userID: string
  readonly ctxPackIDs: readonly string[]
  readonly sessionInputID: string
  readonly admittedAt: number
}

export interface CtxPackUsagePort {
  readonly recordAdmittedUse: (input: CtxPackAdmittedUseInput) => Effect.Effect<void, CtxPackError>
}

const denied = (operation: string): CtxPackError => ({ _tag: "CtxPackPermissionDenied", operation })

// Unknown SQL/driver failures become sanitized defects; only domain errors fail
// the effect. Storage failures never leak driver detail or fragment text.
function toDomainError<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CtxPackError, R> {
  return effect.pipe(
    Effect.catch((error) =>
      isCtxPackError(error) ? Effect.fail(error) : Effect.die(new Error("CtxPack usage storage failure")),
    ),
    Effect.catchDefect(() => Effect.die(new Error("CtxPack usage storage failure"))),
  )
}

type ValidatedAdmission = {
  readonly workspaceID: string
  readonly userID: string
  readonly sessionInputID: string
  readonly admittedAt: number
  readonly ctxPackIDs: readonly string[]
}

// Detach and validate caller input synchronously before any await. Duplicate
// pack ids collapse in first-seen order (baseline DISTINCT). The baseline
// imposes no pack-count bound, so neither does this ledger.
function validateAdmission(input: CtxPackAdmittedUseInput): ValidatedAdmission | null {
  if (typeof input.workspaceID !== "string" || input.workspaceID.trim().length === 0) return null
  if (typeof input.userID !== "string" || input.userID.trim().length === 0) return null
  if (typeof input.sessionInputID !== "string" || input.sessionInputID.trim().length === 0) return null
  if (!Number.isSafeInteger(input.admittedAt) || input.admittedAt < 0) return null
  if (!Array.isArray(input.ctxPackIDs)) return null
  const ctxPackIDs = [...new Set(input.ctxPackIDs)]
  if (ctxPackIDs.some((id) => typeof id !== "string" || id.length === 0)) return null
  return {
    workspaceID: input.workspaceID,
    userID: input.userID,
    sessionInputID: input.sessionInputID,
    admittedAt: input.admittedAt,
    ctxPackIDs,
  }
}

function bootstrap(db: Db, now: number) {
  return db.transaction(() =>
    Effect.gen(function* () {
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_migration (
        id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL
      )`)
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_ctx_pack_usage_admission (
        ctx_pack_id TEXT NOT NULL,
        session_input_id TEXT NOT NULL,
        time_recorded INTEGER NOT NULL,
        PRIMARY KEY (ctx_pack_id, session_input_id)
      )`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_usage_admission_session_idx
        ON cm_ctx_pack_usage_admission (session_input_id, ctx_pack_id)`)
      yield* db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
        VALUES ('0009-ctxpack-usage', ${now})`)
    }),
  )
}

export function makeCtxPackUsage(
  options: CtxPackUsageOptions,
): Effect.Effect<CtxPackUsagePort, never, Database.Service | EventBoundary> {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const boundary = yield* EventBoundary
    const db: Db = database.db
    const now = (): number => options.now?.() ?? Date.now()

    yield* bootstrap(db, now()).pipe(Effect.orDie)

    // Hints are advisory. Non-interrupt failures (typed or defects) are
    // swallowed silently; the durable ledger already committed.
    const publishHint = (event: CtxPackChanged): Effect.Effect<void> =>
      Effect.suspend(() => (options.publish ? options.publish(event) : Effect.void)).pipe(
        Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => Effect.void),
      )

    const recordAdmittedUse: CtxPackUsagePort["recordAdmittedUse"] = (input) =>
      toDomainError(
        Effect.gen(function* () {
          const validated = validateAdmission(input)
          if (validated === null) return yield* Effect.fail(denied("ctxpack.read"))
          const actor: CtxPackActor = { userID: validated.userID, workspaceID: validated.workspaceID }

          // Authorize every pack against its actual live row before any
          // mutation so an invalid, deleted, foreign, or denied pack aborts
          // without touching the ledger or the counters.
          for (const ctxPackID of validated.ctxPackIDs) {
            const pack = yield* options.catalog.get(actor, ctxPackID)
            yield* options.authorize({ actor, operation: "ctxpack.read", pack })
          }

          const newlyCounted: Array<{ readonly ctxPackID: string; readonly revision: number }> = []

          yield* boundary.transaction(
            Effect.gen(function* () {
              // Verified admission: the admitted input must be a native
              // session_input owned by the caller's workspace. A foreign or
              // missing id is a typed denial and writes nothing.
              const admitted = yield* db.get<{ id: string }>(sql`SELECT si.id AS id FROM session_input si
                JOIN session s ON s.id = si.session_id
                WHERE si.id = ${validated.sessionInputID} AND s.workspace_id = ${validated.workspaceID}`)
              if (!admitted) return yield* Effect.fail(denied("ctxpack.read"))

              for (const ctxPackID of validated.ctxPackIDs) {
                // Re-read and re-authorize inside the write transaction so a
                // change or revocation between the initial check and commit
                // cannot count.
                const pack = yield* options.catalog.get(actor, ctxPackID)
                yield* options.authorize({ actor, operation: "ctxpack.read", pack })

                const inserted = yield* db.get<{ ctx_pack_id: string }>(sql`INSERT INTO cm_ctx_pack_usage_admission
                  (ctx_pack_id, session_input_id, time_recorded)
                  VALUES (${ctxPackID}, ${validated.sessionInputID}, ${validated.admittedAt})
                  ON CONFLICT DO NOTHING RETURNING ctx_pack_id`)
                if (!inserted) continue

                yield* db.run(sql`UPDATE cm_ctx_pack
                  SET attached_count = attached_count + 1,
                    last_attached_at = MAX(COALESCE(last_attached_at, ${validated.admittedAt}), ${validated.admittedAt})
                  WHERE id = ${ctxPackID} AND workspace_id = ${validated.workspaceID}`)
                const row = yield* db.get<{ revision: number }>(sql`SELECT revision FROM cm_ctx_pack
                  WHERE id = ${ctxPackID} AND workspace_id = ${validated.workspaceID}`)
                newlyCounted.push({ ctxPackID, revision: row?.revision ?? 0 })
              }
            }),
          )

          // Queue one hint per freshly counted pack on the owning transaction:
          // delivered only after commit, dropped on rollback, and never emitted
          // for a duplicate admission.
          yield* Effect.forEach(newlyCounted, (counted) => boundary.afterCommit(publishHint({
            type: "workspace.ctxpack.changed",
            properties: {
              workspaceID: validated.workspaceID,
              ctxPackID: counted.ctxPackID,
              revision: counted.revision,
              change: "used",
            },
          })), { discard: true })
        }),
      )

    return { recordAdmittedUse } satisfies CtxPackUsagePort
  })
}
