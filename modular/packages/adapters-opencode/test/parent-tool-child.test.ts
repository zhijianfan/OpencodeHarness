// Executable seam proof: a child started by an ACTUAL parent provider tool races
// external child resume/interrupt and parent cancellation through the one native
// Session/Event/Store/LocationServiceMap runtime and the shared pending-session
// execution composition. The fixture tool is named `delegation_probe`; it is a
// proof-only boundary, NOT an implementation of task_batch and carries none of
// its manifests, CtxPack capture, or archival behavior.
import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, LLMEvent, Model, type LLMError, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Cause, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { databaseCleanup } from "../../../test-utils/cleanup"
import { ChildRunError, makeChildRunner, type ChildRunInput, type ChildRunner } from "../src/child-runner"
import { createSessionRuntime } from "../src/session-runtime"
import { PrivatePromptContext } from "../src/session-facade"
import { PendingSessionExecution } from "../src/session-execution"

const cleanup = databaseCleanup()

const workspaceID = WorkspaceV2.ID.make("wrk_parent_tool")
const actor = { userID: "authenticated-user", workspaceID: "wrk_parent_tool" }
const childAgent = AgentV2.ID.make("build")
const childModel = { id: ModelV2.ID.make("proof-model"), providerID: ProviderV2.ID.make("proof") }
const childTitle = "delegated child"
const runnerModel = Model.make({ id: "proof-model", provider: "proof", route })

type Fixture = {
  readonly runtime: ReturnType<typeof createSessionRuntime>
  readonly directory: string
  readonly requests: LLMRequest[]
  readonly frozen: string[]
}

function headerOf(request: LLMRequest) {
  return new Headers(request.http?.headers).get("X-Session-Id")
}

function childRequests(requests: readonly LLMRequest[], childID: SessionSchema.ID) {
  return requests.filter((request) => headerOf(request) === childID)
}

function textEvents(text: string): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

function toolCallEvents(input: Record<string, string>): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id: "delegation", name: "delegation_probe", input: { tasks: [input] } }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}

function authorizeChild(request: { readonly actor: ChildRunInput["actor"]; readonly parent: SessionSchema.Info }) {
  return request.actor.userID === actor.userID &&
    request.actor.workspaceID === actor.workspaceID &&
    request.parent.location.workspaceID === actor.workspaceID
    ? Effect.void
    : Effect.fail(new ChildRunError({ message: "Child delegation authorization failed" }))
}

function makeDelegationProbe(options: { readonly child: ChildRunner; readonly parentSessionID: SessionSchema.ID }) {
  return Tool.make({
    description: "Delegate one child Session run through the native child runner",
    input: Schema.Struct({ tasks: Schema.NonEmptyArray(Schema.Struct({
      prompt: Schema.String, childSessionID: Schema.String, promptMessageID: Schema.String,
    })) }),
    output: Schema.Struct({ text: Schema.String }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    // A typed ChildRunError is an actual model-facing failure; interruption is
    // not caught here, so a cancelled tool never leaves an owned child running.
    execute: (request) => Effect.forEach(request.tasks, (task) =>
      options.child.run({
          parentSessionID: options.parentSessionID,
          childSessionID: SessionSchema.ID.make(task.childSessionID),
          promptMessageID: SessionMessage.ID.make(task.promptMessageID),
          agent: childAgent,
          model: childModel,
          title: childTitle,
          prompt: task.prompt,
          actor,
        }), { concurrency: "unbounded" }).pipe(
          Effect.map((results) => ({ text: results.map((result) => result.text).join("\n") })),
          Effect.mapError((error) => new Tool.Failure({ message: error.message })),
        ),
  })
}

async function withRuntime(
  run: (fixture: Fixture) => Promise<void>,
  response: (request: LLMRequest, requests: readonly LLMRequest[]) => Stream.Stream<LLMEvent, LLMError>,
) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-parent-tool-"))
  cleanup(directory)
  const requests: LLMRequest[] = []
  const frozen: string[] = []
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    policy: {
      managed: () => Effect.succeed(true),
      authorize: (request) => Effect.sync(() => {
        expect(request.actor).toEqual(actor)
        expect(request.references).toEqual([])
      }),
      freeze: (request) => Effect.sync(() => {
        frozen.push(request.messageID)
        return { apiContent: request.text, rendererVersion: 1 }
      }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, {
        stream: (request) => {
          requests.push(request)
          return response(request, requests)
        },
      })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(runnerModel))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  try {
    await run({ runtime, directory, requests, frozen })
  } finally {
    await runtime.dispose()
  }
}

