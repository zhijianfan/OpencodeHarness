// Authorized CtxPack catalog adapter.
//
// This module owns the extension tables for CtxPack packs and fragments in the
// SAME selected native database as the host kernel. It ports the baseline
// custom `ctxpack/sql.ts` + `ctxpack/service.ts` behavior onto `cm_`-prefixed
// tables and journals its bootstrap under `cm_migration` id
// `0007-ctxpack-catalog`. The legacy `ctx_pack*` tables are never read,
// written, or deleted here; they are left for a later copy migration:
//
//   cm_ctx_pack          <- ctx_pack
//   cm_ctx_pack_fragment <- ctx_pack_fragment
//   cm_ctx_pack_keyword  <- ctx_pack_keyword
//   cm_ctx_pack_pin      <- ctx_pack_pin
//   cm_ctx_pack_fts      <- ctx_pack_fts
//
// All writes run through `EventBoundary.transaction` so notifications are
// delivered only after commit and are suppressed when an outer transaction
// rolls back. Change hints carry only identifiers and revision metadata; they
// never carry fragment text.

import { ascending } from "@opencode-ai/schema/identifier"
// Runtime imports stay on official native packages and the two frozen
// cybermastery contract/domain entrypoints; fork CtxPack sources are reference
// only and are never imported here.
import type {
  CtxPackAccess,
  CtxPackActor,
  CtxPackChanged,
  CtxPackDirection,
  CtxPackError,
  CtxPackFragment,
  CtxPackInfo,
  CtxPackListResult,
  CtxPackOperation,
  CtxPackSensitivity,
  CtxPackSort,
  CtxPackSource,
  CtxPackSourceKind,
  CtxPackSummary,
  CtxPackTag,
} from "@cybermastery/contracts/ctxpack"
import {
  buildFtsQuery,
  contentHash,
  estimateTokens,
  isCtxPackError,
  normalizeCreate,
  normalizeKeyword,
  normalizeList,
  normalizePatch,
  normalizeSelectedText,
  utf8ByteLength,
} from "@cybermastery/domain/ctxpack-content"
import { Database } from "@opencode-ai/core/database/database"
import { sql, type SQL } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { EventBoundary } from "./event-boundary"

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CtxPackCatalogOptions {
  readonly authorize: (request: CtxPackAccess) => Effect.Effect<void, CtxPackError>
  readonly publish?: (event: CtxPackChanged) => Effect.Effect<void>
  readonly now?: () => number
}

export interface CtxPackCatalog {
  readonly create: (actor: CtxPackActor, request: unknown) => Effect.Effect<CtxPackInfo, CtxPackError>
  readonly get: (
    actor: CtxPackActor,
    ctxPackID: string,
    includeDeleted?: boolean,
  ) => Effect.Effect<CtxPackInfo, CtxPackError>
  readonly list: (actor: CtxPackActor, request: unknown) => Effect.Effect<CtxPackListResult, CtxPackError>
  readonly patch: (actor: CtxPackActor, request: unknown) => Effect.Effect<CtxPackInfo, CtxPackError>
  readonly remove: (
    actor: CtxPackActor,
    input: { readonly ctxPackID: string; readonly expectedRevision: number },
  ) => Effect.Effect<CtxPackInfo, CtxPackError>
  readonly restore: (
    actor: CtxPackActor,
    input: { readonly ctxPackID: string; readonly expectedRevision: number },
  ) => Effect.Effect<CtxPackInfo, CtxPackError>
  readonly pin: (actor: CtxPackActor, ctxPackID: string) => Effect.Effect<CtxPackInfo, CtxPackError>
  readonly unpin: (actor: CtxPackActor, ctxPackID: string) => Effect.Effect<void, CtxPackError>
}

// ---------------------------------------------------------------------------
// Storage rows
// ---------------------------------------------------------------------------

type Db = Database.Interface["db"]

type PackRow = {
  id: string
  workspace_id: string
  created_by_user_id: string
  title: string
  tags_json: string
  sensitivity: string
  revision: number
  content_hash: string
  byte_length: number
  estimated_tokens: number
  attached_count: number
  last_attached_at: number | null
  create_idempotency_key: string
  time_created: number
  time_updated: number
  time_deleted: number | null
  pinned_at: number | null
}

type FragmentRow = {
  id: string
  ctx_pack_id: string
  ordinal: number
  text_content: string
  content_hash: string
  byte_length: number
  estimated_tokens: number
  source_workspace_id: string
  source_block_id: string
  source_functionality_id: string
  source_kind: string
  source_direction: string
  source_timestamp: number | null
  captured_at: number
  entity_ref_json: string | null
  source_label: string | null
  source_metadata_json: string
  source_sensitivity: string
}

type KeywordRow = {
  ctx_pack_id: string
  ordinal: number
  keyword_display: string
  keyword_normalized: string
}

// ---------------------------------------------------------------------------
// Stored JSON decoding
//
// Stored JSON is decoded through Effect Schema rather than unchecked casts. A
// corrupt stored shape is a sanitized defect and never surfaces fragment text.
// ---------------------------------------------------------------------------

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

function decodeSensitivity(value: string): CtxPackSensitivity {
  if (value === "public" || value === "workspace" || value === "private") return value
  throw new Error("Invalid ctxpack sensitivity")
}

function decodeSourceKind(value: string): CtxPackSourceKind {
  if (
    value === "message" ||
    value === "tool-output" ||
    value === "terminal" ||
    value === "file" ||
    value === "search" ||
    value === "note" ||
    value === "block-text"
  )
    return value
  throw new Error("Invalid ctxpack source kind")
}

