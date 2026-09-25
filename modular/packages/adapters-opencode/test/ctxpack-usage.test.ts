import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CtxPackAccess,
  CtxPackActor,
  CtxPackChanged,
  CtxPackCreateRequest,
  CtxPackError,
  CtxPackInfo,
  CtxPackSource,
} from "@cybermastery/contracts/ctxpack"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, LLMEvent, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { sql } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { databaseCleanup } from "../../../test-utils/cleanup"
import { makeCtxPackCatalog, type CtxPackCatalog, type CtxPackCatalogOptions } from "../src/ctxpack-catalog"
import { makeCtxPackUsage, type CtxPackUsageOptions, type CtxPackUsagePort } from "../src/ctxpack-usage"
import { EventBoundary } from "../src/event-boundary"
import { PrivatePromptContext } from "../src/session-facade"
import { createSessionRuntime } from "../src/session-runtime"

const cleanup = databaseCleanup()
const owner: CtxPackActor = { userID: "user-owner", workspaceID: "wrk_ctxpack_usage" }
const other: CtxPackActor = { userID: "user-other", workspaceID: "wrk_ctxpack_usage" }
const foreign: CtxPackActor = { userID: "user-foreign", workspaceID: "wrk_ctxpack_foreign" }

const model = Model.make({ id: "proof-model", provider: "proof", route })

// The usage ledger never runs the provider. The runtime graph still needs the
// runner's dependencies satisfied, so they are replaced exactly as the sibling
// child-runner suite does; the database, event boundary, and Session authority
// stay native.
function createRuntime(filename: string) {
  return createSessionRuntime({
    filename,
    onRunnerConstruct: () => {},
    policy: {
      managed: () => Effect.succeed(true),
      authorize: () => Effect.void,
      freeze: (request) => Effect.succeed({ apiContent: request.text, rendererVersion: 1 }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: () => completedResponse() })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
}

function completedResponse() {
  return Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text: "answer" }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])
}

type RuntimeContext = { readonly directory: string; readonly runtime: ReturnType<typeof createRuntime> }

type Harness = RuntimeContext & {
  readonly catalog: CtxPackCatalog
  readonly usage: CtxPackUsagePort
  readonly events: CtxPackChanged[]
  readonly catalogEvents: CtxPackChanged[]
  readonly [Symbol.asyncDispose]: () => Promise<void>
}

type HarnessOptions = {
  readonly usageAuthorize?: CtxPackUsageOptions["authorize"]
  readonly usagePublish?: CtxPackUsageOptions["publish"]
  readonly catalogAuthorize?: CtxPackCatalogOptions["authorize"]
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-ctxpack-usage-"))
  cleanup(directory)
  const runtime = createRuntime(join(directory, "runtime.db"))
  const catalogEvents: CtxPackChanged[] = []
  const events: CtxPackChanged[] = []
  const catalog = await runtime.runPromise(
    makeCtxPackCatalog({
      authorize: options.catalogAuthorize ?? (() => Effect.void),
      publish: (event) => Effect.sync(() => { catalogEvents.push(event) }),
    }),
  )
  const usage = await runtime.runPromise(
    makeCtxPackUsage({
      catalog,
      authorize: options.usageAuthorize ?? (() => Effect.void),
      publish: options.usagePublish ?? ((event) => Effect.sync(() => { events.push(event) })),
    }),
  )
  return {
    directory,
    runtime,
    catalog,
    usage,
    events,
    catalogEvents,
    async [Symbol.asyncDispose]() {
      await runtime.dispose()
    },
  }
}

function source(workspaceID: string, overrides: Partial<CtxPackSource> = {}): CtxPackSource {
  const defaults: CtxPackSource = {
    workspaceID,
    blockID: "block-1",
    functionalityID: "functionality-1",
    kind: "message",
    direction: "sent",
    sourceTimestamp: 1_000,
    capturedAt: 1_000,
    entityRef: null,
    label: null,
    metadata: {},
    sensitivity: "workspace",
  }
  return Object.assign(defaults, overrides)
}

