import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { makeEventBoundaryNode, makeMediatedEventNode } from "./event-boundary"

/** A proof kernel, not a production Session/HTTP host. All native modules are official source packages. */
export function createKernel(filename: string) {
  if (filename.length === 0) throw new Error("An explicit database filename is required")
  const database = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(filename),
    deps: [],
  })
  return ManagedRuntime.make(
    AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
      [Database.node, database],
    ]),
  )
}

export function createMediatedKernel(filename: string, options: Parameters<typeof makeEventBoundaryNode>[0] = {}) {
  if (filename.length === 0) throw new Error("An explicit database filename is required")
  const database = makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(filename), deps: [] })
  const boundary = makeEventBoundaryNode(options)
  return ManagedRuntime.make(AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, boundary]),
    [[Database.node, database], [EventV2.node, makeMediatedEventNode(boundary)]],
  ))
}

export const initializeExtension = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.transaction(() =>
    Effect.gen(function* () {
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_migration (
        id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL
      )`)
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_private_input (
        message_id TEXT PRIMARY KEY NOT NULL REFERENCES session_input(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL, api_content TEXT NOT NULL, api_content_hash TEXT NOT NULL,
        renderer_version INTEGER NOT NULL
      )`)
      yield* database.db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
        VALUES ('0001-private-admission-proof', ${Date.now()})`)
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_private_checkpoint (
        message_id TEXT PRIMARY KEY NOT NULL REFERENCES session_message(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        context_json TEXT NOT NULL
      )`)
      yield* database.db.run(sql`CREATE TABLE IF NOT EXISTS cm_private_requirement (
        message_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('input', 'compaction'))
      )`)
      yield* database.db.run(sql`INSERT OR IGNORE INTO cm_private_requirement (message_id, session_id, kind)
        SELECT message_id, session_id, 'input' FROM cm_private_input`)
      yield* database.db.run(sql`CREATE TRIGGER IF NOT EXISTS cm_private_input_deleted AFTER DELETE ON session_input
        BEGIN DELETE FROM cm_private_requirement WHERE message_id = OLD.id AND kind = 'input'; END`)
      yield* database.db.run(sql`CREATE TRIGGER IF NOT EXISTS cm_private_checkpoint_deleted AFTER DELETE ON session_message
        BEGIN DELETE FROM cm_private_requirement WHERE message_id = OLD.id AND kind = 'compaction'; END`)
      yield* database.db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
        VALUES ('0003-private-context-records', ${Date.now()})`)
    }),
  )
})
