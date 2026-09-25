import { describe, expect, test } from "bun:test"
import type {
  CtxPackActor,
  CtxPackCreateRequest,
  CtxPackError,
  CtxPackInfo,
  CtxPackSensitivity,
  CtxPackSource,
} from "@cybermastery/contracts/ctxpack"
import { Database } from "@opencode-ai/core/database/database"
import { sql } from "drizzle-orm"
import { Cause, Effect } from "effect"
import type { ContextSidecarAttachment } from "../src/context-renderer"
import { makeCtxPackCatalog, type CtxPackCatalog } from "../src/ctxpack-catalog"
import {
  makeCtxPackRecall,
  type CtxPackRecall,
  type CtxPackRecallResult,
  type CtxPackRecallTarget,
} from "../src/ctxpack-recall"
import { createMediatedKernel } from "../src/kernel"
import { createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()

type Kernel = ReturnType<typeof createMediatedKernel>

const workspaceID = "workspace-1"
const owner: CtxPackActor = { userID: "user-owner", workspaceID }
const other: CtxPackActor = { userID: "user-other", workspaceID }
const target: CtxPackRecallTarget = { workspaceID, instanceID: "instance-1", functionalityID: "functionality-1" }
const budget = { maximumBytes: 32768, maximumEstimatedTokens: 6000 }

type AuthorizeInput = {
  readonly actor: CtxPackActor
  readonly operation: string
  readonly pack?: CtxPackInfo
  readonly target?: CtxPackRecallTarget
}
type Authorize = (input: AuthorizeInput) => Effect.Effect<void, CtxPackError>

const allow: Authorize = () => Effect.void

function source(overrides: Partial<CtxPackSource> = {}): CtxPackSource {
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

function packRequest(input: {
  readonly actor: CtxPackActor
  readonly title: string
  readonly text: string
  readonly idempotencyKey: string
  readonly sensitivity?: CtxPackSensitivity
  readonly keywords?: readonly string[]
}): CtxPackCreateRequest {
  const sensitivity = input.sensitivity ?? "workspace"
  return {
    workspaceID: input.actor.workspaceID,
    title: input.title,
    keywords: input.keywords ?? [],
    sensitivity,
    fragments: [
      { clientFragmentID: `client-${input.idempotencyKey}`, text: input.text, source: source({ sensitivity }) },
    ],
    idempotencyKey: input.idempotencyKey,
  }
}

function makeCatalog(runtime: Pick<Kernel, "runPromise">, authorize: Authorize = allow): Promise<CtxPackCatalog> {
  return runtime.runPromise(makeCtxPackCatalog({ authorize }))
}

function makeRecall(
  runtime: Pick<Kernel, "runPromise">,
  catalog: CtxPackCatalog,
  authorize: Authorize = allow,
): Promise<CtxPackRecall> {
  return runtime.runPromise(makeCtxPackRecall({ catalog, authorize }))
}

function createPack(
  runtime: Pick<Kernel, "runPromise">,
  catalog: CtxPackCatalog,
  actor: CtxPackActor,
  input: {
    readonly title: string
    readonly text: string
    readonly idempotencyKey: string
    readonly sensitivity?: CtxPackSensitivity
    readonly keywords?: readonly string[]
  },
): Promise<CtxPackInfo> {
  return runtime.runPromise(catalog.create(actor, packRequest({ actor, ...input })))
}

function selectRecall(
  runtime: Pick<Kernel, "runPromise">,
  recall: CtxPackRecall,
  input: {
    readonly actor?: CtxPackActor
    readonly target?: CtxPackRecallTarget
    readonly promptText: string
    readonly explicit?: readonly ContextSidecarAttachment[]
    readonly budget?: { readonly maximumBytes: number; readonly maximumEstimatedTokens: number }
  },
): Promise<CtxPackRecallResult> {
  return runtime.runPromise(
    recall.select({
      actor: input.actor ?? owner,
      target: input.target ?? target,
      promptText: input.promptText,
      explicit: input.explicit ?? [],
      budget: input.budget ?? budget,
    }),
  )
}

function explicitAttachment(index: number): ContextSidecarAttachment {
  return {
    selection: "explicit",
    contextCapsuleID: `capsule-${index}`,
    sourceCtxPackID: `ctxpk_explicit_${index}`,
    label: `Explicit ${index}`,
    contentHash: `hash-explicit-${index}`,
    fragments: [{ contentHash: `fragment-explicit-${index}`, text: `explicit body ${index}` }],
  }
}

describe("ctxpack recall", () => {
  test("selects a relevant workspace pack as an automatic attachment", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    const pack = await createPack(fixture.runtime, catalog, owner, {
      title: "Fox notes",
      text: "the quick brown fox jumps over the lazy dog",
      idempotencyKey: "select-basic",
    })

    const result = await selectRecall(fixture.runtime, recall, { promptText: "tell me about the fox" })

    expect(result.status).toBe("selected")
    expect(result.attachments).toHaveLength(1)
    const attachment = result.attachments[0]
    if (attachment === undefined) throw new Error("missing automatic attachment")
    expect(attachment.selection).toBe("automatic")
    expect(attachment.sourceCtxPackID).toBe(pack.id)
    expect(attachment.label).toBe("Fox notes")
    expect(attachment.contentHash).toBe(pack.contentHash)
    expect(attachment.fragments).toEqual(
      pack.fragments.map((fragment) => ({ contentHash: fragment.contentHash, text: fragment.text })),
    )
    expect("contextCapsuleID" in attachment).toBe(false)
    expect(JSON.stringify(attachment)).not.toContain("block-1")
  })

  test("a trivial turn skips recall without authorization or storage", async () => {
    await using fixture = await mediatedFixture()
    const state = { calls: 0 }
    const policy: Authorize = () => {
      state.calls++
      return Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    await createPack(fixture.runtime, catalog, owner, {
      title: "Fox",
      text: "fox material",
      idempotencyKey: "trivial",
    })
    const before = state.calls

    const result = await selectRecall(fixture.runtime, recall, { promptText: "Ｈｅｌｌｏ" })

    expect(result).toEqual({ attachments: [], status: "skipped-trivial" })
    expect(state.calls).toBe(before)
  })

  test("a stop-word-only prompt reports no-match without authorization", async () => {
    await using fixture = await mediatedFixture()
    const state = { calls: 0 }
    const policy: Authorize = () => {
      state.calls++
      return Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    await createPack(fixture.runtime, catalog, owner, {
      title: "Fox",
      text: "fox material",
      idempotencyKey: "stopwords",
    })
    const before = state.calls

    const result = await selectRecall(fixture.runtime, recall, { promptText: "the and of a to" })

    expect(result).toEqual({ attachments: [], status: "no-match" })
    expect(state.calls).toBe(before)
  })

  test("private packs are never surfaced to a non-creator", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    const pack = await createPack(fixture.runtime, catalog, owner, {
      title: "Private fox",
      text: "secret fox material",
      idempotencyKey: "private",
      sensitivity: "private",
    })

    const hidden = await selectRecall(fixture.runtime, recall, { actor: other, promptText: "secret fox" })
    expect(hidden).toEqual({ attachments: [], status: "no-match" })
    expect(JSON.stringify(hidden)).not.toContain(pack.id)
    expect(JSON.stringify(hidden)).not.toContain(pack.contentHash)

    const visible = await selectRecall(fixture.runtime, recall, { actor: owner, promptText: "secret fox" })
    expect(visible.status).toBe("selected")
    expect(visible.attachments[0]?.sourceCtxPackID).toBe(pack.id)
  })

  test("deleted packs are skipped", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    const pack = await createPack(fixture.runtime, catalog, owner, {
      title: "Doomed fox",
      text: "fox material",
      idempotencyKey: "deleted",
    })
    await fixture.runtime.runPromise(catalog.remove(owner, { ctxPackID: pack.id, expectedRevision: 1 }))

    const result = await selectRecall(fixture.runtime, recall, { promptText: "fox material" })
    expect(result).toEqual({ attachments: [], status: "no-match" })
  })

  test("a changed pack is skipped and later candidates still evaluate", async () => {
    await using fixture = await mediatedFixture()
    const database = await fixture.runtime.runPromise(
      Effect.gen(function* () {
        return yield* Database.Service
      }),
    )
    const holder = { firstID: "" }
    const state = { targetChecks: 0 }
    const policy: Authorize = (input) => {
      if (input.operation !== "chat.context.attach") return Effect.void
      state.targetChecks++
      if (state.targetChecks === 2)
        return database.db
          .run(sql`UPDATE cm_ctx_pack SET content_hash = 'sha256:tampered' WHERE id = ${holder.firstID}`)
          .pipe(Effect.orDie)
      return Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    const first = await createPack(fixture.runtime, catalog, owner, {
      title: "First fox",
      text: "fox fox fox",
      idempotencyKey: "changed-first",
    })
    const second = await createPack(fixture.runtime, catalog, owner, {
      title: "Second fox",
      text: "fox material",
      idempotencyKey: "changed-second",
    })
    holder.firstID = first.id

    const result = await selectRecall(fixture.runtime, recall, { promptText: "fox" })

    expect(result.status).toBe("selected")
    expect(result.attachments.map((attachment) => attachment.sourceCtxPackID)).toEqual([second.id])
  })

  test("an inaccessible pack is skipped and a later candidate is selected", async () => {
    await using fixture = await mediatedFixture()
    const denied = new Set<string>()
    const policy: Authorize = (input) => {
      if (input.operation === "ctxpack.read" && input.pack !== undefined && denied.has(input.pack.id))
        return Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.read" })
      return Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    const first = await createPack(fixture.runtime, catalog, owner, {
      title: "First fox",
      text: "fox fox fox",
      idempotencyKey: "denied-first",
    })
    const second = await createPack(fixture.runtime, catalog, owner, {
      title: "Second fox",
      text: "fox material",
      idempotencyKey: "denied-second",
    })
    denied.add(first.id)

    const result = await selectRecall(fixture.runtime, recall, { promptText: "fox" })

    expect(result.status).toBe("selected")
    expect(result.attachments.map((attachment) => attachment.sourceCtxPackID)).toEqual([second.id])
  })

  test("automatic selection is capped at four and is deterministic", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    for (let index = 0; index < 6; index++)
      await createPack(fixture.runtime, catalog, owner, {
        title: `Fox ${index}`,
        text: "fox material",
        idempotencyKey: `cap-${index}`,
      })

    const first = await selectRecall(fixture.runtime, recall, { promptText: "fox" })
    const second = await selectRecall(fixture.runtime, recall, { promptText: "fox" })

    expect(first.status).toBe("selected")
    expect(first.attachments).toHaveLength(4)
    expect(new Set(first.attachments.map((attachment) => attachment.sourceCtxPackID)).size).toBe(4)
    expect(second.attachments.map((attachment) => attachment.sourceCtxPackID)).toEqual(
      first.attachments.map((attachment) => attachment.sourceCtxPackID),
    )
  })

  test("search is capped at sixteen candidates before authorization", async () => {
    await using fixture = await mediatedFixture()
    const state = { reads: 0 }
    const policy: Authorize = (input) => {
      if (input.operation === "ctxpack.read" && input.pack !== undefined) {
        state.reads++
        return Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.read" })
      }
      return Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    for (let index = 0; index < 20; index++)
      await createPack(fixture.runtime, catalog, owner, {
        title: `Bulk fox ${index}`,
        text: "fox material",
        idempotencyKey: `bulk-${index}`,
      })

    const result = await selectRecall(fixture.runtime, recall, { promptText: "fox" })

    expect(result).toEqual({ attachments: [], status: "no-match" })
    expect(state.reads).toBe(16)
  })

  test("explicit attachments take priority and the combined cap is eight", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    for (let index = 0; index < 6; index++)
      await createPack(fixture.runtime, catalog, owner, {
        title: `Priority fox ${index}`,
        text: "fox material",
        idempotencyKey: `priority-${index}`,
      })

    const full = await selectRecall(fixture.runtime, recall, {
      promptText: "fox",
      explicit: Array.from({ length: 8 }, (_, index) => explicitAttachment(index)),
    })
    expect(full).toEqual({ attachments: [], status: "no-match" })

    const four = await selectRecall(fixture.runtime, recall, {
      promptText: "fox",
      explicit: [explicitAttachment(0), explicitAttachment(1)],
    })
    expect(four.attachments).toHaveLength(4)

    const two = await selectRecall(fixture.runtime, recall, {
      promptText: "fox",
      explicit: Array.from({ length: 6 }, (_, index) => explicitAttachment(index)),
    })
    expect(two.attachments).toHaveLength(2)
  })

  test("a candidate already attached explicitly is skipped by content hash", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    const pack = await createPack(fixture.runtime, catalog, owner, {
      title: "Duplicate fox",
      text: "fox material",
      idempotencyKey: "duplicate",
    })
    const explicit: ContextSidecarAttachment = {
      selection: "explicit",
      contextCapsuleID: "capsule-duplicate",
      sourceCtxPackID: pack.id,
      label: pack.title,
      contentHash: pack.contentHash,
      fragments: pack.fragments.map((fragment) => ({ contentHash: fragment.contentHash, text: fragment.text })),
    }

    const result = await selectRecall(fixture.runtime, recall, { promptText: "fox", explicit: [explicit] })
    expect(result).toEqual({ attachments: [], status: "no-match" })
  })

  test("an oversized first candidate does not discard a later smaller candidate", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    const hugeText = "fox ".repeat(4000)
    const huge = await fixture.runtime.runPromise(
      catalog.create(owner, {
        workspaceID: owner.workspaceID,
        title: "Huge fox",
        keywords: [],
        sensitivity: "workspace",
        fragments: [
          { clientFragmentID: "huge-1", text: hugeText, source: source() },
          { clientFragmentID: "huge-2", text: hugeText, source: source() },
          { clientFragmentID: "huge-3", text: hugeText, source: source() },
        ],
        idempotencyKey: "huge",
      }),
    )
    const small = await createPack(fixture.runtime, catalog, owner, {
      title: "Small fox",
      text: "fox material",
      idempotencyKey: "small",
    })

    const tight = await selectRecall(fixture.runtime, recall, { promptText: "fox" })
    expect(tight.status).toBe("selected")
    expect(tight.attachments.map((attachment) => attachment.sourceCtxPackID)).toEqual([small.id])

    const spacious = await selectRecall(fixture.runtime, recall, {
      promptText: "fox",
      budget: { maximumBytes: 1_000_000, maximumEstimatedTokens: 1_000_000 },
    })
    expect(spacious.attachments.some((attachment) => attachment.sourceCtxPackID === huge.id)).toBe(true)
  })

  test("a target workspace mismatch fails closed before authorization", async () => {
    await using fixture = await mediatedFixture()
    const state = { calls: 0 }
    const policy: Authorize = () => {
      state.calls++
      return Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    await createPack(fixture.runtime, catalog, owner, {
      title: "Fox",
      text: "fox material",
      idempotencyKey: "mismatch",
    })
    const before = state.calls

    const result = await selectRecall(fixture.runtime, recall, {
      promptText: "fox",
      target: { ...target, workspaceID: "workspace-elsewhere" },
    })

    expect(result).toEqual({ attachments: [], status: "unavailable" })
    expect(state.calls).toBe(before)
  })

  test("a broken search index fails closed without leaking pack text", async () => {
    await using fixture = await mediatedFixture()
    const catalog = await makeCatalog(fixture.runtime)
    const recall = await makeRecall(fixture.runtime, catalog)
    const pack = await createPack(fixture.runtime, catalog, owner, {
      title: "Secret fox",
      text: "secret fox material",
      idempotencyKey: "broken-index",
    })
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(sql`DROP TABLE cm_ctx_pack_fts`)
      }),
    )

    const result = await selectRecall(fixture.runtime, recall, { promptText: "secret fox" })

    expect(result).toEqual({ attachments: [], status: "unavailable" })
    expect(JSON.stringify(result)).not.toContain(pack.id)
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("an interrupted candidate propagates and stops later evaluation", async () => {
    await using fixture = await mediatedFixture()
    const state = { targetChecks: 0 }
    const policy: Authorize = (input) => {
      if (input.operation !== "chat.context.attach") return Effect.void
      state.targetChecks++
      return state.targetChecks === 3 ? Effect.interrupt : Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    for (let index = 0; index < 3; index++)
      await createPack(fixture.runtime, catalog, owner, {
        title: `Interrupt fox ${index}`,
        text: "fox material",
        idempotencyKey: `interrupt-${index}`,
      })

    const outcome = await fixture.runtime.runPromise(
      recall.select({ actor: owner, target, promptText: "fox", explicit: [], budget }).pipe(
        Effect.map(() => "success" as const),
        Effect.catchCause((cause) =>
          Effect.succeed(Cause.hasInterrupts(cause) ? ("interrupted" as const) : ("other" as const)),
        ),
      ),
    )

    expect(outcome).toBe("interrupted")
    expect(state.targetChecks).toBe(3)
  })

  test("target permission revoked before return yields unavailable", async () => {
    await using fixture = await mediatedFixture()
    const state = { targetChecks: 0 }
    const policy: Authorize = (input) => {
      if (input.operation !== "chat.context.attach") return Effect.void
      state.targetChecks++
      return state.targetChecks >= 3
        ? Effect.fail<CtxPackError>({ _tag: "CtxPackPermissionDenied", operation: "chat.context.attach" })
        : Effect.void
    }
    const catalog = await makeCatalog(fixture.runtime, policy)
    const recall = await makeRecall(fixture.runtime, catalog, policy)
    await createPack(fixture.runtime, catalog, owner, {
      title: "Revoked fox",
      text: "fox material",
      idempotencyKey: "revoked",
    })

    const result = await selectRecall(fixture.runtime, recall, { promptText: "fox" })

    expect(result).toEqual({ attachments: [], status: "unavailable" })
    expect(state.targetChecks).toBe(3)
  })
})
