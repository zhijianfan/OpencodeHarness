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
import { LLMClient, LLMEvent, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { sql } from "drizzle-orm"
import { AdmissionError, privateRequestIdentity, type FrozenInput } from "../src/admission"
import { interactiveContextBudget, renderContextSnapshot, type ContextSidecarAttachment } from "../src/context-renderer"
import { EventBoundary } from "../src/event-boundary"
import { decodeLegacyContext, legacyDigest } from "../src/legacy-context"
import { makeLegacyProjection, recordLegacyInputEvent } from "../src/legacy-projection"
import { PrivatePromptContext } from "../src/session-facade"
import { createSessionRuntime } from "../src/session-runtime"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const projection = makeLegacyProjection({ authorize: () => Effect.void })
const sessionID = SessionSchema.ID.make("ses_input_compatibility")
const messageID = SessionMessage.ID.make("msg_input_compatibility")
const actor = { userID: "user-input", workspaceID: "wrk_input" }
const scope = { sessionID, workspaceID: actor.workspaceID, ownerID: "owner-input" }
const references = [{
  id: JSON.stringify({ contextCapsuleID: "capsule", sourceCtxPackID: "pack", label: "Reference" }),
  contentHash: "attachment-hash",
}]

type Mode = "clean" | "tagged" | "corrupt" | "budget" | "proof"

async function fixture(mode: Mode = "clean", nativeCreate = false) {
  const directory = await mkdtemp(join(tmpdir(), "input-compatibility-"))
  cleanup(directory)
  const state: { mode: Mode; frozen: number; body: string; authorizations: number; authorizationLimit: number } = {
    mode, frozen: 0, body: "PRIVATE_FRAGMENT <&> 雪", authorizations: 0, authorizationLimit: Infinity,
  }
  const requests: string[] = []
  const entered = Deferred.makeUnsafe<void>()
  const model = Model.make({ id: "input-model", provider: "proof", route })
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    policy: {
      managed: () => Effect.succeed(true),
      authorize: () => Effect.suspend(() => {
        state.authorizations++
        return state.authorizations <= state.authorizationLimit ? Effect.void : Effect.fail(new AdmissionError({ code: "unauthorized" }))
      }),
      freeze: (request) => Effect.try({
        try: (): FrozenInput => {
          state.frozen++
          if (state.mode === "clean") return { apiContent: request.text, rendererVersion: 1 }
          if (state.mode === "proof") return { apiContent: "PRIVATE_PROOF_ONLY", rendererVersion: 1 }
          const attachment: ContextSidecarAttachment = {
            selection: "explicit", contextCapsuleID: "capsule", sourceCtxPackID: "pack", label: "Reference",
            tags: ["ParallelPlan"], contentHash: "attachment-hash", fragments: [{ contentHash: "fragment-hash", text: state.body }],
          }
          const snapshot = renderContextSnapshot({
            promptText: request.text, attachments: [attachment], recall: { policy: "disabled", status: "disabled" },
            budget: state.mode === "budget" ? { maximumBytes: 1, maximumEstimatedTokens: 1 } : interactiveContextBudget,
            createdAt: 42,
          })
          return {
            apiContent: snapshot.apiContent, rendererVersion: snapshot.rendererVersion,
            context: state.mode === "corrupt" ? { ...snapshot.snapshot, apiContentHash: "corrupt" } : snapshot.snapshot,
          }
        },
        catch: () => new AdmissionError({ code: "invalid-snapshot" }),
      }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, {
        stream: (request) => {
          requests.push(JSON.stringify(request))
          return Stream.unwrap(Deferred.succeed(entered, undefined).pipe(Effect.as(Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text" }),
            LLMEvent.textDelta({ id: "text", text: "public answer" }), LLMEvent.textEnd({ id: "text" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" }),
          ]))))
        },
      })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  await runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    if (nativeCreate) {
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location: {
        directory: AbsolutePath.make(directory), workspaceID: WorkspaceV2.ID.make(actor.workspaceID),
      } })
      return
    }
    // Pre-existing placement deliberately has no Created event, matching the
    // retained-session transfer fixture and keeping the admission at sequence 0.
    yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('project', ${directory}, '[]', 0, 0)`)
    yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
      VALUES (${sessionID}, 'project', 'input', ${directory}, 'Input', '1', 0, 0, ${actor.workspaceID})`)
  })).catch(async (error: unknown) => {
    await runtime.dispose()
    throw error
  })
  const prompt = (input: {
    readonly id?: SessionMessage.ID
    readonly text?: string
    readonly references?: readonly { readonly id: string; readonly contentHash: string }[]
    readonly delivery?: "steer" | "queue"
    readonly resume?: boolean
  } = {}) => Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.prompt({
      sessionID, id: input.id ?? messageID, prompt: { text: input.text ?? "public prompt" },
      delivery: input.delivery ?? "steer", resume: input.resume ?? false,
    })
  }).pipe(Effect.provideService(PrivatePromptContext, {
    actor, references: input.references ?? (mode === "clean" || mode === "proof" ? [] : references),
  }))
  return { runtime, prompt, state, requests, entered, [Symbol.asyncDispose]: () => runtime.dispose() }
}

