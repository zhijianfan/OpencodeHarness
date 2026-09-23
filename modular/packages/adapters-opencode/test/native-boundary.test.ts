import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { createKernel, initializeExtension } from "../src/kernel"
import { admit, AdmissionError, type AdmissionPolicy } from "../src/admission"
import { FullParityUnavailable, requireFullParity } from "../src/capabilities"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanupAfterTests = databaseCleanup()

const sessionID = SessionSchema.ID.make("ses_native_proof")
const messageID = SessionMessage.ID.make("msg_native_proof")
const request = {
  sessionID,
  messageID,
  actor: { userID: "proof-user", workspaceID: "proof-workspace" },
  text: "Clean user prompt",
  delivery: "steer" as const,
  references: [{ id: "pack-1", contentHash: "revision-1" }],
  resume: false,
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-native-"))
  const runtime = createKernel(join(directory, "proof.db"))
  await runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* initializeExtension
    yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('proof-project', ${directory}, '[]', 0, 0)`)
    yield* database.db.run(sql`INSERT INTO session
      (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'proof-project', 'proof', ${directory}, 'Proof', '1', 0, 0)`)
  })).catch(async (error: unknown) => {
    await runtime.dispose()
    cleanupAfterTests(directory)
    throw error
  })
  return {
    directory,
    runtime,
    async [Symbol.asyncDispose]() {
      await runtime.dispose()
      cleanupAfterTests(directory)
    },
  }
}

describe("official native boundary", () => {
  test("resolves exported modules and Effect to the actual official source graph", async () => {
    const base = dirname(fileURLToPath(import.meta.url))
    const vendor = resolve(base, "../../../../vendor/opencode")
    const native = createRequire(join(vendor, "packages/core/package.json"))
    expect(await realpath(Bun.resolveSync("@opencode-ai/core/event", base))).toBe(
      await realpath(join(vendor, "packages/core/src/event.ts")),
    )
    expect(await realpath(Bun.resolveSync("effect", base))).toBe(await realpath(native.resolve("effect")))
  })

  test("keeps one native database and Event service per external kernel", async () => {
    await using env = await fixture()
    const first = await env.runtime.runPromise(Effect.all([Database.Service, EventV2.Service]))
    const second = await env.runtime.runPromise(Effect.all([Database.Service, EventV2.Service]))
    expect(first[0]).toBe(second[0])
    expect(first[1]).toBe(second[1])
  })

  test("commits clean native admission with private input and reuses the exact snapshot", async () => {
    await using env = await fixture()
    const calls = { freeze: 0, wake: 0 }
    const policy: AdmissionPolicy = {
      authorize: () => Effect.void,
      freeze: () => Effect.sync(() => {
        calls.freeze++
        return { apiContent: "Immutable private input", rendererVersion: 1 }
      }),
    }
    const wake = () => Effect.sync(() => { calls.wake++ })
    await env.runtime.runPromise(admit(request, policy, wake))
    await env.runtime.runPromise(admit(request, policy, wake))
    expect(calls).toEqual({ freeze: 1, wake: 0 })
    const value = await env.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return {
        input: yield* SessionInput.find(database.db, messageID),
        private: yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input WHERE message_id = ${messageID}`),
        public: yield* database.db.get<{ data: string }>(sql`SELECT data FROM event WHERE aggregate_id = ${sessionID}`),
      }
    }))
    expect(value.input?.prompt.text).toBe("Clean user prompt")
    expect(value.private?.api_content).toBe("Immutable private input")
    expect(JSON.stringify(value.public)).not.toContain("Immutable private input")
    await env.runtime.runPromise(admit({ ...request, resume: true }, policy, wake))
    expect(calls).toEqual({ freeze: 1, wake: 1 })
    const conflict = await env.runtime.runPromise(admit({ ...request, references: [{ id: "pack-1", contentHash: "revision-2" }] }, policy, wake).pipe(Effect.flip))
    if (!(conflict instanceof AdmissionError)) throw conflict
    expect(conflict.code).toBe("conflict")
    expect(calls.freeze).toBe(1)
  })

  test("reopens the database and reuses the admitted snapshot without recalling again", async () => {
    await using env = await fixture()
    const calls = { freeze: 0 }
    const policy: AdmissionPolicy = {
      authorize: () => Effect.void,
      freeze: () => Effect.sync(() => {
        calls.freeze++
        return { apiContent: "Frozen before restart", rendererVersion: 1 }
      }),
    }
    await env.runtime.runPromise(admit(request, policy, () => Effect.void))
    await env.runtime.dispose()
    const reopened = createKernel(join(env.directory, "proof.db"))
    try {
      await reopened.runPromise(admit(request, {
        authorize: policy.authorize,
        freeze: () => Effect.die("exact retry must not recall after restart"),
      }, () => Effect.void))
      const stored = await reopened.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        return yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input WHERE message_id = ${messageID}`)
      }))
      expect(stored?.api_content).toBe("Frozen before restart")
      expect(calls.freeze).toBe(1)
    } finally {
      await reopened.dispose()
    }
  })

  test("rolls back native input and event if the private sidecar commit fails", async () => {
    await using env = await fixture()
    await env.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(sql`CREATE TRIGGER reject_sidecar BEFORE INSERT ON cm_private_input
        BEGIN SELECT RAISE(ABORT, 'injected sidecar failure'); END`)
    }))
    const result = await env.runtime.runPromise(admit(request, {
      authorize: () => Effect.void,
      freeze: () => Effect.succeed({ apiContent: "Private input", rendererVersion: 1 }),
    }, () => Effect.die("must not wake")).pipe(Effect.exit))
    expect(result._tag).toBe("Failure")
    const rows = await env.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return {
        input: yield* SessionInput.find(database.db, messageID),
        events: yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`),
        private: yield* database.db.all(sql`SELECT message_id FROM cm_private_input`),
      }
    }))
    expect(rows).toEqual({ input: undefined, events: [], private: [] })
  })

  test("characterizes native sequential replay: a later failure leaves earlier public admission committed", async () => {
    await using env = await fixture()
    const evidence = await env.runtime.runPromise(Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const first = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
        seq: 0,
        aggregateID: sessionID,
        data: { sessionID, messageID, timestamp: Date.now(), prompt: { text: request.text }, delivery: "steer" },
      }
      const result = yield* events.replayAll([first, { ...first, id: EventV2.ID.create(), seq: 1, type: "unsupported.private-event" }]).pipe(Effect.exit)
      return {
        result: result._tag,
        input: yield* SessionInput.find(database.db, messageID),
        private: yield* database.db.all(sql`SELECT message_id FROM cm_private_input`),
        hasReplayBatch: "replayBatch" in events,
      }
    }))
    expect(evidence.result).toBe("Failure")
    expect(evidence.input?.prompt.text).toBe(request.text)
    expect(evidence.private).toEqual([])
    expect(evidence.hasReplayBatch).toBe(false)
  })

  test("an outer transaction rolls back rows but does not defer native replay notifications", async () => {
    await using env = await fixture()
    const notified: string[] = []
    const state = await env.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) => Effect.sync(() => { notified.push(event.type) }))
      const result = yield* database.db.transaction(() => Effect.gen(function* () {
        yield* events.replayAll([{
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
          seq: 0,
          aggregateID: sessionID,
          data: { sessionID, messageID, timestamp: Date.now(), prompt: { text: request.text }, delivery: "steer" },
        }], { publish: true })
        return yield* Effect.fail(new Error("injected outer rollback"))
      })).pipe(Effect.exit)
      return { result: result._tag, input: yield* SessionInput.find(database.db, messageID) }
    }))
    expect(state).toEqual({ result: "Failure", input: undefined })
    expect(notified).toEqual([SessionEvent.PromptAdmitted.type])
  })

  test("refuses full-parity startup while mandatory native integration remains unproven", () => {
    expect(requireFullParity).toThrow(FullParityUnavailable)
    expect(new FullParityUnavailable().missing).toContain("atomicPrivateReplay")
    expect(new FullParityUnavailable().missing).toContain("privateProviderReconstruction")
  })
})
