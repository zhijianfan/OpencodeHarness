// Browser-safe CtxPack extension client.
//
// This module talks to the authenticated `/api/cybermastery/ctxpack` HTTP
// surface. It depends only on the shared wire contract and standard browser
// primitives (`fetch`, `URL`, `JSON`); it never imports native or Effect code.
//
// Requests always carry the configured bearer token in the `Authorization`
// header, always ask for `cache: "no-store"`, and never follow redirects. The
// configured workspace and token must be nonempty, and a request whose body
// targets another workspace is rejected before any network call. Error bodies
// are reduced to a small set of known `code`/`currentRevision`/
// `currentContentHash` fields so private fragment text can never leak through
// an error message.

import type {
  CtxPackCreateRequest,
  CtxPackFragment,
  CtxPackInfo,
  CtxPackListRequest,
  CtxPackListResult,
  CtxPackPatchRequest,
  CtxPackSensitivity,
  CtxPackSource,
  CtxPackSourceKind,
  CtxPackSummary,
  CtxPackTag,
  CtxPackUsage,
} from "@cybermastery/contracts/ctxpack"
import type { CtxPackMaterializeResult } from "@cybermastery/contracts/ctxpack-capsule"

const BASE_PATH = "/api/cybermastery/ctxpack"
const CTXPACK_ID_PREFIX = "ctxpk_"

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "not-found",
  "deleted",
  "revision-conflict",
  "content-changed",
  "invalid",
  "forbidden",
  "too-large",
  "expired",
  "internal",
  "unauthorized",
  "method-not-allowed",
  "unsupported-media-type",
])

export class CtxPackClientError extends Error {
  readonly status: number
  readonly code: string
  readonly currentRevision?: number
  readonly currentContentHash?: string

  constructor(
    status: number,
    code: string,
    details?: { readonly currentRevision?: number; readonly currentContentHash?: string },
  ) {
    super(code)
    this.name = "CtxPackClientError"
    this.status = status
    this.code = code
    if (details?.currentRevision !== undefined) this.currentRevision = details.currentRevision
    if (details?.currentContentHash !== undefined) this.currentContentHash = details.currentContentHash
  }
}

export type CtxPackMaterializeInput = {
  readonly expectedContentHash: string
  readonly targetInstanceID: string
  readonly targetFunctionalityID: string
}