// Transfer ownership is a separate explicit fixture setup, never inferred from
// an actor-inclusive private request hash or embedded bundle metadata.
const claimTransferOwner = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run(sql`UPDATE event_sequence SET owner_id = ${scope.ownerID} WHERE aggregate_id = ${sessionID}`)
})

const rows = Effect.gen(function* () {
  const database = yield* Database.Service
  return {
    events: yield* database.db.all(sql`SELECT * FROM event WHERE aggregate_id = ${sessionID}`),
    inputs: yield* database.db.all(sql`SELECT * FROM session_input WHERE session_id = ${sessionID}`),
    private: yield* database.db.all(sql`SELECT * FROM cm_private_input WHERE session_id = ${sessionID}`),
    snapshots: yield* database.db.all(sql`SELECT * FROM cm_legacy_input WHERE session_id = ${sessionID}`),
    metadata: yield* database.db.all(sql`SELECT * FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`),
    requirements: yield* database.db.all(sql`SELECT * FROM cm_private_requirement WHERE session_id = ${sessionID}`),
  }
})

const proof = Effect.gen(function* () {
  const database = yield* Database.Service
  return yield* database.db.get<{
    request_hash: string; api_content: string; api_content_hash: string; renderer_version: number; snapshot_json: string;
  }>(sql`SELECT p.request_hash, p.api_content, p.api_content_hash, p.renderer_version, l.snapshot_json
    FROM cm_private_input p JOIN cm_legacy_input l ON l.message_id = p.message_id AND l.session_id = p.session_id
    WHERE p.message_id = ${messageID} AND p.session_id = ${sessionID}`)
})

test("clean native admissions export/restore full snapshots without rewriting local retry identity", async () => {
  await using source = await fixture()
  await using target = await fixture()
  const admitted = await source.runtime.runPromise(source.prompt())
  await source.runtime.runPromise(claimTransferOwner)
  const before = await source.runtime.runPromise(proof)
  expect(before?.request_hash).toBe(privateRequestIdentity({
    sessionID, messageID, actor, text: "public prompt", delivery: "steer", references: [],
  }))
  const bundle = await source.runtime.runPromise(projection.export(scope))
  expect(bundle.events).toHaveLength(1)
  expect(bundle.events[0]?.data.modelContextVersion).toBe(2)
  const context = bundle.contexts[0]
  if (!context) throw new Error("Missing exported snapshot")
  const decoded = decodeLegacyContext(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(context.payload), "public prompt")
  expect(decoded.snapshot.createdAt).toBe(bundle.events[0]?.data.timestamp)
  expect(decoded.snapshot.attachments).toEqual([])
  expect(decoded.snapshot.byteLength).toBe(0)
  expect(decoded.snapshot.estimatedTokens).toBe(0)
  expect(decoded.apiContent).toBe("public prompt")
  await source.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }))
  expect(await source.runtime.runPromise(proof)).toEqual(before)
  expect(await source.runtime.runPromise(source.prompt())).toEqual(admitted)
  expect(source.state.frozen).toBe(1)
  await target.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }))
  expect(await target.runtime.runPromise(projection.export(scope))).toEqual(bundle)
  expect((await target.runtime.runPromise(proof))?.request_hash).toBe("legacy:" + decoded.contextRequestHash)
  expect((await target.runtime.runPromise(target.prompt())).id).toBe(messageID)
  expect(target.state.frozen).toBe(0)
  expect(source.requests).toEqual([])
  expect(target.requests).toEqual([])
}, 30_000)

