import { describe, expect, test } from "bun:test"
import type { CtxPackActor, CtxPackCreateRequest, CtxPackSource } from "@cybermastery/contracts/ctxpack"
import {
  DefaultInteractiveContextBudget,
  type ContextBudget,
  type CtxPackAttachment,
  type CtxPackMaterializeError,
  type CtxPackMaterializeRequest,
  type CtxPackMaterializeResult,
} from "@cybermastery/contracts/ctxpack-capsule"
import { Database } from "@opencode-ai/core/database/database"
import { sql, type SQL } from "drizzle-orm"
import { Deferred, Effect, Schema } from "effect"
import { makeCtxPackCatalog, type CtxPackCatalog } from "../src/ctxpack-catalog"
import { makeCtxPackCapsuleStore, type CtxPackCapsuleStore } from "../src/ctxpack-capsule"
import {
  makeCtxPackMaterializer,
  type CtxPackAuthorizeInput,
  type CtxPackDiagnosticsEntry,
  type CtxPackMaterializer,
} from "../src/ctxpack-materializer"
import { createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()
type Fixture = Awaited<ReturnType<ReturnType<typeof createMediatedFixtures>>>

const SENTINEL = "CTXPACK_SECRET_SENTINEL_7812"

const owner: CtxPackActor = { userID: "user-owner", workspaceID: "workspace-1" }
const other: CtxPackActor = { userID: "user-other", workspaceID: "workspace-1" }

function source(overrides: Partial<CtxPackSource> = {}): CtxPackSource {
  const defaults: CtxPackSource = {
    workspaceID: "workspace-1",
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

function createRequest(input: Partial<CtxPackCreateRequest> = {}): CtxPackCreateRequest {
  const defaults: CtxPackCreateRequest = {
    workspaceID: "workspace-1",
    title: "Materializer pack",
    keywords: ["alpha"],
    tags: ["ParallelPlan"],
    sensitivity: "workspace",
    fragments: [{ clientFragmentID: "client-1", text: "hello world", source: source() }],
    idempotencyKey: "idem-1",
  }
  return Object.assign(defaults, input)
}

type AuthorizeFn = (input: CtxPackAuthorizeInput) => Effect.Effect<void, CtxPackMaterializeError>

interface OpenOptions {
  readonly authorize?: AuthorizeFn
  readonly now?: () => number
  readonly diagnostics?: boolean
}

interface Harness {
  readonly fixture: Fixture
  readonly catalog: CtxPackCatalog
  readonly capsules: CtxPackCapsuleStore
  readonly materializer: CtxPackMaterializer
  readonly entries: CtxPackDiagnosticsEntry[]
  readonly authLog: CtxPackAuthorizeInput[]
}

async function openHarness(fixture: Fixture, options: OpenOptions = {}): Promise<Harness> {
  const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
  const capsules = await fixture.runtime.runPromise(makeCtxPackCapsuleStore())
  const entries: CtxPackDiagnosticsEntry[] = []
  const authLog: CtxPackAuthorizeInput[] = []
  const userAuthorize: AuthorizeFn = options.authorize ?? (() => Effect.void)
  const materializer = makeCtxPackMaterializer({
    catalog,
    capsules,
    authorize: (input) => {
      authLog.push(input)
      return userAuthorize(input)
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.diagnostics === false
      ? {}
      : {
          diagnostics: (entry: CtxPackDiagnosticsEntry) =>
            Effect.sync(() => {
              entries.push(entry)
            }),
        }),
  })
  return { fixture, catalog, capsules, materializer, entries, authLog }
}

async function withHarness<A>(options: OpenOptions, f: (harness: Harness) => Promise<A>): Promise<A> {
  const fixture = await mediatedFixture()
  try {
    return await f(await openHarness(fixture, options))
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
}

const run = <A, E>(fixture: Fixture, effect: Effect.Effect<A, E>): Promise<A> => fixture.runtime.runPromise(effect)

type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown }

const outcome = async <A>(fixture: Fixture, effect: Effect.Effect<A, CtxPackMaterializeError>): Promise<Outcome<A>> => {
  try {
    return { ok: true, value: await fixture.runtime.runPromise(effect) }
  } catch (error) {
    return { ok: false, error }
  }
}

const createPack = (harness: Harness, input: Partial<CtxPackCreateRequest> = {}) =>
  run(harness.fixture, harness.catalog.create(owner, createRequest(input)))

const materializeRequest = (
  pack: { readonly id: string; readonly contentHash: string },
  overrides: Partial<CtxPackMaterializeRequest> = {},
): CtxPackMaterializeRequest => ({
  workspaceID: owner.workspaceID,
  ctxPackID: pack.id,
  expectedContentHash: pack.contentHash,
  targetInstanceID: "inst-1",
  targetFunctionalityID: "builtin:chat",
  ...overrides,
})

const materializePack = (harness: Harness, pack: { readonly id: string; readonly contentHash: string }) =>
  run(harness.fixture, harness.materializer.materialize(owner, materializeRequest(pack)))

const attachmentOf = (
  pack: { readonly id: string },
  result: { readonly contextCapsuleID: string; readonly label: string; readonly contentHash: string },
): CtxPackAttachment => ({
  contextCapsuleID: result.contextCapsuleID,
  label: result.label,
  contentHash: result.contentHash,
  source: { kind: "ctxpack", ctxPackID: pack.id },
})

const ROOMY_BUDGET: ContextBudget = {
  ...DefaultInteractiveContextBudget,
  maximumBytes: 1_000_000_000,
  maximumEstimatedTokens: 1_000_000_000,
}

const snapshotInput = (
  attachments: readonly CtxPackAttachment[],
  overrides: Partial<{
    actor: CtxPackActor
    targetInstanceID: string
    targetFunctionalityID: string
    budget: ContextBudget
  }> = {},
) => ({
  actor: owner,
  targetInstanceID: "inst-1",
  targetFunctionalityID: "builtin:chat",
  attachments,
  budget: ROOMY_BUDGET,
  ...overrides,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const field = (value: unknown, key: string): unknown => (isRecord(value) ? Reflect.get(value, key) : undefined)

const exec = (fixture: Fixture, statement: SQL): Promise<void> =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(statement)
    }),
  )

const mutateCapsuleJson = (fixture: Fixture, id: string, mutate: (body: object) => void): Promise<void> =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const row = yield* database.db.get<{ capsule_json: string }>(
        sql`SELECT capsule_json FROM cm_context_capsule WHERE id = ${id}`,
      )
      if (!row) throw new Error("Missing capsule fixture")
      const value: unknown = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.capsule_json)
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Bad capsule fixture")
      mutate(value)
      yield* database.db.run(sql`UPDATE cm_context_capsule SET capsule_json = ${JSON.stringify(value)} WHERE id = ${id}`)
    }),
  )

