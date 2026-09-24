import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
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
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { sql } from "drizzle-orm"
import { AdmissionError, type FrozenInput } from "../src/admission"
import { interactiveContextBudget, renderContextSnapshot, type ContextSidecarAttachment } from "../src/context-renderer"
import { EventBoundary } from "../src/event-boundary"
import { legacyDigest } from "../src/legacy-context"
import { makeLegacyProjection } from "../src/legacy-projection"
import { PrivatePromptContext } from "../src/session-facade"
import { createSessionHttp } from "../src/session-http"
import { createSessionRuntime } from "../src/session-runtime"
import {
  LEASE_DURATION_MS,
  makeRequestProof,
  makeTransferReadiness,
  type LeaseInput,
  type Mode,
  type RequestProof,
} from "../src/transfer-readiness"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const sessionID = SessionSchema.ID.make("ses_readiness")
const messageID = SessionMessage.ID.make("msg_readiness")
const leaseWorkspace = "wrk_ready"
const actor = { userID: "user-ready", workspaceID: leaseWorkspace }
const scope = { sessionID, workspaceID: leaseWorkspace, ownerID: "owner-ready" }
const projection = makeLegacyProjection({ authorize: () => Effect.void })
const references = [{
  id: JSON.stringify({ contextCapsuleID: "capsule", sourceCtxPackID: "pack", label: "Reference" }),
  contentHash: "hash-one",
}]
const emptyReferences: readonly { readonly id: string; readonly contentHash: string }[] = []

type Behavior = "enriched" | "automatic" | "plain"

function leaseFor(overrides: {
  readonly workspaceID?: string
  readonly topologyRevision?: string
  readonly requestToken?: string
  readonly expiresAt?: number
} = {}): LeaseInput {
  return {
    version: 1,
    workspaceID: overrides.workspaceID ?? leaseWorkspace,
    topologyRevision: overrides.topologyRevision ?? "rev-1",
    requestToken: overrides.requestToken ?? "a".repeat(64),
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  }
}

function proofFor(lease: LeaseInput): RequestProof {
  return makeRequestProof({ topologyRevision: lease.topologyRevision, requestToken: lease.requestToken })
}

function completedResponse() {
  return Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text: "public answer" }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])
}

type PromptInput = {
  readonly id?: SessionMessage.ID
  readonly text?: string
  readonly references?: readonly { readonly id: string; readonly contentHash: string }[]
  readonly delivery?: "steer" | "queue"
  readonly resume?: boolean
  readonly proof?: RequestProof
  readonly actor?: { readonly userID: string; readonly workspaceID: string }
}

