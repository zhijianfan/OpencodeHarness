import { createLayoutRepository } from "@cybermastery/adapters-opencode/layout"
import { capabilities, requireFullParity } from "@cybermastery/adapters-opencode/capabilities"
import { createLayoutService, LayoutError } from "@cybermastery/domain/layout"
import { InvalidLayoutCommand } from "@cybermastery/contracts/layout"
import { routes } from "@cybermastery/contracts/routes"
import { resolve, sep } from "node:path"

export async function createApplication(options: {
  readonly mode: "proof" | "full"
  readonly filename: string
  readonly workspaceID: string
  readonly userID: string
  readonly token: string
  readonly staticDirectory?: string
}) {
  if (options.mode === "full") requireFullParity()
  if (!options.token.trim()) throw new Error("An explicit authentication token is required")
  const storage = await createLayoutRepository({
    filename: options.filename,
    workspaceID: options.workspaceID,
    ownerID: options.userID,
  })
  const layouts = createLayoutService(storage.repository, new Map([["proof:static-card", { minW: 120, minH: 80 }]]))
  const streams = new Set<() => Promise<void>>()
  const actor = { userID: options.userID }
  const encoder = new TextEncoder()

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/api/")) {
      if (!options.staticDirectory) return Response.json({ mode: "proof", status: "ready" })
      const base = resolve(options.staticDirectory)
      const filename = resolve(base, url.pathname === "/" ? "index.html" : `.${url.pathname}`)
      if (!filename.startsWith(base + sep)) return new Response(null, { status: 404 })
      const file = Bun.file(filename)
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 })
    }
    if (request.headers.get("authorization") !== `Bearer ${options.token}`) return Response.json({ code: "unauthorized" }, { status: 401 })
    if (url.pathname === "/api/cybermastery/capabilities") return Response.json({ mode: options.mode, capabilities })
    if (url.searchParams.get("workspaceID") && url.searchParams.get("workspaceID") !== options.workspaceID) {
      return Response.json({ code: "forbidden" }, { status: 403 })
    }
    if (url.pathname === routes.events.path && request.method === routes.events.method) {
      const state = {
        closed: false,
        unsubscribe: undefined as undefined | Promise<() => Promise<void>>,
        closing: undefined as undefined | Promise<void>,
      }
      const close = () => {
        if (state.closing) return state.closing
        state.closed = true
        state.closing = Promise.resolve(state.unsubscribe).then((unsubscribe) => unsubscribe?.()).finally(() => {
          streams.delete(close)
        })
        return state.closing
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          streams.add(close)
          state.unsubscribe = storage.listen((event) => {
            if (!state.closed && event.properties.workspaceID === options.workspaceID) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            }
          })
          await state.unsubscribe
          if (state.closed) return
          controller.enqueue(encoder.encode(": connected\n\n"))
          request.signal.addEventListener("abort", () => { void close() }, { once: true })
          if (request.signal.aborted) await close()
        },
        cancel: close,
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    }
    const operation = async () => {
      if (url.pathname !== routes.layout.path) return new Response(null, { status: 404 })
      if (request.method === routes.layout.method) {
        const tuple = { user: options.userID, style: url.searchParams.get("style") ?? "canvas", deviceClass: url.searchParams.get("deviceClass") ?? "desktop" }
        return Response.json(await layouts.get(actor, options.workspaceID, tuple, url.searchParams.get("clientID") ?? "", url.searchParams.get("claim") === "1"))
      }
      if (request.method === routes.save.method) return Response.json(await layouts.save(actor, await request.json()))
      return new Response(null, { status: 405 })
    }
    return operation().catch((error: unknown) => {
      if (error instanceof InvalidLayoutCommand || error instanceof SyntaxError) return Response.json({ code: "invalid-layout" }, { status: 400 })
      if (error instanceof LayoutError) return Response.json({ code: error.code, revision: error.revision }, {
        status: error.code === "forbidden" ? 403 : error.code === "not-found" ? 404 : 409,
      })
      console.error("Proof host operation failed", error)
      return Response.json({ code: "internal" }, { status: 500 })
    })
  }

  return {
    fetch,
    async dispose() {
      await Promise.all([...streams].map((close) => close()))
      await storage.dispose()
    },
  }
}
