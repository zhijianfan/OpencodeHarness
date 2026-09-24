import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Schema, Stream } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary } from "../src/event-boundary"
import { makeLegacyProjection } from "../src/legacy-projection"
import { requireV2Session, recordV2SessionCreated, RuntimeClassificationError } from "../src/session-classification"
import { createSessionRuntime } from "../src/session-runtime"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const workspaceID = "wrk_classification"
const ownerID = "owner-classification"
const sessionID = SessionSchema.ID.make("ses_classification")
const secondSessionID = SessionSchema.ID.make("ses_classification_second")
const projection = makeLegacyProjection({ authorize: () => Effect.void })
const scope = { sessionID, workspaceID, ownerID }

const location = (directory: string) => ({
  directory: AbsolutePath.make(directory),
  workspaceID: WorkspaceV2.ID.make(workspaceID),
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-classification-"))
  cleanup(directory)
  const model = Model.make({ id: "classification-model", provider: "classification", route })
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    policy: {
      managed: () => Effect.succeed(true),
      authorize: () => Effect.void,
      freeze: () => Effect.die("freeze is not used by classification tests"),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: () => Stream.empty })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  return { runtime, directory }
}

const insertPlacement = (directory: string, id: SessionSchema.ID) => Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('project', ${directory}, '[]', 0, 0)`)
  yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
    VALUES (${id}, 'project', 'classification', ${directory}, 'Classification', '1', 0, 0, ${workspaceID})`)
})

function readInfoField(data: unknown, field: string): unknown {
  return Schema.decodeUnknownSync(Schema.Struct({ info: Schema.Record(Schema.String, Schema.Json) }))(data).info[field]
}

test("fresh creation classifies the runtime atomically without touching native event data", async () => {
  const target = await fixture()
  try {
    await target.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const created = yield* session.create({ id: sessionID, location: location(target.directory) })
      expect(created.id).toBe(sessionID)
      const runtime = yield* database.db.get<{ runtime: string }>(sql`
        SELECT runtime FROM cm_session_runtime WHERE session_id = ${sessionID}`)
      expect(runtime?.runtime).toBe("v2")
      const events = yield* database.db.all<{ id: string; data: string }>(sql`
        SELECT id, data FROM event WHERE aggregate_id = ${sessionID}`)
      expect(events).toHaveLength(1)
      const stored = events[0]
      if (!stored) throw new Error("missing created event")
      expect(readInfoField(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(stored.data), "runtime")).toBeUndefined()
      const metadata = yield* database.db.get<{ event_id: string }>(sql`
        SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`)
      expect(metadata?.event_id).toBe(stored.id)
      // Repeating the exact recording is idempotent: no extra event, runtime or
      // metadata row is produced.
      const boundary = yield* EventBoundary
      yield* boundary.transaction(recordV2SessionCreated(sessionID))
      expect((yield* session.create({ id: sessionID, location: location(target.directory) })).id).toBe(sessionID)
      expect(yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`)).toHaveLength(1)
      expect(yield* database.db.all(sql`SELECT session_id FROM cm_session_runtime WHERE session_id = ${sessionID}`)).toHaveLength(1)
      expect(yield* database.db.all(sql`SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`)).toHaveLength(1)
    }))
  } finally {
    await target.runtime.dispose()
  }
})

test("legacy export reconstructs runtime v2 from classification metadata", async () => {
  const target = await fixture()
  try {
    const bundle = await target.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      yield* session.create({ id: sessionID, location: location(target.directory) })
      yield* database.db.run(sql`UPDATE event_sequence SET owner_id = ${ownerID} WHERE aggregate_id = ${sessionID}`)
      return yield* projection.export(scope)
    }))
    expect(bundle.events).toHaveLength(1)
    const event = bundle.events[0]
    if (!event) throw new Error("missing exported event")
    expect(readInfoField(event.data, "runtime")).toBe("v2")
    expect(await target.runtime.runPromise(requireV2Session(sessionID))).toBeUndefined()
  } finally {
    await target.runtime.dispose()
  }
})

test("existing sessions with missing, legacy or mixed classification are adopted without reclassification", async () => {
  for (const state of [undefined, "legacy", "mixed"] as const) {
    const target = await fixture()
    try {
      await target.runtime.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        yield* insertPlacement(target.directory, sessionID)
        if (state) yield* database.db.run(sql`
          INSERT INTO cm_session_runtime (session_id, runtime) VALUES (${sessionID}, ${state})`)
        const session = yield* SessionV2.Service
        const adopted = yield* session.create({ id: sessionID, location: location(target.directory) })
        expect(adopted.id).toBe(sessionID)
        const stored = yield* database.db.get<{ runtime: string }>(sql`
          SELECT runtime FROM cm_session_runtime WHERE session_id = ${sessionID}`)
        expect(stored?.runtime).toBe(state)
        expect(yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`)).toHaveLength(0)
        expect(yield* database.db.all(sql`SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`)).toHaveLength(0)
      }))
    } finally {
      await target.runtime.dispose()
    }
  }
})

