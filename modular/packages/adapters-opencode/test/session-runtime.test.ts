import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Config } from "@opencode-ai/core/config"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { LLMClient, LLMRequest, LLMEvent, Model, type LLMError } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { sql } from "drizzle-orm"
import { createSessionRuntime } from "../src/session-runtime"
import { PrivatePromptContext } from "../src/session-facade"
import type { RunnerIdentity } from "../src/runner"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()

type RuntimeFixture = {
  directory: string
  runtime: ReturnType<typeof createSessionRuntime>
  requests: LLMRequest[]
  constructed: RunnerIdentity[]
  frozen: { sessionID: string; messageID: string; workspaceID: string; apiContent: string }[]
}

function completedResponse() {
  return Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text" }), LLMEvent.textDelta({ id: "text", text: "answer" }),
    LLMEvent.textEnd({ id: "text" }), LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" }),
  ])
}

async function withRuntime(
  run: (fixture: RuntimeFixture) => Promise<void>,
  response: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> = completedResponse,
) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-runtime-"))
  cleanup(directory)
  const requests: LLMRequest[] = []
  const constructed: RunnerIdentity[] = []
  const frozen: RuntimeFixture["frozen"] = []
  const model = Model.make({ id: "proof-model", provider: "proof", route })
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    onRunnerConstruct: (identity) => { constructed.push(identity) },
    policy: {
      managed: () => Effect.succeed(true), authorize: () => Effect.void,
      // This allow-all policy belongs only to this disposable runtime. Every
      // caller still supplies its own actor and immutable private snapshot.
      freeze: (request) => Effect.sync(() => {
        const apiContent = `private snapshot ${request.sessionID} ${request.actor.workspaceID}: ${request.text}`
        frozen.push({ sessionID: request.sessionID, messageID: request.messageID, workspaceID: request.actor.workspaceID, apiContent })
        return { apiContent, rendererVersion: 1 }
      }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: ((request: LLMRequest) => {
        if (!(request instanceof LLMRequest)) return Stream.die("Expected canonical LLMRequest")
        requests.push(request)
        return response(request)
      }) as unknown as Effect.Success<typeof LLMClient.Service>["stream"] })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  try {
    await run({ directory, runtime, requests, constructed, frozen })
  } finally {
    await runtime.dispose()
  }
}

