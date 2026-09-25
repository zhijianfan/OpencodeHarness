// Authenticated CtxPack extension HTTP surface for the mediated opencode
// adapter. It borrows an already constructed catalog, materializer, and runtime
// and owns no database, runtime, or disposal of its own. Only the exact
// `/api/cybermastery/ctxpack` prefix is owned: any other path returns
// `undefined` so a native fallback can handle it, while an unknown path under
// the prefix is answered 404 and never falls through.
//
// Authorization always comes from the `Authorization` header plus the trusted
// callback; a body or query value can never widen the authenticated actor.
// Private fragment text never appears in an error body.

import type { CtxPackActor, CtxPackInfo } from "@cybermastery/contracts/ctxpack"
import type { CtxPackMaterializeRequest } from "@cybermastery/contracts/ctxpack-capsule"
import { Cause, Effect, Option, Schema } from "effect"
import type { CtxPackCatalog } from "./ctxpack-catalog"
import type { CtxPackMaterializer } from "./ctxpack-materializer"

const OWNED_PREFIX = "/api/cybermastery/ctxpack"
const CTXPACK_ID_PREFIX = "ctxpk_"
const MAX_BODY_BYTES = 1024 * 1024

export interface CtxPackHttpInput {
  readonly catalog: CtxPackCatalog
  readonly materializer: CtxPackMaterializer
  readonly authenticate: (request: Request) => Promise<CtxPackActor | undefined>
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

// --- Strict wire schemas -----------------------------------------------------
// Every body is decoded with excess-property rejection so an unknown field is a
// malformed request rather than an ignored value.

const Sensitivity = Schema.Literals(["public", "workspace", "private"])
const SourceKind = Schema.Literals(["message", "tool-output", "terminal", "file", "search", "note", "block-text"])
const Direction = Schema.Literals(["sent", "received", "generated", "unknown"])
const Sort = Schema.Literals([
  "created-desc",
  "created-asc",
  "updated-desc",
  "title-asc",
  "tokens-desc",
  "most-attached",
  "recently-attached",
])
const Tag = Schema.Literal("ParallelPlan")

const Source = Schema.Struct({
  workspaceID: Schema.String,
  blockID: Schema.String,
  functionalityID: Schema.String,
  kind: SourceKind,
  direction: Direction,
  sourceTimestamp: Schema.NullOr(Schema.Number),
  capturedAt: Schema.Number,
  entityRef: Schema.NullOr(Schema.Struct({ type: Schema.String, id: Schema.String })),
  label: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
  sensitivity: Sensitivity,
})

const CreateRequest = Schema.Struct({
  workspaceID: Schema.String,
  title: Schema.String,
  keywords: Schema.Array(Schema.String),
  tags: Schema.optional(Schema.Array(Tag)),
  sensitivity: Sensitivity,
  fragments: Schema.Array(Schema.Struct({ clientFragmentID: Schema.String, text: Schema.String, source: Source })),
  idempotencyKey: Schema.String,
})

const ListRequest = Schema.Struct({
  workspaceID: Schema.String,
  query: Schema.String,
  keyword: Schema.NullOr(Schema.String),
  sourceBlockID: Schema.NullOr(Schema.String),
  sourceFunctionalityID: Schema.NullOr(Schema.String),
  sourceKind: Schema.NullOr(SourceKind),
  sensitivity: Schema.NullOr(Sensitivity),
  createdAfter: Schema.NullOr(Schema.Number),
  createdBefore: Schema.NullOr(Schema.Number),
  includeDeleted: Schema.Boolean,
  pinnedOnly: Schema.Boolean,
  sort: Sort,
  cursor: Schema.NullOr(Schema.String),
  limit: Schema.Number,
})

const PatchRequest = Schema.Struct({
  workspaceID: Schema.String,
  ctxPackID: Schema.String,
  expectedRevision: Schema.Number,
  patch: Schema.Struct({
    title: Schema.optional(Schema.String),
    keywords: Schema.optional(Schema.Array(Schema.String)),
    tags: Schema.optional(Schema.Array(Tag)),
    sensitivity: Schema.optional(Sensitivity),
  }),
  idempotencyKey: Schema.String,
})

const RevisionRequest = Schema.Struct({ expectedRevision: Schema.Number })
const EmptyRequest = Schema.Struct({})
const decodeEmpty = (value: unknown) => isRecord(value) && Reflect.ownKeys(value).length === 0
  ? Schema.decodeUnknownOption(EmptyRequest)(value) : Option.none<typeof EmptyRequest.Type>()
const MaterializeRequest = Schema.Struct({
  expectedContentHash: Schema.String,
  targetInstanceID: Schema.String,
  targetFunctionalityID: Schema.String,
})

// --- Surface -----------------------------------------------------------------

export function createCtxPackHttp(input: CtxPackHttpInput) {
  const fetch = async (request: Request): Promise<Response | undefined> => {
    try {
      const suffix = ownedRoute(new URL(request.url).pathname)
      if (suffix === undefined) return undefined
      return await dispatch(input, request, suffix)
    } catch (error) {
      // An explicit interrupt or a disconnected request is preserved for the
      // outer transport instead of being flattened into a 500.
      if (error instanceof RequestInterrupted || request.signal.aborted) throw error
      if (error instanceof URIError) return invalid()
      return internalError()
    }
  }
  return { fetch }
}

// --- Routing -----------------------------------------------------------------

type ParsedRoute =
  | { readonly kind: "create" }
  | { readonly kind: "list" }
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "restore"; readonly id: string }
  | { readonly kind: "pin"; readonly id: string }
  | { readonly kind: "unpin"; readonly id: string }
  | { readonly kind: "materialize"; readonly id: string }

