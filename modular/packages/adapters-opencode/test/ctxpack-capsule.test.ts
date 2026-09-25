import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import {
  DefaultInteractiveContextBudget,
  type CapsuleError,
  type ContextBudget,
  type StoredCapsule,
} from "@cybermastery/contracts/ctxpack-capsule"
import { createMediatedKernel } from "../src/kernel"
import { createMediatedFixtures } from "./fixture"
import {
  makeCtxPackCapsuleStore,
  type CtxPackCapsuleStore,
  type CtxPackCapsuleStoreOptions,
} from "../src/ctxpack-capsule"

const SENTINEL = "CTXPACK_SECRET_SENTINEL_7812"

type Fixture = Awaited<ReturnType<ReturnType<typeof createMediatedFixtures>>>

const mediatedFixture = createMediatedFixtures()

const ROOMY_BUDGET: ContextBudget = {
  ...DefaultInteractiveContextBudget,
  maximumBytes: 1_000_000_000,
  maximumEstimatedTokens: 1_000_000_000,
}

const makeCapsule = (overrides: Partial<StoredCapsule> = {}): StoredCapsule => ({
  id: "",
  version: 1,
  workspaceId: "wrk_1",
  purpose: "ctxpack context",
  audience: ["ctxpack"],
  summary: "A summary of the workspace context.",
  facts: [{ fact: "the sky is blue" }],
  references: [
    { ref: { type: "ctxpack-fragment", id: "ref_1" }, label: "one" },
    { ref: { type: "ctxpack-fragment", id: "ref_2" }, label: "two" },
    { plain: "always-kept" },
  ],
  artifactRefs: [{ ref: { type: "ctxpack-artifact", id: "art_1" } }],
  recentEvents: [{ event: "hello" }],
  contentHash: "hash-abc-123",
  createdAt: 1_000,
  expiresAt: undefined,
  createdBy: { userId: "user-1", instanceId: "inst_1", operationId: "op_1" },
  budget: DefaultInteractiveContextBudget,
  ...overrides,
})

async function withFixture<A>(f: (fixture: Fixture) => Promise<A>): Promise<A> {
  const fixture = await mediatedFixture()
  try {
    return await f(fixture)
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
}

const openStore = (fixture: Fixture, options?: CtxPackCapsuleStoreOptions): Promise<CtxPackCapsuleStore> =>
  fixture.runtime.runPromise(makeCtxPackCapsuleStore(options))

const runStore = <A>(fixture: Fixture, effect: Effect.Effect<A, CapsuleError>): Promise<A> =>
  fixture.runtime.runPromise(effect)

const exec = (fixture: Fixture, statement: SQL): Promise<void> =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(statement)
    }),
  )

const readCapsuleJson = (fixture: Fixture, id: string): Promise<string> =>
  fixture.runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const row = yield* database.db.get<{ capsule_json: string }>(
        sql`SELECT capsule_json FROM cm_context_capsule WHERE id = ${id}`,
      )
      if (!row) throw new Error("Missing capsule fixture")
      return row.capsule_json
    }),
  )

const refIDOf = (entry: unknown): string | undefined => {
  if (typeof entry !== "object" || entry === null) return undefined
  const ref = (entry as Record<string, unknown>).ref
  if (typeof ref !== "object" || ref === null) return undefined
  const id = (ref as Record<string, unknown>).id
  return typeof id === "string" ? id : undefined
}

const expectCorrupt = async (fixture: Fixture, store: CtxPackCapsuleStore, capsuleID: string): Promise<void> => {
  const caught = await runStore(fixture, store.get("wrk_1", capsuleID)).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(caught).toMatchObject({ _tag: "ContextCapsule.Corrupt", capsuleID, workspaceID: "wrk_1" })
  expect(String(caught)).not.toContain(SENTINEL)
}