function decodeDirection(value: string): CtxPackDirection {
  if (value === "sent" || value === "received" || value === "generated" || value === "unknown") return value
  throw new Error("Invalid ctxpack direction")
}

function decodeTags(raw: string): readonly CtxPackTag[] {
  const value = decodeJson(raw)
  if (!Array.isArray(value)) throw new Error("Invalid ctxpack tags")
  return value.map((entry: unknown) => {
    if (entry === "ParallelPlan") return entry
    throw new Error("Invalid ctxpack tag")
  })
}

function decodeMetadata(raw: string): Readonly<Record<string, string | number | boolean | null>> {
  const value = decodeJson(raw)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid ctxpack source metadata")
  const result: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(value)) {
    const entry: unknown = Reflect.get(value, key)
    if (entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      result[key] = entry
      continue
    }
    throw new Error("Invalid ctxpack source metadata value")
  }
  return result
}

function decodeEntityRef(raw: string | null): { readonly type: string; readonly id: string } | null {
  if (raw === null) return null
  const value = decodeJson(raw)
  if (value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ctxpack source entityRef")
  const type: unknown = Reflect.get(value, "type")
  const id: unknown = Reflect.get(value, "id")
  if (typeof type !== "string" || typeof id !== "string") throw new Error("Invalid ctxpack source entityRef")
  return { type, id }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function sourceFrom(row: FragmentRow): CtxPackSource {
  return {
    workspaceID: row.source_workspace_id,
    blockID: row.source_block_id,
    functionalityID: row.source_functionality_id,
    kind: decodeSourceKind(row.source_kind),
    direction: decodeDirection(row.source_direction),
    sourceTimestamp: row.source_timestamp,
    capturedAt: row.captured_at,
    entityRef: decodeEntityRef(row.entity_ref_json),
    label: row.source_label,
    metadata: decodeMetadata(row.source_metadata_json),
    sensitivity: decodeSensitivity(row.source_sensitivity),
  }
}

function fragmentFrom(row: FragmentRow): CtxPackFragment {
  return {
    id: row.id,
    ordinal: row.ordinal,
    // The client fragment id is a create-time input and is not persisted. The
    // server-assigned fragment id doubles as the stable client reference.
    clientFragmentID: row.id,
    text: row.text_content,
    source: sourceFrom(row),
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    estimatedTokens: row.estimated_tokens,
  }
}

function infoFrom(row: PackRow, fragments: readonly FragmentRow[], keywords: readonly KeywordRow[]): CtxPackInfo {
  return {
    id: row.id,
    workspaceID: row.workspace_id,
    title: row.title,
    keywords: keywords.map((keyword) => keyword.keyword_display),
    tags: decodeTags(row.tags_json),
    sensitivity: decodeSensitivity(row.sensitivity),
    revision: row.revision,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    estimatedTokens: row.estimated_tokens,
    fragments: fragments.map(fragmentFrom),
    usage: { attachedCount: row.attached_count, lastAttachedAt: row.last_attached_at },
    createdByUserID: row.created_by_user_id,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    deletedAt: row.time_deleted,
    pinnedAt: row.pinned_at,
  }
}

function summaryFrom(row: PackRow, fragments: readonly FragmentRow[], keywords: readonly KeywordRow[]): CtxPackSummary {
  const sourceBlockIDs = [...new Set(fragments.map((fragment) => fragment.source_block_id))]
  const sourceFunctionalityIDs = [...new Set(fragments.map((fragment) => fragment.source_functionality_id))]
  const sourceKinds: CtxPackSourceKind[] = []
  for (const fragment of fragments) {
    const kind = decodeSourceKind(fragment.source_kind)
    if (!sourceKinds.includes(kind)) sourceKinds.push(kind)
  }
  return {
    id: row.id,
    workspaceID: row.workspace_id,
    title: row.title,
    keywords: keywords.map((keyword) => keyword.keyword_display),
    tags: decodeTags(row.tags_json),
    sensitivity: decodeSensitivity(row.sensitivity),
    revision: row.revision,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    estimatedTokens: row.estimated_tokens,
    fragmentCount: fragments.length,
    sourceBlockIDs,
    sourceFunctionalityIDs,
    sourceKinds,
    usage: { attachedCount: row.attached_count, lastAttachedAt: row.last_attached_at },
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    deletedAt: row.time_deleted,
    pinnedAt: row.pinned_at,
  }
}

function ftsKeywords(keywords: readonly KeywordRow[]): string {
  return keywords
    .map((keyword) => keyword.keyword_normalized)
    .join(" ")
    .trim()
}

function ftsContent(fragments: readonly FragmentRow[]): string {
  return fragments.map((fragment) => fragment.text_content).join("\n")
}

function groupBy<Key, Value>(keyOf: (value: Value) => Key, values: readonly Value[]): Map<Key, Value[]> {
  const result = new Map<Key, Value[]>()
  for (const value of values) {
    const key = keyOf(value)
    const bucket = result.get(key)
    if (bucket) bucket.push(value)
    else result.set(key, [value])
  }
  return result
}

// ---------------------------------------------------------------------------
// Domain errors, validation wrapping, and effects
// ---------------------------------------------------------------------------

const notFound = (ctxPackID: string): CtxPackError => ({ _tag: "CtxPackNotFound", ctxPackID })
const deleted = (ctxPackID: string): CtxPackError => ({ _tag: "CtxPackDeleted", ctxPackID })
const conflict = (currentRevision: number): CtxPackError => ({
  _tag: "CtxPackRevisionConflict",
  currentRevision,
})
const denied = (operation: string): CtxPackError => ({ _tag: "CtxPackPermissionDenied", operation })
const invalidCursor = (): CtxPackError => ({ _tag: "CtxPackSearchCursorInvalid" })

// Domain helpers throw `CtxPackError` shaped values. They are synchronous, so
// they are bridged at the boundary; unexpected throws stay defects so
// storage/programming failures are never mislabeled as domain errors.
function attempt<A>(thunk: () => A): Effect.Effect<A, CtxPackError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(thunk())
    } catch (error) {
      if (isCtxPackError(error)) return Effect.fail(error)
      return Effect.die(error)
    }
  })
}