function ownedRoute(pathname: string): string | undefined {
  if (pathname === OWNED_PREFIX) return ""
  if (pathname.startsWith(`${OWNED_PREFIX}/`)) return pathname.slice(OWNED_PREFIX.length)
  return undefined
}

function parseRoute(suffix: string): ParsedRoute | undefined {
  if (suffix === "" || suffix === "/") return { kind: "create" }
  if (suffix === "/list") return { kind: "list" }
  const segments = suffix.slice(1).split("/").map(decodeURIComponent)
  const id = segments[0]
  if (id === undefined || !isCtxPackID(id)) return undefined
  if (segments.length === 1) return { kind: "item", id }
  if (segments.length !== 2) return undefined
  const action = segments[1]
  if (action === "restore") return { kind: "restore", id }
  if (action === "pin") return { kind: "pin", id }
  if (action === "unpin") return { kind: "unpin", id }
  if (action === "materialize") return { kind: "materialize", id }
  return undefined
}

function isCtxPackID(value: string): boolean {
  return value.startsWith(CTXPACK_ID_PREFIX) && value.length > CTXPACK_ID_PREFIX.length
}

function allows(route: ParsedRoute, method: string): boolean {
  if (route.kind === "item") return method === "GET" || method === "PATCH" || method === "DELETE"
  return method === "POST"
}

function allowedVerbs(route: ParsedRoute): string {
  if (route.kind === "item") return "GET, PATCH, DELETE"
  return "POST"
}

async function dispatch(input: CtxPackHttpInput, request: Request, suffix: string): Promise<Response> {
  const route = parseRoute(suffix)
  if (route === undefined) return notFound()
  if (!allows(route, request.method)) return methodNotAllowed(allowedVerbs(route))
  const actor = await authenticateActor(input, request)
  if (actor === undefined) return unauthorized()
  return await handle(input, request, route, actor)
}

async function authenticateActor(input: CtxPackHttpInput, request: Request): Promise<CtxPackActor | undefined> {
  const header = request.headers.get("authorization")
  // The header is the only credential channel; a query token alone grants nothing.
  if (header === null || header.trim().length === 0) return undefined
  const actor = await safelyAuthenticate(input.authenticate, request)
  if (actor === undefined) return undefined
  if (actor.userID.trim().length === 0 || actor.workspaceID.trim().length === 0) return undefined
  return Object.freeze({ userID: actor.userID, workspaceID: actor.workspaceID })
}

