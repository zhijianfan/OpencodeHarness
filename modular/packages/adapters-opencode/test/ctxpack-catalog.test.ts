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
  CtxPackListRequest,
  CtxPackSort,
  CtxPackSource,
} from "@cybermastery/contracts/ctxpack"
import { Database } from "@opencode-ai/core/database/database"
import { sql } from "drizzle-orm"
import { Deferred, Effect } from "effect"
import { databaseCleanup } from "../../../test-utils/cleanup"
import { EventBoundary } from "../src/event-boundary"
import { createMediatedKernel } from "../src/kernel"
import { makeCtxPackCatalog, type CtxPackCatalogOptions } from "../src/ctxpack-catalog"
import { createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()
const cleanup = databaseCleanup()

type Kernel = ReturnType<typeof createMediatedKernel>

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
    title: "Catalog pack",
    keywords: ["alpha", "beta"],
    tags: ["ParallelPlan"],
    sensitivity: "workspace",
    fragments: [{ clientFragmentID: "client-1", text: "hello world", source: source() }],
    idempotencyKey: "idem-1",
  }
  return Object.assign(defaults, input)
}

function listRequest(input: Partial<CtxPackListRequest> = {}): CtxPackListRequest {
  const defaults: CtxPackListRequest = {
    workspaceID: "workspace-1",
    query: "",
    keyword: null,
    sourceBlockID: null,
    sourceFunctionalityID: null,
    sourceKind: null,
    sensitivity: null,
    createdAfter: null,
    createdBefore: null,
    includeDeleted: false,
    pinnedOnly: false,
    sort: "created-desc",
    cursor: null,
    limit: 20,
  }
  return Object.assign(defaults, input)
}

function recordOptions(
  events: CtxPackChanged[],
  authorize: CtxPackCatalogOptions["authorize"] = () => Effect.void,
): CtxPackCatalogOptions {
  return {
    authorize,
    publish: (event) => Effect.sync(() => { events.push(event) }),
  }
}

function run<A>(runtime: Pick<Kernel, "runPromise">, effect: Effect.Effect<A, CtxPackError>): Promise<A> {
  return runtime.runPromise(effect)
}

async function expectFailureTag(
  runtime: Pick<Kernel, "runPromise">,
  effect: Effect.Effect<unknown, CtxPackError>,
): Promise<string> {
  return runtime.runPromise(
    effect.pipe(
      Effect.map(() => "success"),
      Effect.catch((error) => Effect.succeed(error._tag)),
    ),
  )
}