function createSession(ctx: RuntimeContext, actor: CtxPackActor, sessionID: SessionSchema.ID): Promise<void> {
  return ctx.runtime.runPromise(
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session.create({
        id: sessionID,
        location: {
          directory: AbsolutePath.make(ctx.directory),
          workspaceID: WorkspaceV2.ID.make(actor.workspaceID),
        },
      })
    }),
  )
}

function admitInput(
  ctx: RuntimeContext,
  actor: CtxPackActor,
  sessionID: SessionSchema.ID,
  inputID: SessionMessage.ID,
): Promise<void> {
  return ctx.runtime.runPromise(
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session
        .prompt({ id: inputID, sessionID, prompt: { text: "admitted input" }, resume: false })
        .pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))
    }),
  )
}

function createPack(
  ctx: RuntimeContext,
  catalog: CtxPackCatalog,
  actor: CtxPackActor,
  idempotencyKey: string,
  overrides: Partial<CtxPackCreateRequest> = {},
): Promise<CtxPackInfo> {
  return ctx.runtime.runPromise(
    catalog.create(actor, {
      workspaceID: actor.workspaceID,
      title: "Usage pack",
      keywords: ["alpha"],
      tags: [],
      sensitivity: "workspace",
      fragments: [{ clientFragmentID: "frag-1", text: "hello world", source: source(actor.workspaceID) }],
      idempotencyKey,
      ...overrides,
    }),
  )
}

function recordUse(
  ctx: RuntimeContext,
  usage: CtxPackUsagePort,
  actor: CtxPackActor,
  ctxPackIDs: readonly string[],
  sessionInputID: string,
  admittedAt = 1_000,
): Promise<void> {
  return ctx.runtime.runPromise(
    usage.recordAdmittedUse({
      workspaceID: actor.workspaceID,
      userID: actor.userID,
      ctxPackIDs,
      sessionInputID,
      admittedAt,
    }),
  )
}

function readPackUsage(
  ctx: RuntimeContext,
  catalog: CtxPackCatalog,
  actor: CtxPackActor,
  ctxPackID: string,
): Promise<CtxPackInfo> {
  return ctx.runtime.runPromise(catalog.get(actor, ctxPackID))
}

function ledgerRows(
  ctx: RuntimeContext,
): Promise<Array<{ ctx_pack_id: string; session_input_id: string }>> {
  return ctx.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* database.db.all<{ ctx_pack_id: string; session_input_id: string }>(
        sql`SELECT ctx_pack_id, session_input_id FROM cm_ctx_pack_usage_admission ORDER BY ctx_pack_id`,
      )
    }),
  )
}

function expectFailureTag(ctx: RuntimeContext, effect: Effect.Effect<unknown, CtxPackError>): Promise<string> {
  return ctx.runtime.runPromise(
    effect.pipe(
      Effect.map(() => "success"),
      Effect.catch((error) => Effect.succeed(error._tag)),
    ),
  )
}

const usedEvents = (events: readonly CtxPackChanged[]) =>
  events.filter((event) => event.properties.change === "used")