test("a real parent tool's child joins external resume, and interrupting the child settles both", async () => {
  const parentID = SessionSchema.ID.make("ses_parent_tool_join")
  const childID = SessionSchema.ID.make("ses_parent_tool_join_child")
  const childPromptMessageID = SessionMessage.ID.make("msg_parent_tool_join_child")
  const childEntered = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      const location = { directory: AbsolutePath.make(fixture.directory), workspaceID }
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const locations = yield* LocationServiceMap.Service
            const parent = yield* session.create({ id: parentID, location })
            const child = yield* makeChildRunner({ location, authorize: authorizeChild })
            const registry = yield* Effect.provide(ToolRegistry.Service, locations.get(parent.location))
            yield* registry.register({ delegation_probe: makeDelegationProbe({ child, parentSessionID: parentID }) })
            yield* session.prompt({
              id: SessionMessage.ID.make("msg_parent_join"),
              sessionID: parentID,
              prompt: { text: "delegate to a child" },
              resume: false,
            }).pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))
            return yield* Effect.gen(function* () {
              const parentRun = yield* execution.resume(parentID).pipe(Effect.forkScoped({ startImmediately: true }))
              yield* Deferred.await(childEntered)
              const joined = yield* execution.resume(childID).pipe(Effect.forkScoped({ startImmediately: true }))
              expect(childRequests(fixture.requests, childID)).toHaveLength(1)
              expect((yield* execution.active).has(childID)).toBe(true)
              yield* execution.interrupt(childID)
              const joinedExit = yield* Fiber.await(joined)
              expect(joinedExit._tag).toBe("Failure")
              if (joinedExit._tag === "Failure") expect(Cause.hasInterruptsOnly(joinedExit.cause)).toBe(true)
              // The parent run is not itself interrupted: the tool failure is a
              // mapped model-facing result and the parent continues to text.
              const parentExit = yield* Fiber.await(parentRun)
              expect(parentExit._tag).toBe("Success")
              expect((yield* execution.active).has(childID)).toBe(false)
              const history = JSON.stringify(yield* session.messages({ sessionID: parentID }))
              expect(history).toContain(`Worker interrupted: ${childID}`)
              expect(history).toContain("parent answer")
            }).pipe(Effect.ensuring(Effect.all([
              execution.interrupt(parentID),
              execution.interrupt(childID),
            ], { concurrency: "unbounded" })))
          }),
        ).pipe(Effect.timeout("10 seconds")),
      )
    },
    (request, requests) => {
      if (headerOf(request) === childID) {
        return Stream.unwrap(
          Deferred.succeed(childEntered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.as(Stream.fromIterable(textEvents("child answer"))),
          ),
        )
      }
      const turn = requests.filter((candidate) => headerOf(candidate) === parentID).length
      return Stream.fromIterable(
        turn === 1
          ? toolCallEvents({ prompt: "child prompt", childSessionID: childID, promptMessageID: childPromptMessageID })
          : textEvents("parent answer"),
      )
    },
  )
}, 30_000)