async function makeRuntime(options: {
  readonly mode?: Mode | "managed"
  readonly now?: Effect.Effect<number>
  readonly behavior?: Behavior
  readonly seed?: boolean
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "readiness-admission-"))
  cleanup(directory)
  const state = {
    frozen: 0,
    freezeModes: [] as (Mode | undefined)[],
    calls: 0,
    authorizations: 0,
    behavior: options.behavior ?? ("enriched" as Behavior),
  }
  const entered = Deferred.makeUnsafe<void>()
  const requests: string[] = []
  const model = Model.make({ id: "readiness-model", provider: "proof", route })
  const readiness = Effect.runSync(makeTransferReadiness({
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }))
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    readiness,
    policy: {
      managed: () => Effect.succeed(true),
      authorize: () => Effect.suspend(() => {
        state.authorizations++
        return Effect.void
      }),
      freeze: (request) => Effect.sync((): FrozenInput => {
        state.frozen++
        state.freezeModes.push(request.mode)
        if (state.behavior === "plain") return { apiContent: request.text, rendererVersion: 1 }
        if (state.behavior === "automatic") {
          const attachment: ContextSidecarAttachment = {
            selection: "automatic", sourceCtxPackID: "pack", label: "Automatic", contentHash: "auto-hash",
            fragments: [{ contentHash: "frag-hash", text: "AUTO_BODY" }],
          }
          const snapshot = renderContextSnapshot({
            promptText: request.text, attachments: [attachment],
            recall: { policy: "operating-chat-v1", status: "selected" },
            budget: interactiveContextBudget, createdAt: 42,
          })
          return { apiContent: snapshot.apiContent, rendererVersion: snapshot.rendererVersion, context: snapshot.snapshot }
        }
        const attachment: ContextSidecarAttachment = {
          selection: "explicit", contextCapsuleID: "capsule", sourceCtxPackID: "pack", label: "Reference",
          contentHash: "hash-one", fragments: [{ contentHash: "frag-hash", text: "PRIVATE_BODY" }],
        }
        const snapshot = renderContextSnapshot({
          promptText: request.text, attachments: [attachment],
          recall: { policy: "disabled", status: "disabled" },
          budget: interactiveContextBudget, createdAt: 42,
        })
        return { apiContent: snapshot.apiContent, rendererVersion: snapshot.rendererVersion, context: snapshot.snapshot }
      }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, {
        stream: (request) => {
          state.calls++
          requests.push(JSON.stringify(request))
          return Stream.unwrap(Deferred.succeed(entered, undefined).pipe(Effect.as(completedResponse())))
        },
      })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  if (options.seed !== false) {
    await runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('project', ${directory}, '[]', 0, 0)`)
      yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
        VALUES (${sessionID}, 'project', 'ready', ${directory}, 'Ready', '1', 0, 0, ${leaseWorkspace})`)
    })).catch(async (error: unknown) => {
      await runtime.dispose()
      throw error
    })
  }
  const prompt = (input: PromptInput = {}) => Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.prompt({
      sessionID, id: input.id ?? messageID, prompt: { text: input.text ?? "public prompt" },
      delivery: input.delivery ?? "steer", resume: input.resume ?? false,
    })
  }).pipe(Effect.provideService(PrivatePromptContext, {
    actor: input.actor ?? actor,
    references: input.references ?? emptyReferences,
    proof: input.proof,
  }))
  return {
    runtime, readiness, prompt, state, requests, entered, directory,
    [Symbol.asyncDispose]: () => runtime.dispose(),
  }
}

const rows = Effect.gen(function* () {
  const database = yield* Database.Service
  return {
    events: yield* database.db.all(sql`SELECT * FROM event WHERE aggregate_id = ${sessionID}`),
    inputs: yield* database.db.all(sql`SELECT * FROM session_input WHERE session_id = ${sessionID}`),
    private: yield* database.db.all(sql`SELECT * FROM cm_private_input WHERE session_id = ${sessionID}`),
    clean: yield* database.db.all<{ request_hash: string }>(sql`SELECT * FROM cm_clean_input WHERE session_id = ${sessionID}`),
    snapshots: yield* database.db.all(sql`SELECT * FROM cm_legacy_input WHERE session_id = ${sessionID}`),
    requirements: yield* database.db.all(sql`SELECT * FROM cm_private_requirement WHERE session_id = ${sessionID}`),
  }
})

const claimTransferOwner = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run(sql`UPDATE event_sequence SET owner_id = ${scope.ownerID} WHERE aggregate_id = ${sessionID}`)
})

function isAdmissionError(value: unknown, code: string): value is AdmissionError {
  return value instanceof AdmissionError && value.code === code
}

test("clean-only admission skips freeze, stays public and stores only a clean identity", async () => {
  await using target = await makeRuntime()
  const admitted = await target.runtime.runPromise(target.prompt({ references: emptyReferences, resume: true }))
  expect(admitted.id).toBe(messageID)
  await target.runtime.runPromise(Deferred.await(target.entered).pipe(Effect.timeout("5 seconds")))
  const stored = await target.runtime.runPromise(rows)
  expect(stored.private).toEqual([])
  expect(stored.snapshots).toEqual([])
  expect(stored.requirements).toEqual([])
  expect(stored.clean).toHaveLength(1)
  expect(target.state.frozen).toBe(0)
  expect(target.state.calls).toBe(1)
  expect(target.requests.join()).not.toContain("PRIVATE_BODY")
  expect(JSON.stringify(stored.events)).not.toContain("modelContextVersion")
}, 30_000)