describe("ctxpack catalog", () => {
  test("creates a pack, keeps tag/order metadata, and reloads with server fragment ids", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const created = await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "First catalog pack",
        keywords: ["alpha", "beta"],
        tags: ["ParallelPlan"],
        idempotencyKey: "round-trip",
        fragments: [
          { clientFragmentID: "client-a", text: "first body", source: source({ blockID: "block-a" }) },
          { clientFragmentID: "client-b", text: "second body", source: source({ blockID: "block-b" }) },
        ],
      })))

      expect(created.id.startsWith("ctxpk_")).toBe(true)
      expect(created.revision).toBe(1)
      expect(created.deletedAt).toBeNull()
      expect(created.tags).toEqual(["ParallelPlan"])
      expect(created.fragments.map((fragment) => fragment.ordinal)).toEqual([0, 1])
      expect(created.fragments.map((fragment) => fragment.text)).toEqual(["first body", "second body"])
      expect(created.fragments.every((fragment) => fragment.id.startsWith("ctxpkf_"))).toBe(true)
      expect(created.fragments.every((fragment) => fragment.clientFragmentID === fragment.id)).toBe(true)
      expect(created.byteLength).toBeGreaterThan(0)
      expect(created.estimatedTokens).toBeGreaterThan(0)

      const reloaded = await run(fixture.runtime, catalog.get(owner, created.id))
      expect(reloaded.contentHash).toBe(created.contentHash)
      expect(reloaded.fragments).toEqual(created.fragments)

      expect(events).toHaveLength(1)
      expect(events[0]?.properties.change).toBe("created")
      expect(JSON.stringify(events[0])).not.toContain("first body")
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("create is idempotent per key and returns the original winner for a changed valid payload", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const first = await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "Original",
        idempotencyKey: "same-key",
      })))
      const second = await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "Different",
        idempotencyKey: "same-key",
        fragments: [{ clientFragmentID: "client-x", text: "totally different text", source: source() }],
      })))

      expect(second.id).toBe(first.id)
      expect(second.title).toBe("Original")
      expect(second.contentHash).toBe(first.contentHash)
      expect(events.filter((event) => event.properties.change === "created")).toHaveLength(1)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("patch enforces expectedRevision, bumps revision on an empty patch, and keeps content stable", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const created = await run(fixture.runtime, catalog.create(owner, createRequest({ idempotencyKey: "patch-key" })))

      const patched = await run(fixture.runtime, catalog.patch(owner, {
        workspaceID: "workspace-1",
        ctxPackID: created.id,
        expectedRevision: 1,
        patch: { title: "Renamed" },
        idempotencyKey: "p1",
      }))
      expect(patched.revision).toBe(2)
      expect(patched.title).toBe("Renamed")
      expect(patched.contentHash).toBe(created.contentHash)

      const empty = await run(fixture.runtime, catalog.patch(owner, {
        workspaceID: "workspace-1",
        ctxPackID: created.id,
        expectedRevision: 2,
        patch: {},
        idempotencyKey: "p2",
      }))
      expect(empty.revision).toBe(3)
      expect(empty.title).toBe("Renamed")
      expect(empty.contentHash).toBe(created.contentHash)

      // A stale retry with a reused idempotencyKey conflicts: patch does not
      // dedupe on the wire key.
      expect(await expectFailureTag(fixture.runtime, catalog.patch(owner, {
        workspaceID: "workspace-1",
        ctxPackID: created.id,
        expectedRevision: 2,
        patch: { title: "Stale" },
        idempotencyKey: "p2",
      }))).toBe("CtxPackRevisionConflict")

      const after = await run(fixture.runtime, catalog.get(owner, created.id))
      expect(after.title).toBe("Renamed")
      expect(after.revision).toBe(3)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("private packs are hidden before paging and counts", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const privatePack = await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "Private notes",
        sensitivity: "private",
        idempotencyKey: "private",
        fragments: [{ clientFragmentID: "p1", text: "private body", source: source({ sensitivity: "private" }) }],
      })))
      await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "Shared notes",
        idempotencyKey: "shared",
      })))

      const ownerList = await run(fixture.runtime, catalog.list(owner, listRequest()))
      expect(ownerList.totalEstimate).toBe(2)

      const otherList = await run(fixture.runtime, catalog.list(other, listRequest({ limit: 1 })))
      expect(otherList.items.map((item) => item.title)).toEqual(["Shared notes"])
      expect(otherList.totalEstimate).toBe(1)

      expect(await expectFailureTag(fixture.runtime, catalog.get(other, privatePack.id))).toBe(
        "CtxPackPermissionDenied",
      )
      const ownerGet = await run(fixture.runtime, catalog.get(owner, privatePack.id))
      expect(ownerGet.id).toBe(privatePack.id)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("keyset paging covers sorts, the null-last cursor, and invalid cursors", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      await run(fixture.runtime, catalog.create(owner, createRequest({ title: "Bravo", idempotencyKey: "b" })))
      await run(fixture.runtime, catalog.create(owner, createRequest({ title: "Alpha", idempotencyKey: "a" })))
      await run(fixture.runtime, catalog.create(owner, createRequest({ title: "Charlie", idempotencyKey: "c" })))

      const first = await run(fixture.runtime, catalog.list(owner, listRequest({ sort: "title-asc", limit: 1 })))
      expect(first.items.map((item) => item.title)).toEqual(["Alpha"])
      expect(first.nextCursor).not.toBeNull()
      const second = await run(fixture.runtime, catalog.list(owner, listRequest({
        sort: "title-asc",
        limit: 1,
        cursor: first.nextCursor,
      })))
      expect(second.items.map((item) => item.title)).toEqual(["Bravo"])
      expect(second.nextCursor).not.toBeNull()
      const third = await run(fixture.runtime, catalog.list(owner, listRequest({
        sort: "title-asc",
        limit: 1,
        cursor: second.nextCursor,
      })))
      expect(third.items.map((item) => item.title)).toEqual(["Charlie"])
      expect(third.nextCursor).toBeNull()

      // A cursor issued for a different sort is rejected.
      expect(await expectFailureTag(fixture.runtime, catalog.list(owner, listRequest({
        sort: "created-desc",
        cursor: first.nextCursor,
      })))).toBe("CtxPackSearchCursorInvalid")
      expect(await expectFailureTag(fixture.runtime, catalog.list(owner, listRequest({
        cursor: "not-a-valid-cursor",
      })))).toBe("CtxPackSearchCursorInvalid")

      // recently-attached has a nullable sort value: paging still works.
      const nullFirst = await run(fixture.runtime, catalog.list(owner, listRequest({
        sort: "recently-attached",
        limit: 1,
      })))
      expect(nullFirst.nextCursor).not.toBeNull()
      const nullSecond = await run(fixture.runtime, catalog.list(owner, listRequest({
        sort: "recently-attached",
        limit: 1,
        cursor: nullFirst.nextCursor,
      })))
      const firstID = nullFirst.items[0]?.id
      if (!firstID) throw new Error("Missing first page item")
      expect(nullSecond.items[0]?.id).not.toBe(firstID)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("FTS search intersects metadata filters and skips punctuation-only queries", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const fox = await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "Gamma report",
        keywords: ["shared", "animals"],
        idempotencyKey: "fox",
        fragments: [{ clientFragmentID: "f1", text: "the quick brown fox", source: source({ kind: "message" }) }],
      })))
      const dog = await run(fixture.runtime, catalog.create(owner, createRequest({
        title: "Delta report",
        keywords: ["shared", "pets"],
        idempotencyKey: "dog",
        fragments: [
          { clientFragmentID: "f2", text: "the lazy dog sleeps", source: source({ kind: "file", blockID: "block-2" }) },
        ],
      })))

      const andResult = await run(fixture.runtime, catalog.list(owner, listRequest({ query: "quick fox" })))
      expect(andResult.items.map((item) => item.id)).toEqual([fox.id])
      const disjoint = await run(fixture.runtime, catalog.list(owner, listRequest({ query: "quick dog" })))
      expect(disjoint.items).toHaveLength(0)

      const keywordFiltered = await run(fixture.runtime, catalog.list(owner, listRequest({
        query: "dog",
        keyword: "shared",
      })))
      expect(keywordFiltered.items.map((item) => item.id)).toEqual([dog.id])

      const sourceKindFiltered = await run(fixture.runtime, catalog.list(owner, listRequest({
        query: "the",
        sourceKind: "file",
      })))
      expect(sourceKindFiltered.items.map((item) => item.id)).toEqual([dog.id])

      const punctuation = await run(fixture.runtime, catalog.list(owner, listRequest({ query: "???" })))
      expect(punctuation.items).toHaveLength(2)

      const phrase = await run(fixture.runtime, catalog.list(owner, listRequest({ query: "\"brown fox\"" })))
      expect(phrase.items.map((item) => item.id)).toEqual([fox.id])
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("re-bootstrapping backfills a missing FTS index over live packs", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const pack = await run(fixture.runtime, catalog.create(owner, createRequest({
        idempotencyKey: "backfill",
        fragments: [{ clientFragmentID: "b1", text: "uniqueterm here", source: source() }],
      })))

      await fixture.runtime.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(sql`DROP TABLE cm_ctx_pack_fts`)
      }))

      const rebuilt = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions([])))
      const found = await run(fixture.runtime, rebuilt.list(owner, listRequest({ query: "uniqueterm" })))
      expect(found.items.map((item) => item.id)).toEqual([pack.id])
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("per-user pins, delete, and restore preserve the baseline edge semantics", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const created = await run(fixture.runtime, catalog.create(owner, createRequest({ idempotencyKey: "pin-key" })))

      const pinnedOnce = await run(fixture.runtime, catalog.pin(owner, created.id))
      expect(pinnedOnce.pinnedAt).not.toBeNull()
      const pinnedTwice = await run(fixture.runtime, catalog.pin(owner, created.id))
      expect(pinnedTwice).toMatchObject({ pinnedAt: pinnedOnce.pinnedAt })

      const otherPin = await run(fixture.runtime, catalog.pin(other, created.id))
      expect(otherPin.pinnedAt).not.toBeNull()

      const pinnedList = await run(fixture.runtime, catalog.list(owner, listRequest({ pinnedOnly: true })))
      expect(pinnedList.items.map((item) => item.id)).toEqual([created.id])

      const removed = await run(fixture.runtime, catalog.remove(owner, {
        ctxPackID: created.id,
        expectedRevision: 1,
      }))
      expect(removed.deletedAt).not.toBeNull()
      expect(removed.revision).toBe(1)

      // Deleted packs are never reported by pinnedOnly, even with includeDeleted.
      const deletedPinned = await run(fixture.runtime, catalog.list(owner, listRequest({
        pinnedOnly: true,
        includeDeleted: true,
      })))
      expect(deletedPinned.items).toHaveLength(0)

      expect(await expectFailureTag(fixture.runtime, catalog.pin(owner, created.id))).toBe("CtxPackDeleted")

      // Unpin is allowed on a deleted pack and removes the retained pin.
      await run(fixture.runtime, catalog.unpin(owner, created.id))
      const afterUnpin = await run(fixture.runtime, catalog.get(owner, created.id, true))
      expect(afterUnpin.pinnedAt).toBeNull()

      const restored = await run(fixture.runtime, catalog.restore(owner, {
        ctxPackID: created.id,
        expectedRevision: 1,
      }))
      expect(restored.deletedAt).toBeNull()
      expect(restored.revision).toBe(1)
      expect(restored.pinnedAt).toBeNull()

      const otherAfter = await run(fixture.runtime, catalog.get(other, created.id, true))
      expect(otherAfter.pinnedAt).not.toBeNull()

      expect(events.filter((event) => event.properties.change === "pinned")).toHaveLength(2)
      expect(events.filter((event) => event.properties.change === "unpinned")).toHaveLength(1)
      expect(events.filter((event) => event.properties.change === "restored")).toHaveLength(1)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("authorization revoked inside the transaction rolls back and emits no hint", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      let patchAuthorizations = 0
      const authorize: CtxPackCatalogOptions["authorize"] = (request: CtxPackAccess) => {
        if (request.operation !== "ctxpack.patch") return Effect.void
        patchAuthorizations += 1
        if (patchAuthorizations === 1) return Effect.void
        return Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.patch" })
      }
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events, authorize)))
      const created = await run(fixture.runtime, catalog.create(owner, createRequest({ idempotencyKey: "auth-key" })))

      expect(await expectFailureTag(fixture.runtime, catalog.patch(owner, {
        workspaceID: "workspace-1",
        ctxPackID: created.id,
        expectedRevision: 1,
        patch: { title: "Should not apply" },
        idempotencyKey: "auth-p",
      }))).toBe("CtxPackPermissionDenied")

      expect(patchAuthorizations).toBe(2)
      const after = await run(fixture.runtime, catalog.get(owner, created.id))
      expect(after.title).toBe(created.title)
      expect(after.revision).toBe(1)
      expect(events.filter((event) => event.properties.change === "metadata-updated")).toHaveLength(0)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("an outer transaction rollback suppresses committed change hints", async () => {
    const fixture = await mediatedFixture()
    try {
      const events: CtxPackChanged[] = []
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events)))
      const before = events.length

      await fixture.runtime.runPromise(Effect.gen(function* () {
        const boundary = yield* EventBoundary
        yield* boundary.transaction(Effect.gen(function* () {
          yield* catalog.create(owner, createRequest({ title: "Rolled back", idempotencyKey: "rollback" }))
          return yield* Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "test" })
        })).pipe(Effect.catch(() => Effect.void))
      }))

      expect(events.length).toBe(before)
      const listed = await run(fixture.runtime, catalog.list(owner, listRequest()))
      expect(listed.items.some((item) => item.title === "Rolled back")).toBe(false)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("a failing publisher leaves the committed mutation intact", async () => {
    const fixture = await mediatedFixture()
    try {
      const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({
        authorize: () => Effect.void,
        publish: () => Effect.die(new Error("publisher boom")),
      }))
      const created = await run(fixture.runtime, catalog.create(owner, createRequest({ idempotencyKey: "boomer" })))
      const reloaded = await run(fixture.runtime, catalog.get(owner, created.id))
      expect(reloaded.id).toBe(created.id)
      expect(reloaded.title).toBe(created.title)
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })

  test("independent runtimes serialize create and revision races on one database file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpack-catalog-"))
    const file = join(directory, "catalog.db")
    const runtimeA = createMediatedKernel(file)
    const runtimeB = createMediatedKernel(file)
    try {
      const catalogA = await runtimeA.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
      const catalogB = await runtimeB.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))

      const [first, second] = await Promise.all([
        run(runtimeA, catalogA.create(owner, createRequest({ title: "A", idempotencyKey: "race" }))),
        run(runtimeB, catalogB.create(owner, createRequest({ title: "B", idempotencyKey: "race" }))),
      ])
      expect(first.id).toBe(second.id)

      const patches = await Promise.allSettled([run(runtimeA, catalogA.patch(owner, {
        workspaceID: "workspace-1",
        ctxPackID: first.id,
        expectedRevision: 1,
        patch: { title: "Updated" },
        idempotencyKey: "race-p1",
      })), run(runtimeB, catalogB.patch(owner, {
        workspaceID: "workspace-1",
        ctxPackID: first.id,
        expectedRevision: 1,
        patch: { title: "Stale" },
        idempotencyKey: "race-p2",
      }))])
      expect(patches.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      const failed = patches.find((result) => result.status === "rejected")
      if (!failed || failed.status !== "rejected") throw new Error("Missing losing patch")
      expect(failed.reason).toMatchObject({ _tag: "CtxPackRevisionConflict", currentRevision: 2 })
    } finally {
      await runtimeA.dispose()
      await runtimeB.dispose()
      cleanup(directory)
    }
  })

  test("create revalidates authority before the first mutation", async () => {
    await using fixture = await mediatedFixture()
    const events: CtxPackChanged[] = []
    const state = { calls: 0 }
    const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog(recordOptions(events, () => Effect.suspend(() => {
      state.calls++
      return state.calls === 1 ? Effect.void : Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.create" })
    }))))
    expect(await expectFailureTag(fixture.runtime, catalog.create(owner, createRequest()))).toBe("CtxPackPermissionDenied")
    expect(events).toEqual([])
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* database.db.all(sql`SELECT id FROM cm_ctx_pack`)).toEqual([])
      expect(yield* database.db.all(sql`SELECT ctx_pack_id FROM cm_ctx_pack_fts`)).toEqual([])
    }))
  })

  test("caller mutation during authorization cannot change the admitted actor or request", async () => {
    await using fixture = await mediatedFixture()
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const state = { calls: 0 }
    const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({ authorize: () => Effect.suspend(() => {
      state.calls++
      return state.calls === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void
    }) }))
    const actor = { ...owner }
    const request = { ...createRequest() }
    const pending = fixture.runtime.runPromise(catalog.create(actor, request))
    await fixture.runtime.runPromise(Deferred.await(entered))
    actor.userID = "changed-user"
    actor.workspaceID = "changed-workspace"
    request.title = "changed-title"
    await fixture.runtime.runPromise(Deferred.succeed(release, undefined))
    const created = await pending
    expect(created.createdByUserID).toBe(owner.userID)
    expect(created.workspaceID).toBe(owner.workspaceID)
    expect(created.title).toBe("Catalog pack")
  })

  test("blank actors fail before catalog reads or writes", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
    expect(await expectFailureTag(fixture.runtime, catalog.create({ ...owner, userID: " " }, createRequest())))
      .toBe("CtxPackPermissionDenied")
    expect(await expectFailureTag(fixture.runtime, catalog.get({ ...owner, workspaceID: " " }, "ctxpk_missing")))
      .toBe("CtxPackPermissionDenied")
  })

  test("all seven sorts retain their ordering across single-item pages", async () => {
    await using fixture = await mediatedFixture()
    const clock = { time: 100 }
    const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void, now: () => clock.time }))
    const a = await fixture.runtime.runPromise(catalog.create(owner, createRequest({ title: "Bravo", idempotencyKey: "sort-a",
      fragments: [{ clientFragmentID: "a", text: "a".repeat(12), source: source() }],
    })))
    clock.time = 200
    const b = await fixture.runtime.runPromise(catalog.create(owner, createRequest({ title: "Alpha", idempotencyKey: "sort-b",
      fragments: [{ clientFragmentID: "b", text: "b".repeat(4), source: source() }],
    })))
    clock.time = 300
    const c = await fixture.runtime.runPromise(catalog.create(owner, createRequest({ title: "Charlie", idempotencyKey: "sort-c",
      fragments: [{ clientFragmentID: "c", text: "c".repeat(8), source: source() }],
    })))
    clock.time = 400
    await fixture.runtime.runPromise(catalog.patch(owner, { workspaceID: owner.workspaceID, ctxPackID: a.id,
      expectedRevision: 1, patch: {}, idempotencyKey: "sort-patch" }))
    await fixture.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(sql`UPDATE cm_ctx_pack SET attached_count = 1, last_attached_at = 10 WHERE id = ${a.id}`)
      yield* database.db.run(sql`UPDATE cm_ctx_pack SET attached_count = 3 WHERE id = ${b.id}`)
      yield* database.db.run(sql`UPDATE cm_ctx_pack SET attached_count = 2, last_attached_at = 20 WHERE id = ${c.id}`)
    }))
    const cases: readonly [CtxPackSort, readonly string[]][] = [
      ["created-desc", [c.id, b.id, a.id]], ["created-asc", [a.id, b.id, c.id]],
      ["updated-desc", [a.id, c.id, b.id]], ["title-asc", [b.id, a.id, c.id]],
      ["tokens-desc", [a.id, c.id, b.id]], ["most-attached", [b.id, c.id, a.id]],
      ["recently-attached", [c.id, a.id, b.id]],
    ]
    for (const [sort, expected] of cases) {
      const ids: string[] = []
      const position: { cursor: string | null } = { cursor: null }
      do {
        const page = await fixture.runtime.runPromise(catalog.list(owner, listRequest({ sort, cursor: position.cursor, limit: 1 })))
        expect(page.totalEstimate).toBe(3)
        ids.push(...page.items.map((item) => item.id))
        position.cursor = page.nextCursor
      } while (position.cursor !== null && ids.length <= 3)
      expect(position.cursor).toBeNull()
      expect(ids).toEqual([...expected])
    }
  })

  test("synchronous publisher failure occurs after commit and cannot roll it back", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({
      authorize: () => Effect.void,
      publish: () => { throw new Error("private publisher detail") },
    }))
    const created = await fixture.runtime.runPromise(catalog.create(owner, createRequest()))
    expect((await fixture.runtime.runPromise(catalog.get(owner, created.id))).id).toBe(created.id)
  })
})