test("interrupting the parent finalizes the tool-owned child drain while another Session stays independent", async () => {
  const parentID = SessionSchema.ID.make("ses_parent_tool_cancel")
  const childID = SessionSchema.ID.make("ses_parent_tool_cancel_child")
  const otherID = SessionSchema.ID.make("ses_parent_tool_cancel_other")
  const childPromptMessageID = SessionMessage.ID.make("msg_parent_tool_cancel_child")
  const otherPromptMessageID = SessionMessage.ID.make("msg_parent_tool_cancel_other")
  const childEntered = Deferred.makeUnsafe<void>()
  const childFinalized = Deferred.makeUnsafe<void>()
  const otherEntered = Deferred.makeUnsafe<void>()
  const otherRelease = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      const location = { directory: AbsolutePath.make(fixture.directory), workspaceID }
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const locations = yield* LocationServiceMap.Service
            const parent = yield* session.create({ id: parentID, location })
            const child = yield* makeChildRunner({ location, authorize: authorizeChild })
            const registry = yield* Effect.provide(ToolRegistry.Service, locations.get(parent.location))
            yield* registry.register({ delegation_probe: makeDelegationProbe({ child, parentSessionID: parentID }) })
            yield* session.create({ id: otherID, location })
            yield* session.prompt({
              id: otherPromptMessageID,
              sessionID: otherID,
              prompt: { text: "unrelated input" },
              resume: false,
            }).pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))
            return yield* Effect.gen(function* () {
              const otherRun = yield* execution.resume(otherID).pipe(Effect.forkScoped({ startImmediately: true }))
              yield* Deferred.await(otherEntered)
              yield* session.prompt({
                id: SessionMessage.ID.make("msg_parent_cancel"),
                sessionID: parentID,
                prompt: { text: "delegate to a child" },
                resume: false,
              }).pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))
              const parentRun = yield* execution.resume(parentID).pipe(Effect.forkScoped({ startImmediately: true }))
              yield* Deferred.await(childEntered)
              expect((yield* execution.active).has(childID)).toBe(true)
              yield* execution.interrupt(parentID)
              const parentExit = yield* Fiber.await(parentRun)
              expect(parentExit._tag).toBe("Failure")
              if (parentExit._tag === "Failure") expect(Cause.hasInterruptsOnly(parentExit.cause)).toBe(true)
              yield* Deferred.await(childFinalized)
              expect((yield* execution.active).has(childID)).toBe(false)
              expect((yield* execution.active).has(parentID)).toBe(false)
              expect((yield* execution.active).has(otherID)).toBe(true)
              expect(otherRun.pollUnsafe()).toBeUndefined()
              yield* Deferred.succeed(otherRelease, undefined)
              yield* Fiber.join(otherRun)
              expect((yield* execution.active).has(otherID)).toBe(false)
            }).pipe(Effect.ensuring(Effect.all([
              execution.interrupt(parentID),
              execution.interrupt(childID),
              execution.interrupt(otherID),
            ], { concurrency: "unbounded" })))
          }),
        ).pipe(Effect.timeout("10 seconds")),
      )
    },
    (request, requests) => {
      const id = headerOf(request)
      if (id === childID) {
        return Stream.unwrap(
          Deferred.succeed(childEntered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(childFinalized, undefined)),
            Effect.as(Stream.fromIterable(textEvents("child answer"))),
          ),
        )
      }
      if (id === otherID) {
        return Stream.unwrap(
          Deferred.succeed(otherEntered, undefined).pipe(
            Effect.andThen(Deferred.await(otherRelease)),
            Effect.as(Stream.fromIterable(textEvents("other answer"))),
          ),
        )
      }
      const turn = requests.filter((candidate) => headerOf(candidate) === parentID).length
      return Stream.fromIterable(
        turn === 1
          ? toolCallEvents({ prompt: "child prompt", childSessionID: childID, promptMessageID: childPromptMessageID })
          : textEvents("parent answer"),
      )
    },
  )
}, 30_000)

test("a tool joining an independently owned child cancels only its waiter on parent interruption", async () => {
  const parentID = SessionSchema.ID.make("ses_parent_tool_owned")
  const childID = SessionSchema.ID.make("ses_parent_tool_owned_child")
  const childPromptMessageID = SessionMessage.ID.make("msg_parent_tool_owned_child")
  const childEntered = Deferred.makeUnsafe<void>()
  const childRelease = Deferred.makeUnsafe<void>()
  const toolAdmitted = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      const location = { directory: AbsolutePath.make(fixture.directory), workspaceID }
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const locations = yield* LocationServiceMap.Service
            const parent = yield* session.create({ id: parentID, location })
            const pending = yield* PendingSessionExecution
            const independentChild = yield* makeChildRunner({ location, authorize: authorizeChild })
            // Observe the real pending waiter after immediate registration. This
            // delegates to the same coordinator; it adds no execution owner and
            // avoids timing guesses about when the tool has reached its join.
            const child = yield* makeChildRunner({ location, authorize: authorizeChild }).pipe(
              Effect.provideService(PendingSessionExecution, PendingSessionExecution.of({
                run: (id) => Effect.scoped(Effect.gen(function* () {
                  const waiter = yield* pending.run(id).pipe(Effect.forkScoped({ startImmediately: true }))
                  yield* Deferred.succeed(toolAdmitted, undefined)
                  yield* Fiber.join(waiter)
                })),
              })),
            )
            const registry = yield* Effect.provide(ToolRegistry.Service, locations.get(parent.location))
            yield* registry.register({ delegation_probe: makeDelegationProbe({ child, parentSessionID: parentID }) })
            const sharedInput: ChildRunInput = {
              parentSessionID: parentID,
              childSessionID: childID,
              promptMessageID: childPromptMessageID,
              agent: childAgent,
              model: childModel,
              title: childTitle,
              prompt: "child prompt",
              actor,
            }
            return yield* Effect.gen(function* () {
              const independent = yield* independentChild.run(sharedInput).pipe(Effect.forkScoped({ startImmediately: true }))
              yield* Deferred.await(childEntered)
              yield* session.prompt({
                id: SessionMessage.ID.make("msg_parent_owned"),
                sessionID: parentID,
                prompt: { text: "delegate to a child" },
                resume: false,
              }).pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))
              const parentRun = yield* execution.resume(parentID).pipe(Effect.forkScoped({ startImmediately: true }))
              yield* Deferred.await(toolAdmitted)
              expect((yield* execution.active).has(childID)).toBe(true)
              yield* execution.interrupt(parentID)
              // The pre-existing owner must survive: only the joining waiter is
              // cancelled, never the child's pending drain.
              expect((yield* execution.active).has(childID)).toBe(true)
              expect(independent.pollUnsafe()).toBeUndefined()
              yield* Deferred.succeed(childRelease, undefined)
              expect((yield* Fiber.join(independent)).text).toBe("child answer")
              const parentExit = yield* Fiber.await(parentRun)
              expect(parentExit._tag).toBe("Failure")
              if (parentExit._tag === "Failure") expect(Cause.hasInterruptsOnly(parentExit.cause)).toBe(true)
              expect(childRequests(fixture.requests, childID)).toHaveLength(1)
              expect((yield* execution.active).has(childID)).toBe(false)
            }).pipe(Effect.ensuring(Effect.all([
              execution.interrupt(parentID),
              execution.interrupt(childID),
            ], { concurrency: "unbounded" })))
          }),
        ).pipe(Effect.timeout("10 seconds")),
      )
    },
    (request, requests) => {
      if (headerOf(request) === childID) {
        return Stream.unwrap(
          Deferred.succeed(childEntered, undefined).pipe(
            Effect.andThen(Deferred.await(childRelease)),
            Effect.as(Stream.fromIterable(textEvents("child answer"))),
          ),
        )
      }
      const turn = requests.filter((candidate) => headerOf(candidate) === parentID).length
      return Stream.fromIterable(
        turn === 1
          ? toolCallEvents({ prompt: "child prompt", childSessionID: childID, promptMessageID: childPromptMessageID })
          : textEvents("parent answer"),
      )
    },
  )
}, 30_000)