test("clean-only rejects explicit references before freeze or native mutation", async () => {
  await using target = await makeRuntime()
  const defect = await target.runtime.runPromise(target.prompt({ references }).pipe(
    Effect.catchDefect((value) => Effect.succeed<unknown>(value)),
  ))
  expect(isAdmissionError(defect, "transfer-unavailable")).toBe(true)
  const stored = await target.runtime.runPromise(rows)
  for (const value of Object.values(stored)) expect(value).toEqual([])
  expect(target.state.frozen).toBe(0)
  expect(target.state.calls).toBe(0)
}, 30_000)

test("a valid lease permits enriched freeze and stores the private body", async () => {
  await using target = await makeRuntime()
  const lease = leaseFor()
  await target.runtime.runPromise(target.readiness.grant(lease))
  await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease), resume: true }))
  await target.runtime.runPromise(Deferred.await(target.entered).pipe(Effect.timeout("5 seconds")))
  const stored = await target.runtime.runPromise(rows)
  expect(stored.private).toHaveLength(1)
  expect(stored.clean).toEqual([])
  expect(stored.requirements).toHaveLength(1)
  expect(target.state.frozen).toBe(1)
  expect(target.state.freezeModes).toEqual(["v2-enriched"])
  expect(target.requests.join()).toContain("PRIVATE_BODY")
  expect(JSON.stringify(stored.events)).not.toContain("PRIVATE_BODY")
}, 30_000)

test("proof must match the granted lease exactly", async () => {
  await using target = await makeRuntime()
  const cases = [
    { actual: leaseFor(), presented: proofFor(leaseFor({ requestToken: "b".repeat(64) })) },
    { actual: leaseFor(), presented: proofFor(leaseFor({ topologyRevision: "rev-2" })) },
    { actual: leaseFor({ workspaceID: "wrk_other" }), presented: proofFor(leaseFor({ workspaceID: "wrk_other" })) },
  ]
  for (const item of cases) {
    await target.runtime.runPromise(target.readiness.grant(item.actual))
    const defect = await target.runtime.runPromise(target.prompt({ references, proof: item.presented }).pipe(
      Effect.catchDefect((value) => Effect.succeed<unknown>(value)),
    ))
    expect(isAdmissionError(defect, "transfer-unavailable")).toBe(true)
    await target.runtime.runPromise(target.readiness.revoke(item.actual))
  }
  expect(target.state.frozen).toBe(0)
}, 30_000)

test("an expired lease cannot enrich", async () => {
  const clock = { time: 0 }
  await using target = await makeRuntime({ now: Effect.sync(() => clock.time) })
  const lease = leaseFor({ expiresAt: LEASE_DURATION_MS })
  await target.runtime.runPromise(target.readiness.grant(lease))
  clock.time = LEASE_DURATION_MS
  const defect = await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease) }).pipe(
    Effect.catchDefect((value) => Effect.succeed<unknown>(value)),
  ))
  expect(isAdmissionError(defect, "transfer-unavailable")).toBe(true)
  expect(target.state.frozen).toBe(0)
}, 30_000)

test("v1-local-explicit rejects producer automatic recall and admits explicit snapshots", async () => {
  await using automatic = await makeRuntime({ mode: "v1-local-explicit", behavior: "automatic" })
  const rejected = await automatic.runtime.runPromise(automatic.prompt({ references: emptyReferences }).pipe(
    Effect.catchDefect((value) => Effect.succeed<unknown>(value)),
  ))
  expect(isAdmissionError(rejected, "invalid-snapshot")).toBe(true)
  expect(automatic.state.frozen).toBe(1)
  expect((await automatic.runtime.runPromise(rows)).private).toEqual([])

  await using explicit = await makeRuntime({ mode: "v1-local-explicit", behavior: "enriched" })
  const admitted = await explicit.runtime.runPromise(explicit.prompt({ references }))
  expect(admitted.id).toBe(messageID)
  expect((await explicit.runtime.runPromise(rows)).private).toHaveLength(1)
  expect(explicit.state.freezeModes).toEqual(["v1-local-explicit"])
}, 30_000)

