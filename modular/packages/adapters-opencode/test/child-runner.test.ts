import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, LLMEvent, Model, type LLMError, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { sql } from "drizzle-orm"
import { databaseCleanup } from "../../../test-utils/cleanup"
import { AdmissionError, type AdmissionRequest } from "../src/admission"
import { ChildRunError, makeChildRunner, type ChildRunInput } from "../src/child-runner"
import { EventBoundary } from "../src/event-boundary"
import type { RunnerIdentity } from "../src/runner"
import { requireV2Session } from "../src/session-classification"
import { PendingSessionExecution } from "../src/session-execution"
import { PrivatePromptContext } from "../src/session-facade"
import { createSessionRuntime } from "../src/session-runtime"

const cleanup = databaseCleanup()

function completedResponse() {
  return Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text: "child answer" }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])
}

async function withRuntime(
  run: (fixture: {
    runtime: ReturnType<typeof createSessionRuntime>
    directory: string
    requests: LLMRequest[]
    frozen: string[]
    constructed: RunnerIdentity[]
  }) => Promise<void>,
  response: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> = completedResponse,
  authorizePrompt: (request: AdmissionRequest) => Effect.Effect<void, AdmissionError> = () => Effect.void,
) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-pending-child-"))
  cleanup(directory)
  const requests: LLMRequest[] = []
  const frozen: string[] = []
  const constructed: RunnerIdentity[] = []
  const model = Model.make({ id: "proof-model", provider: "proof", route })
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    onRunnerConstruct: (identity) => { constructed.push(identity) },
    policy: {
      managed: () => Effect.succeed(true),
      authorize: (request) => Effect.sync(() => {
        expect(request.actor).toEqual({ userID: "authenticated-user", workspaceID: "wrk_pending_child" })
        expect(request.references).toEqual([])
      }).pipe(Effect.andThen(Effect.suspend(() => authorizePrompt(request)))),
      freeze: (request) => Effect.sync(() => {
        frozen.push(request.messageID)
        return { apiContent: request.text, rendererVersion: 1 }
      }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: (request) => {
        requests.push(request)
        return response(request)
      } })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  try {
    await run({ runtime, directory, requests, frozen, constructed })
  } finally {
    await runtime.dispose()
  }
}

// Exercise the execution bridge independently of the child creation API below.
test("pending-only execution preserves exact completed admission retries and promotes new input", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const pending = yield* PendingSessionExecution
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const child = yield* session.create({
        id: SessionSchema.ID.make("ses_pending_retry"),
        location: { directory: AbsolutePath.make(fixture.directory), workspaceID: WorkspaceV2.ID.make("wrk_pending_child") },
      })
      const prompt = {
        id: SessionMessage.ID.make("msg_pending_retry"), sessionID: child.id,
        prompt: { text: "first child input" }, resume: false,
      }
      const admit = (input: Parameters<typeof session.prompt>[0]) => session.prompt(input).pipe(
        Effect.provideService(PrivatePromptContext, {
          actor: { userID: "authenticated-user", workspaceID: "wrk_pending_child" }, references: [],
        }),
      )
      yield* admit(prompt)
      yield* pending.run(child.id)
      expect(fixture.requests).toHaveLength(1)
      yield* admit(prompt)
      yield* pending.run(child.id)
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.frozen).toEqual([prompt.id])
      yield* admit({ ...prompt, id: SessionMessage.ID.make("msg_pending_new"), prompt: { text: "next child input" } })
      yield* pending.run(child.id)
      expect(fixture.requests).toHaveLength(2)
      expect(fixture.frozen).toHaveLength(2)
      const messages = yield* session.messages({ sessionID: child.id })
      expect(messages.filter((message) => message.type === "user")).toHaveLength(2)
      expect(JSON.stringify(messages)).toContain("child answer")
      expect(fixture.constructed).toHaveLength(1)
      fixture.constructed.forEach((identity) => {
        expect(identity.database).toBe(database)
        expect(identity.events).toBe(events)
        expect(identity.store).toBe(store)
        expect(identity.location.directory).toBe(child.location.directory)
        expect(identity.location.workspaceID).toBe(child.location.workspaceID)
      })
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("native resume joins pending execution, native interrupt settles both, and another Session remains independent", async () => {
  const a = SessionSchema.ID.make("ses_pending_race_a")
  const b = SessionSchema.ID.make("ses_pending_race_b")
  const enteredA = Deferred.makeUnsafe<void>()
  const enteredB = Deferred.makeUnsafe<void>()
  const releaseB = Deferred.makeUnsafe<void>()
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const pending = yield* PendingSessionExecution
      const execution = yield* SessionExecution.Service
      yield* Effect.gen(function* () {
        for (const id of [a, b]) {
          yield* session.create({
            id, location: { directory: AbsolutePath.make(fixture.directory), workspaceID: WorkspaceV2.ID.make("wrk_pending_child") },
          })
          yield* session.prompt({ sessionID: id, prompt: { text: `input for ${id}` }, resume: false }).pipe(
            Effect.provideService(PrivatePromptContext, {
              actor: { userID: "authenticated-user", workspaceID: "wrk_pending_child" }, references: [],
            }),
          )
        }
        const first = yield* pending.run(a).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(enteredA)
        const joined = yield* execution.resume(a).pipe(Effect.forkScoped({ startImmediately: true }))
        const other = yield* pending.run(b).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(enteredB)
        expect(fixture.requests).toHaveLength(2)
        expect((yield* execution.active).size).toBe(2)
        yield* execution.interrupt(a)
        for (const fiber of [first, joined]) {
          const exit = yield* Fiber.await(fiber)
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(other.pollUnsafe()).toBeUndefined()
        expect((yield* execution.active).has(b)).toBe(true)
        yield* Deferred.succeed(releaseB, undefined)
        yield* Fiber.join(other)
        expect(fixture.requests).toHaveLength(2)
        expect((yield* execution.active).size).toBe(0)
      }).pipe(Effect.ensuring(Effect.all([execution.interrupt(a), execution.interrupt(b)], { concurrency: "unbounded" })))
    })).pipe(Effect.timeout("10 seconds")))
  }, (request) => {
    const id = new Headers(request.http?.headers).get("X-Session-Id")
    if (id === a) return Stream.unwrap(Deferred.succeed(enteredA, undefined).pipe(
      Effect.andThen(Effect.never), Effect.as(completedResponse()),
    ))
    if (id === b) return Stream.unwrap(Deferred.succeed(enteredB, undefined).pipe(
      Effect.andThen(Deferred.await(releaseB)), Effect.as(completedResponse()),
    ))
    return Stream.die("Unexpected provider Session")
  })
}, 30_000)

