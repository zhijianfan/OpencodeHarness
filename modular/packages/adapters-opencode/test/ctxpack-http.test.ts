import { describe, expect, test } from "bun:test"
import type {
  CtxPackActor,
  CtxPackCreateRequest,
  CtxPackListRequest,
  CtxPackSource,
} from "@cybermastery/contracts/ctxpack"
import {
  DefaultInteractiveContextBudget,
  type CtxPackMaterializeError,
} from "@cybermastery/contracts/ctxpack-capsule"
import { Effect } from "effect"
import { makeCtxPackCatalog, type CtxPackCatalog } from "../src/ctxpack-catalog"
import { makeCtxPackCapsuleStore, type CtxPackCapsuleStore } from "../src/ctxpack-capsule"
import { createCtxPackHttp } from "../src/ctxpack-http"
import {
  makeCtxPackMaterializer,
  type CtxPackAuthorizeInput,
  type CtxPackMaterializer,
} from "../src/ctxpack-materializer"
import { createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()
type Fixture = Awaited<ReturnType<ReturnType<typeof createMediatedFixtures>>>

const SENTINEL = "CTXPACK_HTTP_SECRET_SENTINEL_5501"

const owner: CtxPackActor = { userID: "user-owner", workspaceID: "workspace-1" }
const other: CtxPackActor = { userID: "user-other", workspaceID: "workspace-1" }

const OWNER_TOKEN = "Bearer owner-token"
const OTHER_TOKEN = "Bearer other-token"

// Function auth actor port: no fake store, only the trusted callback.
const authenticate = (request: Request): Promise<CtxPackActor | undefined> => {
  const header = request.headers.get("authorization")
  if (header === OWNER_TOKEN) return Promise.resolve(owner)
  if (header === OTHER_TOKEN) return Promise.resolve(other)
  return Promise.resolve(undefined)
}

const ROOMY_BUDGET = {
  ...DefaultInteractiveContextBudget,
  maximumBytes: 1_000_000_000,
  maximumEstimatedTokens: 1_000_000_000,
}

interface OpenOptions {
  readonly authorize?: (input: CtxPackAuthorizeInput) => Effect.Effect<void, CtxPackMaterializeError>
  readonly now?: () => number
}

interface Harness {
  readonly fixture: Fixture
  readonly http: ReturnType<typeof createCtxPackHttp>
  readonly catalog: CtxPackCatalog
  readonly capsules: CtxPackCapsuleStore
  readonly materializer: CtxPackMaterializer
}

async function openHarness(fixture: Fixture, options: OpenOptions = {}): Promise<Harness> {
  const catalog = await fixture.runtime.runPromise(makeCtxPackCatalog({ authorize: () => Effect.void }))
  const capsules = await fixture.runtime.runPromise(makeCtxPackCapsuleStore())
  const materializer = makeCtxPackMaterializer({
    catalog,
    capsules,
    authorize: options.authorize ?? (() => Effect.void),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const http = createCtxPackHttp({
    catalog,
    materializer,
    authenticate,
    run: (effect) => fixture.runtime.runPromise(effect),
  })
  return { fixture, http, catalog, capsules, materializer }
}

async function withHttp<A>(options: OpenOptions, f: (harness: Harness) => Promise<A>): Promise<A> {
  const fixture = await mediatedFixture()
  try {
    return await f(await openHarness(fixture, options))
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
}

type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown }

async function outcome<A>(harness: Harness, effect: Effect.Effect<A, unknown>): Promise<Outcome<A>> {
  try {
    return { ok: true, value: await harness.fixture.runtime.runPromise(effect) }
  } catch (error) {
    return { ok: false, error }
  }
}

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

function createBody(overrides: Partial<CtxPackCreateRequest> = {}): CtxPackCreateRequest {
  const defaults: CtxPackCreateRequest = {
    workspaceID: "workspace-1",
    title: "HTTP pack",
    keywords: ["alpha"],
    tags: ["ParallelPlan"],
    sensitivity: "workspace",
    fragments: [{ clientFragmentID: "client-1", text: "hello world", source: source() }],
    idempotencyKey: "http-idem-1",
  }
  return Object.assign(defaults, overrides)
}

function listBody(overrides: Partial<CtxPackListRequest> = {}): CtxPackListRequest {
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
  return Object.assign(defaults, overrides)
}

interface RequestOptions {
  readonly actor?: string
  readonly body?: unknown
  readonly rawBody?: string
  readonly contentType?: string | null
  readonly query?: string
}

function httpRequest(method: string, path: string, options: RequestOptions = {}): Request {
  const headers = new Headers()
  if (options.actor !== undefined) headers.set("authorization", options.actor)
  const hasBody = options.body !== undefined || options.rawBody !== undefined
  const contentType = options.contentType === undefined ? "application/json" : options.contentType
  if (hasBody && contentType !== null) headers.set("content-type", contentType)
  const body =
    options.rawBody !== undefined ? options.rawBody : options.body !== undefined ? JSON.stringify(options.body) : undefined
  return new Request(`http://localhost/api/cybermastery/ctxpack${path}${options.query ?? ""}`, {
    method,
    headers,
    body,
  })
}

function requireResponse(response: Response | undefined): Response {
  if (response === undefined) throw new Error("Expected an owned response")
  return response
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object")
  return value as Record<string, unknown>
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array")
  return value
}

async function createPack(harness: Harness, overrides: Partial<CtxPackCreateRequest> = {}): Promise<Record<string, unknown>> {
  const response = requireResponse(
    await harness.http.fetch(httpRequest("POST", "/", { actor: OWNER_TOKEN, body: createBody(overrides) })),
  )
  if (response.status !== 200) throw new Error(`Expected create 200, received ${response.status}`)
  return record(await response.json())
}

describe("ctxpack http — ownership and routing", () => {
  test("owns only the exact ctxpack prefix and never falls through", async () => {
    await withHttp({}, async (harness) => {
      expect(await harness.http.fetch(new Request("http://localhost/api/session"))).toBeUndefined()
      expect(await harness.http.fetch(new Request("http://localhost/api/cybermastery/session"))).toBeUndefined()

      const unknown = requireResponse(
        await harness.http.fetch(new Request("http://localhost/api/cybermastery/ctxpack/unknown/route")),
      )
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get("cache-control")).toBe("no-store")

      const badId = requireResponse(
        await harness.http.fetch(new Request("http://localhost/api/cybermastery/ctxpack/not-an-id")),
      )
      expect(badId.status).toBe(404)
    })
  })

  test("rejects unsupported methods with the actual supported verb", async () => {
    await withHttp({}, async (harness) => {
      const root = requireResponse(await harness.http.fetch(httpRequest("GET", "/")))
      expect(root.status).toBe(405)
      expect(root.headers.get("allow")).toBe("POST")

      const list = requireResponse(await harness.http.fetch(httpRequest("GET", "/list")))
      expect(list.status).toBe(405)
      expect(list.headers.get("allow")).toBe("POST")

      const item = requireResponse(await harness.http.fetch(httpRequest("POST", "/ctxpk_missing", { body: {} })))
      expect(item.status).toBe(405)
      expect(item.headers.get("allow")).toBe("GET, PATCH, DELETE")
    })
  })

  test("requires the authorization header before reading the body", async () => {
    await withHttp({}, async (harness) => {
      const missing = httpRequest("POST", "/", { body: createBody() })
      const missingResponse = requireResponse(await harness.http.fetch(missing))
      expect(missingResponse.status).toBe(401)
      expect(missing.bodyUsed).toBe(false)

      const queryOnly = httpRequest("POST", "/", { body: createBody(), query: "?auth_token=owner-token" })
      const queryResponse = requireResponse(await harness.http.fetch(queryOnly))
      expect(queryResponse.status).toBe(401)
      expect(queryOnly.bodyUsed).toBe(false)

      const badToken = httpRequest("POST", "/", { actor: "Bearer nope", body: createBody() })
      const badResponse = requireResponse(await harness.http.fetch(badToken))
      expect(badResponse.status).toBe(401)
      expect(badToken.bodyUsed).toBe(false)
    })
  })
})

describe("ctxpack http — pack lifecycle", () => {
  test("creates, reads, and lists packs with preserved provenance", async () => {
    await withHttp({}, async (harness) => {
      const created = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", "/", {
            actor: OWNER_TOKEN,
            body: createBody({
              title: "Niagara pump findings",
              tags: ["ParallelPlan"],
              fragments: [
                { clientFragmentID: "f1", text: "first body", source: source({ blockID: "block-a" }) },
                { clientFragmentID: "f2", text: "second body", source: source({ blockID: "block-b", label: "Second" }) },
              ],
            }),
          }),
        ),
      )
      expect(created.status).toBe(200)
      const info = record(await created.json())
      const id = String(info.id)
      expect(id.startsWith("ctxpk_")).toBe(true)
      expect(info.title).toBe("Niagara pump findings")
      expect(info.tags).toEqual(["ParallelPlan"])
      expect(info.revision).toBe(1)

      const fragments = array(info.fragments)
      expect(fragments.map((fragment) => record(fragment).text)).toEqual(["first body", "second body"])
      expect(record(fragments[0]).source).toMatchObject({
        workspaceID: "workspace-1",
        blockID: "block-a",
        kind: "message",
        direction: "sent",
      })
      expect(record(fragments[1]).source).toMatchObject({ blockID: "block-b", label: "Second" })

      const got = requireResponse(await harness.http.fetch(httpRequest("GET", `/${id}`, { actor: OWNER_TOKEN })))
      expect(got.status).toBe(200)
      const reloaded = record(await got.json())
      expect(reloaded.id).toBe(id)
      expect(reloaded.fragments).toEqual(info.fragments)

      const listed = requireResponse(
        await harness.http.fetch(httpRequest("POST", "/list", { actor: OWNER_TOKEN, body: listBody() })),
      )
      expect(listed.status).toBe(200)
      const result = record(await listed.json())
      const items = array(result.items)
      expect(items).toHaveLength(1)
      expect(record(items[0]).fragments).toBeUndefined()
      expect(record(items[0]).fragmentCount).toBe(2)
      expect(result.totalEstimate).toBe(1)
    })
  })

  test("create is idempotent for the same key", async () => {
    await withHttp({}, async (harness) => {
      const first = await createPack(harness, { idempotencyKey: "same" })
      const second = await createPack(harness, { idempotencyKey: "same", title: "Different" })
      expect(second.id).toBe(first.id)
      expect(second.title).toBe(first.title)
    })
  })

  test("patch enforces path identity, workspace, and revision", async () => {
    await withHttp({}, async (harness) => {
      const info = await createPack(harness)
      const id = String(info.id)

      const patched = requireResponse(
        await harness.http.fetch(
          httpRequest("PATCH", `/${id}`, {
            actor: OWNER_TOKEN,
            body: {
              workspaceID: "workspace-1",
              ctxPackID: id,
              expectedRevision: 1,
              patch: { title: "Renamed" },
              idempotencyKey: "p1",
            },
          }),
        ),
      )
      expect(patched.status).toBe(200)
      const patchedBody = record(await patched.json())
      expect(patchedBody.title).toBe("Renamed")
      expect(patchedBody.revision).toBe(2)

      const stale = requireResponse(
        await harness.http.fetch(
          httpRequest("PATCH", `/${id}`, {
            actor: OWNER_TOKEN,
            body: {
              workspaceID: "workspace-1",
              ctxPackID: id,
              expectedRevision: 1,
              patch: { title: "Stale" },
              idempotencyKey: "p2",
            },
          }),
        ),
      )
      expect(stale.status).toBe(409)
      expect(record(await stale.json()).currentRevision).toBe(2)

      const wrongPath = requireResponse(
        await harness.http.fetch(
          httpRequest("PATCH", `/${id}`, {
            actor: OWNER_TOKEN,
            body: {
              workspaceID: "workspace-1",
              ctxPackID: "ctxpk_other",
              expectedRevision: 2,
              patch: {},
              idempotencyKey: "p3",
            },
          }),
        ),
      )
      expect(wrongPath.status).toBe(400)

      const wrongWorkspace = requireResponse(
        await harness.http.fetch(
          httpRequest("PATCH", `/${id}`, {
            actor: OWNER_TOKEN,
            body: {
              workspaceID: "workspace-2",
              ctxPackID: id,
              expectedRevision: 2,
              patch: {},
              idempotencyKey: "p4",
            },
          }),
        ),
      )
      expect(wrongWorkspace.status).toBe(403)
    })
  })

  test("pin strips fragment bodies, unpin is empty, remove and restore round-trip", async () => {
    await withHttp({}, async (harness) => {
      const info = await createPack(harness)
      const id = String(info.id)

      const pinned = requireResponse(
        await harness.http.fetch(httpRequest("POST", `/${id}/pin`, { actor: OWNER_TOKEN, body: {} })),
      )
      expect(pinned.status).toBe(200)
      const pinnedBody = record(await pinned.json())
      expect(pinnedBody.fragments).toBeUndefined()
      expect(pinnedBody.fragmentCount).toBe(1)
      expect(pinnedBody.sourceKinds).toEqual(["message"])
      expect(pinnedBody.createdByUserID).toBeUndefined()
      expect(pinnedBody.pinnedAt).not.toBeNull()

      const badPin = requireResponse(
        await harness.http.fetch(httpRequest("POST", `/${id}/pin`, { actor: OWNER_TOKEN, body: { extra: true } })),
      )
      expect(badPin.status).toBe(400)

      const unpinned = requireResponse(
        await harness.http.fetch(httpRequest("POST", `/${id}/unpin`, { actor: OWNER_TOKEN, body: {} })),
      )
      expect(unpinned.status).toBe(204)
      expect(await unpinned.text()).toBe("")

      const removed = requireResponse(
        await harness.http.fetch(
          httpRequest("DELETE", `/${id}`, { actor: OWNER_TOKEN, body: { expectedRevision: 1 } }),
        ),
      )
      expect(removed.status).toBe(200)
      expect(record(await removed.json()).deletedAt).not.toBeNull()

      const gone = requireResponse(await harness.http.fetch(httpRequest("GET", `/${id}`, { actor: OWNER_TOKEN })))
      expect(gone.status).toBe(410)

      const included = requireResponse(
        await harness.http.fetch(httpRequest("GET", `/${id}`, { actor: OWNER_TOKEN, query: "?includeDeleted=true" })),
      )
      expect(included.status).toBe(200)

      const restored = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", `/${id}/restore`, { actor: OWNER_TOKEN, body: { expectedRevision: 1 } }),
        ),
      )
      expect(restored.status).toBe(200)
      expect(record(await restored.json()).deletedAt).toBeNull()
    })
  })
})