test("tagged snapshots persist, reconcile exact retries and restore imported retries without freeze", async () => {
  await using source = await fixture("tagged")
  await using target = await fixture("tagged")
  const admitted = await source.runtime.runPromise(source.prompt({ delivery: "queue" }))
  const before = await source.runtime.runPromise(proof)
  expect(before?.renderer_version).toBe(2)
  expect(before?.api_content).toContain("PRIVATE_FRAGMENT")
  expect(before?.snapshot_json).toContain("ParallelPlan")
  source.state.body = "changed producer body must not be used on retry"
  expect(await source.runtime.runPromise(source.prompt({ delivery: "queue" }))).toEqual(admitted)
  expect(source.state.frozen).toBe(1)
  expect(await source.runtime.runPromise(proof)).toEqual(before)
  for (const input of [
    { references: references.map((reference) => ({ ...reference, contentHash: "changed" })), delivery: "queue" },
    { text: "changed prompt", delivery: "queue" },
    { delivery: "steer" },
  ] satisfies Parameters<typeof source.prompt>[0][]) {
    expect(await source.runtime.runPromise(source.prompt(input).pipe(Effect.flip))).toBeInstanceOf(SessionV2.PromptConflictError)
  }
  expect(source.state.frozen).toBe(1)
  await source.runtime.runPromise(claimTransferOwner)
  const bundle = await source.runtime.runPromise(projection.export(scope))
  await source.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }))
  expect(await source.runtime.runPromise(proof)).toEqual(before)
  await target.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }))
  const imported = await target.runtime.runPromise(rows)
  expect((await target.runtime.runPromise(target.prompt({ delivery: "queue" }))).id).toBe(messageID)
  expect(target.state.frozen).toBe(0)
  expect(await target.runtime.runPromise(rows)).toEqual(imported)
  expect(await target.runtime.runPromise(target.prompt({ references: [], delivery: "queue" }).pipe(Effect.flip)))
    .toBeInstanceOf(SessionV2.PromptConflictError)
  expect(await target.runtime.runPromise(projection.export(scope))).toEqual(bundle)
}, 30_000)

test("renderer context reaches the actual provider while native events, messages and notifications remain clean", async () => {
  await using target = await fixture("tagged", true)
  const notifications: string[] = []
  await target.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    yield* events.listen((event) => Effect.gen(function* () {
      const metadata = yield* database.db.get(sql`SELECT event_id FROM cm_legacy_event WHERE aggregate_id = ${sessionID}`).pipe(Effect.orDie)
      expect(metadata).toBeDefined()
      notifications.push(JSON.stringify(event))
    }))
    yield* target.prompt({ resume: true })
    yield* Deferred.await(target.entered).pipe(Effect.timeout("5 seconds"))
    const session = yield* SessionV2.Service
    expect(JSON.stringify(yield* session.messages({ sessionID }))).not.toContain("PRIVATE_FRAGMENT")
    const eventsStored = yield* database.db.all(sql`SELECT data FROM event WHERE aggregate_id = ${sessionID}`)
    expect(JSON.stringify(eventsStored)).not.toContain("PRIVATE_FRAGMENT")
    expect(JSON.stringify(eventsStored)).not.toContain("modelContextVersion")
  }))
  expect(target.requests.join()).toContain("PRIVATE_FRAGMENT")
  expect(target.requests.join()).toContain("ParallelPlan")
  expect(notifications.length).toBeGreaterThan(0)
  expect(notifications.join()).not.toContain("PRIVATE_FRAGMENT")
  expect(notifications.join()).not.toContain("modelContextVersion")
}, 30_000)

test("invalid full snapshots, mismatched reference identities and budget failures leave no admission prefix", async () => {
  for (const mode of ["corrupt", "budget", "tagged"] satisfies Mode[]) {
    await using target = await fixture(mode)
    const result = await target.runtime.runPromise(target.prompt(mode === "tagged" ? { references: [] } : {}).pipe(Effect.exit))
    expect(result._tag).toBe("Failure")
    for (const value of Object.values(await target.runtime.runPromise(rows))) expect(value).toEqual([])
    expect(target.requests).toEqual([])
  }
}, 30_000)