// The bridge tests above own execution coordination. The tests below exercise the
// actual child-runner API: creation/classification, retry reconciliation,
// authorization, placement conflicts, and concurrent/interrupted children.

const childWorkspace = WorkspaceV2.ID.make("wrk_pending_child")
const childActor = { userID: "authenticated-user", workspaceID: "wrk_pending_child" }
const childAgent = AgentV2.ID.make("build")
const childModel = { id: ModelV2.ID.make("proof-model"), providerID: ProviderV2.ID.make("proof") }

function childLocation(directory: string) {
  return { directory: AbsolutePath.make(directory), workspaceID: childWorkspace }
}

function childInput(parentSessionID: SessionSchema.ID, overrides: Partial<ChildRunInput> = {}): ChildRunInput {
  return {
    parentSessionID,
    agent: childAgent,
    model: childModel,
    title: "child title",
    prompt: "child input",
    actor: childActor,
    ...overrides,
  }
}

function expectFailure<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    return exit
  })
}

function expectChildRunFailure<A, R>(effect: Effect.Effect<A, ChildRunError, R>): Effect.Effect<void, never, R> {
  return Effect.gen(function* () {
    const exit = yield* expectFailure(effect)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(ChildRunError)
    }
  })
}

function publishUnclassifiedSession(directory: string, id: SessionSchema.ID, parentID?: SessionSchema.ID) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const boundary = yield* EventBoundary
    const location = childLocation(directory)
    yield* boundary.transaction(
      Effect.gen(function* () {
        const project = yield* projects.resolve(location.directory)
        yield* database.db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: location.directory,
          path: relative(project.directory, location.directory).replaceAll("\\", "/"),
          workspaceID: location.workspaceID,
          parentID,
          title: "unclassified child",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        yield* events.publish(SessionV1.Event.Created, { sessionID: id, info }, { location })
      }),
    )
  })
}