async function safelyAuthenticate(
  authenticate: (request: Request) => Promise<CtxPackActor | undefined>,
  request: Request,
): Promise<CtxPackActor | undefined> {
  try {
    return await authenticate(request)
  } catch {
    return undefined
  }
}

// --- Handlers ----------------------------------------------------------------

async function handle(
  input: CtxPackHttpInput,
  request: Request,
  route: ParsedRoute,
  actor: CtxPackActor,
): Promise<Response> {
  if (route.kind === "create") return await handleCreate(input, request, actor)
  if (route.kind === "list") return await handleList(input, request, actor)
  if (route.kind === "restore") return await handleRestore(input, request, actor, route.id)
  if (route.kind === "pin") return await handlePin(input, request, actor, route.id)
  if (route.kind === "unpin") return await handleUnpin(input, request, actor, route.id)
  if (route.kind === "materialize") return await handleMaterialize(input, request, actor, route.id)
  return await handleItem(input, request, actor, route.id)
}

async function handleCreate(input: CtxPackHttpInput, request: Request, actor: CtxPackActor): Promise<Response> {
  const body = await readJson(request, Schema.decodeUnknownOption(CreateRequest, { onExcessProperty: "error" }))
  if (body._tag !== "ok") return bodyReadError(body._tag)
  return settleResponse(input, input.catalog.create(actor, body.value), (info) => jsonResponse(200, info))
}

async function handleList(input: CtxPackHttpInput, request: Request, actor: CtxPackActor): Promise<Response> {
  const body = await readJson(request, Schema.decodeUnknownOption(ListRequest, { onExcessProperty: "error" }))
  if (body._tag !== "ok") return bodyReadError(body._tag)
  return settleResponse(input, input.catalog.list(actor, body.value), (result) => jsonResponse(200, result))
}

async function handleItem(input: CtxPackHttpInput, request: Request, actor: CtxPackActor, id: string): Promise<Response> {
  if (request.method === "GET") {
    const includeDeleted = new URL(request.url).searchParams.get("includeDeleted") === "true"
    return settleResponse(input, input.catalog.get(actor, id, includeDeleted), (info) => jsonResponse(200, info))
  }
  if (request.method === "PATCH") {
    const body = await readJson(request, Schema.decodeUnknownOption(PatchRequest, { onExcessProperty: "error" }))
    if (body._tag !== "ok") return bodyReadError(body._tag)
    // The path is authoritative: the body may not retarget the pack or workspace.
    if (body.value.ctxPackID !== id) return invalid()
    if (body.value.workspaceID !== actor.workspaceID) return forbidden()
    return settleResponse(input, input.catalog.patch(actor, body.value), (info) => jsonResponse(200, info))
  }
  const body = await readJson(request, Schema.decodeUnknownOption(RevisionRequest, { onExcessProperty: "error" }))
  if (body._tag !== "ok") return bodyReadError(body._tag)
  return settleResponse(
    input,
    input.catalog.remove(actor, { ctxPackID: id, expectedRevision: body.value.expectedRevision }),
    (info) => jsonResponse(200, info),
  )
}

async function handleRestore(
  input: CtxPackHttpInput,
  request: Request,
  actor: CtxPackActor,
  id: string,
): Promise<Response> {
  const body = await readJson(request, Schema.decodeUnknownOption(RevisionRequest, { onExcessProperty: "error" }))
  if (body._tag !== "ok") return bodyReadError(body._tag)
  return settleResponse(
    input,
    input.catalog.restore(actor, { ctxPackID: id, expectedRevision: body.value.expectedRevision }),
    (info) => jsonResponse(200, info),
  )
}

async function handlePin(input: CtxPackHttpInput, request: Request, actor: CtxPackActor, id: string): Promise<Response> {
  const body = await readJson(request, decodeEmpty)
  if (body._tag !== "ok") return bodyReadError(body._tag)
  return settleResponse(input, input.catalog.pin(actor, id), pinResponse)
}

async function handleUnpin(input: CtxPackHttpInput, request: Request, actor: CtxPackActor, id: string): Promise<Response> {
  const body = await readJson(request, decodeEmpty)
  if (body._tag !== "ok") return bodyReadError(body._tag)
  return settleResponse(input, input.catalog.unpin(actor, id), () => noContent())
}