describe("ctxpack http — materialize", () => {
  test("returns the frozen reference and rejects a client capsule", async () => {
    await withHttp({}, async (harness) => {
      const info = await createPack(harness)
      const id = String(info.id)
      const hash = String(info.contentHash)

      const materialized = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", `/${id}/materialize`, {
            actor: OWNER_TOKEN,
            body: { expectedContentHash: hash, targetInstanceID: "inst-1", targetFunctionalityID: "builtin:chat" },
          }),
        ),
      )
      expect(materialized.status).toBe(200)
      const result = record(await materialized.json())
      expect(String(result.contextCapsuleID).startsWith("ctxkpsl_")).toBe(true)
      expect(result.sourceCtxPackID).toBe(id)
      expect(result.label).toBe(info.title)
      expect(result.contentHash).toBe(hash)
      expect(typeof result.estimatedTokens).toBe("number")
      expect(result.fragments).toBeUndefined()

      const forged = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", `/${id}/materialize`, {
            actor: OWNER_TOKEN,
            body: {
              expectedContentHash: hash,
              targetInstanceID: "inst-1",
              targetFunctionalityID: "builtin:chat",
              contextCapsuleID: "ctxkpsl_forged",
            },
          }),
        ),
      )
      expect(forged.status).toBe(400)

      const stale = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", `/${id}/materialize`, {
            actor: OWNER_TOKEN,
            body: { expectedContentHash: "sha256:stale", targetInstanceID: "inst-1", targetFunctionalityID: "builtin:chat" },
          }),
        ),
      )
      expect(stale.status).toBe(409)
      expect(record(await stale.json()).currentContentHash).toBe(hash)
    })
  })

  test("a denied materialize capability maps to a sanitized 403", async () => {
    await withHttp(
      {
        authorize: (authInput) =>
          authInput.operation === "ctxpack.materialize"
            ? Effect.fail({
                _tag: "CtxPackCapabilityDenied",
                operation: "ctxpack.materialize",
              } satisfies CtxPackMaterializeError)
            : Effect.void,
      },
      async (harness) => {
        const info = await createPack(harness)
        const denied = requireResponse(
          await harness.http.fetch(
            httpRequest("POST", `/${String(info.id)}/materialize`, {
              actor: OWNER_TOKEN,
              body: {
                expectedContentHash: String(info.contentHash),
                targetInstanceID: "inst-1",
                targetFunctionalityID: "builtin:chat",
              },
            }),
          ),
        )
        expect(denied.status).toBe(403)
      },
    )
  })

  test("borrowed materializer reports target mismatch and an expired capsule", async () => {
    const fixture = await mediatedFixture()
    try {
      const harness = await openHarness(fixture, { now: () => 10_000 })
      const info = await createPack(harness)
      const id = String(info.id)
      const hash = String(info.contentHash)

      const mismatched = await fixture.runtime.runPromise(
        harness.capsules.store({
          id: "",
          version: 1,
          workspaceId: owner.workspaceID,
          createdBy: { userId: owner.userID, instanceId: "inst-other" },
          purpose: "ctxpack-attachment",
          audience: ["builtin:chat"],
          summary: "mismatch",
          facts: [],
          references: [],
          artifactRefs: [],
          recentEvents: [],
          budget: DefaultInteractiveContextBudget,
          contentHash: hash,
          createdAt: 1_000,
          expiresAt: undefined,
        }),
      )
      const mismatch = await outcome(
        harness,
        harness.materializer.snapshotForSessionInput({
          actor: owner,
          targetInstanceID: "inst-1",
          targetFunctionalityID: "builtin:chat",
          attachments: [
            {
              contextCapsuleID: mismatched.id,
              label: "mismatch",
              contentHash: hash,
              source: { kind: "ctxpack", ctxPackID: id },
            },
          ],
          budget: ROOMY_BUDGET,
        }),
      )
      expect(mismatch.ok).toBe(false)
      if (!mismatch.ok) {
        expect(mismatch.error).toMatchObject({ _tag: "CtxPackCapsuleTargetMismatch", target: "instance" })
      }

      const expired = await fixture.runtime.runPromise(
        harness.capsules.store({
          id: "",
          version: 1,
          workspaceId: owner.workspaceID,
          createdBy: { userId: owner.userID, instanceId: "inst-1" },
          purpose: "ctxpack-attachment",
          audience: ["builtin:chat"],
          summary: "expired",
          facts: [],
          references: [],
          artifactRefs: [],
          recentEvents: [],
          budget: DefaultInteractiveContextBudget,
          contentHash: hash,
          createdAt: 1_000,
          expiresAt: 5_000,
        }),
      )
      const expiredResult = await outcome(
        harness,
        harness.materializer.snapshotForSessionInput({
          actor: owner,
          targetInstanceID: "inst-1",
          targetFunctionalityID: "builtin:chat",
          attachments: [
            {
              contextCapsuleID: expired.id,
              label: "expired",
              contentHash: hash,
              source: { kind: "ctxpack", ctxPackID: id },
            },
          ],
          budget: ROOMY_BUDGET,
        }),
      )
      expect(expiredResult.ok).toBe(false)
      if (!expiredResult.ok) {
        expect(expiredResult.error).toMatchObject({ _tag: "CtxPackCapsuleExpired", expiresAt: 5_000 })
      }
    } finally {
      await fixture[Symbol.asyncDispose]()
    }
  })
})