test("child runner creates a classified native child and returns assistant text", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const location = childLocation(fixture.directory)
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_create_parent"), location })
      const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
      const childID = SessionSchema.ID.make("ses_child_create")
      const promptMessageID = SessionMessage.ID.make("msg_child_create")
      const result = yield* runner.run(childInput(parent.id, { childSessionID: childID, promptMessageID }))
      expect(result.sessionID).toBe(childID)
      expect(result.text).toBe("child answer")
      const child = yield* session.get(childID)
      expect(child.parentID).toBe(parent.id)
      expect(child.title).toBe("child title")
      expect(child.agent).toBe(childAgent)
      expect(child.model?.providerID).toBe(childModel.providerID)
      expect(child.model?.id).toBe(childModel.id)
      // Runtime classification is compatibility metadata, not public native data.
      expect(JSON.stringify(child)).not.toContain('"runtime"')
      yield* requireV2Session(childID)
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.frozen).toEqual([promptMessageID])
      expect(fixture.constructed).toHaveLength(1)
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("child runner reuses identical supplied IDs and freezes the input once", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const location = childLocation(fixture.directory)
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_reuse_parent"), location })
      const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
      const childSessionID = SessionSchema.ID.make("ses_child_reuse")
      const promptMessageID = SessionMessage.ID.make("msg_child_reuse")
      const input = childInput(parent.id, { childSessionID, promptMessageID })
      expect((yield* runner.run(input)).text).toBe("child answer")
      expect(fixture.requests).toHaveLength(1)
      const second = yield* runner.run(input)
      expect(second.sessionID).toBe(childSessionID)
      expect(second.text).toBe("child answer")
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.frozen).toEqual([promptMessageID])
      expect(fixture.constructed).toHaveLength(1)
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("child runner rejects conflicting parent, placement, agent, model, variant, and title", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const location = childLocation(fixture.directory)
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_conflict_parent"), location })
      const otherParent = yield* session.create({ id: SessionSchema.ID.make("ses_child_conflict_other"), location })
      const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
      const base = childInput(parent.id, {
        childSessionID: SessionSchema.ID.make("ses_child_conflict"),
        promptMessageID: SessionMessage.ID.make("msg_child_conflict"),
      })
      expect((yield* runner.run(base)).text).toBe("child answer")
      const requests = fixture.requests.length
      const frozen = fixture.frozen.length
      const conflicts: ChildRunInput[] = [
        { ...base, title: "different title" },
        { ...base, agent: AgentV2.ID.make("plan") },
        { ...base, model: { id: ModelV2.ID.make("other-model"), providerID: childModel.providerID } },
        { ...base, model: { id: childModel.id, providerID: ProviderV2.ID.make("other-provider") } },
        {
          ...base,
          model: { id: childModel.id, providerID: childModel.providerID, variant: ModelV2.VariantID.make("high") },
        },
        { ...base, parentSessionID: otherParent.id },
      ]
      yield* Effect.forEach(conflicts, (conflict) => expectChildRunFailure(runner.run(conflict)))
      const misplaced = yield* makeChildRunner({
        location: { directory: AbsolutePath.make(fixture.directory), workspaceID: WorkspaceV2.ID.make("wrk_other") },
        authorize: () => Effect.void,
      })
      yield* expectChildRunFailure(misplaced.run(base))
      expect(fixture.requests).toHaveLength(requests)
      expect(fixture.frozen).toHaveLength(frozen)
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("denied actor publishes no child Session, admission, or event", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const location = childLocation(fixture.directory)
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_denied_parent"), location })
      const runner = yield* makeChildRunner({
        location,
        authorize: () => Effect.fail(new ChildRunError({ message: "denied" })),
      })
      const childID = SessionSchema.ID.make("ses_child_denied")
      yield* expectChildRunFailure(
        runner.run(
          childInput(parent.id, {
            childSessionID: childID,
            promptMessageID: SessionMessage.ID.make("msg_child_denied"),
          }),
        ),
      )
      expect(Exit.isFailure(yield* Effect.exit(session.get(childID)))).toBe(true)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.frozen).toHaveLength(0)
      const listed = yield* session.list({ directory: AbsolutePath.make(fixture.directory) })
      expect(listed.map((entry) => entry.id)).toEqual([parent.id])
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("unclassified parent and child are rejected without reclassification", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const location = childLocation(fixture.directory)
      const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
      const unclassifiedParent = SessionSchema.ID.make("ses_child_unclassified_parent")
      yield* publishUnclassifiedSession(fixture.directory, unclassifiedParent)
      yield* expectChildRunFailure(runner.run(childInput(unclassifiedParent)))
      yield* expectFailure(requireV2Session(unclassifiedParent))
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_classified_parent"), location })
      const unclassifiedChild = SessionSchema.ID.make("ses_child_unclassified_child")
      yield* publishUnclassifiedSession(fixture.directory, unclassifiedChild, parent.id)
      yield* expectChildRunFailure(runner.run(childInput(parent.id, { childSessionID: unclassifiedChild })))
      yield* expectFailure(requireV2Session(unclassifiedChild))
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.frozen).toHaveLength(0)
    }).pipe(Effect.timeout("10 seconds")))
  })
}, 30_000)