async function handleMaterialize(
  input: CtxPackHttpInput,
  request: Request,
  actor: CtxPackActor,
  id: string,
): Promise<Response> {
  const body = await readJson(request, Schema.decodeUnknownOption(MaterializeRequest, { onExcessProperty: "error" }))
  if (body._tag !== "ok") return bodyReadError(body._tag)
  // The actor workspace and the path id are injected; the client never supplies
  // a capsule body or an overriding target workspace.
  const materializeRequest: CtxPackMaterializeRequest = {
    workspaceID: actor.workspaceID,
    ctxPackID: id,
    expectedContentHash: body.value.expectedContentHash,
    targetInstanceID: body.value.targetInstanceID,
    targetFunctionalityID: body.value.targetFunctionalityID,
  }
  return settleResponse(input, input.materializer.materialize(actor, materializeRequest), (result) =>
    jsonResponse(200, result),
  )
}

// --- Effect settling and error mapping ---------------------------------------

type Settled<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: unknown }
  | { readonly _tag: "interrupt" }

type SettledOutcome<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: unknown }

class RequestInterrupted extends Error {
  constructor() {
    super("Request interrupted")
  }
}

function settle<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Settled<A>> {
  return effect.pipe(
    Effect.map((value): Settled<A> => ({ _tag: "ok", value })),
    Effect.catchCause((cause): Effect.Effect<Settled<A>> => {
      if (Cause.hasInterrupts(cause)) return Effect.succeed<Settled<A>>({ _tag: "interrupt" })
      const found = Cause.findErrorOption(cause)
      return Effect.succeed<Settled<A>>({ _tag: "error", error: Option.isNone(found) ? undefined : found.value })
    }),
  )
}

async function runSettled<A>(input: CtxPackHttpInput, effect: Effect.Effect<A, unknown>): Promise<SettledOutcome<A>> {
  const settled = await input.run(settle(effect))
  if (settled._tag === "interrupt") throw new RequestInterrupted()
  return settled
}

async function settleResponse<A>(
  input: CtxPackHttpInput,
  effect: Effect.Effect<A, unknown>,
  onSuccess: (value: A) => Response,
): Promise<Response> {
  const settled = await runSettled(input, effect)
  if (settled._tag === "error") return errorResponse(settled.error)
  return onSuccess(settled.value)
}

interface MappedError {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly currentRevision?: number
  readonly currentContentHash?: string
}

const INTERNAL: MappedError = { code: "internal", message: "internal error", status: 500 }

const ERROR_MAP: Record<string, MappedError> = {
  CtxPackNotFound: { code: "not-found", message: "not found", status: 404 },
  CtxPackDeleted: { code: "deleted", message: "deleted", status: 410 },
  CtxPackRevisionConflict: { code: "revision-conflict", message: "revision conflict", status: 409 },
  CtxPackContentChanged: { code: "content-changed", message: "content changed", status: 409 },
  CtxPackInvalidSelection: { code: "invalid", message: "invalid request", status: 400 },
  CtxPackSecretSourceDenied: { code: "invalid", message: "invalid request", status: 400 },
  CtxPackCrossWorkspaceDenied: { code: "invalid", message: "invalid request", status: 400 },
  CtxPackSearchCursorInvalid: { code: "invalid", message: "invalid request", status: 400 },
  CtxPackSnapshotDuplicateCapsule: { code: "invalid", message: "invalid request", status: 400 },
  CtxPackPermissionDenied: { code: "forbidden", message: "forbidden", status: 403 },
  CtxPackCapabilityDenied: { code: "forbidden", message: "forbidden", status: 403 },
  CtxPackCapsuleTargetMismatch: { code: "forbidden", message: "forbidden", status: 403 },
  CtxPackBudgetExceeded: { code: "too-large", message: "request too large", status: 413 },
  CtxPackSnapshotOverBudget: { code: "too-large", message: "request too large", status: 413 },
  CtxPackCapsuleMissing: { code: "not-found", message: "not found", status: 404 },
  CtxPackCapsuleExpired: { code: "expired", message: "expired", status: 410 },
}