export function createCtxPackClient(options: {
  readonly baseUrl: string
  readonly token: string
  readonly workspaceID: string
  readonly fetch?: typeof fetch
}) {
  if (options.token.trim().length === 0) throw new CtxPackClientError(0, "invalid-config")
  if (options.workspaceID.trim().length === 0) throw new CtxPackClientError(0, "invalid-config")

  const fetchImpl = options.fetch ?? fetch
  const workspaceID = options.workspaceID

  async function create(request: CtxPackCreateRequest, signal?: AbortSignal): Promise<CtxPackInfo> {
    requireWorkspace(request.workspaceID)
    const response = await send("POST", `${BASE_PATH}/`, undefined, request, signal)
    return readValidated(response, (payload, status) => validateInfo(payload, status, workspaceID))
  }

  async function get(ctxPackID: string, includeDeleted = false, signal?: AbortSignal): Promise<CtxPackInfo> {
    requireCtxPackID(ctxPackID)
    const query = includeDeleted ? { includeDeleted: "true" } : undefined
    const response = await send("GET", itemPath(ctxPackID), query, undefined, signal)
    return readValidated(response, (payload, status) => validateInfo(payload, status, workspaceID, ctxPackID))
  }

  async function list(request: CtxPackListRequest, signal?: AbortSignal): Promise<CtxPackListResult> {
    requireWorkspace(request.workspaceID)
    const response = await send("POST", `${BASE_PATH}/list`, undefined, request, signal)
    return readValidated(response, (payload, status) => validateListResult(payload, status, workspaceID))
  }

  async function patch(request: CtxPackPatchRequest, signal?: AbortSignal): Promise<CtxPackInfo> {
    requireWorkspace(request.workspaceID)
    requireCtxPackID(request.ctxPackID)
    requireRevision(request.expectedRevision)
    const response = await send("PATCH", itemPath(request.ctxPackID), undefined, request, signal)
    return readValidated(response, (payload, status) => validateInfo(payload, status, workspaceID, request.ctxPackID))
  }

  async function remove(ctxPackID: string, expectedRevision: number, signal?: AbortSignal): Promise<CtxPackInfo> {
    requireCtxPackID(ctxPackID)
    requireRevision(expectedRevision)
    const response = await send("DELETE", itemPath(ctxPackID), undefined, { expectedRevision }, signal)
    return readValidated(response, (payload, status) => validateInfo(payload, status, workspaceID, ctxPackID))
  }

  async function restore(ctxPackID: string, expectedRevision: number, signal?: AbortSignal): Promise<CtxPackInfo> {
    requireCtxPackID(ctxPackID)
    requireRevision(expectedRevision)
    const response = await send("POST", `${itemPath(ctxPackID)}/restore`, undefined, { expectedRevision }, signal)
    return readValidated(response, (payload, status) => validateInfo(payload, status, workspaceID, ctxPackID))
  }

  async function pin(ctxPackID: string, signal?: AbortSignal): Promise<CtxPackSummary> {
    requireCtxPackID(ctxPackID)
    const response = await send("POST", `${itemPath(ctxPackID)}/pin`, undefined, {}, signal)
    return readValidated(response, (payload, status) => validatePinResponse(payload, status, workspaceID, ctxPackID))
  }

  async function unpin(ctxPackID: string, signal?: AbortSignal): Promise<void> {
    requireCtxPackID(ctxPackID)
    const response = await send("POST", `${itemPath(ctxPackID)}/unpin`, undefined, {}, signal)
    if (!response.ok) throw errorFromResponse(response.status, await readJson(response))
    if (response.status !== 204) throw new CtxPackClientError(response.status, "invalid_response")
  }

  async function materialize(
    ctxPackID: string,
    input: CtxPackMaterializeInput,
    signal?: AbortSignal,
  ): Promise<CtxPackMaterializeResult> {
    requireCtxPackID(ctxPackID)
    requireNonEmpty(input.expectedContentHash)
    requireNonEmpty(input.targetInstanceID)
    requireNonEmpty(input.targetFunctionalityID)
    const response = await send("POST", `${itemPath(ctxPackID)}/materialize`, undefined, input, signal)
    return readValidated(response, (payload, status) => validateMaterializeResult(payload, status, ctxPackID))
  }

  function requireWorkspace(requestWorkspaceID: string): void {
    if (requestWorkspaceID !== workspaceID) throw new CtxPackClientError(0, "workspace-mismatch")
  }

  async function send(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const response = await fetchImpl(buildUrl(options.baseUrl, path, query), {
      method,
      headers: requestHeaders(options.token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: signal ?? null,
    })
    // `redirect: "manual"` already suppresses following; reject the 3xx (or the
    // browser's opaque redirect) so a caller never treats it as a success.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new CtxPackClientError(response.status, "redirect")
    }
    return response
  }

  return { create, get, list, patch, remove, restore, pin, unpin, materialize }
}

export type CtxPackClient = ReturnType<typeof createCtxPackClient>

// --- Request construction ----------------------------------------------------

function itemPath(id: string): string {
  return `${BASE_PATH}/${encodeURIComponent(id)}`
}

function isCtxPackID(id: string): boolean {
  return id.startsWith(CTXPACK_ID_PREFIX) && id.length > CTXPACK_ID_PREFIX.length
}

function requireCtxPackID(id: string): void {
  if (!isCtxPackID(id)) throw new CtxPackClientError(0, "invalid-request")
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new CtxPackClientError(0, "invalid-request")
}

function requireNonEmpty(value: string): void {
  if (value.trim().length === 0) throw new CtxPackClientError(0, "invalid-request")
}

function requestHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (hasBody) headers["content-type"] = "application/json"
  return headers
}