// Unknown SQL/driver failures surface as sanitized defects; only domain errors
// fail the effect.
function toDomainError<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CtxPackError, R> {
  return effect.pipe(
    Effect.catch((error) => isCtxPackError(error) ? Effect.fail(error) : Effect.die(new Error("CtxPack storage failure"))),
    Effect.catchDefect(() => Effect.die(new Error("CtxPack storage failure"))),
  )
}

// ---------------------------------------------------------------------------
// Cursors (Base64URL JSON v1)
// ---------------------------------------------------------------------------

const CURSOR_VERSION = 1

type Cursor = { readonly value: string | number | null; readonly id: string }

function encodeCursor(sort: CtxPackSort, value: string | number | null, id: string): string {
  return Buffer.from(JSON.stringify({ version: CURSOR_VERSION, sort, value, id })).toString("base64url")
}

function normalizeCursorValue(sort: CtxPackSort, value: unknown): string | number | null | undefined {
  if (sort === "title-asc") return typeof value === "string" ? value : undefined
  if (sort === "recently-attached") {
    if (value === null) return null
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function decodeCursor(cursor: string, sort: CtxPackSort): Cursor | null {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(
    Buffer.from(cursor, "base64url").toString("utf8"),
  )
  if (Option.isNone(parsed)) return null
  const record = parsed.value
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null
  if (Reflect.get(record, "version") !== CURSOR_VERSION) return null
  if (Reflect.get(record, "sort") !== sort) return null
  const id: unknown = Reflect.get(record, "id")
  if (typeof id !== "string" || id.length === 0) return null
  const value = normalizeCursorValue(sort, Reflect.get(record, "value"))
  if (value === undefined) return null
  return { value, id }
}

// ---------------------------------------------------------------------------
// Sort specifications
// ---------------------------------------------------------------------------

type SortSpec = {
  readonly column: SQL
  readonly direction: "ASC" | "DESC"
  readonly nullsLast: boolean
  readonly value: (row: PackRow) => string | number | null
}

const SORTS: Record<CtxPackSort, SortSpec> = {
  "created-desc": {
    column: sql`p.time_created`,
    direction: "DESC",
    nullsLast: false,
    value: (row) => row.time_created,
  },
  "created-asc": {
    column: sql`p.time_created`,
    direction: "ASC",
    nullsLast: false,
    value: (row) => row.time_created,
  },
  "updated-desc": {
    column: sql`p.time_updated`,
    direction: "DESC",
    nullsLast: false,
    value: (row) => row.time_updated,
  },
  "title-asc": { column: sql`p.title`, direction: "ASC", nullsLast: false, value: (row) => row.title },
  "tokens-desc": {
    column: sql`p.estimated_tokens`,
    direction: "DESC",
    nullsLast: false,
    value: (row) => row.estimated_tokens,
  },
  "most-attached": {
    column: sql`p.attached_count`,
    direction: "DESC",
    nullsLast: false,
    value: (row) => row.attached_count,
  },
  "recently-attached": {
    column: sql`p.last_attached_at`,
    direction: "DESC",
    nullsLast: true,
    value: (row) => row.last_attached_at,
  },
}

function cursorCondition(sort: SortSpec, cursor: Cursor): SQL {
  const { column, direction, nullsLast } = sort
  const value = cursor.value
  const id = cursor.id
  if (direction === "DESC") {
    if (nullsLast && value === null) return sql`(${column} IS NULL AND p.id < ${id})`
    if (nullsLast) return sql`(${column} IS NULL OR ${column} < ${value} OR (${column} = ${value} AND p.id < ${id}))`
    return sql`(${column} < ${value} OR (${column} = ${value} AND p.id < ${id}))`
  }
  if (nullsLast && value === null) return sql`(${column} IS NULL AND p.id > ${id})`
  if (nullsLast) return sql`(${column} IS NULL OR ${column} > ${value} OR (${column} = ${value} AND p.id > ${id}))`
  return sql`(${column} > ${value} OR (${column} = ${value} AND p.id > ${id}))`
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(db: Db, now: number) {
  return db.transaction(() =>
    Effect.gen(function* () {
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_migration (
        id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL
      )`)
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_ctx_pack (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        attached_count INTEGER NOT NULL DEFAULT 0,
        last_attached_at INTEGER,
        create_idempotency_key TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_deleted INTEGER
      )`)
      yield* db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS cm_ctx_pack_create_idempotency_idx
        ON cm_ctx_pack (workspace_id, created_by_user_id, create_idempotency_key)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_workspace_created_idx
        ON cm_ctx_pack (workspace_id, time_created DESC, id DESC)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_workspace_updated_idx
        ON cm_ctx_pack (workspace_id, time_updated DESC, id DESC)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_workspace_usage_idx
        ON cm_ctx_pack (workspace_id, attached_count DESC, id DESC)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_workspace_last_used_idx
        ON cm_ctx_pack (workspace_id, last_attached_at DESC, id DESC)`)
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_ctx_pack_fragment (
        id TEXT PRIMARY KEY NOT NULL,
        ctx_pack_id TEXT NOT NULL REFERENCES cm_ctx_pack(id),
        ordinal INTEGER NOT NULL,
        text_content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        source_workspace_id TEXT NOT NULL,
        source_block_id TEXT NOT NULL,
        source_functionality_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_direction TEXT NOT NULL,
        source_timestamp INTEGER,
        captured_at INTEGER NOT NULL,
        entity_ref_json TEXT,
        source_label TEXT,
        source_metadata_json TEXT NOT NULL,
        source_sensitivity TEXT NOT NULL
      )`)
      yield* db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS cm_ctx_pack_fragment_pack_ordinal_idx
        ON cm_ctx_pack_fragment (ctx_pack_id, ordinal)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_fragment_pack_idx
        ON cm_ctx_pack_fragment (ctx_pack_id, ordinal)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_fragment_source_block_idx
        ON cm_ctx_pack_fragment (source_workspace_id, source_block_id, ctx_pack_id)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_fragment_source_functionality_idx
        ON cm_ctx_pack_fragment (source_workspace_id, source_functionality_id, ctx_pack_id)`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_fragment_source_kind_idx
        ON cm_ctx_pack_fragment (source_workspace_id, source_kind, ctx_pack_id)`)
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_ctx_pack_keyword (
        ctx_pack_id TEXT NOT NULL REFERENCES cm_ctx_pack(id),
        ordinal INTEGER NOT NULL,
        keyword_display TEXT NOT NULL,
        keyword_normalized TEXT NOT NULL,
        PRIMARY KEY (ctx_pack_id, keyword_normalized)
      )`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_keyword_lookup_idx
        ON cm_ctx_pack_keyword (keyword_normalized, ctx_pack_id)`)
      yield* db.run(sql`CREATE TABLE IF NOT EXISTS cm_ctx_pack_pin (
        workspace_id TEXT NOT NULL,
        ctx_pack_id TEXT NOT NULL REFERENCES cm_ctx_pack(id),
        user_id TEXT NOT NULL,
        time_pinned INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, ctx_pack_id, user_id)
      )`)
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS cm_ctx_pack_pin_workspace_user_idx
        ON cm_ctx_pack_pin (workspace_id, user_id, time_pinned DESC, ctx_pack_id DESC)`)
      // FTS5 is a virtual table drizzle cannot express, so it is always created
      // lazily before the first search/write. The tokenizer must match the
      // legacy table exactly.
      yield* db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS cm_ctx_pack_fts USING fts5(
        ctx_pack_id UNINDEXED,
        workspace_id UNINDEXED,
        title,
        keywords,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      )`)
      // When the virtual table was missing over existing catalog rows, backfill
      // every live pack transactionally. The NOT EXISTS guard keeps this
      // idempotent on later boots.
      yield* db.run(sql`INSERT INTO cm_ctx_pack_fts (ctx_pack_id, workspace_id, title, keywords, content)
        SELECT p.id, p.workspace_id, p.title,
          COALESCE((SELECT group_concat(keyword_normalized, ' ') FROM
            (SELECT keyword_normalized FROM cm_ctx_pack_keyword WHERE ctx_pack_id = p.id ORDER BY ordinal)), ''),
          COALESCE((SELECT group_concat(text_content, char(10)) FROM
            (SELECT text_content FROM cm_ctx_pack_fragment WHERE ctx_pack_id = p.id ORDER BY ordinal)), '')
        FROM cm_ctx_pack p
        WHERE p.time_deleted IS NULL
          AND NOT EXISTS (SELECT 1 FROM cm_ctx_pack_fts WHERE ctx_pack_id = p.id)`)
      yield* db.run(sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
        VALUES ('0007-ctxpack-catalog', ${now})`)
    }),
  )
}

// ---------------------------------------------------------------------------
// Catalog constructor
// ---------------------------------------------------------------------------

export function makeCtxPackCatalog(
  options: CtxPackCatalogOptions,
): Effect.Effect<CtxPackCatalog, never, Database.Service | EventBoundary> {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const boundary = yield* EventBoundary
    const db: Db = database.db
    const now = (): number => options.now?.() ?? Date.now()

    yield* bootstrap(db, now()).pipe(Effect.orDie)

    const selectRow = (workspaceID: string, ctxPackID: string, viewerUserID?: string) =>
      db.get<PackRow>(
        sql`SELECT p.*, pin.time_pinned AS pinned_at FROM cm_ctx_pack p
          LEFT JOIN cm_ctx_pack_pin pin
            ON pin.workspace_id = p.workspace_id AND pin.ctx_pack_id = p.id AND pin.user_id = ${viewerUserID ?? ""}
          WHERE p.id = ${ctxPackID} AND p.workspace_id = ${workspaceID}`,
      )

    const selectFragments = (ctxPackID: string) =>
      db.all<FragmentRow>(sql`SELECT * FROM cm_ctx_pack_fragment WHERE ctx_pack_id = ${ctxPackID} ORDER BY ordinal`)

    const selectKeywords = (ctxPackID: string) =>
      db.all<KeywordRow>(sql`SELECT * FROM cm_ctx_pack_keyword WHERE ctx_pack_id = ${ctxPackID} ORDER BY ordinal`)

    const loadInfo = (workspaceID: string, ctxPackID: string, viewerUserID?: string) =>
      Effect.gen(function* () {
        const row = yield* selectRow(workspaceID, ctxPackID, viewerUserID)
        if (!row) return yield* Effect.fail(notFound(ctxPackID))
        const fragments = yield* selectFragments(ctxPackID)
        const keywords = yield* selectKeywords(ctxPackID)
        return infoFrom(row, fragments, keywords)
      })

    // Private packs deny every operation to a non-creator independent of the
    // injected capability policy (baseline deny-first rule).
    const requireAccess = (
      actor: CtxPackActor,
      operation: CtxPackOperation,
      info: CtxPackInfo | null,
    ): Effect.Effect<void, CtxPackError> =>
      Effect.gen(function* () {
        if (info !== null && info.sensitivity === "private" && info.createdByUserID !== actor.userID)
          return yield* Effect.fail(denied(operation))
        yield* options.authorize(info === null ? { actor, operation } : { actor, operation, pack: info })
      })

    const publishHint = (event: CtxPackChanged): Effect.Effect<void> =>
      Effect.suspend(() => options.publish ? options.publish(event) : Effect.void).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.void,
        ),
      )

    const create: CtxPackCatalog["create"] = (actor, request) =>
      toDomainError(
        Effect.gen(function* () {
          const normalized = yield* attempt(() => normalizeCreate(request))
          if (normalized.workspaceID !== actor.workspaceID) return yield* Effect.fail(denied("ctxpack.create"))
          yield* requireAccess(actor, "ctxpack.create", null)

          const timestamp = now()
          const fragments = normalized.fragments.map((fragment, ordinal) => {
            const text = normalizeSelectedText(fragment.text)
            const byteLength = utf8ByteLength(text)
            return {
              id: `ctxpkf_${ascending()}`,
              ordinal,
              text,
              source: fragment.source,
              contentHash: contentHash([{ ordinal, text, source: fragment.source }]),
              byteLength,
              estimatedTokens: estimateTokens(byteLength),
            }
          })
          const packHash = contentHash(
            normalized.fragments.map((fragment, ordinal) => ({
              ordinal,
              text: normalizeSelectedText(fragment.text),
              source: fragment.source,
            })),
          )
          const byteLength = fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0)
          const estimatedTokens = fragments.reduce((sum, fragment) => sum + fragment.estimatedTokens, 0)
          const keywords = normalized.keywords.map((keyword, ordinal) => ({
            ordinal,
            display: keyword,
            normalized: normalizeKeyword(keyword),
          }))

          const outcome = yield* boundary.transaction(
            Effect.gen(function* () {
              yield* requireAccess(actor, "ctxpack.create", null)
              const id = `ctxpk_${ascending()}`
              const inserted = yield* db.get<{ id: string }>(sql`INSERT INTO cm_ctx_pack
                (id, workspace_id, created_by_user_id, title, tags_json, sensitivity, revision, content_hash, byte_length, estimated_tokens, attached_count, last_attached_at, create_idempotency_key, time_created, time_updated, time_deleted)
                VALUES (${id}, ${normalized.workspaceID}, ${actor.userID}, ${normalized.title}, ${JSON.stringify(normalized.tags)}, ${normalized.sensitivity}, 1, ${packHash}, ${byteLength}, ${estimatedTokens}, 0, NULL, ${normalized.idempotencyKey}, ${timestamp}, ${timestamp}, NULL)
                ON CONFLICT(workspace_id, created_by_user_id, create_idempotency_key) DO NOTHING RETURNING id`)
              if (!inserted) {
                // Idempotent replay: return the original winner even when a
                // different valid payload reused the key.
                const winner = yield* db.get<PackRow>(sql`SELECT p.*, NULL AS pinned_at FROM cm_ctx_pack p
                  WHERE p.workspace_id = ${normalized.workspaceID}
                    AND p.created_by_user_id = ${actor.userID}
                    AND p.create_idempotency_key = ${normalized.idempotencyKey}`)
                if (!winner) return yield* Effect.die(new Error("ctxpack create race did not find winner row"))
                return { info: yield* loadInfo(actor.workspaceID, winner.id, actor.userID), created: false }
              }
              for (const fragment of fragments) {
                yield* db.run(sql`INSERT INTO cm_ctx_pack_fragment
                  (id, ctx_pack_id, ordinal, text_content, content_hash, byte_length, estimated_tokens, source_workspace_id, source_block_id, source_functionality_id, source_kind, source_direction, source_timestamp, captured_at, entity_ref_json, source_label, source_metadata_json, source_sensitivity)
                  VALUES (${fragment.id}, ${id}, ${fragment.ordinal}, ${fragment.text}, ${fragment.contentHash}, ${fragment.byteLength}, ${fragment.estimatedTokens}, ${fragment.source.workspaceID}, ${fragment.source.blockID}, ${fragment.source.functionalityID}, ${fragment.source.kind}, ${fragment.source.direction}, ${fragment.source.sourceTimestamp}, ${fragment.source.capturedAt}, ${fragment.source.entityRef === null ? null : JSON.stringify(fragment.source.entityRef)}, ${fragment.source.label}, ${JSON.stringify(fragment.source.metadata)}, ${fragment.source.sensitivity})`)
              }
              for (const keyword of keywords) {
                yield* db.run(sql`INSERT INTO cm_ctx_pack_keyword
                  (ctx_pack_id, ordinal, keyword_display, keyword_normalized)
                  VALUES (${id}, ${keyword.ordinal}, ${keyword.display}, ${keyword.normalized})`)
              }
              yield* db.run(sql`INSERT INTO cm_ctx_pack_fts
                (ctx_pack_id, workspace_id, title, keywords, content)
                VALUES (${id}, ${normalized.workspaceID}, ${normalized.title}, ${keywords.map((keyword) => keyword.normalized).join(" ")}, ${fragments.map((fragment) => fragment.text).join("\n")})`)
              const info = yield* loadInfo(actor.workspaceID, id, actor.userID)
              yield* boundary.afterCommit(
                publishHint({
                  type: "workspace.ctxpack.changed",
                  properties: {
                    workspaceID: actor.workspaceID,
                    ctxPackID: id,
                    revision: info.revision,
                    change: "created",
                  },
                }),
              )
              return { info, created: true }
            }),
          )
          return outcome.info
        }),
      )

    const get: CtxPackCatalog["get"] = (actor, ctxPackID, includeDeleted) =>
      toDomainError(
        Effect.gen(function* () {
          const info = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
          yield* requireAccess(actor, "ctxpack.read", info)
          if (info.deletedAt !== null && !(includeDeleted ?? false))
            return yield* Effect.fail(deleted(ctxPackID))
          return info
        }),
      )

    const list: CtxPackCatalog["list"] = (actor, request) =>
      toDomainError(
        Effect.gen(function* () {
          const normalized = yield* attempt(() => normalizeList(request))
          if (normalized.workspaceID !== actor.workspaceID) return yield* Effect.fail(denied("ctxpack.read"))
          yield* requireAccess(actor, "ctxpack.read", null)

          const sort = SORTS[normalized.sort]
          const cursor = normalized.cursor === null ? null : decodeCursor(normalized.cursor, normalized.sort)
          if (normalized.cursor !== null && cursor === null) return yield* Effect.fail(invalidCursor())

          const conditions: SQL[] = [sql`p.workspace_id = ${actor.workspaceID}`]
          // Visibility is applied before pagination and counts so private rows
          // never leak through cursor positions or totals.
          conditions.push(sql`(p.sensitivity != 'private' OR p.created_by_user_id = ${actor.userID})`)
          if (normalized.pinnedOnly || !normalized.includeDeleted) conditions.push(sql`p.time_deleted IS NULL`)
          if (normalized.pinnedOnly) conditions.push(sql`pin.time_pinned IS NOT NULL`)
          if (normalized.sensitivity !== null) conditions.push(sql`p.sensitivity = ${normalized.sensitivity}`)
          if (normalized.createdAfter !== null) conditions.push(sql`p.time_created > ${normalized.createdAfter}`)
          if (normalized.createdBefore !== null) conditions.push(sql`p.time_created < ${normalized.createdBefore}`)
          if (normalized.keyword !== null)
            conditions.push(
              sql`EXISTS (SELECT 1 FROM cm_ctx_pack_keyword k WHERE k.ctx_pack_id = p.id AND k.keyword_normalized = ${normalizeKeyword(normalized.keyword)})`,
            )
          if (normalized.sourceBlockID !== null)
            conditions.push(
              sql`EXISTS (SELECT 1 FROM cm_ctx_pack_fragment f WHERE f.ctx_pack_id = p.id AND f.source_workspace_id = p.workspace_id AND f.source_block_id = ${normalized.sourceBlockID})`,
            )
          if (normalized.sourceFunctionalityID !== null)
            conditions.push(
              sql`EXISTS (SELECT 1 FROM cm_ctx_pack_fragment f WHERE f.ctx_pack_id = p.id AND f.source_workspace_id = p.workspace_id AND f.source_functionality_id = ${normalized.sourceFunctionalityID})`,
            )
          if (normalized.sourceKind !== null)
            conditions.push(
              sql`EXISTS (SELECT 1 FROM cm_ctx_pack_fragment f WHERE f.ctx_pack_id = p.id AND f.source_workspace_id = p.workspace_id AND f.source_kind = ${normalized.sourceKind})`,
            )
          const ftsQuery = buildFtsQuery(normalized.query)
          if (ftsQuery !== null && ftsQuery.length > 0)
            conditions.push(
              sql`EXISTS (SELECT 1 FROM cm_ctx_pack_fts WHERE ctx_pack_id = p.id AND workspace_id = p.workspace_id AND cm_ctx_pack_fts MATCH ${ftsQuery})`,
            )

          const join = sql`LEFT JOIN cm_ctx_pack_pin pin ON pin.workspace_id = p.workspace_id AND pin.ctx_pack_id = p.id AND pin.user_id = ${actor.userID}`
          const where = sql`WHERE ${sql.join(conditions, sql` AND `)}`
          const orderBy = sql`ORDER BY ${sort.column} ${sql.raw(sort.direction)}, p.id ${sql.raw(sort.direction)}`

          const rows = yield* db.all<PackRow>(sql`SELECT p.*, pin.time_pinned AS pinned_at FROM cm_ctx_pack p ${join} ${where} ${cursor === null ? sql`` : sql`AND ${cursorCondition(sort, cursor)}`} ${orderBy} LIMIT ${normalized.limit + 1}`)
          const count = yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM cm_ctx_pack p ${join} ${where}`)

          const page = rows.slice(0, normalized.limit)
          const last = page[page.length - 1]
          const nextCursor =
            rows.length > normalized.limit && last !== undefined
              ? encodeCursor(normalized.sort, sort.value(last), last.id)
              : null

          const ids = page.map((row) => row.id)
          const fragments =
            ids.length === 0
              ? []
              : yield* db.all<FragmentRow>(sql`SELECT * FROM cm_ctx_pack_fragment WHERE ctx_pack_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ORDER BY ctx_pack_id, ordinal`)
          const keywords =
            ids.length === 0
              ? []
              : yield* db.all<KeywordRow>(sql`SELECT * FROM cm_ctx_pack_keyword WHERE ctx_pack_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ORDER BY ctx_pack_id, ordinal`)

          const fragmentsByPack = groupBy((row: FragmentRow) => row.ctx_pack_id, fragments)
          const keywordsByPack = groupBy((row: KeywordRow) => row.ctx_pack_id, keywords)

          const result: CtxPackListResult = {
            items: page.map((row) =>
              summaryFrom(row, fragmentsByPack.get(row.id) ?? [], keywordsByPack.get(row.id) ?? []),
            ),
            nextCursor,
            totalEstimate: count?.count ?? null,
          }
          return result
        }),
      )

    const patch: CtxPackCatalog["patch"] = (actor, request) =>
      toDomainError(
        Effect.gen(function* () {
          const structural = yield* attempt(() => normalizePatch(request, []))
          if (structural.workspaceID !== actor.workspaceID) return yield* Effect.fail(denied("ctxpack.patch"))
          const current = yield* loadInfo(actor.workspaceID, structural.ctxPackID, actor.userID)
          yield* requireAccess(actor, "ctxpack.patch", current)
          if (current.deletedAt !== null) return yield* Effect.fail(deleted(structural.ctxPackID))
          const normalized = yield* attempt(() =>
            normalizePatch(
              structural,
              current.fragments.map((fragment) => fragment.source),
            ),
          )

          return yield* boundary.transaction(
            Effect.gen(function* () {
              const fresh = yield* loadInfo(actor.workspaceID, normalized.ctxPackID, actor.userID)
              yield* requireAccess(actor, "ctxpack.patch", fresh)
              if (fresh.deletedAt !== null) return yield* Effect.fail(deleted(normalized.ctxPackID))
              if (fresh.revision !== normalized.expectedRevision) return yield* Effect.fail(conflict(fresh.revision))

              const timestamp = now()
              const title = normalized.patch.title ?? fresh.title
              const sensitivity = normalized.patch.sensitivity ?? fresh.sensitivity
              const tags = normalized.patch.tags === undefined ? fresh.tags : normalized.patch.tags
              const revision = fresh.revision + 1
              const existingKeywords = yield* selectKeywords(fresh.id)
              const keywords =
                normalized.patch.keywords !== undefined
                  ? normalized.patch.keywords.map((keyword, ordinal) => ({
                      ordinal,
                      display: keyword,
                      normalized: normalizeKeyword(keyword),
                    }))
                  : existingKeywords.map((keyword) => ({
                      ordinal: keyword.ordinal,
                      display: keyword.keyword_display,
                      normalized: keyword.keyword_normalized,
                    }))

              // CAS plus the reserved immediate writer guards separate
              // connections; an empty patch still bumps revision/time_updated
              // while content and hashes stay untouched.
              const updated = yield* db.get<{ id: string }>(sql`UPDATE cm_ctx_pack
                SET title = ${title}, tags_json = ${JSON.stringify(tags ?? [])}, sensitivity = ${sensitivity}, revision = ${revision}, time_updated = ${timestamp}
                WHERE id = ${fresh.id} AND workspace_id = ${actor.workspaceID} AND revision = ${normalized.expectedRevision}
                RETURNING id`)
              if (!updated) return yield* Effect.fail(conflict(fresh.revision))

              if (normalized.patch.keywords !== undefined) {
                yield* db.run(sql`DELETE FROM cm_ctx_pack_keyword WHERE ctx_pack_id = ${fresh.id}`)
                for (const keyword of keywords) {
                  yield* db.run(sql`INSERT INTO cm_ctx_pack_keyword
                    (ctx_pack_id, ordinal, keyword_display, keyword_normalized)
                    VALUES (${fresh.id}, ${keyword.ordinal}, ${keyword.display}, ${keyword.normalized})`)
                }
              }
              if (normalized.patch.title !== undefined || normalized.patch.keywords !== undefined) {
                yield* db.run(sql`UPDATE cm_ctx_pack_fts
                  SET title = ${title}, keywords = ${keywords.map((keyword) => keyword.normalized).join(" ")}
                  WHERE ctx_pack_id = ${fresh.id}`)
              }

              const info = yield* loadInfo(actor.workspaceID, fresh.id, actor.userID)
              yield* boundary.afterCommit(
                publishHint({
                  type: "workspace.ctxpack.changed",
                  properties: {
                    workspaceID: actor.workspaceID,
                    ctxPackID: info.id,
                    revision: info.revision,
                    change: "metadata-updated",
                  },
                }),
              )
              return info
            }),
          )
        }),
      )

    const remove: CtxPackCatalog["remove"] = (actor, input) =>
      toDomainError(
        Effect.gen(function* () {
          const ctxPackID = input.ctxPackID
          const expectedRevision = input.expectedRevision
          const current = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
          yield* requireAccess(actor, "ctxpack.remove", current)
          return yield* boundary.transaction(
            Effect.gen(function* () {
              const fresh = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
              yield* requireAccess(actor, "ctxpack.remove", fresh)
              if (fresh.deletedAt !== null) return yield* Effect.fail(deleted(ctxPackID))
              if (fresh.revision !== expectedRevision) return yield* Effect.fail(conflict(fresh.revision))
              // Soft delete retains revision/time_updated per baseline.
              yield* db.run(sql`UPDATE cm_ctx_pack SET time_deleted = ${now()} WHERE id = ${ctxPackID} AND workspace_id = ${actor.workspaceID}`)
              yield* db.run(sql`DELETE FROM cm_ctx_pack_fts WHERE ctx_pack_id = ${ctxPackID}`)
              const info = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
              yield* boundary.afterCommit(
                publishHint({
                  type: "workspace.ctxpack.changed",
                  properties: {
                    workspaceID: actor.workspaceID,
                    ctxPackID,
                    revision: info.revision,
                    change: "deleted",
                  },
                }),
              )
              return info
            }),
          )
        }),
      )

    const restore: CtxPackCatalog["restore"] = (actor, input) =>
      toDomainError(
        Effect.gen(function* () {
          const ctxPackID = input.ctxPackID
          const expectedRevision = input.expectedRevision
          const current = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
          yield* requireAccess(actor, "ctxpack.restore", current)
          return yield* boundary.transaction(
            Effect.gen(function* () {
              const fresh = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
              yield* requireAccess(actor, "ctxpack.restore", fresh)
              if (fresh.revision !== expectedRevision) return yield* Effect.fail(conflict(fresh.revision))
              if (fresh.deletedAt !== null) {
                const fragments = yield* selectFragments(ctxPackID)
                const keywords = yield* selectKeywords(ctxPackID)
                yield* db.run(sql`UPDATE cm_ctx_pack SET time_deleted = NULL WHERE id = ${ctxPackID} AND workspace_id = ${actor.workspaceID}`)
                yield* db.run(sql`INSERT INTO cm_ctx_pack_fts (ctx_pack_id, workspace_id, title, keywords, content)
                  VALUES (${ctxPackID}, ${actor.workspaceID}, ${fresh.title}, ${ftsKeywords(keywords)}, ${ftsContent(fragments)})`)
                yield* boundary.afterCommit(
                  publishHint({
                    type: "workspace.ctxpack.changed",
                    properties: {
                      workspaceID: actor.workspaceID,
                      ctxPackID,
                      revision: fresh.revision,
                      change: "restored",
                    },
                  }),
                )
              }
              return yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
            }),
          )
        }),
      )

    const pin: CtxPackCatalog["pin"] = (actor, ctxPackID) =>
      toDomainError(
        Effect.gen(function* () {
          const current = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
          yield* requireAccess(actor, "ctxpack.read", current)
          if (current.deletedAt !== null) return yield* Effect.fail(deleted(ctxPackID))
          return yield* boundary.transaction(
            Effect.gen(function* () {
              const fresh = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
              yield* requireAccess(actor, "ctxpack.read", fresh)
              if (fresh.deletedAt !== null) return yield* Effect.fail(deleted(ctxPackID))
              // Exact repeats keep the original pin time and change nothing.
              const inserted = yield* db.get<{ ctx_pack_id: string }>(sql`INSERT INTO cm_ctx_pack_pin
                (workspace_id, ctx_pack_id, user_id, time_pinned)
                VALUES (${actor.workspaceID}, ${ctxPackID}, ${actor.userID}, ${now()})
                ON CONFLICT(workspace_id, ctx_pack_id, user_id) DO NOTHING RETURNING ctx_pack_id`)
              const info = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
              if (inserted !== undefined) {
                yield* boundary.afterCommit(
                  publishHint({
                    type: "workspace.ctxpack.changed",
                    properties: {
                      workspaceID: actor.workspaceID,
                      ctxPackID,
                      revision: info.revision,
                      change: "pinned",
                    },
                  }),
                )
              }
              return info
            }),
          )
        }),
      )

    const unpin: CtxPackCatalog["unpin"] = (actor, ctxPackID) =>
      toDomainError(
        Effect.gen(function* () {
          const current = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
          yield* requireAccess(actor, "ctxpack.read", current)
          yield* boundary.transaction(
            Effect.gen(function* () {
              const fresh = yield* loadInfo(actor.workspaceID, ctxPackID, actor.userID)
              yield* requireAccess(actor, "ctxpack.read", fresh)
              // Unpin is allowed on a deleted pack; no revision changes.
              const removed = yield* db.get<{ ctx_pack_id: string }>(sql`DELETE FROM cm_ctx_pack_pin
                WHERE workspace_id = ${actor.workspaceID} AND ctx_pack_id = ${ctxPackID} AND user_id = ${actor.userID}
                RETURNING ctx_pack_id`)
              if (removed !== undefined) {
                yield* boundary.afterCommit(
                  publishHint({
                    type: "workspace.ctxpack.changed",
                    properties: {
                      workspaceID: actor.workspaceID,
                      ctxPackID,
                      revision: fresh.revision,
                      change: "unpinned",
                    },
                  }),
                )
              }
            }),
          )
        }),
      )

    const scoped = <A>(actor: CtxPackActor, operation: CtxPackOperation, run: (actor: CtxPackActor) => Effect.Effect<A, CtxPackError>) =>
      toDomainError(Effect.suspend(() => {
        if (typeof actor.userID !== "string" || !actor.userID.trim() ||
          typeof actor.workspaceID !== "string" || !actor.workspaceID.trim()) return Effect.fail(denied(operation))
        return run(Object.freeze({ userID: actor.userID, workspaceID: actor.workspaceID }))
      }))

    return {
      create: (actor, request) => scoped(actor, "ctxpack.create", (actor) => create(actor, structuredClone(request))),
      get: (actor, id, includeDeleted) => scoped(actor, "ctxpack.read", (actor) => get(actor, id, includeDeleted)),
      list: (actor, request) => scoped(actor, "ctxpack.read", (actor) => list(actor, structuredClone(request))),
      patch: (actor, request) => scoped(actor, "ctxpack.patch", (actor) => patch(actor, structuredClone(request))),
      remove: (actor, request) => scoped(actor, "ctxpack.remove", (actor) => remove(actor, { ...request })),
      restore: (actor, request) => scoped(actor, "ctxpack.restore", (actor) => restore(actor, { ...request })),
      pin: (actor, id) => scoped(actor, "ctxpack.read", (actor) => pin(actor, id)),
      unpin: (actor, id) => scoped(actor, "ctxpack.read", (actor) => unpin(actor, id)),
    } satisfies CtxPackCatalog
  })
}
