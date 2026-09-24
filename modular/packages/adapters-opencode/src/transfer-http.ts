import { Cause, Effect, Option, Schema } from "effect"
import { LeaseConflict, makeTransferReadiness, type LeaseInput } from "./transfer-readiness"
import { makeTransferReceiver } from "./transfer-receiver"
import { TransferError } from "./transfer-protocol"
import type { TransferSource } from "./transfer-source"

const MAX_BODY_BYTES = 1024 * 1024

const OWNED_PREFIXES = ["/sync", "/api/cybermastery/sync"] as const

const KNOWN_ROUTES = new Set(["/start", "/history", "/replay", "/steal"])

type TransferCode =
  | "invalid"
  | "forbidden"
  | "conflict"
  | "restart"
  | "snapshot-advanced"
  | "version"
  | "too-large"
  | "busy"
  | "expired"

const PUBLIC_MESSAGES: Record<TransferCode, string> = {
  invalid: "invalid request",
  forbidden: "forbidden",
  conflict: "conflict",
  restart: "restart required",
  "snapshot-advanced": "snapshot advanced",
  version: "unsupported version",
  "too-large": "request too large",
  busy: "busy",
  expired: "expired",
}

const ERROR_STATUS: Record<TransferCode, number> = {
  invalid: 400,
  forbidden: 403,
  conflict: 409,
  restart: 409,
  "snapshot-advanced": 409,
  version: 409,
  "too-large": 413,
  busy: 503,
  expired: 410,
}

const StartRequest = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literals(["grant", "revoke"]),
  workspaceID: Schema.optional(Schema.String),
  topologyRevision: Schema.String,
  expiresAt: Schema.Number,
  requestToken: Schema.String,
})

type TransferHttpInput = {
  readonly source: TransferSource
  readonly receiver: Effect.Success<ReturnType<typeof makeTransferReceiver>>
  readonly readiness: Effect.Success<ReturnType<typeof makeTransferReadiness>>
  readonly workspaceID?: string
  readonly authenticate: (request: Request) => Promise<boolean>
  readonly authorizeStart: () => Effect.Effect<void, TransferError>
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

type Settled<A> = { readonly _tag: "ok"; readonly value: A } | { readonly _tag: "error"; readonly error: unknown }

type RunSettled = <A, E>(effect: Effect.Effect<A, E>) => Promise<Settled<A>>

type BodyRead =
  | { readonly _tag: "ok"; readonly text: string }
  | { readonly _tag: "too-large" }
  | { readonly _tag: "invalid" }

/**
 * Authenticated private transfer surface. The adapter borrows already constructed source, receiver,
 * readiness and runtime; it never owns or disposes them. Only the exact `/sync` and
 * `/api/cybermastery/sync` prefixes are owned, and unknown paths there must not reach a native
 * fallback.
 */
export function createTransferHttp(input: TransferHttpInput) {
  const runSettled: RunSettled = (effect) => input.run(settle(effect))

  const fetch = async (request: Request): Promise<Response | undefined> => {
    try {
      const route = ownedRoute(new URL(request.url).pathname)
      if (route === undefined) return undefined
      if (!KNOWN_ROUTES.has(route)) return notFound()
      if (request.method !== "POST") return methodNotAllowed()
      if (!(await isAuthenticated(input.authenticate, request))) return unauthorized()
      if (route === "/steal")
        return errorResponse(new TransferError({ code: "conflict", message: "owner steal unavailable" }))
      if (!isJsonMediaType(request.headers.get("content-type"))) return unsupportedMediaType()
      const body = await readBoundedBody(request, MAX_BODY_BYTES)
      if (body._tag === "too-large") return errorResponse(new TransferError({ code: "too-large", message: "body too large" }))
      if (body._tag === "invalid") return errorResponse(new TransferError({ code: "invalid", message: "invalid body" }))
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body.text)
      if (Option.isNone(parsed)) return errorResponse(new TransferError({ code: "invalid", message: "invalid json" }))
      if (!isJsonObject(parsed.value)) return errorResponse(new TransferError({ code: "invalid", message: "invalid json" }))
      // Reject legacy/unversioned payloads before any DTO decoder can fall back to a downgrade.
      if (parsed.value.version !== 1)
        return errorResponse(new TransferError({ code: "version", message: "version unsupported" }))
      if (route === "/start") return await handleStart(input, runSettled, parsed.value)
      if (route === "/history") return await forwardHistory(input, runSettled, parsed.value)
      return await forwardReplay(input, runSettled, parsed.value)
    } catch {
      return errorResponse(undefined)
    }
  }

  return { fetch }
}