function mapError(error: unknown): MappedError {
  if (!isRecord(error)) return INTERNAL
  const tag = error._tag
  if (typeof tag !== "string") return INTERNAL
  const mapped = ERROR_MAP[tag]
  if (mapped === undefined) return INTERNAL
  if (tag === "CtxPackRevisionConflict") {
    const currentRevision = error.currentRevision
    if (typeof currentRevision === "number") return { ...mapped, currentRevision }
  }
  if (tag === "CtxPackContentChanged") {
    const currentContentHash = error.currentContentHash
    if (typeof currentContentHash === "string") return { ...mapped, currentContentHash }
  }
  return mapped
}

function errorResponse(error: unknown): Response {
  const mapped = mapError(error)
  const body: Record<string, unknown> = { code: mapped.code, message: mapped.message }
  if (mapped.currentRevision !== undefined) body.currentRevision = mapped.currentRevision
  if (mapped.currentContentHash !== undefined) body.currentContentHash = mapped.currentContentHash
  return jsonResponse(mapped.status, body)
}

// --- Response helpers --------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
}

function notFound(): Response {
  return jsonResponse(404, { code: "not-found", message: "not found" })
}

function unauthorized(): Response {
  return jsonResponse(401, { code: "unauthorized", message: "unauthorized" })
}

function invalid(): Response {
  return jsonResponse(400, { code: "invalid", message: "invalid request" })
}

function forbidden(): Response {
  return jsonResponse(403, { code: "forbidden", message: "forbidden" })
}

function tooLarge(): Response {
  return jsonResponse(413, { code: "too-large", message: "request too large" })
}

function unsupportedMediaType(): Response {
  return jsonResponse(415, { code: "unsupported-media-type", message: "application/json required" })
}

function internalError(): Response {
  return jsonResponse(500, { code: "internal", message: "internal error" })
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ code: "method-not-allowed", message: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", "cache-control": "no-store", allow },
  })
}

// The pin response is the updated pack with fragment text removed: only
// create/get/patch/remove/restore may carry fragment bodies.
function pinResponse(info: CtxPackInfo): Response {
  const detached: Record<string, unknown> = info
  return jsonResponse(200, {
    ...Object.fromEntries(Object.entries(detached).filter(([key]) => key !== "fragments" && key !== "createdByUserID")),
    fragmentCount: info.fragments.length,
    sourceBlockIDs: [...new Set(info.fragments.map((fragment) => fragment.source.blockID))],
    sourceFunctionalityIDs: [...new Set(info.fragments.map((fragment) => fragment.source.functionalityID))],
    sourceKinds: [...new Set(info.fragments.map((fragment) => fragment.source.kind))],
  })
}

// --- Body handling -----------------------------------------------------------

type BodyRead<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "too-large" }
  | { readonly _tag: "invalid" }

async function readJson<A>(request: Request, decode: (value: unknown) => Option.Option<A>): Promise<BodyRead<A>> {
  if (!isJsonMediaType(request.headers.get("content-type"))) return { _tag: "unsupported" }
  const body = await readBoundedBody(request, MAX_BODY_BYTES)
  if (body._tag === "too-large") return { _tag: "too-large" }
  if (body._tag === "invalid") return { _tag: "invalid" }
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body.text)
  if (Option.isNone(parsed)) return { _tag: "invalid" }
  const decoded = decode(parsed.value)
  if (Option.isNone(decoded)) return { _tag: "invalid" }
  return { _tag: "ok", value: decoded.value }
}

function bodyReadError(tag: "unsupported" | "too-large" | "invalid"): Response {
  if (tag === "unsupported") return unsupportedMediaType()
  if (tag === "too-large") return tooLarge()
  return invalid()
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false
  const mediaType = value.split(";")[0]?.trim().toLowerCase()
  return mediaType === "application/json"
}

type RawBody =
  | { readonly _tag: "ok"; readonly text: string }
  | { readonly _tag: "too-large" }
  | { readonly _tag: "invalid" }

async function readBoundedBody(request: Request, limit: number): Promise<RawBody> {
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
        // Content-Length is never trusted: cancel as soon as the byte budget is passed.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
