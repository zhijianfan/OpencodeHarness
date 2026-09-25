/**
 * CtxPack content and validation (frozen v1 helpers).
 *
 * Server-side, framework-free normalization for the browser-safe CtxPack v1
 * contract. This module owns the frozen normalization/validation/hash/search
 * helpers. It mirrors the authoritative semantics in packages/schema and
 * packages/core without importing the Effect runtime, the integrated fork
 * schema, or vendor Core.
 *
 * Every emitted failure is a CtxPackError-shaped value and never echoes
 * fragment text back to the caller.
 */

import { createHash } from "node:crypto"
import type {
  CtxPackCreateRequest,
  CtxPackDirection,
  CtxPackError,
  CtxPackFragmentInput,
  CtxPackListRequest,
  CtxPackPatchRequest,
  CtxPackSensitivity,
  CtxPackSort,
  CtxPackSource,
  CtxPackSourceKind,
  CtxPackTag,
} from "@cybermastery/contracts/ctxpack"

export const LIMITS = {
  titleMaxCodePoints: 120,
  keywordMaxCount: 12,
  keywordMaxCodePoints: 48,
  fragmentMinCount: 1,
  fragmentMaxCount: 32,
  fragmentMaxBytes: 16384,
  totalMaxBytes: 65536,
  totalMaxEstimatedTokens: 16384,
  listLimitMin: 1,
  listLimitMax: 50,
  queryMaxCodePoints: 256,
} as const

const SENSITIVITY_RANK: Readonly<Record<CtxPackSensitivity, number>> = {
  public: 0,
  workspace: 1,
  private: 2,
}

const SENSITIVITIES: readonly CtxPackSensitivity[] = ["public", "workspace", "private"]
const SOURCE_KINDS: readonly CtxPackSourceKind[] = [
  "message",
  "tool-output",
  "terminal",
  "file",
  "search",
  "note",
  "block-text",
]
const DIRECTIONS: readonly CtxPackDirection[] = ["sent", "received", "generated", "unknown"]
const SORTS: readonly CtxPackSort[] = [
  "created-desc",
  "created-asc",
  "updated-desc",
  "title-asc",
  "tokens-desc",
  "most-attached",
  "recently-attached",
]
const TAGS: readonly CtxPackTag[] = ["ParallelPlan"]

const CREATE_KEYS: readonly string[] = [
  "workspaceID",
  "title",
  "keywords",
  "tags",
  "sensitivity",
  "fragments",
  "idempotencyKey",
]
const FRAGMENT_KEYS: readonly string[] = ["clientFragmentID", "text", "source"]
const SOURCE_KEYS: readonly string[] = [
  "workspaceID",
  "blockID",
  "functionalityID",
  "kind",
  "direction",
  "sourceTimestamp",
  "capturedAt",
  "entityRef",
  "label",
  "metadata",
  "sensitivity",
]
const ENTITY_REF_KEYS: readonly string[] = ["type", "id"]
const PATCH_KEYS: readonly string[] = ["workspaceID", "ctxPackID", "expectedRevision", "patch", "idempotencyKey"]
const PATCH_FIELD_KEYS: readonly string[] = ["title", "keywords", "tags", "sensitivity"]
const LIST_KEYS: readonly string[] = [
  "workspaceID",
  "query",
  "keyword",
  "sourceBlockID",
  "sourceFunctionalityID",
  "sourceKind",
  "sensitivity",
  "createdAfter",
  "createdBefore",
  "includeDeleted",
  "pinnedOnly",
  "sort",
  "cursor",
  "limit",
]

// Normalization ---------------------------------------------------------------

export function normalizeSelectedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim()
}

export function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ")
}

const encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}

export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4)
}

// Hashing ---------------------------------------------------------------------

export function contentHash(
  fragments: readonly { readonly ordinal: number; readonly text: string; readonly source: CtxPackSource }[],
): string {
  const canonical = JSON.stringify(
    fragments.map((fragment) => ({
      ordinal: fragment.ordinal,
      text: normalizeSelectedText(fragment.text),
      source: recursiveKeySortedSource(fragment.source),
    })),
  )
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}