async function handleStart(
  input: TransferHttpInput,
  runSettled: RunSettled,
  value: Record<string, unknown>,
): Promise<Response> {
  const decoded = Schema.decodeUnknownOption(StartRequest, { onExcessProperty: "error" })(value)
  if (Option.isNone(decoded)) return errorResponse(new TransferError({ code: "invalid", message: "invalid start" }))
  const request = decoded.value
  if (request.workspaceID !== input.workspaceID)
    return errorResponse(new TransferError({ code: "forbidden", message: "workspace mismatch" }))
  const authorized = await runSettled(input.authorizeStart())
  if (authorized._tag === "error") return errorResponse(authorized.error)
  const lease: LeaseInput = {
    version: 1,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    topologyRevision: request.topologyRevision,
    expiresAt: request.expiresAt,
    requestToken: request.requestToken,
  }
  if (request.action === "grant") {
    // Read required before the lease changes so a failed query leaves no granted lease behind.
    const required = await runSettled(input.source.required)
    if (required._tag === "error") return errorResponse(required.error)
    const ack = await runSettled(input.readiness.grant(lease))
    if (ack._tag === "error") return errorResponse(ack.error)
    return successResponse({ version: 1, acceptedRevision: ack.value.acceptedRevision, expiresAt: ack.value.expiresAt, transferRequired: required.value })
  }
  const ack = await runSettled(input.readiness.revoke(lease))
  if (ack._tag === "error") return errorResponse(ack.error)
  // Refresh after the drain so an in-flight admission that committed private state is observed.
  const required = await runSettled(input.source.required)
  if (required._tag === "error") return errorResponse(required.error)
  return successResponse({ version: 1, acceptedRevision: ack.value.acceptedRevision, expiresAt: ack.value.expiresAt, transferRequired: required.value })
}

async function forwardHistory(
  input: TransferHttpInput,
  runSettled: RunSettled,
  value: Record<string, unknown>,
): Promise<Response> {
  const result = await runSettled(input.source.history(value))
  if (result._tag === "error") return errorResponse(result.error)
  return successResponse(result.value)
}

async function forwardReplay(
  input: TransferHttpInput,
  runSettled: RunSettled,
  value: Record<string, unknown>,
): Promise<Response> {
  const result = await runSettled(input.receiver.replay(value))
  if (result._tag === "error") return errorResponse(result.error)
  return successResponse(result.value)
}

/** Resolves the owned route suffix, or `undefined` when the path is not owned at all. */
function ownedRoute(pathname: string): string | undefined {
  for (const prefix of OWNED_PREFIXES) {
    if (pathname === prefix) return ""
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length)
  }
  return undefined
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false
  const mediaType = value.split(";")[0]?.trim().toLowerCase()
  return mediaType === "application/json"
}

async function isAuthenticated(
  authenticate: (request: Request) => Promise<boolean>,
  request: Request,
): Promise<boolean> {
  const header = request.headers.get("authorization")
  if (header === null || header.trim().length === 0) return false
  try {
    return (await authenticate(request)) === true
  } catch {
    return false
  }
}

async function readBoundedBody(request: Request, limit: number): Promise<BodyRead> {
  const body = request.body
  if (body === null) return { _tag: "ok", text: "" }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        // Never trust Content-Length: cancel the reader as soon as the actual byte budget is passed.
        await reader.cancel()
        return { _tag: "too-large" }
      }
      chunks.push(next.value)
    }
  } catch {
    return { _tag: "invalid" }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { _tag: "ok", text: new TextDecoder().decode(merged) }
}

function settle<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Settled<A>> {
  return effect.pipe(
    Effect.map((value): Settled<A> => ({ _tag: "ok", value })),
    Effect.catchCause((cause): Effect.Effect<Settled<A>> => {
      const found = Cause.findErrorOption(cause)
      return Effect.succeed<Settled<A>>({ _tag: "error", error: Option.isNone(found) ? undefined : found.value })
    }),
  )
}

function mapError(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  if (error instanceof TransferError)
    return { code: error.code, message: PUBLIC_MESSAGES[error.code], status: ERROR_STATUS[error.code] }
  if (error instanceof LeaseConflict) return { code: "conflict", message: PUBLIC_MESSAGES.conflict, status: 409 }
  return { code: "internal", message: "internal error", status: 500 }
}

function successResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: privateHeaders(true) })
}

function errorResponse(error: unknown): Response {
  const mapped = mapError(error)
  return new Response(JSON.stringify({ code: mapped.code, message: mapped.message }), {
    status: mapped.status,
    headers: privateHeaders(false),
  })
}

function notFound(): Response {
  return new Response(JSON.stringify({ code: "not-found", message: "not found" }), {
    status: 404,
    headers: privateHeaders(false),
  })
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ code: "method-not-allowed", message: "method not allowed" }), {
    status: 405,
    headers: { ...privateHeaders(false), allow: "POST" },
  })
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ code: "unauthorized", message: "unauthorized" }), {
    status: 401,
    headers: privateHeaders(false),
  })
}

function unsupportedMediaType(): Response {
  return new Response(JSON.stringify({ code: "unsupported-media-type", message: "application/json required" }), {
    status: 415,
    headers: privateHeaders(false),
  })
}

function privateHeaders(withVersion: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(withVersion ? { "x-opencode-session-sync-version": "1" } : {}),
  }
}