test("revoke drains until the owning transaction settles on commit and rollback", async () => {
  await using target = await makeRuntime()
  for (const outcome of ["commit", "rollback"] as const) {
    const id = SessionMessage.ID.make(`msg_ready_${outcome}`)
    await target.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const boundary = yield* EventBoundary
      const lease = leaseFor()
      yield* target.readiness.grant(lease)
      const prompted = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const transaction = yield* Effect.forkScoped(boundary.transaction(Effect.gen(function* () {
        yield* session.prompt({ sessionID, id, prompt: { text: "public prompt" }, delivery: "steer", resume: false }).pipe(
          Effect.provideService(PrivatePromptContext, { actor, references, proof: proofFor(lease) }),
        )
        yield* Deferred.succeed(prompted, undefined)
        yield* Deferred.await(held)
        if (outcome === "rollback") return yield* Effect.fail("rollback")
      })), { startImmediately: true })
      yield* Deferred.await(prompted)
      const started = yield* Deferred.make<void>()
      const revoke = yield* Effect.forkScoped(Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* target.readiness.revoke(lease)
      }), { startImmediately: true })
      yield* Deferred.await(started)
      // Drained only once the enclosing transaction settles.
      expect(revoke.pollUnsafe()).toBeUndefined()
      // New enrichments are refused while the revoke is draining.
      expect(yield* target.readiness.withPermit({ sessionID, workspaceID: leaseWorkspace, proof: proofFor(lease) }, Effect.succeed))
        .toBe("v1-clean-only")
      yield* Deferred.succeed(held, undefined)
      const transactionExit = yield* Fiber.await(transaction)
      expect(Exit.isFailure(transactionExit)).toBe(outcome === "rollback")
      expect(Exit.isSuccess(yield* Fiber.await(revoke))).toBe(true)
    })))
  }
}, 30_000)

test("interrupting the owning transaction does not strand the permit", async () => {
  await using target = await makeRuntime()
  const lease = leaseFor()
  await target.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const boundary = yield* EventBoundary
    yield* target.readiness.grant(lease)
    const prompted = yield* Deferred.make<void>()
    const held = yield* Deferred.make<void>()
    const transaction = yield* Effect.forkScoped(boundary.transaction(Effect.gen(function* () {
      yield* session.prompt({
        sessionID, id: SessionMessage.ID.make("msg_ready_cancel"), prompt: { text: "public prompt" },
        delivery: "steer", resume: false,
      }).pipe(Effect.provideService(PrivatePromptContext, { actor, references, proof: proofFor(lease) }))
      yield* Deferred.succeed(prompted, undefined)
      yield* Deferred.await(held)
    })), { startImmediately: true })
    yield* Deferred.await(prompted)
    yield* Fiber.interrupt(transaction)
    yield* target.readiness.revoke(lease)
  })))
}, 30_000)

test("exact retries reconcile without freezing or acquiring a new lease", async () => {
  await using target = await makeRuntime()
  const lease = leaseFor()
  await target.runtime.runPromise(target.readiness.grant(lease))
  const admitted = await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease) }))
  expect(target.state.frozen).toBe(1)
  await target.runtime.runPromise(target.readiness.revoke(lease))
  const before = await target.runtime.runPromise(rows)
  const retry = await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease) }))
  expect(retry).toEqual(admitted)
  expect(target.state.frozen).toBe(1)
  expect(await target.runtime.runPromise(rows)).toEqual(before)
  for (const input of [
    { text: "changed prompt" },
    { delivery: "queue" as const },
    { references: emptyReferences },
    { actor: { userID: actor.userID, workspaceID: "wrk_other" } },
  ] satisfies PromptInput[]) {
    const exit = await target.runtime.runPromise(target.prompt(input).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
  }
  expect(target.state.frozen).toBe(1)
  expect(target.state.calls).toBe(0)
}, 30_000)

test("clean retry reconciles its clean identity without acquiring a lease", async () => {
  await using target = await makeRuntime()
  const admitted = await target.runtime.runPromise(target.prompt({ references: emptyReferences }))
  const stored = await target.runtime.runPromise(rows)
  expect(stored.clean).toHaveLength(1)
  expect(stored.private).toEqual([])
  expect(target.state.frozen).toBe(0)
  const lease = leaseFor()
  await target.runtime.runPromise(target.readiness.grant(lease))
  const retry = await target.runtime.runPromise(target.prompt({ references: emptyReferences, proof: proofFor(lease) }))
  expect(retry).toEqual(admitted)
  expect(target.state.frozen).toBe(0)
  expect((await target.runtime.runPromise(rows)).private).toEqual([])
}, 30_000)