describe("ctxpack http — privacy and strictness", () => {
  test("private packs are hidden from another actor in list, count, and get", async () => {
    await withHttp({}, async (harness) => {
      const privateInfo = await createPack(harness, {
        sensitivity: "private",
        idempotencyKey: "private",
        fragments: [
          { clientFragmentID: "p", text: "private body", source: source({ sensitivity: "private" }) },
        ],
      })
      await createPack(harness, { idempotencyKey: "shared", title: "Shared" })

      const otherList = requireResponse(
        await harness.http.fetch(httpRequest("POST", "/list", { actor: OTHER_TOKEN, body: listBody() })),
      )
      expect(otherList.status).toBe(200)
      const result = record(await otherList.json())
      expect(array(result.items)).toHaveLength(1)
      expect(result.totalEstimate).toBe(1)

      const denied = requireResponse(
        await harness.http.fetch(httpRequest("GET", `/${String(privateInfo.id)}`, { actor: OTHER_TOKEN })),
      )
      expect(denied.status).toBe(403)
    })
  })

  test("error bodies never contain private fragment text", async () => {
    await withHttp({}, async (harness) => {
      const info = await createPack(harness, {
        idempotencyKey: "sentinel",
        sensitivity: "private",
        fragments: [
          { clientFragmentID: "s", text: `Secret ${SENTINEL} body`, source: source({ sensitivity: "private" }) },
        ],
      })
      const id = String(info.id)

      const stale = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", `/${id}/materialize`, {
            actor: OWNER_TOKEN,
            body: { expectedContentHash: "sha256:stale", targetInstanceID: "inst-1", targetFunctionalityID: "builtin:chat" },
          }),
        ),
      )
      expect(stale.status).toBe(409)
      expect(await stale.text()).not.toContain(SENTINEL)

      const conflict = requireResponse(
        await harness.http.fetch(
          httpRequest("PATCH", `/${id}`, {
            actor: OWNER_TOKEN,
            body: {
              workspaceID: "workspace-1",
              ctxPackID: id,
              expectedRevision: 99,
              patch: { title: "x" },
              idempotencyKey: "c",
            },
          }),
        ),
      )
      expect(conflict.status).toBe(409)
      expect(await conflict.text()).not.toContain(SENTINEL)

      const denied = requireResponse(
        await harness.http.fetch(httpRequest("GET", `/${id}`, { actor: OTHER_TOKEN })),
      )
      expect(denied.status).toBe(403)
      expect(await denied.text()).not.toContain(SENTINEL)

      const materialized = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", `/${id}/materialize`, {
            actor: OWNER_TOKEN,
            body: {
              expectedContentHash: String(info.contentHash),
              targetInstanceID: "inst-1",
              targetFunctionalityID: "builtin:chat",
            },
          }),
        ),
      )
      expect(materialized.status).toBe(200)
      expect(await materialized.text()).not.toContain(SENTINEL)
    })
  })

  test("rejects malicious fields, oversize bodies, wrong mime, and malformed JSON", async () => {
    await withHttp({}, async (harness) => {
      const extra = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", "/", { actor: OWNER_TOKEN, body: { ...createBody(), malicious: true } }),
        ),
      )
      expect(extra.status).toBe(400)

      const listExtra = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", "/list", { actor: OWNER_TOKEN, body: { ...listBody(), extra: 1 } }),
        ),
      )
      expect(listExtra.status).toBe(400)

      const oversize = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", "/", { actor: OWNER_TOKEN, rawBody: "x".repeat(1024 * 1024 + 1) }),
        ),
      )
      expect(oversize.status).toBe(413)

      const mime = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", "/", { actor: OWNER_TOKEN, body: createBody(), contentType: "text/plain" }),
        ),
      )
      expect(mime.status).toBe(415)

      const malformed = requireResponse(
        await harness.http.fetch(httpRequest("POST", "/", { actor: OWNER_TOKEN, rawBody: "{" })),
      )
      expect(malformed.status).toBe(400)

      const wrongWorkspace = requireResponse(
        await harness.http.fetch(
          httpRequest("POST", "/", {
            actor: OWNER_TOKEN,
            body: createBody({
              workspaceID: "workspace-2",
              fragments: [
                { clientFragmentID: "w2", text: "other workspace", source: source({ workspaceID: "workspace-2" }) },
              ],
            }),
          }),
        ),
      )
      expect(wrongWorkspace.status).toBe(403)
    })
  })
})