test("compatibility metadata exists after native insertion and rolls back with the outer transaction before notifications or wake", async () => {
  await using target = await fixture("tagged")
  const notifications: string[] = []
  const result = await target.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    yield* events.listen((event) => Effect.sync(() => { notifications.push(event.id) }))
    return yield* boundary.transaction(Effect.gen(function* () {
      const admitted = yield* target.prompt({ resume: true })
      const stored = yield* rows
      expect(stored.events).toHaveLength(1)
      expect(stored.metadata).toHaveLength(1)
      expect(stored.snapshots).toHaveLength(1)
      yield* recordLegacyInputEvent(sessionID, admitted.id, admitted.admittedSeq)
      expect((yield* rows).metadata).toEqual(stored.metadata)
      return yield* Effect.fail("rollback")
    })).pipe(Effect.flip)
  }))
  expect(result).toBe("rollback")
  for (const value of Object.values(await target.runtime.runPromise(rows))) expect(value).toEqual([])
  expect(notifications).toEqual([])
  expect(target.requests).toEqual([])
}, 30_000)

test("a compatibility metadata INSERT failure rolls back native and private admission", async () => {
  await using target = await fixture()
  const notifications: string[] = []
  await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* database.db.run(sql`CREATE TRIGGER reject_input_metadata BEFORE INSERT ON cm_legacy_event
      BEGIN SELECT RAISE(ABORT, 'reject metadata'); END`)
    yield* events.listen((event) => Effect.sync(() => { notifications.push(event.id) }))
    expect((yield* target.prompt({ resume: true }).pipe(Effect.exit))._tag).toBe("Failure")
  }))
  for (const value of Object.values(await target.runtime.runPromise(rows))) expect(value).toEqual([])
  expect(notifications).toEqual([])
  expect(target.requests).toEqual([])
}, 30_000)

test("proof-only policies keep their former behavior and cannot export fabricated attachments", async () => {
  await using target = await fixture("proof")
  await target.runtime.runPromise(target.prompt())
  await target.runtime.runPromise(claimTransferOwner)
  expect((await target.runtime.runPromise(rows)).snapshots).toEqual([])
  expect((await target.runtime.runPromise(rows)).metadata).toEqual([])
  expect(await target.runtime.runPromise(projection.export(scope).pipe(Effect.flip)))
    .toMatchObject({ code: "unsupported-private-origin" })
  await target.runtime.runPromise(target.prompt())
  expect(target.state.frozen).toBe(1)
}, 30_000)

test("exact retries reauthorize in the owning transaction before scheduling a wake", async () => {
  await using target = await fixture("tagged")
  await target.runtime.runPromise(target.prompt())
  const before = await target.runtime.runPromise(rows)
  target.state.authorizationLimit = target.state.authorizations + 2
  expect((await target.runtime.runPromise(target.prompt({ resume: true }).pipe(Effect.exit)))._tag).toBe("Failure")
  expect(target.state.authorizations).toBe(target.state.authorizationLimit + 1)
  expect(target.state.frozen).toBe(1)
  expect(await target.runtime.runPromise(rows)).toEqual(before)
  expect(target.requests).toEqual([])
}, 30_000)

test("local restore cannot fill missing provenance or overwrite a corrupted preserved snapshot", async () => {
  await using target = await fixture("tagged")
  await target.runtime.runPromise(target.prompt())
  await target.runtime.runPromise(claimTransferOwner)
  const bundle = await target.runtime.runPromise(projection.export(scope))
  const before = await target.runtime.runPromise(proof)
  await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`UPDATE cm_legacy_input SET snapshot_json = '{}' WHERE message_id = ${messageID}`)
  }))
  expect((await target.runtime.runPromise(target.prompt().pipe(Effect.exit)))._tag).toBe("Failure")
  expect(target.state.frozen).toBe(1)
  expect(await target.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }).pipe(Effect.flip)))
    .toMatchObject({ code: "input-conflict" })
  expect((await target.runtime.runPromise(proof))?.request_hash).toBe(before?.request_hash)
  await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`DELETE FROM cm_legacy_input WHERE message_id = ${messageID}`)
  }))
  expect(await target.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }).pipe(Effect.flip)))
    .toMatchObject({ code: "input-conflict" })
}, 30_000)
