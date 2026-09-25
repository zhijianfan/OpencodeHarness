import { describe, expect, test } from "bun:test"
import type {
  CtxPackCreateRequest,
  CtxPackListRequest,
  CtxPackPatchRequest,
  CtxPackSource,
} from "@cybermastery/contracts/ctxpack"
import { CtxPackClientError, createCtxPackClient } from "./ctxpack"

type Recorded = {
  readonly method: string
  readonly pathname: string
  readonly search: string
  readonly headers: Headers
  readonly body: string
}

type CapturedInit = {
  readonly url: string
  readonly init: RequestInit
}

describe("ctxpack client", () => {
  test("create posts the request to the root with auth, json content type and no-store", async () => {
    const request = createRequest()
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client, captures } = makeClient(baseUrl)

      const result = await client.create(request)

      expect(result.id).toBe("ctxpk_1")
      expect(result.fragments.length).toBe(1)
      const recorded = first(requests)
      expect(recorded.method).toBe("POST")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/")
      expect(recorded.headers.get("authorization")).toBe("Bearer secret-token")
      expect(recorded.headers.get("content-type")).toBe("application/json")
      expect(new URLSearchParams(recorded.search).has("token")).toBe(false)
      expect(parseBody(recorded.body)).toEqual(request)
      const init = first(captures).init
      expect(init.cache).toBe("no-store")
      expect(init.redirect).toBe("manual")
    })
  })

  test("get sends GET with includeDeleted and omits it by default", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const result = await client.get("ctxpk_1", true)
      expect(result.id).toBe("ctxpk_1")
      const included = first(requests)
      expect(included.method).toBe("GET")
      expect(included.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1")
      expect(new URLSearchParams(included.search).get("includeDeleted")).toBe("true")

      await client.get("ctxpk_1")
      expect(requests.length).toBe(2)
      expect(requests[1]?.search).toBe("")
    })
  })

  test("get percent-encodes the pack id in the path", async () => {
    await withServer(() => json(infoBody({ id: "ctxpk_a b" })), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const result = await client.get("ctxpk_a b")

      expect(result.id).toBe("ctxpk_a b")
      expect(first(requests).pathname).toBe("/api/cybermastery/ctxpack/ctxpk_a%20b")
    })
  })

  test("list posts filters to the list route and validates summaries", async () => {
    const request = listRequest()
    await withServer(
      () => json({ items: [summaryBody()], nextCursor: null, totalEstimate: 1 }),
      async (baseUrl, requests) => {
        const { client } = makeClient(baseUrl)

        const result = await client.list(request)

        expect(result.items.length).toBe(1)
        expect(result.items[0]?.fragmentCount).toBe(1)
        expect(result.nextCursor).toBeNull()
        expect(result.totalEstimate).toBe(1)
        const recorded = first(requests)
        expect(recorded.method).toBe("POST")
        expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/list")
        expect(parseBody(recorded.body)).toEqual(request)
      },
    )
  })

  test("patch sends PATCH with the body and validates the updated info", async () => {
    const request = patchRequest()
    await withServer(() => json(infoBody({ revision: 2 })), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const result = await client.patch(request)

      expect(result.revision).toBe(2)
      const recorded = first(requests)
      expect(recorded.method).toBe("PATCH")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1")
      expect(parseBody(recorded.body)).toEqual(request)
    })
  })

  test("remove sends DELETE with expectedRevision", async () => {
    await withServer(() => json(infoBody({ deletedAt: 5 })), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const result = await client.remove("ctxpk_1", 2)

      expect(result.deletedAt).toBe(5)
      const recorded = first(requests)
      expect(recorded.method).toBe("DELETE")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1")
      expect(parseBody(recorded.body)).toEqual({ expectedRevision: 2 })
    })
  })

  test("restore posts expectedRevision to the restore route", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      await client.restore("ctxpk_1", 3)

      const recorded = first(requests)
      expect(recorded.method).toBe("POST")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1/restore")
      expect(parseBody(recorded.body)).toEqual({ expectedRevision: 3 })
    })
  })

  test("pin posts an empty body and strips fragments from a full info response", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const result = await client.pin("ctxpk_1")

      expect(result.fragmentCount).toBe(1)
      expect(result.sourceBlockIDs).toEqual(["block-1"])
      expect(result.sourceKinds).toEqual(["message"])
      expect("fragments" in result).toBe(false)
      const recorded = first(requests)
      expect(recorded.method).toBe("POST")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1/pin")
      expect(parseBody(recorded.body)).toEqual({})
      expect(recorded.headers.get("content-type")).toBe("application/json")
    })
  })

  test("pin accepts an already-summarized response", async () => {
    await withServer(() => json(summaryBody()), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const result = await client.pin("ctxpk_1")

      expect(result.id).toBe("ctxpk_1")
      expect(result.fragmentCount).toBe(1)
      expect("fragments" in result).toBe(false)
    })
  })

  test("unpin posts an empty body and accepts a 204 with no content", async () => {
    await withServer(() => new Response(null, { status: 204 }), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      await client.unpin("ctxpk_1")

      const recorded = first(requests)
      expect(recorded.method).toBe("POST")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1/unpin")
      expect(parseBody(recorded.body)).toEqual({})
    })
  })

  test("unpin rejects a response that is not 204", async () => {
    await withServer(() => json({ ok: true }, 200), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.unpin("ctxpk_1"))

      expect(error.code).toBe("invalid_response")
    })
  })

  test("materialize posts only the selection and validates the capsule result", async () => {
    const body = {
      contextCapsuleID: "cap-1",
      sourceCtxPackID: "ctxpk_1",
      label: "Pack",
      contentHash: "hash-1",
      estimatedTokens: 3,
    }
    await withServer(() => json(body), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const result = await client.materialize("ctxpk_1", {
        expectedContentHash: "hash-1",
        targetInstanceID: "inst-1",
        targetFunctionalityID: "fn-1",
      })

      expect(result.contextCapsuleID).toBe("cap-1")
      expect(result.sourceCtxPackID).toBe("ctxpk_1")
      const recorded = first(requests)
      expect(recorded.method).toBe("POST")
      expect(recorded.pathname).toBe("/api/cybermastery/ctxpack/ctxpk_1/materialize")
      expect(parseBody(recorded.body)).toEqual({
        expectedContentHash: "hash-1",
        targetInstanceID: "inst-1",
        targetFunctionalityID: "fn-1",
      })
    })
  })

  test("materialize rejects a result that names another pack", async () => {
    const body = {
      contextCapsuleID: "cap-1",
      sourceCtxPackID: "ctxpk_other",
      label: "Pack",
      contentHash: "hash-1",
      estimatedTokens: 3,
    }
    await withServer(() => json(body), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() =>
        client.materialize("ctxpk_1", {
          expectedContentHash: "hash-1",
          targetInstanceID: "inst-1",
          targetFunctionalityID: "fn-1",
        }),
      )

      expect(error.code).toBe("invalid_response")
    })
  })

  test("materialize surfaces an expired capsule error by code", async () => {
    await withServer(() => json({ code: "expired" }, 410), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() =>
        client.materialize("ctxpk_1", {
          expectedContentHash: "hash-1",
          targetInstanceID: "inst-1",
          targetFunctionalityID: "fn-1",
        }),
      )

      expect(error.status).toBe(410)
      expect(error.code).toBe("expired")
    })
  })

  test("maps a revision conflict with its current revision and no raw message", async () => {
    const secret = "PRIVATE_FRAGMENT_TEXT"
    await withServer(() => json({ code: "revision-conflict", message: secret, currentRevision: 7 }, 409), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.remove("ctxpk_1", 6))

      expect(error.status).toBe(409)
      expect(error.code).toBe("revision-conflict")
      expect(error.currentRevision).toBe(7)
      expect(error.message).toBe("revision-conflict")
      expect(error.message).not.toContain(secret)
    })
  })

  test("maps a content changed conflict with its current hash", async () => {
    await withServer(() => json({ code: "content-changed", currentContentHash: "hash-2" }, 409), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() =>
        client.materialize("ctxpk_1", {
          expectedContentHash: "hash-1",
          targetInstanceID: "inst-1",
          targetFunctionalityID: "fn-1",
        }),
      )

      expect(error.code).toBe("content-changed")
      expect(error.currentContentHash).toBe("hash-2")
    })
  })

  test("falls back to a status code when the error body is not JSON", async () => {
    await withServer(() => new Response("SECRET_FRAGMENT_BODY", { status: 404 }), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("ctxpk_1"))

      expect(error.status).toBe(404)
      expect(error.code).toBe("not-found")
      expect(error.message).not.toContain("SECRET_FRAGMENT_BODY")
    })
  })

  test("falls back when the error discriminator is unknown", async () => {
    await withServer(() => json({ code: "made-up", message: "PRIVATE" }, 400), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("ctxpk_1"))

      expect(error.code).toBe("invalid")
      expect(error.message).not.toContain("PRIVATE")
    })
  })

  test("rejects redirects without following them", async () => {
    await withServer(
      () => new Response(null, { status: 302, headers: { location: "http://example.com/steal" } }),
      async (baseUrl, requests) => {
        const { client } = makeClient(baseUrl)

        const error = await expectClientError(() => client.get("ctxpk_1"))

        expect(error.code).toBe("redirect")
        expect(error.status).toBe(302)
        expect(requests.length).toBe(1)
      },
    )
  })

  test("rejects a create for another workspace before sending", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.create(createRequest({ workspaceID: "ws-2" })))

      expect(error.code).toBe("workspace-mismatch")
      expect(requests.length).toBe(0)
    })
  })

  test("rejects a list for another workspace before sending", async () => {
    await withServer(() => json({ items: [], nextCursor: null, totalEstimate: null }), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.list(listRequest({ workspaceID: "ws-2" })))

      expect(error.code).toBe("workspace-mismatch")
      expect(requests.length).toBe(0)
    })
  })

  test("rejects an invalid pack id before sending", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("pack-1"))

      expect(error.code).toBe("invalid-request")
      expect(requests.length).toBe(0)
    })
  })

  test("rejects a non-integer revision before sending", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.remove("ctxpk_1", 1.5))

      expect(error.code).toBe("invalid-request")
      expect(requests.length).toBe(0)
    })
  })

  test("requires a nonempty token and workspace", () => {
    expect(() => createCtxPackClient({ baseUrl: "http://localhost", token: "", workspaceID: "ws-1" })).toThrow(
      CtxPackClientError,
    )
    expect(() => createCtxPackClient({ baseUrl: "http://localhost", token: "t", workspaceID: " " })).toThrow(
      CtxPackClientError,
    )
  })

  test("forwards the abort signal and does not reach the server once aborted", async () => {
    await withServer(() => json(infoBody()), async (baseUrl, requests) => {
      const { client, captures } = makeClient(baseUrl)
      const controller = new AbortController()
      controller.abort()

      await expect(client.get("ctxpk_1", false, controller.signal)).rejects.toThrow()

      expect(first(captures).init.signal).toBe(controller.signal)
      expect(requests.length).toBe(0)
    })
  })

  test("rejects a success payload from another workspace", async () => {
    await withServer(() => json(infoBody({ workspaceID: "ws-2" })), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("ctxpk_1"))

      expect(error.status).toBe(200)
      expect(error.code).toBe("invalid_response")
    })
  })

  test("rejects a success payload with malformed fragments", async () => {
    await withServer(() => json(infoBody({ fragments: [{ clientFragmentID: "frag-1" }] })), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("ctxpk_1"))

      expect(error.code).toBe("invalid_response")
    })
  })

  test("rejects unknown discriminator values inside fragments", async () => {
    const fragment = fragmentBody({ source: sourceBody({ kind: "mystery" }) })
    await withServer(() => json(infoBody({ fragments: [fragment] })), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("ctxpk_1"))

      expect(error.code).toBe("invalid_response")
    })
  })

  test("rejects a success payload whose id is not a pack id", async () => {
    await withServer(() => json(infoBody({ id: "pack-1" })), async (baseUrl) => {
      const { client } = makeClient(baseUrl)

      const error = await expectClientError(() => client.get("ctxpk_1"))

      expect(error.code).toBe("invalid_response")
    })
  })
})

