import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { createMediatedKernel, initializeExtension } from "../src/kernel"
import { databaseCleanup } from "../../../test-utils/cleanup"

export function createMediatedFixtures() {
  const cleanupAfterTests = databaseCleanup()
  return async function mediatedFixture(options: Parameters<typeof createMediatedKernel>[1] = {}) {
    const directory = await mkdtemp(join(tmpdir(), "cybermastery-mediated-"))
    const state: { runtime?: ReturnType<typeof createMediatedKernel> } = { runtime: createMediatedKernel(join(directory, "proof.db"), options) }
    const runtime = () => {
      if (!state.runtime) throw new Error("Fixture runtime already disposed")
      return state.runtime
    }
    const sessionID = SessionSchema.ID.make("ses_mediated")
    await runtime().runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      yield* initializeExtension
      yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('project', ${directory}, '[]', 0, 0)`)
      yield* database.db.run(sql`INSERT INTO session
        (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
        VALUES (${sessionID}, 'project', 'proof', ${SessionTable.directory.mapToDriverValue(directory)}, 'Proof', '1', 0, 0, 'workspace-proof')`)
    })).catch(async (error: unknown) => {
      await runtime().dispose()
      state.runtime = undefined
      cleanupAfterTests(directory)
      throw error
    })
    return {
      directory, sessionID,
      get runtime() { return runtime() },
      async [Symbol.asyncDispose]() {
        await runtime().dispose()
        state.runtime = undefined
        cleanupAfterTests(directory)
      },
    }
  }
}

export function admittedEvent(sessionID: SessionSchema.ID, seq: number, messageID = SessionMessage.ID.create()): EventV2.SerializedEvent {
  return {
    id: EventV2.ID.create(),
    type: EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
    seq, aggregateID: sessionID,
    data: { sessionID, messageID, timestamp: Date.now(), prompt: { text: "clean prompt" }, delivery: "steer" },
  }
}