describe("ctxpack admitted-use ledger", () => {
  test("counts once per pack and admitted input, dedupes ids, and counts a new input again", async () => {
    await using h = await harness()
    const sessionID = SessionSchema.ID.make("ses_usage_once")
    const inputA = SessionMessage.ID.make("msg_usage_a")
    const inputB = SessionMessage.ID.make("msg_usage_b")
    await createSession(h, owner, sessionID)
    await admitInput(h, owner, sessionID, inputA)
    await admitInput(h, owner, sessionID, inputB)
    const pack = await createPack(h, h.catalog, owner, "usage-once")

    await recordUse(h, h.usage, owner, [pack.id, pack.id, pack.id], inputA, 1_000)
    await recordUse(h, h.usage, owner, [pack.id], inputA, 2_000)

    const afterFirst = await readPackUsage(h, h.catalog, owner, pack.id)
    expect(afterFirst.usage.attachedCount).toBe(1)
    expect(afterFirst.usage.lastAttachedAt).toBe(1_000)
    expect(await ledgerRows(h)).toEqual([{ ctx_pack_id: pack.id, session_input_id: inputA }])
    expect(usedEvents(h.events)).toHaveLength(1)
    expect(usedEvents(h.events)[0]?.properties).toEqual({
      workspaceID: owner.workspaceID,
      ctxPackID: pack.id,
      revision: 1,
      change: "used",
    })

    await recordUse(h, h.usage, owner, [pack.id], inputB, 3_000)
    const afterSecond = await readPackUsage(h, h.catalog, owner, pack.id)
    expect(afterSecond.usage.attachedCount).toBe(2)
    expect(afterSecond.usage.lastAttachedAt).toBe(3_000)
    expect(await ledgerRows(h)).toHaveLength(2)
    expect(usedEvents(h.events)).toHaveLength(2)
  })

  test("two packs abort atomically when the second pack is denied", async () => {
    const deniedPack = { id: "" }
    await using h = await harness({
      usageAuthorize: (request: CtxPackAccess) =>
        request.pack?.id === deniedPack.id
          ? Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.read" })
          : Effect.void,
    })
    const sessionID = SessionSchema.ID.make("ses_usage_two")
    const inputID = SessionMessage.ID.make("msg_usage_two")
    await createSession(h, owner, sessionID)
    await admitInput(h, owner, sessionID, inputID)
    const packA = await createPack(h, h.catalog, owner, "usage-two-a")
    const packB = await createPack(h, h.catalog, owner, "usage-two-b")
    deniedPack.id = packB.id

    expect(
      await expectFailureTag(
        h,
        h.usage.recordAdmittedUse({
          workspaceID: owner.workspaceID,
          userID: owner.userID,
          ctxPackIDs: [packA.id, packB.id],
          sessionInputID: inputID,
          admittedAt: 1_000,
        }),
      ),
    ).toBe("CtxPackPermissionDenied")

    expect(await ledgerRows(h)).toHaveLength(0)
    expect((await readPackUsage(h, h.catalog, owner, packA.id)).usage.attachedCount).toBe(0)
    expect((await readPackUsage(h, h.catalog, owner, packB.id)).usage.attachedCount).toBe(0)
    expect(usedEvents(h.events)).toHaveLength(0)
  })

  test("a private pack is denied to another workspace member and writes nothing", async () => {
    await using h = await harness()
    const sessionID = SessionSchema.ID.make("ses_usage_private")
    const inputID = SessionMessage.ID.make("msg_usage_private")
    await createSession(h, owner, sessionID)
    await admitInput(h, owner, sessionID, inputID)
    const pack = await createPack(h, h.catalog, owner, "usage-private", { sensitivity: "private" })

    expect(
      await expectFailureTag(
        h,
        h.usage.recordAdmittedUse({
          workspaceID: other.workspaceID,
          userID: other.userID,
          ctxPackIDs: [pack.id],
          sessionInputID: inputID,
          admittedAt: 1_000,
        }),
      ),
    ).toBe("CtxPackPermissionDenied")

    expect(await ledgerRows(h)).toHaveLength(0)
    expect((await readPackUsage(h, h.catalog, owner, pack.id)).usage.attachedCount).toBe(0)
  })

  test("unverified session inputs are rejected without touching the ledger", async () => {
    await using h = await harness()
    const ownerSession = SessionSchema.ID.make("ses_usage_verify_owner")
    const ownerInput = SessionMessage.ID.make("msg_usage_verify_owner")
    await createSession(h, owner, ownerSession)
    await admitInput(h, owner, ownerSession, ownerInput)

    const foreignSession = SessionSchema.ID.make("ses_usage_verify_foreign")
    const foreignInput = SessionMessage.ID.make("msg_usage_verify_foreign")
    await createSession(h, foreign, foreignSession)
    await admitInput(h, foreign, foreignSession, foreignInput)
    const foreignPack = await createPack(h, h.catalog, foreign, "usage-verify-foreign")

    // A valid admitted input belonging to a different workspace.
    expect(
      await expectFailureTag(
        h,
        h.usage.recordAdmittedUse({
          workspaceID: foreign.workspaceID,
          userID: foreign.userID,
          ctxPackIDs: [foreignPack.id],
          sessionInputID: ownerInput,
          admittedAt: 1_000,
        }),
      ),
    ).toBe("CtxPackPermissionDenied")

    // An unknown session input id.
    expect(
      await expectFailureTag(
        h,
        h.usage.recordAdmittedUse({
          workspaceID: foreign.workspaceID,
          userID: foreign.userID,
          ctxPackIDs: [foreignPack.id],
          sessionInputID: "msg_usage_unknown",
          admittedAt: 1_000,
        }),
      ),
    ).toBe("CtxPackPermissionDenied")

    // An existing session whose input was never admitted.
    expect(
      await expectFailureTag(
        h,
        h.usage.recordAdmittedUse({
          workspaceID: foreign.workspaceID,
          userID: foreign.userID,
          ctxPackIDs: [foreignPack.id],
          sessionInputID: "msg_usage_not_admitted",
          admittedAt: 1_000,
        }),
      ),
    ).toBe("CtxPackPermissionDenied")

    expect(await ledgerRows(h)).toHaveLength(0)
    expect((await readPackUsage(h, h.catalog, foreign, foreignPack.id)).usage.attachedCount).toBe(0)
  })

  test("authorization revoked between the initial check and commit rolls back", async () => {
    const state = { calls: 0 }
    await using h = await harness({
      usageAuthorize: () =>
        Effect.suspend(() => {
          state.calls += 1
          return state.calls === 1
            ? Effect.void
            : Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.read" })
        }),
    })
    const sessionID = SessionSchema.ID.make("ses_usage_revoke")
    const inputID = SessionMessage.ID.make("msg_usage_revoke")
    await createSession(h, owner, sessionID)
    await admitInput(h, owner, sessionID, inputID)
    const pack = await createPack(h, h.catalog, owner, "usage-revoke")

    expect(
      await expectFailureTag(
        h,
        h.usage.recordAdmittedUse({
          workspaceID: owner.workspaceID,
          userID: owner.userID,
          ctxPackIDs: [pack.id],
          sessionInputID: inputID,
          admittedAt: 1_000,
        }),
      ),
    ).toBe("CtxPackPermissionDenied")

    expect(state.calls).toBe(2)
    expect(await ledgerRows(h)).toHaveLength(0)
    expect((await readPackUsage(h, h.catalog, owner, pack.id)).usage.attachedCount).toBe(0)
    expect(usedEvents(h.events)).toHaveLength(0)
  })

  test("an outer transaction rollback suppresses the ledger, counter, and hint", async () => {
    await using h = await harness()
    const sessionID = SessionSchema.ID.make("ses_usage_outer")
    const inputID = SessionMessage.ID.make("msg_usage_outer")
    await createSession(h, owner, sessionID)
    await admitInput(h, owner, sessionID, inputID)
    const pack = await createPack(h, h.catalog, owner, "usage-outer")
    const before = h.events.length

    await h.runtime.runPromise(
      Effect.gen(function* () {
        const boundary = yield* EventBoundary
        yield* boundary
          .transaction(
            Effect.gen(function* () {
              yield* h.usage.recordAdmittedUse({
                workspaceID: owner.workspaceID,
                userID: owner.userID,
                ctxPackIDs: [pack.id],
                sessionInputID: inputID,
                admittedAt: 1_000,
              })
              return yield* Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "test" })
            }),
          )
          .pipe(Effect.catch(() => Effect.void))
      }),
    )

    expect(await ledgerRows(h)).toHaveLength(0)
    expect((await readPackUsage(h, h.catalog, owner, pack.id)).usage.attachedCount).toBe(0)
    expect(h.events.length).toBe(before)
  })

  test("a publisher defect after commit does not roll back the committed count", async () => {
    await using h = await harness({ usagePublish: () => Effect.die(new Error("publisher boom")) })
    const sessionID = SessionSchema.ID.make("ses_usage_publish")
    const inputID = SessionMessage.ID.make("msg_usage_publish")
    await createSession(h, owner, sessionID)
    await admitInput(h, owner, sessionID, inputID)
    const pack = await createPack(h, h.catalog, owner, "usage-publish")

    await recordUse(h, h.usage, owner, [pack.id], inputID, 1_000)

    expect((await readPackUsage(h, h.catalog, owner, pack.id)).usage.attachedCount).toBe(1)
    expect(await ledgerRows(h)).toHaveLength(1)
  })

  test("two independent runtimes racing the same admission count once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cybermastery-ctxpack-usage-race-"))
    cleanup(directory)
    const filename = join(directory, "runtime.db")
    const runtimeA = createRuntime(filename)
    const runtimeB = createRuntime(filename)
    try {
      const catalogA = await runtimeA.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
      const catalogB = await runtimeB.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
      const usageA = await runtimeA.runPromise(
        makeCtxPackUsage({ catalog: catalogA, authorize: () => Effect.void }),
      )
      const usageB = await runtimeB.runPromise(
        makeCtxPackUsage({ catalog: catalogB, authorize: () => Effect.void }),
      )
      const ctxA: RuntimeContext = { directory, runtime: runtimeA }
      const ctxB: RuntimeContext = { directory, runtime: runtimeB }
      const sessionID = SessionSchema.ID.make("ses_usage_race")
      const inputID = SessionMessage.ID.make("msg_usage_race")
      await createSession(ctxA, owner, sessionID)
      await admitInput(ctxA, owner, sessionID, inputID)
      const pack = await createPack(ctxA, catalogA, owner, "usage-race")

      await Promise.all([
        recordUse(ctxA, usageA, owner, [pack.id], inputID, 1_000),
        recordUse(ctxB, usageB, owner, [pack.id], inputID, 1_000),
      ])

      expect(await ledgerRows(ctxA)).toHaveLength(1)
      expect((await readPackUsage(ctxA, catalogA, owner, pack.id)).usage.attachedCount).toBe(1)
    } finally {
      await runtimeA.dispose()
      await runtimeB.dispose()
    }
  })

  test("the ledger and counters survive a database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cybermastery-ctxpack-usage-reopen-"))
    cleanup(directory)
    const filename = join(directory, "runtime.db")
    const sessionID = SessionSchema.ID.make("ses_usage_reopen")
    const inputID = SessionMessage.ID.make("msg_usage_reopen")
    const state: { packID: string } = { packID: "" }

    const first = createRuntime(filename)
    try {
      const catalog = await first.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
      const usage = await first.runPromise(makeCtxPackUsage({ catalog, authorize: () => Effect.void }))
      const ctx: RuntimeContext = { directory, runtime: first }
      await createSession(ctx, owner, sessionID)
      await admitInput(ctx, owner, sessionID, inputID)
      const pack = await createPack(ctx, catalog, owner, "usage-reopen")
      state.packID = pack.id
      await recordUse(ctx, usage, owner, [pack.id], inputID, 1_000)
    } finally {
      await first.dispose()
    }

    const second = createRuntime(filename)
    try {
      const catalog = await second.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
      const usage = await second.runPromise(makeCtxPackUsage({ catalog, authorize: () => Effect.void }))
      const ctx: RuntimeContext = { directory, runtime: second }
      const reloaded = await readPackUsage(ctx, catalog, owner, state.packID)
      expect(reloaded.usage.attachedCount).toBe(1)
      expect(reloaded.usage.lastAttachedAt).toBe(1_000)
      expect(await ledgerRows(ctx)).toHaveLength(1)

      // Re-recording after reopen is still a duplicate and emits nothing.
      await recordUse(ctx, usage, owner, [state.packID], inputID, 9_000)
      const after = await readPackUsage(ctx, catalog, owner, state.packID)
      expect(after.usage.attachedCount).toBe(1)
      expect(after.usage.lastAttachedAt).toBe(1_000)
    } finally {
      await second.dispose()
    }
  })
})