test("an exact completed child and prompt retry from a later tool call does not call the provider again", async () => {
  const parentID = SessionSchema.ID.make("ses_parent_tool_retry")
  const childID = SessionSchema.ID.make("ses_parent_tool_retry_child")
  const childPromptMessageID = SessionMessage.ID.make("msg_parent_tool_retry_child")
  await withRuntime(
    async (fixture) => {
      const location = { directory: AbsolutePath.make(fixture.directory), workspaceID }
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const locations = yield* LocationServiceMap.Service
            const parent = yield* session.create({ id: parentID, location })
            const child = yield* makeChildRunner({ location, authorize: authorizeChild })
            const registry = yield* Effect.provide(ToolRegistry.Service, locations.get(parent.location))
            yield* registry.register({ delegation_probe: makeDelegationProbe({ child, parentSessionID: parentID }) })
            yield* session.prompt({
              id: SessionMessage.ID.make("msg_parent_retry"),
              sessionID: parentID,
              prompt: { text: "delegate twice" },
              resume: false,
            }).pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))
            return yield* Effect.gen(function* () {
              const parentRun = yield* execution.resume(parentID).pipe(Effect.forkScoped({ startImmediately: true }))
              yield* Fiber.join(parentRun)
              // The second, exact completed retry reuses the child without a
              // second provider turn and without re-freezing the input.
              expect(childRequests(fixture.requests, childID)).toHaveLength(1)
              expect(fixture.frozen.filter((id) => id === childPromptMessageID)).toHaveLength(1)
              const info = yield* session.get(childID)
              expect(info.parentID).toBe(parentID)
              expect(info.title).toBe(childTitle)
              expect(info.agent).toBe(childAgent)
              expect(info.model?.providerID).toBe(childModel.providerID)
              expect(info.model?.id).toBe(childModel.id)
              expect(info.model?.variant).toBe(ModelV2.VariantID.make("default"))
              const history = JSON.stringify(yield* session.messages({ sessionID: parentID }))
              expect(history).toContain("parent answer")
              expect(history).toContain("child answer")
            }).pipe(Effect.ensuring(execution.interrupt(parentID)))
          }),
        ).pipe(Effect.timeout("10 seconds")),
      )
    },
    (request, requests) => {
      if (headerOf(request) === childID) return Stream.fromIterable(textEvents("child answer"))
      const turn = requests.filter((candidate) => headerOf(candidate) === parentID).length
      return Stream.fromIterable(
        turn <= 2
          ? toolCallEvents({ prompt: "child prompt", childSessionID: childID, promptMessageID: childPromptMessageID })
          : textEvents("parent answer"),
      )
    },
  )
}, 30_000)