// Recursive key sort of any JSON-serializable value: arrays keep their order,
// object keys are sorted, scalars pass through. Integer-like keys land in JS
// enumeration order (ascending numeric) after assignment, matching the
// authoritative canonical form. Title/keywords/tags/revision are not hashed.
function recursiveKeySortedSource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursiveKeySortedSource)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    result[key] = recursiveKeySortedSource(value[key])
  }
  return result
}

// Structural guards -----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((entry) => entry === value)
}

function isSensitivity(value: unknown): value is CtxPackSensitivity {
  return isOneOf(value, SENSITIVITIES)
}

export function isCtxPackError(input: unknown): input is CtxPackError {
  if (!isRecord(input)) return false
  const tag = input._tag
  if (typeof tag !== "string") return false
  switch (tag) {
    case "CtxPackNotFound":
    case "CtxPackDeleted":
      return typeof input.ctxPackID === "string"
    case "CtxPackRevisionConflict":
      return typeof input.currentRevision === "number"
    case "CtxPackContentChanged":
      return typeof input.currentContentHash === "string"
    case "CtxPackInvalidSelection":
      return typeof input.reason === "string"
    case "CtxPackBudgetExceeded":
      return typeof input.bytes === "number" && typeof input.estimatedTokens === "number"
    case "CtxPackSecretSourceDenied":
      return typeof input.clientFragmentID === "string"
    case "CtxPackCrossWorkspaceDenied":
      return typeof input.sourceWorkspaceID === "string"
    case "CtxPackPermissionDenied":
      return typeof input.operation === "string"
    case "CtxPackSearchCursorInvalid":
      return true
    default:
      return false
  }
}

// Error helpers ---------------------------------------------------------------

function invalidSelection(reason: string): CtxPackError {
  return { _tag: "CtxPackInvalidSelection", reason }
}

function fail(reason: string): never {
  throw invalidSelection(reason)
}

function budgetExceeded(bytes: number, estimatedTokens: number): CtxPackError {
  return { _tag: "CtxPackBudgetExceeded", bytes, estimatedTokens }
}

function secretSource(clientFragmentID: string): CtxPackError {
  return { _tag: "CtxPackSecretSourceDenied", clientFragmentID }
}

function crossWorkspace(sourceWorkspaceID: string): CtxPackError {
  return { _tag: "CtxPackCrossWorkspaceDenied", sourceWorkspaceID }
}

// Primitive guards ------------------------------------------------------------

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path}: expected an object`)
  return value
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}: unsupported property`)
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path}: expected a string`)
  return value
}

function requireIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${path}: expected a nonempty string`)
  return value
}

function requireCtxPackID(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.startsWith("ctxpk_")) fail(`${path}: expected a ctxpk_ identifier`)
  return value
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path}: expected a boolean`)
  return value
}

function requireNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`${path}: expected a nonnegative safe integer`)
  return value
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (!isOneOf(value, allowed)) {
    fail(`${path}: expected one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`)
  }
  return value
}

function requireSensitivity(value: unknown, path: string): CtxPackSensitivity {
  if (!isSensitivity(value)) fail(`${path}: expected public, workspace, or private`)
  return value
}

function requireSourceKind(value: unknown, path: string): CtxPackSourceKind {
  return requireEnum(value, path, SOURCE_KINDS)
}

function requireNullable<T>(value: unknown, path: string, check: (value: unknown, path: string) => T): T | null {
  if (value === null) return null
  return check(value, path)
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

// Field normalizers -----------------------------------------------------------

function validateTitle(value: unknown, path: string): string {
  const trimmed = requireString(value, path).trim()
  const length = codePointLength(trimmed)
  if (length < 1 || length > LIMITS.titleMaxCodePoints)
    fail(`${path}: title must be 1-${LIMITS.titleMaxCodePoints} code points`)
  return trimmed
}

function normalizeKeywords(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${path}: expected an array`)
  const entries: readonly unknown[] = value
  const result: string[] = []
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const normalized = normalizeKeyword(requireString(entry, `${path}[${index}]`))
    if (normalized.length === 0 || codePointLength(normalized) > LIMITS.keywordMaxCodePoints)
      fail(`${path}[${index}]: keywords must be 1-${LIMITS.keywordMaxCodePoints} code points after normalization`)
    // Case-insensitive dedup keeps the first display spelling.
    const dedupeKey = normalized.toLowerCase()
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey)
      result.push(normalized)
    }
  })
  if (result.length > LIMITS.keywordMaxCount) fail(`${path}: at most ${LIMITS.keywordMaxCount} keywords`)
  return result
}