test("requireV2Session rejects missing, legacy and mixed classifications without writing", async () => {
  for (const state of [undefined, "legacy", "mixed"] as const) {
    const target = await fixture()
    try {
      const error = await target.runtime.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        yield* insertPlacement(target.directory, sessionID)
        if (state) yield* database.db.run(sql`
          INSERT INTO cm_session_runtime (session_id, runtime) VALUES (${sessionID}, ${state})`)
        return yield* requireV2Session(sessionID).pipe(Effect.flip)
      }))
      if (!(error instanceof RuntimeClassificationError)) throw new Error("expected classification error")
      expect(error.code).toBe(state === undefined ? "missing-runtime" : state === "legacy" ? "legacy-runtime" : "mixed-runtime")
      const rows = await target.runtime.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        return {
          runtimes: yield* database.db.all(sql`SELECT session_id FROM cm_session_runtime WHERE session_id = ${sessionID}`),
          metadata: yield* database.db.all(sql`SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`),
          events: yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`),
        }
      }))
      expect(rows.events).toEqual([])
      expect(rows.metadata).toEqual([])
      expect(rows.runtimes).toHaveLength(state === undefined ? 0 : 1)
    } finally {
      await target.runtime.dispose()
    }
  }
})

test("conflicting classification metadata fails and rolls back an outer boundary transaction with its notifications", async () => {
  const target = await fixture()
  try {
    const notifications: string[] = []
    const error = await target.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const boundary = yield* EventBoundary
      yield* session.create({ id: sessionID, location: location(target.directory) })
      const metadata = yield* database.db.get<{ event_id: string }>(sql`
        SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`)
      if (!metadata) throw new Error("missing classification metadata")
      yield* database.db.run(sql`UPDATE cm_legacy_event SET original_json = '{}' WHERE event_id = ${metadata.event_id}`)
      yield* events.listen((event) => Effect.sync(() => { notifications.push(event.id) }))
      return yield* boundary.transaction(Effect.gen(function* () {
        yield* session.create({ id: secondSessionID, location: location(target.directory) })
        return yield* recordV2SessionCreated(sessionID)
      })).pipe(Effect.flip)
    }))
    if (!(error instanceof RuntimeClassificationError)) throw new Error("expected classification error")
    expect(error.code).toBe("event-metadata-conflict")
    const after = await target.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return {
        sessions: yield* database.db.all(sql`SELECT id FROM session WHERE id = ${secondSessionID}`),
        events: yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${secondSessionID}`),
        runtimes: yield* database.db.all(sql`SELECT session_id FROM cm_session_runtime WHERE session_id = ${secondSessionID}`),
        metadata: yield* database.db.all(sql`SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${secondSessionID}`),
      }
    }))
    expect(after.sessions).toEqual([])
    expect(after.events).toEqual([])
    expect(after.runtimes).toEqual([])
    expect(after.metadata).toEqual([])
    expect(notifications).toEqual([])
  } finally {
    await target.runtime.dispose()
  }
})
