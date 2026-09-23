import { describe, expect, test } from "bun:test"
import type { BlockDescriptor, Layout } from "@cybermastery/contracts/layout"
import { ClientError, createLayoutClient, type LayoutEvent } from "./client"

const encoder = new TextEncoder()

type CapturedRequest = {
  readonly url: string
  readonly init: RequestInit
}

describe("layout client", () => {
  test("get sends bearer auth and canvas query without a claim by default", async () => {
    const captured: CapturedRequest[] = []
    const client = makeClient(captured, () => jsonResponse(layout("ws-1", 3)))

    const result = await client.get()

    expect(result).toEqual(layout("ws-1", 3))
    const request = first(captured)
    const url = new URL(request.url)
    expect(url.origin).toBe("http://localhost:4321")
    expect(url.pathname).toBe("/api/cybermastery/layout")
    expect(url.searchParams.get("workspaceID")).toBe("ws-1")
    expect(url.searchParams.get("style")).toBe("canvas")
    expect(url.searchParams.get("deviceClass")).toBe("desktop")
    expect(url.searchParams.get("clientID")).toBe("client-1")
    expect(url.searchParams.has("claim")).toBe(false)
    expect(request.init.method).toBe("GET")
    expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer secret-token")
  })

  test("get claims authority only when explicitly requested", async () => {
    const captured: CapturedRequest[] = []
    const client = makeClient(captured, () => jsonResponse(layout("ws-1", 1)))

    await client.get({ claim: true })

    expect(new URL(first(captured).url).searchParams.get("claim")).toBe("1")
  })

  test("save sends the command body with content type and workspace query", async () => {
    const captured: CapturedRequest[] = []
    let body: unknown
    const client = makeClient(captured, (_input, init) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse(layout("ws-1", 9))
    })
    const blocks = [block("block-1")]

    const result = await client.save(blocks, 8)

    expect(result.revision).toBe(9)
    const request = first(captured)
    const url = new URL(request.url)
    expect(request.init.method).toBe("PUT")
    expect(url.pathname).toBe("/api/cybermastery/layout")
    expect(url.searchParams.get("workspaceID")).toBe("ws-1")
    expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer secret-token")
    expect(new Headers(request.init.headers).get("content-type")).toBe("application/json")
    expect(body).toEqual({
      workspaceID: "ws-1",
      tuple: { user: "user-1", style: "canvas", deviceClass: "desktop" },
      clientID: "client-1",
      expectedRevision: 8,
      blocks,
    })
  })

  test("preserves status, code and revision from non-2xx responses", async () => {
    const captured: CapturedRequest[] = []
    const client = makeClient(captured, () => jsonResponse({ code: "revision_conflict", revision: 4 }, 409))

    const error = await expectClientError(() => client.save([block("block-1")], 4))

    expect(error.status).toBe(409)
    expect(error.code).toBe("revision_conflict")
    expect(error.revision).toBe(4)
    expect(error.message).not.toContain("secret-token")
  })

  test("rejects layout payloads with invalid blocks", async () => {
    const captured: CapturedRequest[] = []
    const invalid = { id: "layout-1", workspaceID: "ws-1", revision: 1, blocks: [block("same"), block("same")] }
    const client = makeClient(captured, () => jsonResponse(invalid))

    const error = await expectClientError(() => client.get())

    expect(error.status).toBe(200)
    expect(error.code).toBe("invalid_response")
  })

  test("rejects layouts that belong to another workspace", async () => {
    const captured: CapturedRequest[] = []
    const client = makeClient(captured, () => jsonResponse(layout("ws-2", 1)))

    const error = await expectClientError(() => client.get())

    expect(error.status).toBe(200)
    expect(error.code).toBe("workspace_mismatch")
  })

  test("rejects layouts whose body is not JSON", async () => {
    const captured: CapturedRequest[] = []
    const client = makeClient(captured, () => new Response("not json", { status: 200 }))

    const error = await expectClientError(() => client.get())

    expect(error.code).toBe("invalid_response")
  })

  test("subscribe streams split frames, ignores noise and filters by workspace", async () => {
    const captured: CapturedRequest[] = []
    const frames = [
      `event: message\r\ndata: ${JSON.stringify(layoutEvent("ws-1", 5))}\r\n\r\n`,
      `data: ${JSON.stringify(layoutEvent("ws-2", 6))}\n\n`,
      `data: ${JSON.stringify({ type: "workspace.layout.deleted", properties: { workspaceID: "ws-1", revision: 7 } })}\n\n`,
      `data: ${JSON.stringify({ type: "workspace.layout.updated", properties: { workspaceID: "ws-1", revision: -1 } })}\n\n`,
      `data: ${JSON.stringify({ type: "workspace.layout.updated", properties: { workspaceID: "ws-1", revision: 1.5 } })}\n\n`,
      ": connected\n\n",
      `data: ${JSON.stringify(layoutEvent("ws-1", 9))}\n\n`,
    ]
    const bytes = encoder.encode(frames.join(""))
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, index) => bytes.slice(index * 7, index * 7 + 7))
    const received: LayoutEvent[] = []
    let ready = 0
    const client = makeClient(captured, () => sseResponse(chunks))

    await client.subscribe((event) => received.push(event), new AbortController().signal, () => {
      ready += 1
    })

    expect(ready).toBe(1)
    expect(received).toEqual([layoutEvent("ws-1", 5), layoutEvent("ws-1", 9)])
    expect(captured.length).toBe(1)
    const request = first(captured)
    expect(request.init.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/api/cybermastery/events")
    expect(new URL(request.url).searchParams.get("workspaceID")).toBe("ws-1")
    expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer secret-token")
  })

  test("subscribe decodes multi-byte characters split across chunks", async () => {
    const workspaceID = "ws-é"
    const text = `data: ${JSON.stringify(layoutEvent(workspaceID, 2))}\n\n`
    const bytes = encoder.encode(text)
    const splitAt = encoder.encode(text.slice(0, text.indexOf("é"))).length + 1
    const received: LayoutEvent[] = []
    const client = makeClient([], () => sseResponse([bytes.slice(0, splitAt), bytes.slice(splitAt)]), { workspaceID })

    await client.subscribe((event) => received.push(event), new AbortController().signal)

    expect(received).toEqual([layoutEvent(workspaceID, 2)])
  })

  test("subscribe rejects malformed event JSON and cancels the reader", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not-json}\n\n"))
      },
      cancel() {
        cancelled = true
      },
    })
    const client = makeClient([], () => new Response(stream, { status: 200 }))

    const error = await expectClientError(() => client.subscribe(() => undefined, new AbortController().signal))

    expect(error.code).toBe("invalid_event")
    expect(cancelled).toBe(true)
  })

  test("subscribe propagates stream errors that are not aborts", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"))
        controller.error(new Error("socket lost"))
      },
    })
    const client = makeClient([], () => new Response(stream, { status: 200 }))

    const error = await expectError(() => client.subscribe(() => undefined, new AbortController().signal))

    expect(error.message).toBe("socket lost")
  })

  test("subscribe stops cleanly on caller abort with a single connection", async () => {
    const captured: CapturedRequest[] = []
    const abort = new AbortController()
    const client = makeClient(captured, (_input, init) => {
      const signal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(layoutEvent("ws-1", 1))}\n\n`))
            signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")))
          },
        }),
        { status: 200 },
      )
    })
    const received: LayoutEvent[] = []
    let notified: (() => void) | undefined
    const becameActive = new Promise<void>((resolve) => {
      notified = resolve
    })

    const subscription = client.subscribe((event) => {
      received.push(event)
      notified?.()
    }, abort.signal)
    await becameActive
    abort.abort()
    await subscription

    expect(received.length).toBe(1)
    expect(captured.length).toBe(1)
  })

  test("subscribe surfaces non-2xx responses without signalling ready", async () => {
    let ready = false
    const client = makeClient([], () => jsonResponse({ code: "unauthorized" }, 401))

    const error = await expectClientError(() =>
      client.subscribe(() => undefined, new AbortController().signal, () => {
        ready = true
      }),
    )

    expect(error.status).toBe(401)
    expect(error.code).toBe("unauthorized")
    expect(ready).toBe(false)
  })
})

function block(id: string): BlockDescriptor {
  return {
    id,
    functionalityID: `fn-${id}`,
    transform: { x: 0, y: 0, w: 4, h: 3, z: 1 },
  }
}

function layout(workspaceID: string, revision: number): Layout {
  return { id: "layout-1", workspaceID, revision, blocks: [block("block-1")] }
}

function layoutEvent(workspaceID: string, revision: number): LayoutEvent {
  return { type: "workspace.layout.updated", properties: { workspaceID, revision } }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function sseResponse(chunks: readonly (string | Uint8Array)[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function makeClient(
  captured: CapturedRequest[],
  respond: (input: RequestInfo | URL, init: RequestInit | undefined) => Response | Promise<Response>,
  overrides?: { readonly workspaceID?: string; readonly token?: string },
) {
  const fetchImpl = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} })
    return respond(input, init)
  }, { preconnect: () => undefined })
  return createLayoutClient({
    baseUrl: "http://localhost:4321",
    token: overrides?.token ?? "secret-token",
    userID: "user-1",
    workspaceID: overrides?.workspaceID ?? "ws-1",
    clientID: "client-1",
    fetch: fetchImpl,
  })
}

function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error("expected a captured request")
  return item
}

async function expectClientError(action: () => Promise<unknown>): Promise<ClientError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ClientError) return error
    throw error
  }
  throw new Error("expected the call to reject with ClientError")
}

async function expectError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the call to reject")
}
