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
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Context, Effect, Layer, LayerMap, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary, makeEventBoundaryNode, makeMediatedEventNode } from "../src/event-boundary"
import { initializeExtension } from "../src/kernel"
import { PrivatePromptContext, makeSessionFacadeNode } from "../src/session-facade"
import { makePrivateProjection } from "../src/projection"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const sessionID = SessionSchema.ID.make("ses_facade")
const context = { actor: { userID: "user", workspaceID: "wrk_proof" }, references: [{ id: "pack", contentHash: "version-1" }] }

async function fixture(managed = true) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-session-facade-"))
  cleanup(directory)
  const counts = { freeze: 0, wake: 0 }
  const database = makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(join(directory, "proof.db")), deps: [] })
  const boundary = makeEventBoundaryNode()
  const facade = makeSessionFacadeNode(boundary, {
    managed: () => Effect.succeed(managed),
    authorize: () => Effect.void,
    freeze: () => Effect.sync(() => { counts.freeze++; return { apiContent: "frozen private context", rendererVersion: 1 } }),
  })
  const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
    active: Effect.succeed(new Set()), resume: () => Effect.die("admission fixture does not execute models"),
    wake: () => Effect.sync(() => { counts.wake++ }), interrupt: () => Effect.void,
  }))
  const unavailableLocation: Effect.Effect<Context.Context<LocationServices>> = Effect.die("admission fixture has no model runtime")
  const locationLayer = Layer.effectContext(unavailableLocation)
  const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node, EventV2.node, boundary]), [
    [Database.node, database], [EventV2.node, makeMediatedEventNode(boundary)], [SessionV2.node, facade],
    [SessionExecution.node, execution],
    // These collaborators are not used by get/prompt; the native Session
    // constructor still receives its actual service identities.
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
      VALUES (${sessionID}, 'project', 'proof', ${directory}, 'Proof', '1', 0, 0, 'wrk_proof')`)
  })).catch(async (error: unknown) => { await runtime.dispose(); throw error })
  return { runtime, counts, async [Symbol.asyncDispose]() { await runtime.dispose() } }
}

test("native Session prompt service delegates normalization while adding atomic private context", async () => {
  await using env = await fixture()
  const id = SessionMessage.ID.make("msg_facade")
  const prompt = { text: "public", files: [{ uri: "data:text/plain;base64,YQ==", name: "file.png" }] }
  const input = { id, sessionID, prompt, delivery: "queue" as const, resume: false }
  const run = Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.prompt(input)
  }).pipe(Effect.provideService(PrivatePromptContext, context))
  const admitted = await env.runtime.runPromise(run)
  expect(admitted.prompt.files?.[0].mime).toBe("text/plain")
  expect(admitted.delivery).toBe("queue")
  expect(admitted.prompt.text).toBe("public")
  expect(env.counts).toEqual({ freeze: 1, wake: 0 })
  await env.runtime.runPromise(run)
  expect(env.counts.freeze).toBe(1)
  const data = await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input WHERE message_id = ${id}`)
  }))
  expect(data?.api_content).toBe("frozen private context")
  await env.runtime.runPromise(Effect.gen(function* () {
    const session = yield* SessionV2.Service
    yield* session.prompt({ ...input, resume: true })
  }).pipe(Effect.provideService(PrivatePromptContext, context)))
  expect(env.counts).toEqual({ freeze: 1, wake: 1 })
})

test("changed references or normalized native prompt conflict without recall or wake", async () => {
  await using env = await fixture()
  const id = SessionMessage.ID.create()
  const run = (text: string) => Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.prompt({ sessionID, id, prompt: { text }, resume: false })
  })
  await env.runtime.runPromise(run("public").pipe(Effect.provideService(PrivatePromptContext, context)))
  const changedContext = { ...context, references: [{ id: "pack", contentHash: "changed" }] }
  const referenceConflict = await env.runtime.runPromise(run("public").pipe(Effect.provideService(PrivatePromptContext, changedContext), Effect.flip))
  expect(referenceConflict).toBeInstanceOf(SessionV2.PromptConflictError)
  const promptConflict = await env.runtime.runPromise(run("changed").pipe(Effect.provideService(PrivatePromptContext, context), Effect.flip))
  expect(promptConflict).toBeInstanceOf(SessionV2.PromptConflictError)
  expect(env.counts).toEqual({ freeze: 1, wake: 0 })
})

test("managed native prompt and bare admission cannot bypass required private scope", async () => {
  await using env = await fixture()
  await env.runtime.runPromise(Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const missing = yield* session.prompt({ sessionID, prompt: { text: "public" }, resume: false }).pipe(Effect.exit)
    expect(missing._tag).toBe("Failure")
    const bare = yield* SessionInput.admit(database.db, events, { sessionID, id: SessionMessage.ID.create(), prompt: { text: "bypass" }, delivery: "steer" }).pipe(Effect.exit)
    expect(bare._tag).toBe("Failure")
    expect(yield* database.db.all(sql`SELECT id FROM session_input`)).toEqual([])
  }))
  expect(env.counts).toEqual({ freeze: 0, wake: 0 })
})

test("unmanaged native sessions retain ordinary clean prompt behavior", async () => {
  await using env = await fixture(false)
  const result = await env.runtime.runPromise(Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.prompt({ sessionID, prompt: { text: "ordinary" } })
  }))
  expect(result.prompt.text).toBe("ordinary")
  expect(env.counts).toEqual({ freeze: 0, wake: 1 })
})

test("validated private replay works with the managed admission guard installed", async () => {
  await using source = await fixture()
  await using target = await fixture()
  const projection = makePrivateProjection({ authorize: () => Effect.void })
  const scope = { sessionID, workspaceID: "wrk_proof", ownerID: "owner" }
  await source.runtime.runPromise(Effect.gen(function* () {
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: { text: "public" }, resume: false })
  }).pipe(Effect.provideService(PrivatePromptContext, context)))
  const bundle = await source.runtime.runPromise(projection.export(scope))
  await target.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: bundle.digest }))
  expect(await target.runtime.runPromise(projection.export(scope))).toEqual(bundle)
  expect(target.counts).toEqual({ freeze: 0, wake: 0 })
})

test("ordinary native prompt wake also waits for an enclosing transaction", async () => {
  await using env = await fixture(false)
  await env.runtime.runPromise(Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const boundary = yield* EventBoundary
    const result = yield* boundary.transaction(Effect.gen(function* () {
      yield* session.prompt({ sessionID, prompt: { text: "ordinary" } })
      expect(env.counts.wake).toBe(0)
      return yield* Effect.fail("rollback outer")
    })).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }))
  expect(env.counts).toEqual({ freeze: 0, wake: 0 })
})