function buildUrl(baseUrl: string, path: string, query: Record<string, string> | undefined): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`)
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  }
  return url.toString()
}

// --- Response handling -------------------------------------------------------

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function readValidated<T>(
  response: Response,
  validate: (payload: unknown, status: number) => T,
): Promise<T> {
  const payload = await readJson(response)
  if (!response.ok) throw errorFromResponse(response.status, payload)
  return validate(payload, response.status)
}

function statusFallback(status: number): string {
  if (status === 400) return "invalid"
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not-found"
  if (status === 405) return "method-not-allowed"
  if (status === 409) return "conflict"
  if (status === 410) return "deleted"
  if (status === 413) return "too-large"
  if (status === 415) return "unsupported-media-type"
  if (status >= 500) return "internal"
  return "request-failed"
}

function errorFromResponse(status: number, payload: unknown): CtxPackClientError {
  const fallback = statusFallback(status)
  if (!isRecord(payload)) return new CtxPackClientError(status, fallback)
  // Only a known discriminator is trusted; anything else degrades to a fixed
  // status-derived code so no server-provided text reaches the message.
  const code = payload.code
  if (typeof code !== "string" || !KNOWN_ERROR_CODES.has(code)) return new CtxPackClientError(status, fallback)
  const details: { currentRevision?: number; currentContentHash?: string } = {}
  const currentRevision = payload.currentRevision
  if (typeof currentRevision === "number" && Number.isSafeInteger(currentRevision) && currentRevision >= 0) {
    details.currentRevision = currentRevision
  }
  const currentContentHash = payload.currentContentHash
  if (typeof currentContentHash === "string" && currentContentHash.length > 0) {
    details.currentContentHash = currentContentHash
  }
  return new CtxPackClientError(status, code, details)
}

// --- Validation helpers ------------------------------------------------------

function invalid(status: number): never {
  throw new CtxPackClientError(status, "invalid_response")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCtxPackTag(value: unknown): value is CtxPackTag {
  return value === "ParallelPlan"
}

function isSensitivity(value: unknown): value is CtxPackSensitivity {
  return value === "public" || value === "workspace" || value === "private"
}

function isSourceKind(value: unknown): value is CtxPackSourceKind {
  return (
    value === "message" ||
    value === "tool-output" ||
    value === "terminal" ||
    value === "file" ||
    value === "search" ||
    value === "note" ||
    value === "block-text"
  )
}

function isDirection(value: unknown): value is "sent" | "received" | "generated" | "unknown" {
  return value === "sent" || value === "received" || value === "generated" || value === "unknown"
}

function requireString(value: unknown, status: number): string {
  if (typeof value !== "string") return invalid(status)
  return value
}

function requireNonEmptyString(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length === 0) return invalid(status)
  return value
}

function requireFiniteNumber(value: unknown, status: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid(status)
  return value
}

function requireCount(value: unknown, status: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid(status)
  return value
}

function requireNullableNumber(value: unknown, status: number): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid(status)
  return value
}

function requireStringArray(value: unknown, status: number): readonly string[] {
  if (!Array.isArray(value)) return invalid(status)
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") return invalid(status)
    result.push(entry)
  }
  return result
}

function requireTags(value: unknown, status: number): readonly CtxPackTag[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return invalid(status)
  const result: CtxPackTag[] = []
  for (const entry of value) {
    if (!isCtxPackTag(entry)) return invalid(status)
    result.push(entry)
  }
  return result
}

function validateMetadata(value: unknown, status: number): Readonly<Record<string, string | number | boolean | null>> {
  if (!isRecord(value)) return invalid(status)
  const result: Record<string, string | number | boolean | null> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      result[key] = entry
      continue
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry
      continue
    }
    return invalid(status)
  }
  return result
}

function validateEntityRef(value: unknown, status: number): { readonly type: string; readonly id: string } | null {
  if (value === null) return null
  if (!isRecord(value)) return invalid(status)
  return { type: requireString(value.type, status), id: requireString(value.id, status) }
}

function validateSource(value: unknown, status: number): CtxPackSource {
  if (!isRecord(value)) return invalid(status)
  if (!isSensitivity(value.sensitivity)) return invalid(status)
  if (!isSourceKind(value.kind)) return invalid(status)
  if (!isDirection(value.direction)) return invalid(status)
  return {
    workspaceID: requireString(value.workspaceID, status),
    blockID: requireString(value.blockID, status),
    functionalityID: requireString(value.functionalityID, status),
    kind: value.kind,
    direction: value.direction,
    sourceTimestamp: requireNullableNumber(value.sourceTimestamp, status),
    capturedAt: requireFiniteNumber(value.capturedAt, status),
    entityRef: validateEntityRef(value.entityRef, status),
    label: value.label === null ? null : requireString(value.label, status),
    metadata: validateMetadata(value.metadata, status),
    sensitivity: value.sensitivity,
  }
}

function validateFragment(value: unknown, status: number): CtxPackFragment {
  if (!isRecord(value)) return invalid(status)
  return {
    clientFragmentID: requireString(value.clientFragmentID, status),
    text: requireString(value.text, status),
    source: validateSource(value.source, status),
    id: requireString(value.id, status),
    ordinal: requireCount(value.ordinal, status),
    contentHash: requireNonEmptyString(value.contentHash, status),
    byteLength: requireCount(value.byteLength, status),
    estimatedTokens: requireCount(value.estimatedTokens, status),
  }
}

function validateFragments(value: unknown, status: number): readonly CtxPackFragment[] {
  if (!Array.isArray(value)) return invalid(status)
  return value.map((entry) => validateFragment(entry, status))
}

function validateUsage(value: unknown, status: number): CtxPackUsage {
  if (!isRecord(value)) return invalid(status)
  return {
    attachedCount: requireCount(value.attachedCount, status),
    lastAttachedAt: requireNullableNumber(value.lastAttachedAt, status),
  }
}

function validateInfo(payload: unknown, status: number, workspaceID: string, expectedID?: string): CtxPackInfo {
  if (!isRecord(payload)) return invalid(status)
  const id = requireNonEmptyString(payload.id, status)
  if (!isCtxPackID(id)) return invalid(status)
  if (expectedID !== undefined && id !== expectedID) return invalid(status)
  const payloadWorkspaceID = requireNonEmptyString(payload.workspaceID, status)
  if (payloadWorkspaceID !== workspaceID) return invalid(status)
  if (!isSensitivity(payload.sensitivity)) return invalid(status)
  const tags = requireTags(payload.tags, status)
  const info: CtxPackInfo = {
    id,
    workspaceID: payloadWorkspaceID,
    title: requireString(payload.title, status),
    keywords: requireStringArray(payload.keywords, status),
    sensitivity: payload.sensitivity,
    revision: requireCount(payload.revision, status),
    contentHash: requireNonEmptyString(payload.contentHash, status),
    byteLength: requireCount(payload.byteLength, status),
    estimatedTokens: requireCount(payload.estimatedTokens, status),
    fragments: validateFragments(payload.fragments, status),
    usage: validateUsage(payload.usage, status),
    createdByUserID: requireNonEmptyString(payload.createdByUserID, status),
    createdAt: requireFiniteNumber(payload.createdAt, status),
    updatedAt: requireFiniteNumber(payload.updatedAt, status),
    deletedAt: requireNullableNumber(payload.deletedAt, status),
    pinnedAt: requireNullableNumber(payload.pinnedAt, status),
  }
  if (tags === undefined) return info
  return { ...info, tags }
}

function validateSourceKinds(value: unknown, status: number): readonly CtxPackSourceKind[] {
  if (!Array.isArray(value)) return invalid(status)
  const result: CtxPackSourceKind[] = []
  for (const entry of value) {
    if (!isSourceKind(entry)) return invalid(status)
    result.push(entry)
  }
  return result
}

function validateSummary(payload: unknown, status: number, workspaceID: string, expectedID?: string): CtxPackSummary {
  if (!isRecord(payload)) return invalid(status)
  const id = requireNonEmptyString(payload.id, status)
  if (!isCtxPackID(id)) return invalid(status)
  if (expectedID !== undefined && id !== expectedID) return invalid(status)
  const payloadWorkspaceID = requireNonEmptyString(payload.workspaceID, status)
  if (payloadWorkspaceID !== workspaceID) return invalid(status)
  if (!isSensitivity(payload.sensitivity)) return invalid(status)
  const tags = requireTags(payload.tags, status)
  const summary: CtxPackSummary = {
    id,
    workspaceID: payloadWorkspaceID,
    title: requireString(payload.title, status),
    keywords: requireStringArray(payload.keywords, status),
    sensitivity: payload.sensitivity,
    revision: requireCount(payload.revision, status),
    contentHash: requireNonEmptyString(payload.contentHash, status),
    byteLength: requireCount(payload.byteLength, status),
    estimatedTokens: requireCount(payload.estimatedTokens, status),
    usage: validateUsage(payload.usage, status),
    createdAt: requireFiniteNumber(payload.createdAt, status),
    updatedAt: requireFiniteNumber(payload.updatedAt, status),
    deletedAt: requireNullableNumber(payload.deletedAt, status),
    pinnedAt: requireNullableNumber(payload.pinnedAt, status),
    fragmentCount: requireCount(payload.fragmentCount, status),
    sourceBlockIDs: requireStringArray(payload.sourceBlockIDs, status),
    sourceFunctionalityIDs: requireStringArray(payload.sourceFunctionalityIDs, status),
    sourceKinds: validateSourceKinds(payload.sourceKinds, status),
  }
  if (tags === undefined) return summary
  return { ...summary, tags }
}

// The pin surface returns the pack without fragment bodies. A full info body is
// reduced locally (never synthesizing data: the summary is derived from the
// fragments the server sent), while an already-summarized body is used directly.
function validatePinResponse(
  payload: unknown,
  status: number,
  workspaceID: string,
  expectedID: string,
): CtxPackSummary {
  if (!isRecord(payload)) return invalid(status)
  if (Array.isArray(payload.fragments)) {
    return summaryFromInfo(validateInfo(payload, status, workspaceID, expectedID))
  }
  return validateSummary(payload, status, workspaceID, expectedID)
}

function summaryFromInfo(info: CtxPackInfo): CtxPackSummary {
  const summary: CtxPackSummary = {
    id: info.id,
    workspaceID: info.workspaceID,
    title: info.title,
    keywords: info.keywords,
    sensitivity: info.sensitivity,
    revision: info.revision,
    contentHash: info.contentHash,
    byteLength: info.byteLength,
    estimatedTokens: info.estimatedTokens,
    usage: info.usage,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    deletedAt: info.deletedAt,
    pinnedAt: info.pinnedAt,
    fragmentCount: info.fragments.length,
    sourceBlockIDs: unique(info.fragments.map((fragment) => fragment.source.blockID)),
    sourceFunctionalityIDs: unique(info.fragments.map((fragment) => fragment.source.functionalityID)),
    sourceKinds: unique(info.fragments.map((fragment) => fragment.source.kind)),
  }
  if (info.tags === undefined) return summary
  return { ...summary, tags: info.tags }
}

function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)]
}

function validateListResult(payload: unknown, status: number, workspaceID: string): CtxPackListResult {
  if (!isRecord(payload)) return invalid(status)
  if (!Array.isArray(payload.items)) return invalid(status)
  return {
    items: payload.items.map((entry) => validateSummary(entry, status, workspaceID)),
    nextCursor: payload.nextCursor === null ? null : requireString(payload.nextCursor, status),
    totalEstimate: payload.totalEstimate === null ? null : requireCount(payload.totalEstimate, status),
  }
}

function validateMaterializeResult(
  payload: unknown,
  status: number,
  ctxPackID: string,
): CtxPackMaterializeResult {
  if (!isRecord(payload)) return invalid(status)
  const sourceCtxPackID = requireNonEmptyString(payload.sourceCtxPackID, status)
  if (sourceCtxPackID !== ctxPackID) return invalid(status)
  const contextCapsuleID = requireNonEmptyString(payload.contextCapsuleID, status)
  const tags = requireTags(payload.tags, status)
  const result: CtxPackMaterializeResult = {
    contextCapsuleID,
    sourceCtxPackID,
    label: requireString(payload.label, status),
    contentHash: requireNonEmptyString(payload.contentHash, status),
    estimatedTokens: requireCount(payload.estimatedTokens, status),
  }
  if (tags === undefined) return result
  return { ...result, tags }
}