describe("makeCtxPackCapsuleStore", () => {
  test("store/get round trip preserves separate metadata and explicit ids", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const stored = await runStore(fixture, store.store(makeCapsule({ id: "ctxkpsl_explicit" })))
      expect(stored.id).toBe("ctxkpsl_explicit")

      const loaded = await runStore(fixture, store.get("wrk_1", stored.id))
      expect(loaded).toEqual(stored)
      expect(loaded?.createdBy).toEqual({ userId: "user-1", instanceId: "inst_1", operationId: "op_1" })
      expect(loaded?.budget).toEqual(DefaultInteractiveContextBudget)
      expect(loaded?.summary).toBe("A summary of the workspace context.")
      expect(loaded?.references).toHaveLength(3)
      expect(loaded?.expiresAt).toBeUndefined()

      // createdBy and budget are deliberately out-of-body in their own columns.
      const parsed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await readCapsuleJson(fixture, stored.id)),
      )
      expect(Object.keys(parsed)).not.toContain("createdBy")
      expect(Object.keys(parsed)).not.toContain("budget")
      expect(parsed.summary).toBe("A summary of the workspace context.")
    }))

  test("empty id is assigned, and re-store with the same id is an immutable conflict", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const stored = await runStore(fixture, store.store(makeCapsule()))
      expect(stored.id).toMatch(/^ctxkpsl_/)

      await expect(
        runStore(fixture, store.store({ ...makeCapsule(), id: stored.id })),
      ).rejects.toMatchObject({ _tag: "ContextCapsule.Conflict", capsuleID: stored.id, workspaceID: "wrk_1" })

      // A byte-identical re-store is still a conflict, never an idempotent overwrite.
      const identical = await runStore(fixture, store.get("wrk_1", stored.id))
      await expect(
        runStore(fixture, store.store({ ...identical!, id: stored.id })),
      ).rejects.toMatchObject({ _tag: "ContextCapsule.Conflict" })
    }))

  test("get and materialize are workspace-scoped", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const stored = await runStore(fixture, store.store(makeCapsule()))
      expect(await runStore(fixture, store.get("wrk_other", stored.id))).toBeUndefined()
      expect(
        await runStore(
          fixture,
          store.materialize({ workspaceID: "wrk_other", capsuleID: stored.id, requestedRefs: [], budget: ROOMY_BUDGET }),
        ),
      ).toEqual({ status: "not-found" })
    }))

  test("materialize filters references, keeps ref-less entries, and preserves unresolved order", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const stored = await runStore(fixture, store.store(makeCapsule()))

      const all = await runStore(
        fixture,
        store.materialize({ workspaceID: "wrk_1", capsuleID: stored.id, requestedRefs: [], budget: ROOMY_BUDGET }),
      )
      expect(all.status).toBe("ok")
      if (all.status !== "ok") return
      expect(all.content.references).toHaveLength(3)
      expect(all.content.artifactRefs).toHaveLength(1)
      expect(all.unresolvedRefs).toEqual([])
      expect(all.content.facts).toEqual([{ fact: "the sky is blue" }])

      const filtered = await runStore(
        fixture,
        store.materialize({
          workspaceID: "wrk_1",
          capsuleID: stored.id,
          requestedRefs: ["ref_2", "ref_1", "ghost_1", "ref_2", "ghost_1"],
          budget: ROOMY_BUDGET,
        }),
      )
      expect(filtered.status).toBe("ok")
      if (filtered.status !== "ok") return
      expect(filtered.content.references.map((entry) => refIDOf(entry))).toEqual(["ref_1", "ref_2", undefined])
      expect(filtered.content.artifactRefs).toEqual([])
      expect(filtered.unresolvedRefs).toEqual(["ghost_1", "ghost_1"])

      const artifacts = await runStore(
        fixture,
        store.materialize({
          workspaceID: "wrk_1",
          capsuleID: stored.id,
          requestedRefs: ["art_1"],
          budget: ROOMY_BUDGET,
        }),
      )
      expect(artifacts.status).toBe("ok")
      if (artifacts.status !== "ok") return
      expect(artifacts.content.references.map((entry) => refIDOf(entry))).toEqual([undefined])
      expect(artifacts.content.artifactRefs.map((entry) => refIDOf(entry))).toEqual(["art_1"])
      expect(artifacts.unresolvedRefs).toEqual([])
    }))

  test("expiry boundary is inclusive against an injected clock", () =>
    withFixture(async (fixture) => {
      const expiresAt = 5_000
      const before = await openStore(fixture, { now: () => expiresAt - 1 })
      const stored = await runStore(fixture, before.store(makeCapsule({ id: "ctxkpsl_exp", createdAt: 1, expiresAt })))
      const live = await runStore(
        fixture,
        before.materialize({ workspaceID: "wrk_1", capsuleID: stored.id, requestedRefs: [], budget: ROOMY_BUDGET }),
      )
      expect(live.status).toBe("ok")

      const at = await openStore(fixture, { now: () => expiresAt })
      const expired = await runStore(
        fixture,
        at.materialize({ workspaceID: "wrk_1", capsuleID: stored.id, requestedRefs: [], budget: ROOMY_BUDGET }),
      )
      expect(expired).toEqual({ status: "expired", expiresAt })
    }))

  test("byte length is UTF-8 and tokens derive from bytes", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const facts = [{ text: "héllo — 世界 🌍" }]
      const stored = await runStore(
        fixture,
        store.store(makeCapsule({ id: "ctxkpsl_utf8", facts, references: [], artifactRefs: [] })),
      )
      const result = await runStore(
        fixture,
        store.materialize({ workspaceID: "wrk_1", capsuleID: stored.id, requestedRefs: [], budget: ROOMY_BUDGET }),
      )
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      const expectedBytes = new TextEncoder().encode(
        JSON.stringify({ facts, references: [], artifactRefs: [] }),
      ).length
      expect(result.byteLength).toBe(expectedBytes)
      expect(result.estimatedTokens).toBe(Math.ceil(expectedBytes / 4))
      expect(new TextEncoder().encode(JSON.stringify(result.content)).length).toBe(expectedBytes)
    }))

  test("byte budget is checked before token budget", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const stored = await runStore(fixture, store.store(makeCapsule()))

      const bytesFirst = await runStore(
        fixture,
        store.materialize({
          workspaceID: "wrk_1",
          capsuleID: stored.id,
          requestedRefs: [],
          budget: { ...DefaultInteractiveContextBudget, maximumBytes: 2, maximumEstimatedTokens: 1 },
        }),
      )
      expect(bytesFirst.status).toBe("over-budget")
      if (bytesFirst.status === "over-budget") {
        expect(bytesFirst.limit).toBe("bytes")
        expect(bytesFirst.maximum).toBe(2)
        expect(bytesFirst.current).toBeGreaterThan(2)
      }

      const tokensOnly = await runStore(
        fixture,
        store.materialize({
          workspaceID: "wrk_1",
          capsuleID: stored.id,
          requestedRefs: [],
          budget: { ...DefaultInteractiveContextBudget, maximumBytes: 1_000_000_000, maximumEstimatedTokens: 1 },
        }),
      )
      expect(tokensOnly.status).toBe("over-budget")
      if (tokensOnly.status === "over-budget") {
        expect(tokensOnly.limit).toBe("tokens")
        expect(tokensOnly.maximum).toBe(1)
      }
    }))

  test("corrupt JSON in each column surfaces a typed, redacted Corrupt error", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)

      const badBody = await runStore(fixture, store.store(makeCapsule({ id: "ctxkpsl_bad_body", summary: SENTINEL })))
      await exec(
        fixture,
        sql`UPDATE cm_context_capsule SET capsule_json = ${`{"summary":"${SENTINEL}",`} WHERE id = ${badBody.id}`,
      )
      await expectCorrupt(fixture, store, badBody.id)

      const badMeta = await runStore(fixture, store.store(makeCapsule({ id: "ctxkpsl_bad_meta" })))
      await exec(fixture, sql`UPDATE cm_context_capsule SET created_by_json = ${"{"} WHERE id = ${badMeta.id}`)
      await expectCorrupt(fixture, store, badMeta.id)

      const badBudget = await runStore(fixture, store.store(makeCapsule({ id: "ctxkpsl_bad_budget" })))
      await exec(fixture, sql`UPDATE cm_context_capsule SET budget_json = ${"[1,2,3]"} WHERE id = ${badBudget.id}`)
      await expectCorrupt(fixture, store, badBudget.id)

      // Strict excess-property behavior: an unknown body key is corrupt.
      const excess = await runStore(fixture, store.store(makeCapsule({ id: "ctxkpsl_excess" })))
      const bodyFields = {
        id: excess.id,
        version: excess.version,
        workspaceId: excess.workspaceId,
        purpose: excess.purpose,
        audience: excess.audience,
        summary: excess.summary,
        facts: excess.facts,
        references: excess.references,
        artifactRefs: excess.artifactRefs,
        recentEvents: excess.recentEvents,
        contentHash: excess.contentHash,
        createdAt: excess.createdAt,
        expiresAt: excess.expiresAt,
      }
      await exec(
        fixture,
        sql`UPDATE cm_context_capsule SET capsule_json = ${JSON.stringify({ ...bodyFields, extra: true })} WHERE id = ${excess.id}`,
      )
      await expectCorrupt(fixture, store, excess.id)
    }))

  test("returned objects are detached from stored data", () =>
    withFixture(async (fixture) => {
      const store = await openStore(fixture)
      const facts = [{ fact: "the sky is blue" }]
      const input = makeCapsule({ id: "ctxkpsl_detach", facts })
      const stored = await runStore(fixture, store.store(input))
      facts.push({ fact: "mutated-input" })

      const first = await runStore(fixture, store.get("wrk_1", stored.id))
      expect(first?.facts).toEqual([{ fact: "the sky is blue" }])
      if (!first) throw new Error("Missing capsule")
      Reflect.set(first.facts, 0, { fact: "mutated-return" })

      const second = await runStore(fixture, store.get("wrk_1", stored.id))
      expect(second?.facts).toEqual([{ fact: "the sky is blue" }])
    }))

  test("capsules survive a runtime reopen on the same native file", async () => {
    const fixture = await mediatedFixture()
    let reopened: ReturnType<typeof createMediatedKernel> | undefined
    let fixtureDisposed = false
    const disposeFixture = async () => {
      if (fixtureDisposed) return
      fixtureDisposed = true
      await fixture[Symbol.asyncDispose]()
    }
    try {
      const store = await openStore(fixture)
      const stored = await runStore(
        fixture,
        store.store(makeCapsule({ id: "ctxkpsl_reopen", summary: "reopen-summary" })),
      )
      expect(stored.id).toBe("ctxkpsl_reopen")

      // Close the first connection before reopening so this is a real reopen.
      await disposeFixture()
      reopened = createMediatedKernel(join(fixture.directory, "proof.db"))

      const reopenedStore = await reopened.runPromise(makeCtxPackCapsuleStore())
      const loaded = await reopened.runPromise(reopenedStore.get("wrk_1", "ctxkpsl_reopen"))
      expect(loaded?.summary).toBe("reopen-summary")
      expect(loaded?.createdBy).toEqual({ userId: "user-1", instanceId: "inst_1", operationId: "op_1" })
    } finally {
      await disposeFixture()
      if (reopened) await reopened.dispose()
    }
  })
})
