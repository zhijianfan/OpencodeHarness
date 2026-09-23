import { decodeLayoutCommand, type BlockDescriptor, type Layout } from "@cybermastery/contracts/layout"
import { routes } from "./generated/routes"

export type LayoutEvent = {
  readonly type: "workspace.layout.updated"
  readonly properties: {
    readonly workspaceID: string
    readonly revision: number
  }
}

export class ClientError extends Error {
  readonly status: number
  readonly code: string
  readonly revision?: number

  constructor(status: number, code: string, revision?: number) {
    super(code)
    this.name = "ClientError"
    this.status = status
    this.code = code
    if (revision !== undefined) this.revision = revision
  }
}

type GetOptions = {
  readonly claim?: boolean
  readonly signal?: AbortSignal
}

type LayoutContext = {
  readonly workspaceID: string
  readonly userID: string
  readonly clientID: string
}

export function createLayoutClient(options: {
  readonly baseUrl: string
  readonly token: string
  readonly userID: string
  readonly workspaceID: string
  readonly clientID: string
  readonly fetch?: typeof fetch
}) {
  const fetchImpl = options.fetch ?? fetch
  const context: LayoutContext = {
    workspaceID: options.workspaceID,
    userID: options.userID,
    clientID: options.clientID,
  }

  async function get(request?: GetOptions): Promise<Layout> {
    const query: Record<string, string> = {
      workspaceID: options.workspaceID,
      style: "canvas",
      deviceClass: "desktop",
      clientID: options.clientID,
    }
    if (request?.claim === true) query.claim = "1"
    const response = await fetchImpl(buildUrl(options.baseUrl, routes.layout.path, query), {
      method: routes.layout.method,
      headers: authenticate(options.token),
      signal: request?.signal ?? null,
    })
    return readLayout(response, context)
  }

  async function save(
    blocks: readonly BlockDescriptor[],
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<Layout> {
    const response = await fetchImpl(buildUrl(options.baseUrl, routes.save.path, { workspaceID: options.workspaceID }), {
      method: routes.save.method,
      headers: {
        ...authenticate(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceID: options.workspaceID,
        tuple: { user: options.userID, style: "canvas", deviceClass: "desktop" },
        clientID: options.clientID,
        expectedRevision,
        blocks,
      }),
      signal: signal ?? null,
    })
    return readLayout(response, context)
  }

  async function subscribe(
    onEvent: (event: LayoutEvent) => void,
    signal: AbortSignal,
    onReady?: () => void,
  ): Promise<void> {
    try {
      const response = await fetchImpl(buildUrl(options.baseUrl, routes.events.path, { workspaceID: options.workspaceID }), {
        method: routes.events.method,
        headers: authenticate(options.token),
        signal,
      })
      if (!response.ok) throw await toClientError(response)
      const body = response.body
      if (body === null) throw new ClientError(response.status, "invalid_stream")
      const reader = body.getReader()
      const abort = () => { void reader.cancel().catch(() => undefined) }
      signal.addEventListener("abort", abort, { once: true })
      try {
        if (signal.aborted) return
        onReady?.()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          buffer = buffer.replace(/\r\n/g, "\n")
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const event = parseEventFrame(frame, response.status, context)
            if (event !== undefined) onEvent(event)
            boundary = buffer.indexOf("\n\n")
          }
        }
      } finally {
        signal.removeEventListener("abort", abort)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
  }

  return { get, save, subscribe }
}

function authenticate(token: string) {
  return { authorization: `Bearer ${token}` }
}

function buildUrl(baseUrl: string, path: string, query: Record<string, string>): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

async function readLayout(response: Response, context: LayoutContext): Promise<Layout> {
  const payload = await readJson(response)
  if (!response.ok) throw errorFromResponse(response, payload)
  return validateLayout(payload, response.status, context)
}

async function toClientError(response: Response): Promise<ClientError> {
  return errorFromResponse(response, await readJson(response))
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorFromResponse(response: Response, payload: unknown): ClientError {
  if (!isRecord(payload)) return new ClientError(response.status, "request_failed")
  const code = payload.code
  if (typeof code !== "string" || code.length === 0) return new ClientError(response.status, "request_failed")
  const revision = payload.revision
  const errorRevision = typeof revision === "number" && Number.isSafeInteger(revision) ? revision : undefined
  return new ClientError(response.status, code, errorRevision)
}

function validateLayout(payload: unknown, status: number, context: LayoutContext): Layout {
  if (!isRecord(payload)) throw new ClientError(status, "invalid_response")
  const id = payload.id
  if (typeof id !== "string" || id.trim().length === 0) throw new ClientError(status, "invalid_response")
  if (payload.workspaceID !== context.workspaceID) throw new ClientError(status, "workspace_mismatch")
  const decoded = decodeResponseCommand(
    {
      workspaceID: payload.workspaceID,
      tuple: { user: context.userID, style: "canvas", deviceClass: "desktop" },
      clientID: context.clientID,
      expectedRevision: payload.revision,
      blocks: payload.blocks,
    },
    status,
  )
  return {
    id,
    workspaceID: context.workspaceID,
    revision: decoded.expectedRevision,
    blocks: decoded.blocks,
  }
}

function decodeResponseCommand(value: unknown, status: number) {
  try {
    return decodeLayoutCommand(value)
  } catch {
    throw new ClientError(status, "invalid_response")
  }
}

function parseEventFrame(frame: string, status: number, context: LayoutContext): LayoutEvent | undefined {
  const data: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue
    if (!line.startsWith("data:")) continue
    const raw = line.slice("data:".length)
    data.push(raw.startsWith(" ") ? raw.slice(1) : raw)
  }
  if (data.length === 0) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(data.join("\n"))
  } catch {
    throw new ClientError(status, "invalid_event")
  }
  return selectLayoutEvent(payload, context)
}

function selectLayoutEvent(payload: unknown, context: LayoutContext): LayoutEvent | undefined {
  if (!isRecord(payload) || payload.type !== "workspace.layout.updated") return undefined
  const properties = payload.properties
  if (!isRecord(properties)) return undefined
  const revision = properties.revision
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return undefined
  if (properties.workspaceID !== context.workspaceID) return undefined
  return {
    type: "workspace.layout.updated",
    properties: { workspaceID: context.workspaceID, revision },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