const mutateCreatedByJson = (fixture: Fixture, id: string, mutate: (createdBy: object) => void): Promise<void> =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const row = yield* database.db.get<{ created_by_json: string }>(
        sql`SELECT created_by_json FROM cm_context_capsule WHERE id = ${id}`,
      )
      if (!row) throw new Error("Missing capsule fixture")
      const value: unknown = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.created_by_json)
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Bad capsule fixture")
      mutate(value)
      yield* database.db.run(
        sql`UPDATE cm_context_capsule SET created_by_json = ${JSON.stringify(value)} WHERE id = ${id}`,
      )
    }),
  )

const capsuleCount = (fixture: Fixture) =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* database.db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM cm_context_capsule`)
    }),
  )

const usageOf = (fixture: Fixture, id: string) =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* database.db.get<{ attached_count: number; last_attached_at: number | null }>(
        sql`SELECT attached_count, last_attached_at FROM cm_ctx_pack WHERE id = ${id}`,
      )
    }),
  )

const fakeAttachment = (index: number): CtxPackAttachment => ({
  contextCapsuleID: `ctxkpsl_fake_${index}`,
  label: `fake-${index}`,
  contentHash: "sha256:h",
  source: { kind: "ctxpack", ctxPackID: `ctxpk_fake_${index}` },
})

describe("ctxpack materializer — materialize", () => {
  test("freezes the pack into an immutable ctxpack-attachment capsule with real hashes", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, {
        title: "Niagara pump findings",
        tags: ["ParallelPlan"],
        fragments: [
          { clientFragmentID: "f1", text: "first body", source: source({ blockID: "block-a" }) },
          { clientFragmentID: "f2", text: "second body", source: source({ blockID: "block-b", label: "Second label" }) },
        ],
      })
      const result = await materializePack(harness, pack)

      expect(Object.keys(result).sort()).toEqual([
        "contentHash",
        "contextCapsuleID",
        "estimatedTokens",
        "label",
        "sourceCtxPackID",
        "tags",
      ])
      expect(result.contextCapsuleID.startsWith("ctxkpsl_")).toBe(true)
      expect(result.sourceCtxPackID).toBe(pack.id)
      expect(result.label).toBe(pack.title)
      expect(result.tags).toEqual(["ParallelPlan"])
      expect(result.contentHash).toBe(pack.contentHash)
      expect(result.estimatedTokens).toBe(pack.estimatedTokens)

      const stored = await run(harness.fixture, harness.capsules.get(owner.workspaceID, result.contextCapsuleID))
      expect(stored).toBeDefined()
      if (!stored) return
      expect(stored.purpose).toBe("ctxpack-attachment")
      expect(stored.audience).toEqual(["builtin:chat"])
      expect(stored.createdBy).toEqual({ userId: owner.userID, instanceId: "inst-1" })
      expect(stored.summary).toBe(pack.title)
      expect(stored.contentHash).toBe(pack.contentHash)
      expect(stored.budget).toEqual(DefaultInteractiveContextBudget)
      expect(stored.expiresAt).toBeUndefined()
      expect(stored.artifactRefs).toEqual([])
      expect(stored.recentEvents).toEqual([])

      expect(stored.facts).toContainEqual({
        key: "ctxpack.id",
        value: pack.id,
        sourceRef: { type: "ctxpack", id: pack.id },
        sensitivity: pack.sensitivity,
      })
      expect(stored.facts).toContainEqual({
        key: "ctxpack.fragmentCount",
        value: 2,
        sourceRef: { type: "ctxpack", id: pack.id },
        sensitivity: pack.sensitivity,
      })
      expect(stored.facts).toContainEqual({
        key: "ctxpack.tags",
        value: ["ParallelPlan"],
        sourceRef: { type: "ctxpack", id: pack.id },
        sensitivity: pack.sensitivity,
      })

      expect(stored.references).toHaveLength(1 + pack.fragments.length)
      const fragmentRefs = stored.references.slice(1).filter(isRecord)
      expect(fragmentRefs.map((entry) => field(field(entry, "ref"), "id"))).toEqual(
        pack.fragments.map((fragment) => fragment.id),
      )
      expect(fragmentRefs.map((entry) => field(entry, "contentHash"))).toEqual(
        pack.fragments.map((fragment) => fragment.contentHash),
      )
      expect(fragmentRefs.map((entry) => field(entry, "label"))).toEqual(["Fragment 1", "Second label"])
      expect(fragmentRefs.map((entry) => field(entry, "summary"))).toEqual(["first body", "second body"])
    }))

  test("rejects a stale expected hash and a deleted pack without storing a capsule", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness)
      const stale = await outcome(
        harness.fixture,
        harness.materializer.materialize(owner, materializeRequest(pack, { expectedContentHash: "sha256:stale" })),
      )
      expect(stale.ok).toBe(false)
      if (!stale.ok) {
        expect(stale.error).toMatchObject({ _tag: "CtxPackContentChanged", currentContentHash: pack.contentHash })
      }
      expect(await capsuleCount(harness.fixture)).toEqual({ count: 0 })

      await run(
        harness.fixture,
        harness.catalog.remove(owner, { ctxPackID: pack.id, expectedRevision: pack.revision }),
      )
      const deleted = await outcome(harness.fixture, harness.materializer.materialize(owner, materializeRequest(pack)))
      expect(deleted.ok).toBe(false)
      if (!deleted.ok) expect(deleted.error).toMatchObject({ _tag: "CtxPackDeleted", ctxPackID: pack.id })
      expect(await capsuleCount(harness.fixture)).toEqual({ count: 0 })
    }))

  test("requires both the pack operation and the attach target capability", () =>
    withHarness(
      {
        authorize: (input) =>
          input.operation === "ctxpack.materialize"
            ? Effect.fail(
                { _tag: "CtxPackCapabilityDenied", operation: "ctxpack.materialize" } satisfies CtxPackMaterializeError,
              )
            : Effect.void,
      },
      async (harness) => {
        const pack = await createPack(harness)
        const denied = await outcome(harness.fixture, harness.materializer.materialize(owner, materializeRequest(pack)))
        expect(denied.ok).toBe(false)
        if (!denied.ok) {
          expect(denied.error).toMatchObject({ _tag: "CtxPackCapabilityDenied", operation: "ctxpack.materialize" })
        }
        expect(harness.authLog.map((entry) => entry.operation)).toEqual(["ctxpack.materialize"])
        expect(await capsuleCount(harness.fixture)).toEqual({ count: 0 })
      },
    ))

  test("denies on the attach target capability before storing a capsule", () =>
    withHarness(
      {
        authorize: (input) =>
          input.operation === "chat.context.attach"
            ? Effect.fail(
                { _tag: "CtxPackCapabilityDenied", operation: "chat.context.attach" } satisfies CtxPackMaterializeError,
              )
            : Effect.void,
      },
      async (harness) => {
        const pack = await createPack(harness)
        const denied = await outcome(harness.fixture, harness.materializer.materialize(owner, materializeRequest(pack)))
        expect(denied.ok).toBe(false)
        if (!denied.ok) {
          expect(denied.error).toMatchObject({ _tag: "CtxPackCapabilityDenied", operation: "chat.context.attach" })
        }
        expect(await capsuleCount(harness.fixture)).toEqual({ count: 0 })
      },
    ))

  test("creator-private packs deny a non-owner before any capsule is stored", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, {
        sensitivity: "private",
        idempotencyKey: "private",
        fragments: [{ clientFragmentID: "p1", text: "private body", source: source({ sensitivity: "private" }) }],
      })
      const denied = await outcome(harness.fixture, harness.materializer.materialize(other, materializeRequest(pack)))
      expect(denied.ok).toBe(false)
      if (!denied.ok) {
        expect(denied.error).toMatchObject({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.read" })
      }
      expect(await capsuleCount(harness.fixture)).toEqual({ count: 0 })

      const allowed = await materializePack(harness, pack)
      expect(allowed.contextCapsuleID.startsWith("ctxkpsl_")).toBe(true)
    }))

  test("materialize and snapshot never touch usage counters", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, { idempotencyKey: "usage" })
      const result = await materializePack(harness, pack)
      await run(harness.fixture, harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, result)])))
      expect(await usageOf(harness.fixture, pack.id)).toEqual({ attached_count: 0, last_attached_at: null })
      const reloaded = await run(harness.fixture, harness.catalog.get(owner, pack.id))
      expect(reloaded.usage).toEqual({ attachedCount: 0, lastAttachedAt: null })
    }))
})

describe("ctxpack materializer — snapshotForSessionInput", () => {
  test("zero attachments yields a frozen v1 snapshot with zero bytes and tokens", () =>
    withHarness({ now: () => 4_200 }, async (harness) => {
      const snapshot = await run(harness.fixture, harness.materializer.snapshotForSessionInput(snapshotInput([])))
      expect(snapshot).toEqual({ version: 1, attachments: [], byteLength: 0, estimatedTokens: 0, createdAt: 4_200 })
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(harness.authLog.map((entry) => entry.operation)).toEqual(["chat.context.attach"])
      expect(harness.entries).toEqual([
        {
          operation: "snapshot",
          workspaceID: owner.workspaceID,
          attachmentCount: 0,
          byteLength: 0,
          estimatedTokens: 0,
        },
      ])
    }))

  test("requires the attach capability even when nothing is attached", () =>
    withHarness(
      {
        authorize: (input) =>
          input.operation === "chat.context.attach"
            ? Effect.fail(
                { _tag: "CtxPackCapabilityDenied", operation: "chat.context.attach" } satisfies CtxPackMaterializeError,
              )
            : Effect.void,
      },
      async (harness) => {
        const result = await outcome(harness.fixture, harness.materializer.snapshotForSessionInput(snapshotInput([])))
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toMatchObject({ _tag: "CtxPackCapabilityDenied", operation: "chat.context.attach" })
        }
      },
    ))

  test("returns an ordered deep-frozen v1 snapshot and tags come from the capsule fact", () =>
    withHarness({ now: () => 1_000 }, async (harness) => {
      const packA = await createPack(harness, {
        idempotencyKey: "a",
        tags: ["ParallelPlan"],
        fragments: [{ clientFragmentID: "a1", text: "alpha body", source: source() }],
      })
      const packB = await createPack(harness, {
        idempotencyKey: "b",
        tags: [],
        title: "Untagged",
        fragments: [{ clientFragmentID: "b1", text: "beta body", source: source({ label: "Beta" }) }],
      })
      const capA = await materializePack(harness, packA)
      const capB = await materializePack(harness, packB)

      const snapshot = await run(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput([attachmentOf(packB, capB), attachmentOf(packA, capA)]),
        ),
      )
      expect(snapshot.version).toBe(1)
      expect(snapshot.createdAt).toBe(1_000)
      expect(snapshot.attachments.map((entry) => entry.contextCapsuleID)).toEqual([
        capB.contextCapsuleID,
        capA.contextCapsuleID,
      ])
      expect(snapshot.attachments[0]?.tags).toBeUndefined()
      expect(snapshot.attachments[1]?.tags).toEqual(["ParallelPlan"])
      expect(snapshot.attachments[1]?.sourceCtxPackID).toBe(packA.id)
      expect(snapshot.attachments[1]?.contentHash).toBe(packA.contentHash)
      expect(snapshot.attachments[1]?.fragments.map((fragment) => fragment.text)).toEqual(["alpha body"])
      expect(snapshot.attachments[1]?.fragments.map((fragment) => fragment.contentHash)).toEqual(
        packA.fragments.map((fragment) => fragment.contentHash),
      )
      expect(snapshot.attachments[1]?.fragments[0]?.source).toEqual(packA.fragments[0]?.source)

      // Tags frozen at materialize time survive a metadata-only patch.
      await run(
        harness.fixture,
        harness.catalog.patch(owner, {
          workspaceID: owner.workspaceID,
          ctxPackID: packA.id,
          expectedRevision: packA.revision,
          patch: { tags: [] },
          idempotencyKey: "clear-tags",
        }),
      )
      const afterPatch = await run(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(packA, capA)])),
      )
      expect(afterPatch.attachments[0]?.tags).toEqual(["ParallelPlan"])
      expect(Object.isFrozen(afterPatch.attachments[0]?.tags)).toBe(true)

      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.attachments[0])).toBe(true)
      expect(Object.isFrozen(snapshot.attachments[0]?.fragments[0])).toBe(true)
      expect(Object.isFrozen(snapshot.attachments[0]?.fragments[0]?.source)).toBe(true)
    }))

  test("rejects duplicate capsule ids before the eight-attachment limit", () =>
    withHarness({}, async (harness) => {
      const duplicate = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput([fakeAttachment(0), fakeAttachment(0), fakeAttachment(1), fakeAttachment(2), fakeAttachment(3)]),
        ),
      )
      expect(duplicate.ok).toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.error).toMatchObject({
          _tag: "CtxPackSnapshotDuplicateCapsule",
          contextCapsuleID: "ctxkpsl_fake_0",
        })
      }

      const tooMany = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput(Array.from({ length: 9 }, (_, index) => fakeAttachment(index))),
        ),
      )
      expect(tooMany.ok).toBe(false)
      if (!tooMany.ok) {
        expect(tooMany.error).toMatchObject({ _tag: "CtxPackInvalidSelection", reason: "too-many-attachments" })
      }
    }))

  test("accepts exactly eight distinct capsules", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, { idempotencyKey: "eight" })
      const results: CtxPackMaterializeResult[] = []
      for (let index = 0; index < 8; index++) results.push(await materializePack(harness, pack))
      const snapshot = await run(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput(results.map((result) => attachmentOf(pack, result)))),
      )
      expect(snapshot.attachments).toHaveLength(8)
    }))

  test("rejects capsules whose purpose, instance, audience, or expiry does not match", () =>
    withHarness({ now: () => 10_000 }, async (harness) => {
      const pack = await createPack(harness, { idempotencyKey: "targets" })

      const purpose = await materializePack(harness, pack)
      await mutateCapsuleJson(harness.fixture, purpose.contextCapsuleID, (body) => {
        Reflect.set(body, "purpose", "other-purpose")
      })
      await exec(
        harness.fixture,
        sql`UPDATE cm_context_capsule SET purpose = 'other-purpose' WHERE id = ${purpose.contextCapsuleID}`,
      )
      const purposeResult = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, purpose)])),
      )
      expect(purposeResult.ok).toBe(false)
      if (!purposeResult.ok) {
        expect(purposeResult.error).toMatchObject({ _tag: "CtxPackCapsuleTargetMismatch", target: "purpose" })
      }

      const instance = await materializePack(harness, pack)
      await mutateCreatedByJson(harness.fixture, instance.contextCapsuleID, (createdBy) => {
        Reflect.set(createdBy, "instanceId", "inst-other")
      })
      const instanceResult = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, instance)])),
      )
      expect(instanceResult.ok).toBe(false)
      if (!instanceResult.ok) {
        expect(instanceResult.error).toMatchObject({ _tag: "CtxPackCapsuleTargetMismatch", target: "instance" })
      }

      const audience = await materializePack(harness, pack)
      await mutateCapsuleJson(harness.fixture, audience.contextCapsuleID, (body) => {
        Reflect.set(body, "audience", ["builtin:other"])
      })
      const audienceResult = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, audience)])),
      )
      expect(audienceResult.ok).toBe(false)
      if (!audienceResult.ok) {
        expect(audienceResult.error).toMatchObject({ _tag: "CtxPackCapsuleTargetMismatch", target: "audience" })
      }

      const expired = await materializePack(harness, pack)
      await mutateCapsuleJson(harness.fixture, expired.contextCapsuleID, (body) => {
        Reflect.set(body, "expiresAt", 5_000)
      })
      await exec(
        harness.fixture,
        sql`UPDATE cm_context_capsule SET expires_at = 5000 WHERE id = ${expired.contextCapsuleID}`,
      )
      const expiredResult = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, expired)])),
      )
      expect(expiredResult.ok).toBe(false)
      if (!expiredResult.ok) {
        expect(expiredResult.error).toMatchObject({ _tag: "CtxPackCapsuleExpired", expiresAt: 5_000 })
      }
    }))

  test("is workspace-scoped: a capsule from another workspace is not found", () =>
    withHarness({}, async (harness) => {
      const foreignActor: CtxPackActor = { userID: "user-other", workspaceID: "workspace-2" }
      const pack = await run(
        harness.fixture,
        harness.catalog.create(foreignActor, {
          ...createRequest({ workspaceID: "workspace-2", idempotencyKey: "ws2" }),
          fragments: [{ clientFragmentID: "w2", text: "workspace two", source: source({ workspaceID: "workspace-2" }) }],
        }),
      )
      const result = await run(
        harness.fixture,
        harness.materializer.materialize(foreignActor, {
          workspaceID: "workspace-2",
          ctxPackID: pack.id,
          expectedContentHash: pack.contentHash,
          targetInstanceID: "inst-1",
          targetFunctionalityID: "builtin:chat",
        }),
      )
      const missing = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput([
            {
              contextCapsuleID: result.contextCapsuleID,
              label: result.label,
              contentHash: result.contentHash,
              source: { kind: "ctxpack", ctxPackID: pack.id },
            },
          ]),
        ),
      )
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error).toMatchObject({ _tag: "CtxPackCapsuleMissing" })
    }))

  test("rejects a capsule fragment reference that is missing from the current pack", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, { idempotencyKey: "stale-ref" })
      const stored = await run(
        harness.fixture,
        harness.capsules.store({
          id: "",
          version: 1,
          workspaceId: owner.workspaceID,
          createdBy: { userId: owner.userID, instanceId: "inst-1" },
          purpose: "ctxpack-attachment",
          audience: ["builtin:chat"],
          summary: "stale refs",
          facts: [],
          references: [
            {
              kind: "ctxpack.fragment",
              ref: { type: "ctxpack-fragment", id: "ctxpkf_gone" },
              label: "gone",
              summary: "gone",
              contentHash: "sha256:gone",
              sensitivity: "workspace",
            },
          ],
          artifactRefs: [],
          recentEvents: [],
          budget: DefaultInteractiveContextBudget,
          contentHash: pack.contentHash,
          createdAt: 1_000,
          expiresAt: undefined,
        }),
      )
      const result = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput([
            {
              contextCapsuleID: stored.id,
              label: "stale",
              contentHash: pack.contentHash,
              source: { kind: "ctxpack", ctxPackID: pack.id },
            },
          ]),
        ),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatchObject({ _tag: "CtxPackContentChanged", currentContentHash: pack.contentHash })
      }
    }))

  test("pack removal, hash tamper, and capsule corruption fail closed without private text", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, {
        idempotencyKey: "sentinel",
        fragments: [{ clientFragmentID: "secret", text: `Secret material ${SENTINEL} here.`, source: source() }],
      })
      const result = await materializePack(harness, pack)
      const attachment = attachmentOf(pack, result)

      await run(
        harness.fixture,
        harness.catalog.remove(owner, { ctxPackID: pack.id, expectedRevision: pack.revision }),
      )
      const removed = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachment])),
      )
      expect(removed.ok).toBe(false)
      if (!removed.ok) {
        expect(removed.error).toMatchObject({ _tag: "CtxPackDeleted", ctxPackID: pack.id })
        expect(JSON.stringify(removed.error)).not.toContain(SENTINEL)
      }

      await run(
        harness.fixture,
        harness.catalog.restore(owner, { ctxPackID: pack.id, expectedRevision: pack.revision }),
      )
      await exec(harness.fixture, sql`UPDATE cm_ctx_pack SET content_hash = 'sha256:tampered' WHERE id = ${pack.id}`)
      const tampered = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachment])),
      )
      expect(tampered.ok).toBe(false)
      if (!tampered.ok) {
        expect(tampered.error).toMatchObject({ _tag: "CtxPackContentChanged", currentContentHash: "sha256:tampered" })
        expect(JSON.stringify(tampered.error)).not.toContain(SENTINEL)
      }

      await exec(
        harness.fixture,
        sql`UPDATE cm_context_capsule SET capsule_json = ${`{"summary":"${SENTINEL}",`} WHERE id = ${result.contextCapsuleID}`,
      )
      const corrupt = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachment])),
      )
      expect(corrupt.ok).toBe(false)
      if (!corrupt.ok) expect(String(corrupt.error)).not.toContain(SENTINEL)
    }))

  test("a corrupt tags fact is rejected without leaking stored text", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, {
        idempotencyKey: "tags-corrupt",
        fragments: [{ clientFragmentID: "secret", text: `Tagged ${SENTINEL} body`, source: source() }],
      })
      const result = await materializePack(harness, pack)
      await mutateCapsuleJson(harness.fixture, result.contextCapsuleID, (body) => {
        Reflect.set(body, "facts", [
          {
            key: "ctxpack.tags",
            value: ["NotAParallelPlan"],
            sourceRef: { type: "ctxpack", id: pack.id },
            sensitivity: "workspace",
          },
        ])
      })
      const corrupt = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, result)])),
      )
      expect(corrupt.ok).toBe(false)
      if (!corrupt.ok) expect(String(corrupt.error)).not.toContain(SENTINEL)
    }))

  test("byte/token accounting is exact UTF-8 and checks bytes before tokens", () =>
    withHarness({ now: () => 1_234 }, async (harness) => {
      const pack = await createPack(harness, {
        idempotencyKey: "utf8",
        fragments: [{ clientFragmentID: "u1", text: "héllo — 世界 🌍", source: source() }],
      })
      const result = await materializePack(harness, pack)
      const attachment = attachmentOf(pack, result)

      const snapshot = await run(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachment])),
      )
      const payload = { version: 1, attachments: snapshot.attachments, createdAt: snapshot.createdAt }
      const expectedBytes = new TextEncoder().encode(JSON.stringify(payload)).length
      expect(snapshot.byteLength).toBe(expectedBytes)
      expect(snapshot.estimatedTokens).toBe(Math.ceil(expectedBytes / 4))

      const bytesFirst = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput([attachment], {
            budget: { ...DefaultInteractiveContextBudget, maximumBytes: expectedBytes - 1, maximumEstimatedTokens: 0 },
          }),
        ),
      )
      expect(bytesFirst.ok).toBe(false)
      if (!bytesFirst.ok) {
        expect(bytesFirst.error).toMatchObject({
          _tag: "CtxPackSnapshotOverBudget",
          current: expectedBytes,
          maximum: expectedBytes - 1,
        })
      }

      const tokensOnly = await outcome(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(
          snapshotInput([attachment], {
            budget: {
              ...DefaultInteractiveContextBudget,
              maximumBytes: 1_000_000,
              maximumEstimatedTokens: snapshot.estimatedTokens - 1,
            },
          }),
        ),
      )
      expect(tokensOnly.ok).toBe(false)
      if (!tokensOnly.ok) {
        expect(tokensOnly.error).toMatchObject({
          _tag: "CtxPackSnapshotOverBudget",
          current: snapshot.estimatedTokens,
          maximum: snapshot.estimatedTokens - 1,
        })
      }
    }))

  test("diagnostics carry counts/bytes only and never private text", () =>
    withHarness({}, async (harness) => {
      const pack = await createPack(harness, {
        idempotencyKey: "diag",
        fragments: [{ clientFragmentID: "secret", text: `Diagnostic ${SENTINEL} body`, source: source() }],
      })
      const result = await materializePack(harness, pack)
      const snapshot = await run(
        harness.fixture,
        harness.materializer.snapshotForSessionInput(snapshotInput([attachmentOf(pack, result)])),
      )
      expect(harness.entries).toHaveLength(2)
      for (const entry of harness.entries) {
        expect(Object.keys(entry).sort()).toEqual([
          "attachmentCount",
          "byteLength",
          "estimatedTokens",
          "operation",
          "workspaceID",
        ])
      }
      expect(JSON.stringify(harness.entries)).not.toContain(SENTINEL)
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(JSON.stringify(snapshot)).toContain(SENTINEL)
    }))
})

describe("ctxpack materializer — input detachment", () => {
  test("caller mutation during materialize authorization cannot change admitted inputs", async () => {
    const fixture = await mediatedFixture()
    try {
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      let calls = 0
      const harness = await openHarness(fixture, {
        authorize: () =>
          Effect.suspend(() => {
            calls++
            if (calls === 1) return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            return Effect.void
          }),
      })
      const pack = await createPack(harness, { idempotencyKey: "mutation" })
      const actor = { ...owner }
      const request = { ...materializeRequest(pack) }
      const pending = run(fixture, harness.materializer.materialize(actor, request))
      await run(fixture, Deferred.await(entered))
      actor.userID = "changed-user"
      actor.workspaceID = "changed-workspace"
      request.expectedContentHash = "changed-hash"
      request.targetInstanceID = "changed-instance"
      request.targetFunctionalityID = "changed-functionality"
      await run(fixture, Deferred.succeed(release, undefined))
      const result = await pending

      const capsule = await run(fixture, harness.capsules.get(owner.workspaceID, result.contextCapsuleID))
      expect(capsule?.createdBy).toEqual({ userId: owner.userID, instanceId: "inst-1" })
      expect(capsule?.audience).toEqual(["builtin:chat"])
      expect(result.sourceCtxPackID).toBe(pack.id)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("snapshot detaches attachments, budget, and actor before the first await", async () => {
    const fixture = await mediatedFixture()
    try {
      const setup = await openHarness(fixture)
      const pack = await createPack(setup, { idempotencyKey: "snap-mutation" })
      const result = await materializePack(setup, pack)

      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      let calls = 0
      const harness = await openHarness(fixture, {
        authorize: () =>
          Effect.suspend(() => {
            calls++
            if (calls === 1) return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            return Effect.void
          }),
      })

      const attachments: CtxPackAttachment[] = [attachmentOf(pack, result)]
      const budget = { ...DefaultInteractiveContextBudget, maximumBytes: 1_000_000, maximumEstimatedTokens: 1_000_000 }
      const actor = { ...owner }
      const input = {
        actor,
        targetInstanceID: "inst-1",
        targetFunctionalityID: "builtin:chat",
        attachments,
        budget,
      }
      const pending = run(fixture, harness.materializer.snapshotForSessionInput(input))
      await run(fixture, Deferred.await(entered))
      attachments[0] = { ...attachmentOf(pack, result), label: "changed-label" }
      attachments.push(fakeAttachment(99))
      budget.maximumBytes = 1
      actor.userID = "changed-user"
      await run(fixture, Deferred.succeed(release, undefined))
      const snapshot = await pending

      expect(snapshot.attachments).toHaveLength(1)
      expect(snapshot.attachments[0]?.label).toBe(result.label)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })
})