function normalizeTags(value: unknown, path: string): readonly CtxPackTag[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${path}: expected an array`)
  const entries: readonly unknown[] = value
  const result: CtxPackTag[] = []
  entries.forEach((entry, index) => {
    const tag = requireEnum(entry, `${path}[${index}]`, TAGS)
    if (!result.includes(tag)) result.push(tag)
  })
  return result
}

// Source parsing --------------------------------------------------------------

// Sensitivity is parsed as a plain string so callers that bypassed schema
// decoding can be rejected with CtxPackSecretSourceDenied (not a generic
// invalid-selection) at the same point the service checks it.
type ParsedSource = Omit<CtxPackSource, "sensitivity"> & { readonly sensitivity: string }

function parseSource(value: unknown, path: string): ParsedSource {
  const record = requireRecord(value, path)
  rejectUnknownKeys(record, SOURCE_KEYS, path)
  return {
    workspaceID: requireString(record.workspaceID, `${path}.workspaceID`),
    blockID: requireString(record.blockID, `${path}.blockID`),
    functionalityID: requireString(record.functionalityID, `${path}.functionalityID`),
    kind: requireEnum(record.kind, `${path}.kind`, SOURCE_KINDS),
    direction: requireEnum(record.direction, `${path}.direction`, DIRECTIONS),
    sourceTimestamp: requireNullable(record.sourceTimestamp, `${path}.sourceTimestamp`, requireNonNegativeInt),
    capturedAt: requireNonNegativeInt(record.capturedAt, `${path}.capturedAt`),
    entityRef: parseEntityRef(record.entityRef, `${path}.entityRef`),
    label: requireNullable(record.label, `${path}.label`, requireString),
    metadata: parseMetadata(record.metadata, `${path}.metadata`),
    sensitivity: requireString(record.sensitivity, `${path}.sensitivity`),
  }
}

function parseEntityRef(value: unknown, path: string): CtxPackSource["entityRef"] {
  if (value === null) return null
  const record = requireRecord(value, path)
  rejectUnknownKeys(record, ENTITY_REF_KEYS, path)
  return {
    type: requireString(record.type, `${path}.type`),
    id: requireString(record.id, `${path}.id`),
  }
}

function parseMetadata(value: unknown, path: string): Readonly<Record<string, string | number | boolean | null>> {
  const record = requireRecord(value, path)
  const result: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(record)) {
    const entry = record[key]
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      result[key] = entry
      continue
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry
      continue
    }
    fail(`${path}.${key}: expected a string, finite number, boolean, or null`)
  }
  return result
}

// Create ----------------------------------------------------------------------

export function normalizeCreate(input: unknown): CtxPackCreateRequest & { readonly tags: readonly CtxPackTag[] } {
  const record = requireRecord(input, "create")
  rejectUnknownKeys(record, CREATE_KEYS, "create")
  const workspaceID = requireIdentifier(record.workspaceID, "create.workspaceID")
  const title = validateTitle(record.title, "create.title")
  const keywords = normalizeKeywords(record.keywords, "create.keywords")
  const tags = normalizeTags(record.tags, "create.tags")
  const sensitivity = requireSensitivity(record.sensitivity, "create.sensitivity")
  const fragments = normalizeCreateFragments(record.fragments, workspaceID, sensitivity)
  const idempotencyKey = requireIdentifier(record.idempotencyKey, "create.idempotencyKey")
  return { workspaceID, title, keywords, tags, sensitivity, fragments, idempotencyKey }
}

function normalizeCreateFragments(
  value: unknown,
  workspaceID: string,
  sensitivity: CtxPackSensitivity,
): readonly CtxPackFragmentInput[] {
  if (!Array.isArray(value)) fail("create.fragments: expected an array")
  const entries: readonly unknown[] = value
  if (entries.length < LIMITS.fragmentMinCount || entries.length > LIMITS.fragmentMaxCount)
    fail(`create.fragments: fragments must be between ${LIMITS.fragmentMinCount} and ${LIMITS.fragmentMaxCount}`)

  const captured: CtxPackFragmentInput[] = []
  let totalBytes = 0
  entries.forEach((entry, index) => {
    const path = `create.fragments[${index}]`
    const record = requireRecord(entry, path)
    rejectUnknownKeys(record, FRAGMENT_KEYS, path)
    const clientFragmentID = requireIdentifier(record.clientFragmentID, `${path}.clientFragmentID`)
    const text = normalizeSelectedText(requireString(record.text, `${path}.text`))
    if (text.length === 0) fail(`${path}: fragment must not be empty after normalization`)

    const source = parseSource(record.source, `${path}.source`)
    if (source.workspaceID !== workspaceID) throw crossWorkspace(source.workspaceID)
    if (!isSensitivity(source.sensitivity)) throw secretSource(clientFragmentID)
    const validatedSensitivity = source.sensitivity

    totalBytes += utf8ByteLength(text)
    captured.push({ clientFragmentID, text, source: { ...source, sensitivity: validatedSensitivity } })
  })

  const totalTokens = estimateTokens(totalBytes)
  if (totalBytes > LIMITS.totalMaxBytes || totalTokens > LIMITS.totalMaxEstimatedTokens)
    throw budgetExceeded(totalBytes, totalTokens)

  const fragments = captured.flatMap((fragment) => splitFragment(fragment))
  if (fragments.length < LIMITS.fragmentMinCount || fragments.length > LIMITS.fragmentMaxCount)
    fail(`create.fragments: fragments must be between ${LIMITS.fragmentMinCount} and ${LIMITS.fragmentMaxCount}`)

  // A pack can never be less sensitive than any of its fragment sources.
  const strictest = fragments.reduce(
    (max, fragment) => Math.max(max, SENSITIVITY_RANK[fragment.source.sensitivity]),
    0,
  )
  if (SENSITIVITY_RANK[sensitivity] < strictest)
    fail(`requested sensitivity ${sensitivity} is weaker than the strictest fragment source sensitivity`)

  return fragments
}

// Split oversized fragments into <=16KiB chunks on Unicode code-point
// boundaries, preserving source metadata. clientFragmentID gains a :N suffix
// only when a fragment actually splits.
function splitFragment(fragment: CtxPackFragmentInput): CtxPackFragmentInput[] {
  if (utf8ByteLength(fragment.text) <= LIMITS.fragmentMaxBytes) return [fragment]
  const slices: string[] = []
  let chunk: string[] = []
  let chunkBytes = 0
  for (const point of fragment.text) {
    const pointBytes = utf8ByteLength(point)
    if (chunkBytes + pointBytes > LIMITS.fragmentMaxBytes) {
      slices.push(chunk.join(""))
      chunk = []
      chunkBytes = 0
    }
    chunk.push(point)
    chunkBytes += pointBytes
  }
  if (chunk.length > 0) slices.push(chunk.join(""))
  return slices.map((text, index) => ({
    clientFragmentID: `${fragment.clientFragmentID}:${index + 1}`,
    text,
    source: fragment.source,
  }))
}

// Patch -----------------------------------------------------------------------

export function normalizePatch(input: unknown, sources: readonly CtxPackSource[]): CtxPackPatchRequest {
  const record = requireRecord(input, "patch")
  rejectUnknownKeys(record, PATCH_KEYS, "patch")
  const workspaceID = requireIdentifier(record.workspaceID, "patch.workspaceID")
  const ctxPackID = requireCtxPackID(record.ctxPackID, "patch.ctxPackID")
  const expectedRevision = requireNonNegativeInt(record.expectedRevision, "patch.expectedRevision")
  const patch = normalizePatchFields(record.patch, sources)
  const idempotencyKey = requireIdentifier(record.idempotencyKey, "patch.idempotencyKey")
  return { workspaceID, ctxPackID, expectedRevision, patch, idempotencyKey }
}

function normalizePatchFields(value: unknown, sources: readonly CtxPackSource[]): CtxPackPatchRequest["patch"] {
  const record = requireRecord(value, "patch.patch")
  rejectUnknownKeys(record, PATCH_FIELD_KEYS, "patch.patch")
  const result: {
    title?: string
    keywords?: readonly string[]
    tags?: readonly CtxPackTag[]
    sensitivity?: CtxPackSensitivity
  } = {}
  if (record.title !== undefined) result.title = validateTitle(record.title, "patch.patch.title")
  if (record.keywords !== undefined) result.keywords = normalizeKeywords(record.keywords, "patch.patch.keywords")
  if (record.tags !== undefined) result.tags = normalizeTags(record.tags, "patch.patch.tags")
  if (record.sensitivity !== undefined) {
    const sensitivity = requireSensitivity(record.sensitivity, "patch.patch.sensitivity")
    const strictest = sources.reduce((max, source) => {
      if (!isSensitivity(source.sensitivity))
        fail("patch.patch.sensitivity: fragment source sensitivity must be public, workspace, or private")
      return Math.max(max, SENSITIVITY_RANK[source.sensitivity])
    }, 0)
    if (SENSITIVITY_RANK[sensitivity] < strictest)
      fail(`requested sensitivity ${sensitivity} is weaker than the strictest fragment source sensitivity`)
    result.sensitivity = sensitivity
  }
  return result
}

// List ------------------------------------------------------------------------

export function normalizeList(input: unknown): CtxPackListRequest {
  const record = requireRecord(input, "list")
  rejectUnknownKeys(record, LIST_KEYS, "list")
  const workspaceID = requireIdentifier(record.workspaceID, "list.workspaceID")
  const query = requireString(record.query, "list.query")
  if (codePointLength(query) > LIMITS.queryMaxCodePoints)
    fail(`list.query: query must be at most ${LIMITS.queryMaxCodePoints} code points`)
  const limit = requireNonNegativeInt(record.limit, "list.limit")
  if (limit < LIMITS.listLimitMin || limit > LIMITS.listLimitMax)
    fail(`list.limit: limit must be between ${LIMITS.listLimitMin} and ${LIMITS.listLimitMax}`)
  return {
    workspaceID,
    // The raw query is returned unchanged; the repository applies buildFtsQuery.
    query,
    keyword: requireNullable(record.keyword, "list.keyword", requireString),
    sourceBlockID: requireNullable(record.sourceBlockID, "list.sourceBlockID", requireString),
    sourceFunctionalityID: requireNullable(record.sourceFunctionalityID, "list.sourceFunctionalityID", requireString),
    sourceKind: requireNullable(record.sourceKind, "list.sourceKind", requireSourceKind),
    sensitivity: requireNullable(record.sensitivity, "list.sensitivity", requireSensitivity),
    createdAfter: requireNullable(record.createdAfter, "list.createdAfter", requireNonNegativeInt),
    createdBefore: requireNullable(record.createdBefore, "list.createdBefore", requireNonNegativeInt),
    includeDeleted: requireBoolean(record.includeDeleted, "list.includeDeleted"),
    pinnedOnly: requireBoolean(record.pinnedOnly, "list.pinnedOnly"),
    sort: requireEnum(record.sort, "list.sort", SORTS),
    cursor: requireNullable(record.cursor, "list.cursor", requireString),
    limit,
  }
}

// FTS query -------------------------------------------------------------------

// The FTS5 tokenizer (unicode61) tokenizes letters, digits, and underscores.
// Tokens without any of those can never match and some are FTS5 syntax
// hazards even when quoted, so they are dropped up front.
const TOKEN_CHAR = /[\p{L}\p{N}_]/u

export function buildFtsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => normalizeKeyword(token))
    .filter((token) => token.length > 0 && TOKEN_CHAR.test(token))
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ")
}

// Recall terms ----------------------------------------------------------------

const RECALL_STOP_WORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
])

const TRIVIAL_TURNS = new Set<string>(["hi", "hello", "hey", "ok", "okay", "thanks", "thank you", "got it", "sounds good"])
const RECALL_TOKEN = /[\p{L}\p{N}]+/gu

export function buildRecallTerms(text: string): readonly string[] {
  const terms = Array.from(text.normalize("NFKC").toLowerCase().matchAll(RECALL_TOKEN), (match) => match[0])
  return terms.filter((term, index) => !RECALL_STOP_WORDS.has(term) && terms.indexOf(term) === index).slice(0, 8)
}

export function isTrivialRecallTurn(text: string): boolean {
  return TRIVIAL_TURNS.has(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\p{P}+/gu, " ")
      .trim()
      .replace(/\s+/g, " "),
  )
}
