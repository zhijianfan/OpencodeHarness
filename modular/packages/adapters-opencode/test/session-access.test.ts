import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Location } from "@opencode-ai/core/location"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Context, Effect, Layer, LayerMap, ManagedRuntime, Stream } from "effect"
import { sql } from "drizzle-orm"
import type { AdmissionRequest } from "../src/admission"
import { makeEventBoundaryNode, makeMediatedEventNode } from "../src/event-boundary"
import { initializeExtension } from "../src/kernel"
import { makeSessionFacadeNode } from "../src/session-facade"
import { makeSessionAccess, SessionAccessError, type ContextAttachment, type SessionAccessPolicy } from "../src/session-access"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const sessionID = SessionSchema.ID.make("ses_access_a")
const otherID = SessionSchema.ID.make("ses_access_b")
const actor = { userID: "user-a", workspaceID: WorkspaceV2.ID.make("wrk_access_a") }
const otherActor = { userID: "user-b", workspaceID: WorkspaceV2.ID.make("wrk_access_b") }
const attachment: ContextAttachment = {
  contextCapsuleID: "capsule", label: "Selected context", contentHash: "hash-1",
  source: { kind: "ctxpack", ctxPackID: "pack-1" },
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-session-access-"))
  cleanup(directory)
  const counts = { freeze: 0, wake: 0, resume: 0, interrupt: 0 }
  const frozen: AdmissionRequest[] = []
  const checks: Parameters<SessionAccessPolicy["authorize"]>[0][] = []
  const active = new Set([sessionID, otherID])
  const policy: SessionAccessPolicy = {
    authorize: (input) => Effect.gen(function* () {
      checks.push(input)
      if (input.location.workspaceID !== input.actor.workspaceID) {
        return yield* new SessionAccessError({ code: "forbidden" })
      }
    }),
  }
  const database = makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(join(directory, "access.db")), deps: [] })
  const boundary = makeEventBoundaryNode()
  const facade = makeSessionFacadeNode(boundary, {
    managed: () => Effect.succeed(true),
    authorize: () => Effect.void,
    freeze: (request) => Effect.sync(() => {
      counts.freeze++
      frozen.push(request)
      return { apiContent: "PRIVATE fragment never supplied by the caller", rendererVersion: 1 }
    }),
  })
  const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
    active: Effect.sync(() => active),
    resume: () => Effect.sync(() => { counts.resume++ }),
    wake: () => Effect.sync(() => { counts.wake++ }),
    interrupt: () => Effect.sync(() => { counts.interrupt++ }),
  }))
  const unavailableLocation: Effect.Effect<Context.Context<LocationServices>> = Effect.die("access fixture has no model runtime")
  const locationLayer = Layer.effectContext(unavailableLocation)
  const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node, EventV2.node, boundary]), [
    [Database.node, database], [EventV2.node, makeMediatedEventNode(boundary)], [SessionV2.node, facade],
    [SessionExecution.node, execution],
    // Actual native Session, projector and store; these collaborators are unused
    // by seeded reads/adoption/admission and authorization-denied mutations.
    [ProjectV2.node, Layer.mock(ProjectV2.Service, {})],
    [LocationServiceMap.node, Layer.effect(LocationServiceMap.Service, LayerMap.make((_ref: Location.Ref) => locationLayer))],
  ]))
  await runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* initializeExtension
    yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('project', ${directory}, '[]', 0, 0)`)
    yield* database.db.run(sql`INSERT INTO session
      (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
      VALUES (${sessionID}, 'project', 'a', ${directory}, 'A', '1', 0, 0, ${actor.workspaceID}),
             (${otherID}, 'project', 'b', ${directory}, 'B', '1', 1, 1, ${otherActor.workspaceID})`)
  })).catch(async (error: unknown) => { await runtime.dispose(); throw error })
  return { runtime, directory, counts, frozen, checks, active, policy, async [Symbol.asyncDispose]() { await runtime.dispose() } }
}

function accessError<A, E, R>(operation: Effect.Effect<A, E, R>, code: SessionAccessError["code"]) {
  return operation.pipe(Effect.flip, Effect.map((error) => {
    expect(error).toBeInstanceOf(SessionAccessError)
    if (!(error instanceof SessionAccessError)) throw new Error("Expected SessionAccessError")
    expect(error.code).toBe(code)
  }))
}

test("empty actors fail before lookup, policy or delegation, including empty collections", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const database = yield* Database.Service
    env.active.clear()
    yield* database.db.run(sql`DELETE FROM session`)
    const missing = SessionSchema.ID.make("ses_missing")
    yield* accessError(access.get({ ...actor, userID: " \t" }, missing), "unauthorized")
    yield* accessError(access.list({ ...actor, workspaceID: "" }), "unauthorized")
    yield* accessError(access.active({ ...actor, workspaceID: " \n" }), "unauthorized")
    yield* accessError(access.prompt({ ...actor, userID: "" }, { sessionID: missing, prompt: { text: "public" } }), "unauthorized")
    yield* accessError(access.create({ ...actor, userID: "" }, {
      location: { directory: AbsolutePath.make(env.directory), workspaceID: WorkspaceV2.ID.make(actor.workspaceID) },
    }), "unauthorized")
    yield* accessError(access.events({ ...actor, workspaceID: " " }, { sessionID: missing }).pipe(Stream.runCollect), "unauthorized")
    expect(env.checks).toEqual([])
  }))
  expect(env.counts).toEqual({ freeze: 0, wake: 0, resume: 0, interrupt: 0 })
})

test("recorded placement gates reads, message lookup and mutations without side effects", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const native = yield* SessionV2.Service
    const database = yield* Database.Service
    const before = yield* native.get(otherID)
    const history = yield* native.history({ sessionID: otherID, limit: 100 })
    const messageID = SessionMessage.ID.make("msg_absent")
    yield* accessError(access.get(actor, otherID), "forbidden")
    yield* accessError(access.context(actor, otherID), "forbidden")
    yield* accessError(access.messages(actor, { sessionID: otherID }), "forbidden")
    yield* accessError(access.message(actor, { sessionID: otherID, messageID }), "forbidden")
    yield* accessError(access.history(actor, { sessionID: otherID, limit: 100 }), "forbidden")
    yield* accessError(access.prompt(actor, { sessionID: otherID, prompt: { text: "private caller input" } }), "forbidden")
    yield* accessError(access.resume(actor, otherID), "forbidden")
    yield* accessError(access.interrupt(actor, otherID), "forbidden")
    yield* accessError(access.switchAgent(actor, { sessionID: otherID, agent: "new-agent" }), "forbidden")
    yield* accessError(access.revertStage(actor, { sessionID: otherID, messageID }), "forbidden")
    yield* accessError(access.revertClear(actor, otherID), "forbidden")
    yield* accessError(access.revertCommit(actor, otherID), "forbidden")
    yield* accessError(access.events(actor, { sessionID: otherID }).pipe(Stream.runCollect), "forbidden")
    expect(yield* native.get(otherID)).toEqual(before)
    expect(yield* native.history({ sessionID: otherID, limit: 100 })).toEqual(history)
    expect(yield* database.db.all(sql`SELECT id FROM session_input`)).toEqual([])
    expect(env.checks.length).toBeGreaterThan(0)
    env.checks.forEach((check) => {
      expect(check.session?.id).toBe(otherID)
      expect(check.location).toEqual(before.location)
      expect(check.actor).toEqual(actor)
    })
  }))
  expect(env.counts).toEqual({ freeze: 0, wake: 0, resume: 0, interrupt: 0 })
})

test("create cannot adopt another workspace through an authorized requested location", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const native = yield* SessionV2.Service
    const before = yield* native.get(otherID)
    yield* accessError(access.create(actor, {
      id: otherID,
      location: { directory: AbsolutePath.make(env.directory), workspaceID: WorkspaceV2.ID.make(actor.workspaceID) },
    }), "forbidden")
    expect(env.checks.map((check) => ({ action: check.action, workspaceID: check.location.workspaceID, id: check.session?.id }))).toEqual([
      { action: "create", workspaceID: actor.workspaceID, id: undefined },
      { action: "create", workspaceID: otherActor.workspaceID, id: otherID },
    ])
    expect(yield* native.get(otherID)).toEqual(before)
    env.checks.length = 0
    expect(yield* access.create(otherActor, { id: otherID, location: before.location })).toEqual(before)
    expect(env.checks.map((check) => check.session?.id)).toEqual([undefined, otherID, otherID])
  }))
})

test("list and active filter forbidden Sessions but propagate all other access errors", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    expect((yield* access.list(actor)).map((info) => info.id)).toEqual([sessionID])
    expect((yield* access.list(otherActor)).map((info) => info.id)).toEqual([otherID])
    expect(yield* access.active(actor)).toEqual(new Set([sessionID]))
    expect(yield* access.active(otherActor)).toEqual(new Set([otherID]))
    const unauthorized = yield* makeSessionAccess({ authorize: () => Effect.fail(new SessionAccessError({ code: "unauthorized" })) })
    yield* accessError(unauthorized.list(actor), "unauthorized")
    yield* accessError(unauthorized.active(actor), "unauthorized")
    const invalid = yield* makeSessionAccess({ authorize: () => Effect.fail(new SessionAccessError({ code: "invalid-attachments" })) })
    yield* accessError(invalid.list(actor), "invalid-attachments")
    yield* accessError(invalid.active(actor), "invalid-attachments")
  }))
})

test("native MIME normalization, queue, admit-only and exact attachment retries are preserved", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const input = {
      id: SessionMessage.ID.make("msg_access_retry"), sessionID,
      prompt: { text: "public question", files: [{ uri: "data:text/plain;base64,YQ==", name: "file.png" }] },
      delivery: "queue", resume: false, contextAttachments: [attachment],
    } satisfies Parameters<typeof access.prompt>[1]
    const admitted = yield* access.prompt(actor, input)
    expect(env.frozen[0]?.messageID).toBe(input.id)
    expect(admitted.prompt.files?.[0]?.mime).toBe("text/plain")
    expect(admitted.prompt.text).toBe(input.prompt.text)
    expect(admitted.delivery).toBe("queue")
    expect(env.counts).toEqual({ freeze: 1, wake: 0, resume: 0, interrupt: 0 })
    expect(env.frozen[0]?.actor).toEqual(actor)
    expect(env.frozen[0]?.references).toEqual([{
      id: JSON.stringify({ contextCapsuleID: attachment.contextCapsuleID, sourceCtxPackID: attachment.source.ctxPackID, label: attachment.label }),
      contentHash: attachment.contentHash,
    }])
    expect(yield* access.prompt(actor, input)).toEqual(admitted)
    yield* access.prompt(actor, { ...input, resume: true })
    expect(env.counts).toEqual({ freeze: 1, wake: 1, resume: 0, interrupt: 0 })
    const messages = yield* access.messages(actor, { sessionID })
    const context = yield* access.context(actor, sessionID)
    const history = yield* access.history(actor, { sessionID, limit: 100 })
    expect(JSON.stringify(history)).toContain("public question")
    expect(JSON.stringify({ messages, context, history })).not.toContain("PRIVATE fragment")
    expect(JSON.stringify({ messages, context, history })).not.toContain(attachment.contextCapsuleID)
    yield* access.resume(actor, sessionID)
    yield* access.interrupt(actor, sessionID)
    expect(env.counts).toEqual({ freeze: 1, wake: 1, resume: 1, interrupt: 1 })
  }))
})

test("attachment source, label, hash and order participate in native exact retry conflicts", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const second = { ...attachment, contextCapsuleID: "capsule-2" }
    const input = {
      sessionID, id: SessionMessage.ID.make("msg_access_identity"), prompt: { text: "public" },
      resume: false, contextAttachments: [attachment, second],
    }
    yield* access.prompt(actor, input)
    const variants = [
      [{ ...attachment, source: { ...attachment.source, ctxPackID: "other-source" } }, second],
      [{ ...attachment, label: "other label" }, second],
      [{ ...attachment, contentHash: "other hash" }, second],
      [second, attachment],
    ]
    yield* Effect.forEach(variants, (contextAttachments) => access.prompt(actor, { ...input, contextAttachments }).pipe(
      Effect.flip, Effect.map((error) => { expect(error).toBeInstanceOf(SessionV2.PromptConflictError) }),
    ))
    const changedPrompt = yield* access.prompt(actor, { ...input, prompt: { text: "changed public" } }).pipe(Effect.flip)
    expect(changedPrompt).toBeInstanceOf(SessionV2.PromptConflictError)
    const changedDelivery = yield* access.prompt(actor, { ...input, delivery: "queue" }).pipe(Effect.flip)
    expect(changedDelivery).toBeInstanceOf(SessionV2.PromptConflictError)
    expect(env.counts).toEqual({ freeze: 1, wake: 0, resume: 0, interrupt: 0 })
  }))
})

test("invalid attachment shapes, private bodies, duplicates and oversized arrays fail before freeze", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const invalid: readonly unknown[] = [
      null, {}, "not an array", [null], [{}],
      [{ ...attachment, contextCapsuleID: " " }], [{ ...attachment, label: "" }],
      [{ ...attachment, contentHash: "\t" }], [{ ...attachment, source: { kind: "ctxpack", ctxPackID: "" } }],
      [{ ...attachment, source: { kind: "other", ctxPackID: "pack" } }],
      [{ ...attachment, body: "PRIVATE caller body" }],
      [{ ...attachment, source: { ...attachment.source, body: "PRIVATE caller body" } }],
      [attachment, attachment],
      Array.from({ length: 9 }, (_, index) => ({ ...attachment, contextCapsuleID: `capsule-${index}` })),
      Array.from({ length: 1 }),
    ]
    yield* Effect.forEach(invalid, (contextAttachments) => {
      // Deliberately exercise untyped transport callers, without an unchecked cast.
      // @ts-expect-error contextAttachments is intentionally untrusted runtime input
      return accessError(access.prompt(actor, { sessionID, prompt: { text: "public" }, contextAttachments }), "invalid-attachments")
    })
    expect(env.checks).toEqual([])
    const database = yield* Database.Service
    expect(yield* database.db.all(sql`SELECT id FROM session_input`)).toEqual([])
    expect(env.counts.freeze).toBe(0)
    expect(env.counts.wake).toBe(0)
    yield* access.prompt(actor, {
      sessionID, prompt: { text: "eight valid references" }, resume: false,
      contextAttachments: Array.from({ length: 8 }, (_, index) => ({ ...attachment, contextCapsuleID: `capsule-${index}` })),
    })
    expect(env.counts.freeze).toBe(1)
  }))
})

test("native NotFound stays typed and message lookup first authorizes its parent", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const missing = SessionSchema.ID.make("ses_missing")
    expect(yield* access.get(actor, missing).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
    expect(yield* access.message(actor, { sessionID: missing, messageID: SessionMessage.ID.make("msg_missing") }).pipe(Effect.flip))
      .toBeInstanceOf(SessionV2.NotFoundError)
    expect(yield* access.message(actor, { sessionID, messageID: SessionMessage.ID.make("msg_missing") })).toBeUndefined()
    expect(env.checks.map((check) => check.session?.id)).toEqual([sessionID])
    env.active.add(missing)
    expect(yield* access.active(actor).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
  }))
})

test("omitted attachments and native default delivery still use explicit private actor scope", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const admitted = yield* access.prompt(actor, { sessionID, prompt: { text: "ordinary public prompt" } })
    expect(admitted.delivery).toBe("steer")
    expect(env.frozen[0]?.actor).toEqual(actor)
    expect(env.frozen[0]?.references).toEqual([])
    expect(env.counts).toEqual({ freeze: 1, wake: 1, resume: 0, interrupt: 0 })
  }))
})

test("event delivery rechecks current recorded placement before each public event", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const access = yield* makeSessionAccess(env.policy)
    const database = yield* Database.Service
    yield* access.switchAgent(actor, { sessionID, agent: "first" })
    yield* access.switchAgent(actor, { sessionID, agent: "second" })
    // after:0 is exclusive, so two replayable events require sequences 1 and 2.
    yield* access.switchAgent(actor, { sessionID, agent: "third" })
    const delivered: unknown[] = []
    yield* accessError(access.events(actor, { sessionID, after: 0 }).pipe(
      Stream.mapEffect((event) => Effect.gen(function* () {
        delivered.push(event)
        // Simulate recorded placement changing after subscription. The next
        // event must be withheld even though the actor initially had access.
        yield* database.db.run(sql`UPDATE session SET workspace_id = ${otherActor.workspaceID} WHERE id = ${sessionID}`)
        return event
      })),
      Stream.take(2),
      Stream.runCollect,
    ), "forbidden")
    expect(delivered).toHaveLength(1)
    expect(env.checks.at(-1)?.location.workspaceID).toBe(otherActor.workspaceID)
  }).pipe(Effect.timeout("5 seconds")))
})