// --- Fixtures ----------------------------------------------------------------

function sourceBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceID: "ws-1",
    blockID: "block-1",
    functionalityID: "fn-1",
    kind: "message",
    direction: "sent",
    sourceTimestamp: null,
    capturedAt: 1,
    entityRef: null,
    label: null,
    metadata: {},
    sensitivity: "workspace",
    ...overrides,
  }
}

function fragmentBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    clientFragmentID: "frag-1",
    text: "hello",
    source: sourceBody(),
    id: "frag-id-1",
    ordinal: 0,
    contentHash: "frag-hash-1",
    byteLength: 5,
    estimatedTokens: 2,
    ...overrides,
  }
}

function infoBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ctxpk_1",
    workspaceID: "ws-1",
    title: "Pack",
    keywords: ["alpha"],
    sensitivity: "workspace",
    revision: 1,
    contentHash: "hash-1",
    byteLength: 10,
    estimatedTokens: 3,
    fragments: [fragmentBody()],
    usage: { attachedCount: 0, lastAttachedAt: null },
    createdByUserID: "user-1",
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    pinnedAt: null,
    ...overrides,
  }
}

function summaryBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ctxpk_1",
    workspaceID: "ws-1",
    title: "Pack",
    keywords: ["alpha"],
    sensitivity: "workspace",
    revision: 1,
    contentHash: "hash-1",
    byteLength: 10,
    estimatedTokens: 3,
    usage: { attachedCount: 0, lastAttachedAt: null },
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    pinnedAt: null,
    fragmentCount: 1,
    sourceBlockIDs: ["block-1"],
    sourceFunctionalityIDs: ["fn-1"],
    sourceKinds: ["message"],
    ...overrides,
  }
}