test("native Session prompt and resume route through the private runner using the native Location map and coordinator", async () => {
  await withRuntime(async ({ directory, runtime, requests, constructed, frozen }) => {
    await runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* SessionV2.Service
      const id = Session.ID.make("ses_integrated")
      yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_integrated', ${directory}, '[]', 0, 0)`)
      yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
        VALUES (${id}, 'proj_integrated', 'proof', ${directory}, 'Proof', '1', 0, 0, 'wrk_integrated')`)
      yield* session.prompt({ sessionID: id, prompt: { text: "public question" }, resume: false }).pipe(
        Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: "wrk_integrated" }, references: [] }),
      )
      expect(requests).toHaveLength(0)
      yield* session.resume(id)
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      expect(constructed).toHaveLength(1)
      expect(constructed[0].database).toBe(database)
      expect(constructed[0].events).toBe(events)
      expect(constructed[0].store).toBe(store)
      expect(requests).toHaveLength(1)
      expect(frozen).toHaveLength(1)
      expect(JSON.stringify(requests[0].messages)).toContain(frozen[0].apiContent)
      const history = yield* session.messages({ sessionID: id })
      expect(history.some((message) => message.type === "user" && message.text === "public question")).toBe(true)
      expect(JSON.stringify(history)).not.toContain(frozen[0].apiContent)
    }))
  })
}, 30_000)

test("native create adopts existing identity and isolates two Locations while sharing root services", async () => {
  await withRuntime(async ({ directory, runtime, requests, constructed, frozen }) => {
    const locations = [
      { directory: AbsolutePath.make(join(directory, "a")), workspaceID: WorkspaceV2.ID.make("wrk_runtime_a") },
      { directory: AbsolutePath.make(join(directory, "b")), workspaceID: WorkspaceV2.ID.make("wrk_runtime_b") },
    ]
    await Promise.all(locations.map((location) => mkdir(location.directory)))
    await runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const a = yield* session.create({ id: Session.ID.make("ses_runtime_created_a"), location: locations[0] })
      const b = yield* session.create({ id: Session.ID.make("ses_runtime_created_b"), location: locations[1] })
      expect(a.location).toEqual(locations[0])
      expect(b.location).toEqual(locations[1])
      const adopted = yield* session.create({ id: a.id, location: locations[1] })
      expect(adopted).toEqual(a)
      const retained = yield* session.get(a.id)
      expect(retained.id).toBe(a.id)
      expect(retained.location).toEqual(locations[0])

      yield* session.prompt({ sessionID: adopted.id, prompt: { text: "public question A" }, resume: false }).pipe(
        Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: locations[0].workspaceID }, references: [] }),
      )
      yield* session.prompt({ sessionID: b.id, prompt: { text: "public question B" }, resume: false }).pipe(
        Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: locations[1].workspaceID }, references: [] }),
      )
      expect(requests).toHaveLength(0)
      expect(frozen).toHaveLength(2)
      yield* session.resume(adopted.id)
      yield* session.resume(b.id)
      expect(requests).toHaveLength(2)
      expect(frozen).toHaveLength(2)
      expect(constructed).toHaveLength(2)
      expect(constructed[0]).not.toBe(constructed[1])
      expect(constructed[0].location).not.toBe(constructed[1].location)
      constructed.forEach((identity) => {
        expect(identity.database).toBe(database)
        expect(identity.events).toBe(events)
        expect(identity.store).toBe(store)
      })
      for (const info of [a, b]) {
        const identities = constructed.filter((identity) => identity.location.directory === info.location.directory)
        expect(identities).toHaveLength(1)
        expect(identities[0].location.workspaceID).toBe(info.location.workspaceID)
        const ownRequests = requests.filter((request) => new Headers(request.http?.headers).get("X-Session-Id") === info.id)
        expect(ownRequests).toHaveLength(1)
        const ownSnapshots = frozen.filter((snapshot) => snapshot.sessionID === info.id)
        expect(ownSnapshots).toHaveLength(1)
        expect(String(info.location.workspaceID)).toBe(ownSnapshots[0].workspaceID)
        expect(JSON.stringify(ownRequests[0].messages)).toContain(ownSnapshots[0].apiContent)
        const messages = yield* session.messages({ sessionID: info.id })
        const context = yield* session.context(info.id)
        const history = yield* session.history({ sessionID: info.id, limit: 100 })
        const publicText = info.id === a.id ? "public question A" : "public question B"
        const otherText = info.id === a.id ? "public question B" : "public question A"
        expect(messages.some((message) => message.type === "user" && message.text === publicText)).toBe(true)
        const transcript = JSON.stringify({ messages, context, history })
        expect(transcript).not.toContain(otherText)
        frozen.forEach((snapshot) => {
          expect(transcript).not.toContain(snapshot.apiContent)
          if (snapshot.sessionID !== info.id) expect(JSON.stringify(ownRequests[0].messages)).not.toContain(snapshot.apiContent)
        })
        expect(JSON.stringify(ownRequests[0].messages)).not.toContain(otherText)
      }
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("native coordinator joins one Session, isolates interruption, and resumes durable queued input without freezing again", async () => {
  const a = Session.ID.make("ses_runtime_concurrent_a")
  const b = Session.ID.make("ses_runtime_concurrent_b")
  const queuedID = SessionMessage.ID.make("msg_runtime_queued_a")
  const enteredA = Deferred.makeUnsafe<void>()
  const enteredB = Deferred.makeUnsafe<void>()
  const releaseA = Deferred.makeUnsafe<void>()
  const releaseB = Deferred.makeUnsafe<void>()
  const finalizedA = Deferred.makeUnsafe<void>()
  const finalizedB = Deferred.makeUnsafe<void>()
  const exitedB = Deferred.makeUnsafe<void>()
  const calls: string[] = []
  const finalizers: string[] = []

  await withRuntime(async ({ directory, runtime, requests, constructed, frozen }) => {
    const locationA = { directory: AbsolutePath.make(join(directory, "a")), workspaceID: WorkspaceV2.ID.make("wrk_concurrent_a") }
    const locationB = { directory: AbsolutePath.make(join(directory, "b")), workspaceID: WorkspaceV2.ID.make("wrk_concurrent_b") }
    await Promise.all([mkdir(locationA.directory), mkdir(locationB.directory)])
    await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* Effect.gen(function* () {
        yield* session.create({ id: a, location: locationA })
        yield* session.create({ id: b, location: locationB })
        yield* session.prompt({ sessionID: a, prompt: { text: "public active A" }, resume: false }).pipe(
          Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: locationA.workspaceID }, references: [] }),
        )
        yield* session.prompt({ sessionID: b, prompt: { text: "public active B" }, resume: false }).pipe(
          Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: locationB.workspaceID }, references: [] }),
        )
        expect(frozen).toHaveLength(2)
        expect(requests).toHaveLength(0)

        const first = yield* session.resume(a).pipe(Effect.forkScoped)
        yield* Deferred.await(enteredA)
        // Start immediately so this waiter joins A before interruption rather
        // than becoming a fresh forced drain after A has been cancelled.
        const joined = yield* session.resume(a).pipe(Effect.forkScoped({ startImmediately: true }))
        const other = yield* session.resume(b).pipe(
          Effect.ensuring(Deferred.succeed(exitedB, undefined)),
          Effect.forkScoped,
        )
        yield* Deferred.await(enteredB)
        const active = yield* session.active
        expect(active.has(a)).toBe(true)
        expect(active.has(b)).toBe(true)
        expect(calls.filter((id) => id === a)).toHaveLength(1)
        expect(calls.filter((id) => id === b)).toHaveLength(1)
        expect(requests).toHaveLength(2)
        frozen.forEach((snapshot) => {
          const ownRequests = requests.filter((request) => new Headers(request.http?.headers).get("X-Session-Id") === snapshot.sessionID)
          expect(ownRequests).toHaveLength(1)
          expect(JSON.stringify(ownRequests[0].messages)).toContain(snapshot.apiContent)
        })
        expect(finalizers).toHaveLength(0)
        expect(Option.isNone(yield* Deferred.poll(releaseA))).toBe(true)
        expect(Option.isNone(yield* Deferred.poll(releaseB))).toBe(true)

        // Admit while both providers are blocked, without scheduling a wake.
        // An exact retry after interruption must reuse this persisted snapshot.
        const queued = {
          id: queuedID, sessionID: a, prompt: { text: "public queued A" },
          delivery: "queue", resume: false,
        } satisfies Parameters<typeof session.prompt>[0]
        yield* session.prompt(queued).pipe(
          Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: locationA.workspaceID }, references: [] }),
        )
        expect(frozen).toHaveLength(3)
        const beforeInterrupt = yield* session.messages({ sessionID: a })
        expect(beforeInterrupt.some((message) => message.type === "user" && message.text === queued.prompt.text)).toBe(false)
        expect(requests).toHaveLength(2)

        yield* session.interrupt(a)
        const firstExit = yield* Fiber.await(first)
        const joinedExit = yield* Fiber.await(joined)
        expect(firstExit._tag).toBe("Failure")
        expect(joinedExit._tag).toBe("Failure")
        if (firstExit._tag === "Failure") expect(Cause.hasInterruptsOnly(firstExit.cause)).toBe(true)
        if (joinedExit._tag === "Failure") expect(Cause.hasInterruptsOnly(joinedExit.cause)).toBe(true)
        expect(joinedExit._tag).toBe(firstExit._tag)
        expect(Option.isSome(yield* Deferred.poll(finalizedA))).toBe(true)
        expect(Option.isNone(yield* Deferred.poll(finalizedB))).toBe(true)
        expect(Option.isNone(yield* Deferred.poll(exitedB))).toBe(true)
        expect(Option.isNone(yield* Deferred.poll(releaseA))).toBe(true)
        expect(finalizers).toEqual([a])
        const remaining = yield* session.active
        expect(remaining.has(a)).toBe(false)
        expect(remaining.has(b)).toBe(true)

        yield* session.prompt(queued).pipe(
          Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: locationA.workspaceID }, references: [] }),
        )
        expect(frozen).toHaveLength(3)
        expect(requests).toHaveLength(2)
        const afterInterrupt = yield* session.messages({ sessionID: a })
        expect(afterInterrupt.some((message) => message.type === "user" && message.text === queued.prompt.text)).toBe(false)
        const stillActive = yield* session.active
        expect(stillActive.has(a)).toBe(false)
        expect(stillActive.has(b)).toBe(true)

        yield* Deferred.succeed(releaseB, undefined)
        yield* Fiber.join(other)
        expect(Option.isSome(yield* Deferred.poll(finalizedB))).toBe(true)
        expect(Option.isSome(yield* Deferred.poll(exitedB))).toBe(true)
        expect(finalizers).toEqual([a, b])
        expect((yield* session.active).size).toBe(0)
        const completedB = yield* session.messages({ sessionID: b })
        expect(JSON.stringify(completedB)).toContain("answer")

        // No automatic crash retry: only this explicit resume promotes the
        // still-durable queued input and starts the next provider attempt.
        yield* session.resume(a)
        expect(frozen).toHaveLength(3)
        expect(requests).toHaveLength(3)
        expect(calls.filter((id) => id === a)).toHaveLength(2)
        expect(calls.filter((id) => id === b)).toHaveLength(1)
        expect(finalizers).toEqual([a, b, a])
        expect((yield* session.active).size).toBe(0)
        expect(Option.isNone(yield* Deferred.poll(releaseA))).toBe(true)

        const queuedSnapshots = frozen.filter((snapshot) => snapshot.messageID === queuedID)
        const aRequests = requests.filter((request) => new Headers(request.http?.headers).get("X-Session-Id") === a)
        expect(queuedSnapshots).toHaveLength(1)
        expect(aRequests).toHaveLength(2)
        expect(JSON.stringify(aRequests[0].messages)).not.toContain(queuedSnapshots[0].apiContent)
        expect(JSON.stringify(aRequests[1].messages)).toContain(queuedSnapshots[0].apiContent)

        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        expect(constructed).toHaveLength(2)
        expect(constructed[0].location).not.toBe(constructed[1].location)
        constructed.forEach((identity) => {
          expect(identity.database).toBe(database)
          expect(identity.events).toBe(events)
          expect(identity.store).toBe(store)
        })
        for (const id of [a, b]) {
          const messages = yield* session.messages({ sessionID: id })
          const context = yield* session.context(id)
          const history = yield* session.history({ sessionID: id, limit: 100 })
          const transcript = JSON.stringify({ messages, context, history })
          expect(messages.some((message) => message.type === "user" && message.text === (id === a ? "public active A" : "public active B"))).toBe(true)
          if (id === a) expect(messages.filter((message) => message.type === "user" && message.text === queued.prompt.text)).toHaveLength(1)
          expect(transcript).not.toContain(id === a ? "public active B" : "public active A")
          if (id === b) expect(transcript).not.toContain(queued.prompt.text)
          frozen.forEach((snapshot) => {
            expect(transcript).not.toContain(snapshot.apiContent)
            if (snapshot.sessionID !== id) {
              requests.filter((request) => new Headers(request.http?.headers).get("X-Session-Id") === id).forEach((request) => {
                expect(JSON.stringify(request.messages)).not.toContain(snapshot.apiContent)
              })
            }
          })
        }
      }).pipe(Effect.ensuring(
        // Resume waiters do not own execution. Cancel the actual owners even
        // when an assertion fails before either provider gate is released.
        Effect.all([session.interrupt(a), session.interrupt(b)], { concurrency: "unbounded" }),
      ))
    })).pipe(Effect.timeout("10 seconds")))
  }, (request) => {
    const id = new Headers(request.http?.headers).get("X-Session-Id")
    if (id !== a && id !== b) return Stream.die("Unexpected provider Session")
    const previous = calls.filter((sessionID) => sessionID === id).length
    calls.push(id)
    const response = previous === 0
      ? Stream.unwrap(Deferred.succeed(id === a ? enteredA : enteredB, undefined).pipe(
        Effect.andThen(Deferred.await(id === a ? releaseA : releaseB)),
        Effect.as(completedResponse()),
      ))
      : completedResponse()
    return Stream.ensuring(response, Effect.sync(() => { finalizers.push(id) }).pipe(
      Effect.andThen(Deferred.succeed(id === a ? finalizedA : finalizedB, undefined)),
    ))
  })
}, 30_000)
