import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { LLMClient, LLMError, LLMRequest, LLMEvent, Model, ProviderInternalReason } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Cause, Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Scope, Stream } from "effect"
import { sql } from "drizzle-orm"
import { makeEventBoundaryNode, makeMediatedEventNode } from "../src/event-boundary"
import { initializeExtension } from "../src/kernel"
import { privateRunnerNode } from "../src/runner"
import { admit } from "../src/admission"
import { SENTINEL } from "../src/checkpoint"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const sessionID = Session.ID.make("ses_runner")
const workspaceID = WorkspaceV2.ID.make("wrk_runner")
const normalModel = Model.make({ id: "proof-model", provider: "proof", route })
const compactModel = Model.make({ id: "proof-model", provider: "proof", route: route.with({ limits: { context: 20_000, output: 500 } }) })
const text = (value = "answer"): LLMEvent[] => [LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text" }),
  LLMEvent.textDelta({ id: "text", text: value }), LLMEvent.textEnd({ id: "text" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" })]
const toolCall = (): LLMEvent[] => [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "echo-call", name: "echo", input: { text: "tool result" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })]

async function fixture(options: {
  native?: boolean
  compact?: boolean
  overflow?: boolean
  steps?: number
  response?: (request: LLMRequest, index: number) => Stream.Stream<LLMEvent, LLMError>
  execute?: (input: { text: string }) => Effect.Effect<{ text: string }, Tool.Failure>
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-runner-"))
  cleanup(directory)
  const requests: LLMRequest[] = []
  const tools: string[] = []
  const boundary = makeEventBoundaryNode()
  const database = makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(join(directory, "proof.db")), deps: [] })
  const client = Layer.mock(LLMClient.Service, {
    // This fixture accepts the canonical request shape the two runners emit.
    stream: ((request: LLMRequest) => {
      if (!(request instanceof LLMRequest)) return Stream.die("Expected canonical LLMRequest")
      requests.push(request)
      return options.response?.(request, requests.length - 1) ?? Stream.fromIterable(text())
    }) as unknown as Effect.Success<typeof LLMClient.Service>["stream"],
  })
  const runner = options.native ? node : privateRunnerNode
  const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([runner, Database.node, EventV2.node, SessionProjector.node, SessionStore.node, AgentV2.node, ToolRegistry.node]), [
    [Database.node, database], [EventV2.node, makeMediatedEventNode(boundary)],
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(options.compact || options.overflow ? compactModel : normalModel))],
    [Snapshot.node, Snapshot.noopLayer],
    [Location.node, Layer.succeed(Location.Service, Location.Service.of({ directory: AbsolutePath.make(directory), workspaceID,
      project: { id: ProjectV2.ID.make("proj_runner"), directory: AbsolutePath.make(directory) } }))],
    [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({
      compaction: new ConfigCompaction.Info({ auto: !!options.compact, buffer: 19_000, keep: new ConfigCompaction.Keep({ tokens: 100 }) }),
    }) })]) })],
  ]))
  await runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* initializeExtension
    yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_runner', ${directory}, '[]', 0, 0)`)
    yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
      VALUES (${sessionID}, 'proj_runner', 'proof', ${directory}, 'Proof', '1', 0, 0, ${workspaceID})`)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) => editor.update(AgentV2.defaultID, (agent) => { agent.system = "Proof system"; agent.steps = options.steps }))
  }).pipe(Scope.provide(runtime.scope))).catch(async (error: unknown) => { await runtime.dispose(); throw error })
  const runEffect = Effect.scoped(Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* registry.register({ echo: Tool.make({ description: "Echo text", input: Schema.Struct({ text: Schema.String }), output: Schema.Struct({ text: Schema.String }),
      toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
      execute: (input) => Effect.gen(function* () {
        tools.push(input.text)
        return options.execute ? yield* options.execute(input) : input
      }),
    }) })
    const runner = yield* SessionRunner.Service
    yield* runner.run({ sessionID, force: false })
  }))
  return {
    runtime, requests, tools, runEffect,
    async run() { return runtime.runPromise(runEffect) },
    async history() {
      return runtime.runPromise(Effect.gen(function* () {
        const store = yield* SessionStore.Service
        return yield* store.context(sessionID)
      }))
    },
    async add(value: string, id = SessionMessage.ID.create(), delivery: "steer" | "queue" = "steer", privateText?: string) {
      return runtime.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        if (privateText !== undefined) return yield* admit({ sessionID, messageID: id, actor: { userID: "user", workspaceID },
          text: value, delivery, resume: false, references: [],
        }, { authorize: () => Effect.void, freeze: () => Effect.succeed({ apiContent: privateText, rendererVersion: 1 }) }, () => Effect.void)
        return yield* SessionInput.admit(database.db, events, { sessionID, id, prompt: { text: value }, delivery })
      }))
    },
    async [Symbol.asyncDispose]() { await runtime.dispose() },
  }
}

test("clean private-runner turns conform to native request and transcript behavior", async () => {
  await using native = await fixture({ native: true })
  await using privateRunner = await fixture()
  for (const env of [native, privateRunner]) {
    await env.add("public question", SessionMessage.ID.make("msg_compare"))
    await env.run()
    expect(env.requests).toHaveLength(1)
    const messages = await env.runtime.runPromise(Effect.gen(function* () {
      const store = yield* SessionStore.Service
      return yield* store.context(sessionID)
    }))
    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
  }
  expect(privateRunner.requests[0].messages).toEqual(native.requests[0].messages)
  expect(privateRunner.requests[0].system).toEqual(native.requests[0].system)
  expect(privateRunner.requests[0].tools).toEqual(native.requests[0].tools)
})

test("real runner consumes immutable private input while public user history stays clean", async () => {
  await using env = await fixture()
  await env.add("public question", SessionMessage.ID.make("msg_private"), "steer", "frozen private prompt")
  await env.run()
  expect(env.requests).toHaveLength(1)
  expect(JSON.stringify(env.requests[0].messages)).toContain("frozen private prompt")
  expect(JSON.stringify(await env.runtime.runPromise(Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return yield* store.context(sessionID)
  })))).not.toContain("frozen private prompt")
})

test("local tool settlement reaches the next explicit turn and step limits disable further tools", async () => {
  await using env = await fixture({ steps: 2, response: (_request, index) => Stream.fromIterable(index === 0 ? toolCall() : text()) })
  await env.add("use tool")
  await env.run()
  expect(env.tools).toEqual(["tool result"])
  expect(env.requests).toHaveLength(2)
  expect(env.requests[0].tools.some((tool) => tool.name === "echo")).toBe(true)
  expect(env.requests[1].tools).toEqual([])
  expect(env.requests[1].toolChoice?.type).toBe("none")
  expect(env.requests[1].messages.some((message) => message.role === "tool")).toBe(true)
})

test("the runner invokes private-aware native compaction before the provider turn", async () => {
  await using env = await fixture({ compact: true, response: (request) => request.generation?.maxTokens === 500
    ? Stream.make(LLMEvent.textDelta({ id: "summary", text: "private summary" })) : Stream.fromIterable(text()),
  })
  await env.add("public head", SessionMessage.ID.create(), "steer", "private head ".repeat(1600))
  await env.add("public tail", SessionMessage.ID.create(), "steer", "private tail")
  await env.run()
  expect(env.requests).toHaveLength(2)
  expect(JSON.stringify(env.requests[0].messages)).toContain("private head")
  expect(JSON.stringify(env.requests[1].messages)).toContain("private summary")
  expect(JSON.stringify(env.requests[1].messages)).toContain("private tail")
  const messages = await env.runtime.runPromise(Effect.gen(function* () { const store = yield* SessionStore.Service; return yield* store.context(sessionID) }))
  expect(JSON.stringify(messages)).toContain(SENTINEL)
  expect(JSON.stringify(messages)).not.toContain("private summary")
})

test("native coordinator joins same-Session runs and allows interruption of the owned drain", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const hold = Deferred.makeUnsafe<void>()
  await using env = await fixture({ response: () => Stream.unwrap(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold)), Effect.as(Stream.fromIterable(text())))) })
  await env.add("interrupt")
  await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({ drain: (id, force) => runner.run({ sessionID: id, force }) })
    const first = yield* coordinator.run(sessionID).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    // Joining is synchronous up to the shared Deferred; start immediately so
    // interruption cannot race an as-yet-unscheduled second resume.
    const second = yield* coordinator.run(sessionID).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* coordinator.interrupt(sessionID)
    expect((yield* Fiber.await(first))._tag).toBe("Failure")
    expect((yield* Fiber.await(second))._tag).toBe("Failure")
  })))
  expect(env.requests).toHaveLength(1)
})

test("queued inputs wait for tool continuation to settle and each new input resets the turn allowance", async () => {
  await using env = await fixture({ steps: 2, response: (_request, index) => Stream.fromIterable(index === 0 ? toolCall() : text()) })
  await env.add("initial", SessionMessage.ID.make("msg_initial"))
  await env.add("queued-one", SessionMessage.ID.make("msg_queue_one"), "queue")
  await env.add("queued-two", SessionMessage.ID.make("msg_queue_two"), "queue")
  await env.run()
  expect(env.requests).toHaveLength(4)
  expect(JSON.stringify(env.requests[0].messages)).not.toContain("queued-one")
  expect(JSON.stringify(env.requests[1].messages)).not.toContain("queued-one")
  expect(JSON.stringify(env.requests[2].messages)).toContain("queued-one")
  expect(JSON.stringify(env.requests[2].messages)).not.toContain("queued-two")
  expect(JSON.stringify(env.requests[3].messages)).toContain("queued-two")
  expect(env.requests[1].tools).toEqual([])
  expect(env.requests[2].tools.some((tool) => tool.name === "echo")).toBe(true)
})

test("steering admitted during a provider turn appears at the next safe boundary", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const hold = Deferred.makeUnsafe<void>()
  await using env = await fixture({ response: (_request, index) => index === 0
    ? Stream.unwrap(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold)), Effect.as(Stream.fromIterable(text()))))
    : Stream.fromIterable(text()),
  })
  await env.add("initial")
  const running = env.run()
  await Effect.runPromise(Deferred.await(entered))
  await env.add("new steering", SessionMessage.ID.make("msg_steering"))
  await Effect.runPromise(Deferred.succeed(hold, undefined))
  await running
  expect(env.requests).toHaveLength(2)
  expect(JSON.stringify(env.requests[0].messages)).not.toContain("new steering")
  expect(JSON.stringify(env.requests[1].messages)).toContain("new steering")
})

test("one overflow recovery compacts private context before the next explicit provider attempt", async () => {
  await using env = await fixture({ overflow: true, response: (request, index) => {
    if (index === 0) return Stream.make(LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }))
    if (request.generation?.maxTokens === 500) return Stream.make(LLMEvent.textDelta({ id: "summary", text: "recovered private summary" }))
    return Stream.fromIterable(text())
  } })
  await env.add("public", SessionMessage.ID.create(), "steer", "private history ".repeat(1600))
  await env.run()
  expect(env.requests).toHaveLength(3)
  expect(JSON.stringify(env.requests[0].messages)).toContain("private history")
  expect(JSON.stringify(env.requests[1].messages)).toContain("private history")
  expect(JSON.stringify(env.requests[2].messages)).toContain("recovered private summary")
})

for (const native of [true, false]) {
  const name = native ? "stock" : "private"

  test(`${name}: permission decline and question rejection interrupt rather than continue`, async () => {
    // Real Tool/registry error mapping, not a proof of the permission HTTP flow.
    for (const defect of [new PermissionV2.DeclinedError(), new QuestionV2.RejectedError()]) {
      await using env = await fixture({ native, execute: () => Effect.die(defect), response: (_request, index) => Stream.fromIterable(index === 0 ? toolCall() : text()) })
      await env.add("ask before using the tool")
      const exit = await env.runtime.runPromise(Effect.exit(env.runEffect))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(env.requests).toHaveLength(1)
      expect(env.tools).toEqual(["tool result"])
      const history = JSON.stringify(await env.history())
      expect(history).toContain("Tool execution interrupted")
      expect(history).not.toContain("Tool execution failed:")
    }
  })

  test(`${name}: corrected and blocked tool failures become model-facing results`, async () => {
    for (const failure of [
      { error: new PermissionV2.CorrectedError({ feedback: "Use another tool" }), message: "Use another tool" },
      { error: new PermissionV2.BlockedError({ rules: [{ action: "echo", resource: "*", effect: "deny" }] }), message: "Echo is blocked by policy" },
    ]) {
      await using env = await fixture({ native,
        execute: () => Effect.fail(failure.error).pipe(Effect.mapError(() => new Tool.Failure({ message: failure.message }))),
        response: (_request, index) => Stream.fromIterable(index === 0 ? toolCall() : text()),
      })
      await env.add("use the tool")
      await env.run()
      expect(env.tools).toEqual(["tool result"])
      expect(env.requests).toHaveLength(2)
      expect(JSON.stringify(env.requests[1].messages.filter((message) => message.role === "tool"))).toContain(failure.message)
      const history = JSON.stringify(await env.history())
      expect(history).toContain(failure.message)
      expect(history).not.toContain("Tool execution interrupted")
    }
  })

  test(`${name}: ordinary tool defects retain non-interruption cleanup and continuation`, async () => {
    await using env = await fixture({ native, execute: () => Effect.die(new Error("ordinary tool defect")),
      response: (_request, index) => Stream.fromIterable(index === 0 ? toolCall() : text()),
    })
    await env.add("use the failing tool")
    await env.run()
    expect(env.requests).toHaveLength(2)
    expect(env.tools).toEqual(["tool result"])
    expect(JSON.stringify(env.requests[1].messages.filter((message) => message.role === "tool"))).toContain("Tool execution failed: ordinary tool defect")
    expect(JSON.stringify(await env.history())).not.toContain("Tool execution interrupted")
  })

  test(`${name}: provider events, typed failures and EOF settle outstanding hosted calls`, async () => {
    for (const ending of ["event", "raw", "eof"] as const) {
      const error = new LLMError({ module: "proof", method: "stream", reason: new ProviderInternalReason({ message: "Provider unavailable", status: 503 }) })
      await using env = await fixture({ native, response: (_request, index) => {
        if (index > 0) return Stream.fromIterable(text())
        const start = Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "visible unfinished text" }),
          LLMEvent.toolCall({ id: "hosted", name: "echo", input: { text: "hosted only" }, providerExecuted: true }),
          LLMEvent.toolCall({ id: "local", name: "echo", input: { text: "local result" } }),
        ])
        if (ending === "raw") return Stream.concat(start, Stream.fail(error))
        if (ending === "event") return Stream.concat(start, Stream.make(LLMEvent.providerError({ message: "Provider unavailable" })))
        return start
      } })
      await env.add("use hosted and local tools")
      const exit = await env.runtime.runPromise(Effect.exit(env.runEffect))
      expect(exit._tag).toBe(ending === "raw" ? "Failure" : "Success")
      if (exit._tag === "Failure") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(error)
      expect(env.tools).toEqual(["local result"])
      expect(env.requests).toHaveLength(ending === "eof" ? 2 : 1)
      const messages = await env.history()
      const hosted = messages.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool" && part.id === "hosted") : [])
      expect(hosted).toHaveLength(1)
      expect(JSON.stringify(hosted)).toContain(ending === "event" ? "Tool execution interrupted" : "Provider did not return a tool result")
      expect(JSON.stringify(messages)).toContain("visible unfinished text")
      if (ending !== "eof") {
        expect(messages.find((message) => message.type === "assistant")).toMatchObject({ finish: "error", error: { type: "unknown", message: "Provider unavailable" } })
      }
    }
  })

  test(`${name}: a raw provider failure waits for an already-started local tool`, async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const failed = Deferred.makeUnsafe<void>()
    const completed = Deferred.makeUnsafe<void>()
    const error = new LLMError({ module: "proof", method: "stream", reason: new ProviderInternalReason({ message: "Provider unavailable", status: 503 }) })
    await using env = await fixture({ native,
      execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ text: "completed local output" })),
      response: () => Stream.concat(Stream.make(LLMEvent.toolCall({ id: "local", name: "echo", input: { text: "settled after failure" } })),
        Stream.unwrap(Deferred.await(entered).pipe(Effect.andThen(Deferred.succeed(failed, undefined)), Effect.as(Stream.fail(error))))),
    })
    await env.add("wait for the local tool")
    await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* env.runEffect.pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped)
      yield* Deferred.await(failed)
      expect(Option.isNone(yield* Deferred.poll(completed))).toBe(true)
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(error)
    })))
    expect(env.requests).toHaveLength(1)
    expect(env.tools).toEqual(["settled after failure"])
    const messages = await env.history()
    const local = messages.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool" && part.id === "local") : [])
    expect(local).toHaveLength(1)
    expect(JSON.stringify(local)).toContain("completed local output")
    expect(JSON.stringify(local)).not.toContain("Provider did not return a tool result")
    expect(JSON.stringify(local)).not.toContain("Tool execution interrupted")
  })

  test(`${name}: interruption cancels a local tool and flushes partial visible text`, async () => {
    const entered = Deferred.makeUnsafe<void>()
    const cancelled = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    await using env = await fixture({ native,
      execute: (input) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(input), Effect.ensuring(Deferred.succeed(cancelled, undefined))),
      response: () => Stream.concat(Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "partial" }),
        LLMEvent.textDelta({ id: "partial", text: "interrupted partial text" }),
        LLMEvent.toolCall({ id: "local", name: "echo", input: { text: "blocked execution" } }),
      ]), Stream.never),
    })
    await env.add("interrupt a running tool")
    await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* env.runEffect.pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      // Stock FiberSet registration follows synchronous child startup. This
      // comparison cancels only after that registration has completed.
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(Option.isSome(yield* Deferred.poll(cancelled))).toBe(true)
    })))
    expect(env.requests).toHaveLength(1)
    const history = JSON.stringify(await env.history())
    expect(history).toContain("interrupted partial text")
    expect(history).toContain("Tool execution interrupted")
    expect(history).toContain("Provider turn interrupted")
    expect(history).not.toContain("Tool execution failed:")
  })

  test(`${name}: overflow after visible output fails the assistant without summarization`, async () => {
    await using env = await fixture({ native, overflow: true, response: () => Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "partial" }),
      LLMEvent.textDelta({ id: "partial", text: "output before overflow" }),
      LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
    ]) })
    await env.add("history ".repeat(1600))
    await env.run()
    expect(env.requests).toHaveLength(1)
    const messages = await env.history()
    expect(JSON.stringify(messages)).toContain("output before overflow")
    expect(messages.find((message) => message.type === "assistant")).toMatchObject({ finish: "error", error: { type: "unknown", message: "prompt too long" } })
  })

  test(`${name}: raw failure flushes partial reasoning and tool input without executing it`, async () => {
    const error = new LLMError({ module: "proof", method: "stream", reason: new ProviderInternalReason({ message: "Provider unavailable", status: 503 }) })
    await using env = await fixture({ native, response: () => Stream.concat(Stream.fromIterable([
      LLMEvent.reasoningStart({ id: "thought" }),
      LLMEvent.reasoningDelta({ id: "thought", text: "partial reasoning" }),
      LLMEvent.toolInputStart({ id: "incomplete", name: "echo" }),
      LLMEvent.toolInputDelta({ id: "incomplete", name: "echo", text: '{"text":"unfinished' }),
    ]), Stream.fail(error)) })
    await env.add("flush incomplete fragments")
    const exit = await env.runtime.runPromise(Effect.exit(env.runEffect))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(error)
    expect(env.requests).toHaveLength(1)
    expect(env.tools).toEqual([])
    const content = (await env.history()).flatMap((message) => message.type === "assistant" ? message.content : [])
    expect(content.find((part) => part.type === "reasoning")).toMatchObject({ type: "reasoning", text: "partial reasoning" })
    expect(content.find((part) => part.type === "tool")).toMatchObject({ type: "tool", id: "incomplete", state: { input: '{"text":"unfinished' } })
  })

  test(`${name}: provider interruption takes precedence over an already-failed tool`, async () => {
    const failed = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    await using env = await fixture({ native,
      execute: () => Effect.withFiber((fiber) => Deferred.succeed(failed, fiber).pipe(Effect.andThen(Effect.die(new Error("prior tool defect"))))),
      response: () => Stream.concat(Stream.make(LLMEvent.toolCall({ id: "failed", name: "echo", input: { text: "fail first" } })), Stream.never),
    })
    await env.add("interrupt after a tool has failed")
    await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const run = yield* env.runEffect.pipe(Effect.forkScoped)
      const tool = yield* Deferred.await(failed)
      expect((yield* Fiber.await(tool))._tag).toBe("Failure")
      // Let the stock synchronous spawn finish registering its completed child.
      yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      const exit = yield* Fiber.await(run)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    })))
    const history = JSON.stringify(await env.history())
    expect(history).toContain("Tool execution interrupted")
    expect(history).not.toContain("Tool execution failed: prior tool defect")
    expect(env.requests).toHaveLength(1)
  })

  test(native ? "stock: reentrant cancellation precedes tool registration" : "private: reentrant cancellation waits for the started tool's cleanup", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const cancelled = Deferred.makeUnsafe<void>()
    await using env = await fixture({ native,
      execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(cancelled, undefined))),
      response: () => Stream.concat(Stream.make(LLMEvent.toolCall({ id: "reentrant", name: "echo", input: { text: "cancel immediately" } })), Stream.never),
    })
    await env.add("cancel as soon as the tool starts")
    await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const run = yield* env.runEffect.pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      // Deliberately no yield: a same-process observer can cancel reentrantly.
      yield* Fiber.interrupt(run)
      expect((yield* Fiber.await(run))._tag).toBe("Failure")
      expect(Option.isSome(yield* Deferred.poll(cancelled))).toBe(!native)
    })))
    expect(env.requests).toHaveLength(1)
    expect(JSON.stringify(await env.history())).toContain("Tool execution interrupted")
  })
}

test("private: relocated Sessions are rejected before unfinished-tool repair or inbox promotion", async () => {
  await using env = await fixture()
  await env.add("pending relocated input")
  const before = await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const publisher = createLLMEventPublisher(events, {
      sessionID, agent: "build", model: { id: ModelV2.ID.make("proof-model"), providerID: ProviderV2.ID.make("proof") },
    })
    yield* publisher.publish(LLMEvent.toolCall({ id: "unfinished", name: "echo", input: { text: "old" } }))
    const sequence = yield* EventV2.latestSequence(database.db, sessionID)
    yield* database.db.run(sql`UPDATE session SET workspace_id = 'wrk_moved' WHERE id = ${sessionID}`)
    return sequence
  }))
  const history = await env.history()
  expect(history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])).toMatchObject([
    { id: "unfinished", state: { status: "running" } },
  ])
  const exit = await env.runtime.runPromise(Effect.exit(env.runEffect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  expect(env.requests).toEqual([])
  expect(env.tools).toEqual([])
  expect(await env.history()).toEqual(history)
  await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    expect(yield* EventV2.latestSequence(database.db, sessionID)).toBe(before)
    expect(yield* SessionInput.hasPending(database.db, sessionID, "steer")).toBe(true)
  }))
})

test("private: idle advisory runs remain no-ops while a forced missing Session still fails", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const runner = yield* SessionRunner.Service
    yield* database.db.run(sql`UPDATE session SET workspace_id = 'wrk_moved' WHERE id = ${sessionID}`)
    const before = yield* EventV2.latestSequence(database.db, sessionID)
    yield* runner.run({ sessionID, force: false })
    expect(yield* EventV2.latestSequence(database.db, sessionID)).toBe(before)
    const missing = Session.ID.make("ses_missing")
    yield* runner.run({ sessionID: missing, force: false })
    const exit = yield* Effect.exit(runner.run({ sessionID: missing, force: true }))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false)
    }
  }))
  expect(env.requests).toEqual([])
  expect(env.tools).toEqual([])
})
