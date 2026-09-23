import type { Actor, BlockDescriptor, Layout, LayoutTuple } from "@cybermastery/contracts/layout"
import { LayoutError, type LayoutRepository } from "@cybermastery/domain/layout"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { createMediatedKernel } from "./kernel"

const LayoutUpdated = EventV2.define({
  type: "workspace.layout.updated",
  schema: { workspaceID: Schema.String, revision: Schema.Number },
})

type Row = { id: string; workspace_id: string; revision: number; blocks: string }
const fromRow = (row: Row): Layout => ({
  id: row.id,
  workspaceID: row.workspace_id,
  revision: row.revision,
  blocks: JSON.parse(row.blocks) as BlockDescriptor[],
})

/** Same native database service, extension-owned tables and migration ledger. */
export async function createLayoutRepository(input: {
  readonly filename: string
  readonly workspaceID: string
  readonly ownerID: string
}) {
  const runtime = createMediatedKernel(input.filename)
  const database = await runtime.runPromise(Database.Service)
  const events = await runtime.runPromise(EventV2.Service)
  const db = database.db
  await runtime.runPromise(db.transaction(() => Effect.gen(function* () {
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_migration (id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)`)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_workspace (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL)`)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_layout (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cm_workspace(id),
      user_id TEXT NOT NULL, style TEXT NOT NULL, device_class TEXT NOT NULL,
      revision INTEGER NOT NULL, blocks TEXT NOT NULL,
      UNIQUE(workspace_id, user_id, style, device_class)
    )`)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_layout_authority (
      layout_id TEXT PRIMARY KEY REFERENCES cm_layout(id), holder_id TEXT NOT NULL
    )`)
    yield* db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at) VALUES ('0002-layout-proof', ${Date.now()})`)
    yield* db.run(sql`INSERT OR IGNORE INTO cm_workspace (id, owner_id) VALUES (${input.workspaceID}, ${input.ownerID})`)
  }))).catch(async (error: unknown) => {
    await runtime.dispose()
    throw error
  })

  const authorize = (actor: Actor, workspaceID: string, tuple: LayoutTuple) => Effect.gen(function* () {
    if (actor.userID !== tuple.user) return yield* Effect.fail(new LayoutError("forbidden"))
    const row = yield* db.get<{ owner_id: string }>(sql`SELECT owner_id FROM cm_workspace WHERE id = ${workspaceID}`)
    if (!row) return yield* Effect.fail(new LayoutError("not-found"))
    if (row.owner_id !== actor.userID) return yield* Effect.fail(new LayoutError("forbidden"))
  })
  const find = (workspaceID: string, tuple: LayoutTuple) => db.get<Row>(sql`SELECT id, workspace_id, revision, blocks FROM cm_layout
    WHERE workspace_id = ${workspaceID} AND user_id = ${tuple.user} AND style = ${tuple.style} AND device_class = ${tuple.deviceClass}`)

  const repository: LayoutRepository = {
    get: (actor, workspaceID, tuple, clientID, claimAuthority = true) => runtime.runPromise(db.transaction(() => Effect.gen(function* () {
      yield* authorize(actor, workspaceID, tuple)
      yield* db.run(sql`INSERT OR IGNORE INTO cm_layout
        (id, workspace_id, user_id, style, device_class, revision, blocks)
        VALUES (${crypto.randomUUID()}, ${workspaceID}, ${tuple.user}, ${tuple.style}, ${tuple.deviceClass}, 0, '[]')`)
      const row = yield* find(workspaceID, tuple)
      if (!row) return yield* Effect.fail(new LayoutError("not-found"))
      if (claimAuthority) {
        yield* db.run(sql`INSERT INTO cm_layout_authority (layout_id, holder_id) VALUES (${row.id}, ${clientID})
          ON CONFLICT(layout_id) DO UPDATE SET holder_id = excluded.holder_id`)
      }
      return fromRow(row)
    }), { behavior: "immediate" })),
    save: (actor, command) => runtime.runPromise(Effect.gen(function* () {
      const result = yield* db.transaction(() => Effect.gen(function* () {
        yield* authorize(actor, command.workspaceID, command.tuple)
        const row = yield* find(command.workspaceID, command.tuple)
        if (!row) return yield* Effect.fail(new LayoutError("not-found"))
        const authority = yield* db.get<{ holder_id: string }>(sql`SELECT holder_id FROM cm_layout_authority WHERE layout_id = ${row.id}`)
        if (authority?.holder_id !== command.clientID) return yield* Effect.fail(new LayoutError("handed-over", row.revision))
        if (row.revision !== command.expectedRevision) return yield* Effect.fail(new LayoutError("conflict", row.revision))
        const updated = yield* db.get<Row>(sql`UPDATE cm_layout SET revision = revision + 1, blocks = ${JSON.stringify(command.blocks)}
          WHERE id = ${row.id} AND revision = ${command.expectedRevision}
            AND EXISTS (SELECT 1 FROM cm_layout_authority WHERE layout_id = ${row.id} AND holder_id = ${command.clientID})
          RETURNING id, workspace_id, revision, blocks`)
        if (!updated) return yield* Effect.fail(new LayoutError("conflict", row.revision))
        return fromRow(updated)
      }), { behavior: "immediate" })
      yield* events.publish(LayoutUpdated, { workspaceID: result.workspaceID, revision: result.revision })
      return result
    })),
  }

  return {
    repository,
    listen: (handler: (event: { type: string; properties: { workspaceID: string; revision: number } }) => void) =>
      runtime.runPromise(events.listen((event) => {
        if (event.type !== LayoutUpdated.type) return Effect.void
        const properties = Schema.decodeUnknownSync(LayoutUpdated.data)(event.data)
        return Effect.sync(() => handler({ type: event.type, properties }))
      })).then((unsubscribe) => () => runtime.runPromise(unsubscribe)),
    dispose: () => runtime.dispose(),
  }
}