function sourceFixture(): CtxPackSource {
  return {
    workspaceID: "ws-1",
    blockID: "block-1",
    functionalityID: "fn-1",
    kind: "message",
    direction: "sent",
    sourceTimestamp: null,
    capturedAt: 1,
    entityRef: null,
    label: null,
    metadata: {},
    sensitivity: "workspace",
  }
}

function createRequest(overrides?: Partial<CtxPackCreateRequest>): CtxPackCreateRequest {
  return {
    workspaceID: "ws-1",
    title: "Pack",
    keywords: ["alpha"],
    sensitivity: "workspace",
    fragments: [{ clientFragmentID: "frag-1", text: "hello", source: sourceFixture() }],
    idempotencyKey: "idem-1",
    ...overrides,
  }
}

function listRequest(overrides?: Partial<CtxPackListRequest>): CtxPackListRequest {
  return {
    workspaceID: "ws-1",
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
    ...overrides,
  }
}

function patchRequest(): CtxPackPatchRequest {
  return {
    workspaceID: "ws-1",
    ctxPackID: "ctxpk_1",
    expectedRevision: 1,
    patch: { title: "New" },
    idempotencyKey: "idem-2",
  }
}

// --- Harness -----------------------------------------------------------------

async function withServer(
  respond: (request: Recorded) => Response | Promise<Response>,
  run: (baseUrl: string, requests: readonly Recorded[]) => Promise<void>,
): Promise<void> {
  const requests: Recorded[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = await request.text()
      const recorded: Recorded = {
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        headers: request.headers,
        body,
      }
      requests.push(recorded)
      return await respond(recorded)
    },
  })
  try {
    await run(`http://127.0.0.1:${server.port}`, requests)
  } finally {
    await server.stop(true)
  }
}

function makeClient(baseUrl: string, overrides?: { readonly token?: string; readonly workspaceID?: string }) {
  const captures: CapturedInit[] = []
  const fetchImpl = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      captures.push({ url: String(input), init: init ?? {} })
      return await fetch(input, init)
    },
    { preconnect: () => undefined },
  )
  const client = createCtxPackClient({
    baseUrl,
    token: overrides?.token ?? "secret-token",
    workspaceID: overrides?.workspaceID ?? "ws-1",
    fetch: fetchImpl,
  })
  return { client, captures }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function parseBody(body: string): unknown {
  return JSON.parse(body)
}

function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error("expected at least one item")
  return item
}

async function expectClientError(action: () => Promise<unknown>): Promise<CtxPackClientError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof CtxPackClientError) return error
    throw error
  }
  throw new Error("expected the call to reject with CtxPackClientError")
}