test("missing private context never downgrades to clean and dual markers are corruption", async () => {
  await using target = await makeRuntime()
  const lease = leaseFor()
  await target.runtime.runPromise(target.readiness.grant(lease))
  await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease) }))
  await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`DELETE FROM cm_private_input WHERE message_id = ${messageID}`)
  }))
  const missing = await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease) }).pipe(
    Effect.catchDefect((value) => Effect.succeed<unknown>(value)),
  ))
  expect(isAdmissionError(missing, "missing-private-context")).toBe(true)
  expect(target.state.frozen).toBe(1)

  await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`INSERT INTO cm_private_input
      (message_id, session_id, request_hash, api_content, api_content_hash, renderer_version)
      VALUES (${messageID}, ${sessionID}, 'corrupt', 'corrupt', 'corrupt', 2)`)
    yield* database.db.run(sql`INSERT INTO cm_clean_input (message_id, session_id, request_hash)
      VALUES (${messageID}, ${sessionID}, 'corrupt')`)
  }))
  const dual = await target.runtime.runPromise(target.prompt({ references, proof: proofFor(lease) }).pipe(
    Effect.catchDefect((value) => Effect.succeed<unknown>(value)),
  ))
  expect(isAdmissionError(dual, "conflict")).toBe(true)
}, 30_000)

test("legacy restoration registers an imported clean identity and retries without freeze", async () => {
  await using source = await makeRuntime()
  await source.runtime.runPromise(source.prompt({ references: emptyReferences }))
  await source.runtime.runPromise(claimTransferOwner)
  const bundle = await source.runtime.runPromise(projection.export(scope))

  await using target = await makeRuntime()
  await target.runtime.runPromise(projection.restore({ bundle, scope, expectedDigest: legacyDigest(bundle) }))
  const imported = await target.runtime.runPromise(rows)
  expect(imported.clean).toHaveLength(1)
  expect(String(imported.clean[0]?.request_hash).startsWith("legacy:")).toBe(true)

  const retry = await target.runtime.runPromise(target.prompt({ references: emptyReferences }))
  expect(retry.id).toBe(messageID)
  expect(target.state.frozen).toBe(0)
  expect(await target.runtime.runPromise(rows)).toEqual(imported)
  expect(await target.runtime.runPromise(projection.export(scope))).toEqual(bundle)
}, 30_000)

test("prompt HTTP forwards both proof headers and rejects partial proof", async () => {
  await using target = await makeRuntime({ seed: false })
  const lease = leaseFor()
  await target.runtime.runPromise(target.readiness.grant(lease))
  const location = { directory: AbsolutePath.make(join(target.directory, "work")), workspaceID: WorkspaceV2.ID.make(leaseWorkspace) }
  await mkdir(location.directory, { recursive: true })
  const http = await createSessionHttp({
    runtime: target.runtime,
    defaultLocation: location,
    authenticate: async () => ({ userID: "user-http", workspaceID: leaseWorkspace }),
    policy: { authorize: () => Effect.void },
  })
  try {
    const created = await http.fetch(new Request("http://localhost/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "ses_ready_http" }),
    }))
    expect(created?.status).toBe(200)
    const url = "http://localhost/api/session/ses_ready_http/prompt"
    const attachment = { contextCapsuleID: "capsule", label: "Reference", contentHash: "hash-one", source: { kind: "ctxpack", ctxPackID: "pack" } }
    const enriched = await http.fetch(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session-context-topology": lease.topologyRevision,
        "x-opencode-session-context-lease": lease.requestToken,
      },
      body: JSON.stringify({ id: "msg_ready_http", prompt: { text: "public prompt" }, resume: false, contextAttachments: [attachment] }),
    }))
    expect(enriched?.status).toBe(200)
    expect(target.state.frozen).toBe(1)

    const partial = await http.fetch(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session-context-topology": lease.topologyRevision },
      body: JSON.stringify({ id: "msg_ready_http_partial", prompt: { text: "public prompt" }, resume: false, contextAttachments: [attachment] }),
    }))
    expect(partial?.status).toBe(400)
    expect(target.state.frozen).toBe(1)
  } finally {
    await http.dispose()
  }
}, 30_000)