test("admission authorization revoked after child creation rolls back the entire child", async () => {
  const calls: string[] = []
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const location = childLocation(fixture.directory)
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_revoke_parent"), location })
      const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
      const childID = SessionSchema.ID.make("ses_child_revoke")
      const notifications: string[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => { notifications.push(event.id) }))
      yield* expectChildRunFailure(runner.run(childInput(parent.id, {
        childSessionID: childID, promptMessageID: SessionMessage.ID.make("msg_child_revoke"),
      }))).pipe(Effect.ensuring(unsubscribe))
      expect(calls).toHaveLength(2)
      expect(yield* database.db.all(sql`SELECT id FROM session WHERE id = ${childID}`)).toEqual([])
      expect(yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${childID}`)).toEqual([])
      expect(yield* database.db.all(sql`SELECT id FROM session_input WHERE session_id = ${childID}`)).toEqual([])
      expect(yield* database.db.all(sql`SELECT session_id FROM cm_session_runtime WHERE session_id = ${childID}`)).toEqual([])
      expect(yield* database.db.all(sql`SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${childID}`)).toEqual([])
      expect(yield* database.db.all(sql`SELECT message_id FROM cm_private_input WHERE session_id = ${childID}`)).toEqual([])
      expect(notifications).toEqual([])
      expect(fixture.requests).toEqual([])
    }))
  }, completedResponse, (request) => Effect.suspend(() => {
    calls.push(request.messageID)
    return calls.length === 1 ? Effect.void : Effect.fail(new AdmissionError({ code: "unauthorized" }))
  }))
}, 30_000)

test("legacy and mixed parent or child classification rejects an otherwise exact retry", async () => {
  await withRuntime(async (fixture) => {
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const location = childLocation(fixture.directory)
      const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_runtime_parent"), location })
      const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
      const childID = SessionSchema.ID.make("ses_child_runtime")
      const input = childInput(parent.id, { childSessionID: childID, promptMessageID: SessionMessage.ID.make("msg_child_runtime") })
      expect((yield* runner.run(input)).text).toBe("child answer")
      const before = yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${childID}`)
      for (const id of [parent.id, childID]) {
        for (const runtime of ["legacy", "mixed"]) {
          yield* database.db.run(sql`UPDATE cm_session_runtime SET runtime = ${runtime} WHERE session_id = ${id}`)
          yield* expectChildRunFailure(runner.run(input))
          expect(yield* database.db.get<{ runtime: string }>(sql`SELECT runtime FROM cm_session_runtime WHERE session_id = ${id}`))
            .toEqual({ runtime })
        }
        yield* database.db.run(sql`UPDATE cm_session_runtime SET runtime = 'v2' WHERE session_id = ${id}`)
      }
      expect(yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${childID}`)).toEqual(before)
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.frozen).toHaveLength(1)
    }))
  })
}, 30_000)

test("concurrent child call and external resume share one provider turn", async () => {
  const childID = SessionSchema.ID.make("ses_child_join")
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const location = childLocation(fixture.directory)
            const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_join_parent"), location })
            const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
            const child = yield* runner
              .run(
                childInput(parent.id, {
                  childSessionID: childID,
                  promptMessageID: SessionMessage.ID.make("msg_child_join"),
                }),
              )
              .pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Deferred.await(entered)
            const resumed = yield* execution.resume(childID).pipe(Effect.forkScoped({ startImmediately: true }))
            expect(fixture.requests).toHaveLength(1)
            yield* Deferred.succeed(release, undefined)
            expect((yield* Fiber.join(child)).text).toBe("child answer")
            yield* Fiber.join(resumed)
            expect(fixture.requests).toHaveLength(1)
          }).pipe(Effect.timeout("10 seconds")),
        ),
      )
    },
    (request) => {
      const id = new Headers(request.http?.headers).get("X-Session-Id")
      if (id === childID)
        return Stream.unwrap(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(completedResponse()),
          ),
        )
      return Stream.die("Unexpected provider Session")
    },
  )
}, 30_000)

test("explicit interrupt settles the child call and the joined resume", async () => {
  const childID = SessionSchema.ID.make("ses_child_interrupt")
  const entered = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const location = childLocation(fixture.directory)
            const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_interrupt_parent"), location })
            const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
            const child = yield* runner
              .run(
                childInput(parent.id, {
                  childSessionID: childID,
                  promptMessageID: SessionMessage.ID.make("msg_child_interrupt"),
                }),
              )
              .pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Deferred.await(entered)
            const resumed = yield* execution.resume(childID).pipe(Effect.forkScoped({ startImmediately: true }))
            yield* execution.interrupt(childID)
            const childExit = yield* Fiber.await(child)
            expect(childExit._tag).toBe("Failure")
            if (childExit._tag === "Failure") {
              const failure = Cause.findErrorOption(childExit.cause)
              expect(Option.isSome(failure)).toBe(true)
              if (Option.isSome(failure) && failure.value instanceof ChildRunError) {
                expect(failure.value.outcome).toBe("interrupted")
              }
            }
            const resumeExit = yield* Fiber.await(resumed)
            expect(resumeExit._tag).toBe("Failure")
            if (resumeExit._tag === "Failure") expect(Cause.hasInterruptsOnly(resumeExit.cause)).toBe(true)
          }).pipe(Effect.timeout("10 seconds")),
        ),
      )
    },
    (request) => {
      const id = new Headers(request.http?.headers).get("X-Session-Id")
      if (id === childID)
        return Stream.unwrap(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.as(completedResponse())),
        )
      return Stream.die("Unexpected provider Session")
    },
  )
}, 30_000)

test("independent children run concurrently", async () => {
  const a = SessionSchema.ID.make("ses_child_independent_a")
  const b = SessionSchema.ID.make("ses_child_independent_b")
  const enteredA = Deferred.makeUnsafe<void>()
  const enteredB = Deferred.makeUnsafe<void>()
  const releaseA = Deferred.makeUnsafe<void>()
  const releaseB = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const location = childLocation(fixture.directory)
            const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_independent_parent"), location })
            const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
            const first = yield* runner
              .run(
                childInput(parent.id, {
                  childSessionID: a,
                  promptMessageID: SessionMessage.ID.make("msg_independent_a"),
                }),
              )
              .pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Deferred.await(enteredA)
            const second = yield* runner
              .run(
                childInput(parent.id, {
                  childSessionID: b,
                  promptMessageID: SessionMessage.ID.make("msg_independent_b"),
                }),
              )
              .pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Deferred.await(enteredB)
            expect(fixture.requests).toHaveLength(2)
            yield* Deferred.succeed(releaseA, undefined)
            yield* Deferred.succeed(releaseB, undefined)
            expect((yield* Fiber.join(first)).text).toBe("child answer")
            expect((yield* Fiber.join(second)).text).toBe("child answer")
            expect(fixture.requests).toHaveLength(2)
          }).pipe(Effect.timeout("10 seconds")),
        ),
      )
    },
    (request) => {
      const id = new Headers(request.http?.headers).get("X-Session-Id")
      if (id === a)
        return Stream.unwrap(
          Deferred.succeed(enteredA, undefined).pipe(
            Effect.andThen(Deferred.await(releaseA)),
            Effect.as(completedResponse()),
          ),
        )
      if (id === b)
        return Stream.unwrap(
          Deferred.succeed(enteredB, undefined).pipe(
            Effect.andThen(Deferred.await(releaseB)),
            Effect.as(completedResponse()),
          ),
        )
      return Stream.die("Unexpected provider Session")
    },
  )
}, 30_000)

test("cancelling the initiating caller cleans the owned execution", async () => {
  const childID = SessionSchema.ID.make("ses_child_cancel")
  const entered = Deferred.makeUnsafe<void>()
  await withRuntime(
    async (fixture) => {
      await fixture.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const execution = yield* SessionExecution.Service
            const location = childLocation(fixture.directory)
            const parent = yield* session.create({ id: SessionSchema.ID.make("ses_child_cancel_parent"), location })
            const runner = yield* makeChildRunner({ location, authorize: () => Effect.void })
            const child = yield* runner
              .run(
                childInput(parent.id, {
                  childSessionID: childID,
                  promptMessageID: SessionMessage.ID.make("msg_child_cancel"),
                }),
              )
              .pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Deferred.await(entered)
            expect((yield* execution.active).has(childID)).toBe(true)
            yield* Fiber.interrupt(child)
            const exit = yield* Fiber.await(child)
            expect(exit._tag).toBe("Failure")
            expect((yield* execution.active).has(childID)).toBe(false)
          }).pipe(Effect.timeout("10 seconds")),
        ),
      )
    },
    (request) => {
      const id = new Headers(request.http?.headers).get("X-Session-Id")
      if (id === childID)
        return Stream.unwrap(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.as(completedResponse())),
        )
      return Stream.die("Unexpected provider Session")
    },
  )
}, 30_000)
