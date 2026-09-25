// Server-side durable CtxPack capsule storage for the mediated opencode
// adapter. This store is mechanical: it performs NO authorization checks (the
// later materializer authorizes before it calls in). It owns the
// `cm_context_capsule` table and the `0008-ctxpack-capsule` migration marker,
// and it reuses the same native Database.Service as the rest of core.
//
// The fork's Functionality.Capsule shape is a source reference only; a local
// Effect Schema validates the persisted body so neither direction can leak an
// unexpected shape through. createdBy and budget live OUT-OF-BODY in their own
// JSON columns because the capsule body has no room for them.
//
// Redaction contract: every returned error and defect carries IDs only.
// Stored content (facts, references, summaries) never appears in errors.

export * as CtxPackCapsule from "./ctxpack-capsule"

import { Effect, Option, Schema } from "effect"
import { desc, sql } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Database } from "@opencode-ai/core/database/database"
import { ascending } from "@opencode-ai/schema/identifier"
import type {
  CapsuleError,
  CapsuleResult,
  ContextBudget,
  StoredCapsule,
} from "@cybermastery/contracts/ctxpack-capsule"

// --- Local body schema -------------------------------------------------------
// Exact body fields of a stored capsule (everything except the out-of-body
// createdBy and budget). `Schema.Unknown` mirrors the contract's opaque
// facts/references/artifactRefs/recentEvents entries.

const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const CapsuleBody = Schema.Struct({
  id: Schema.String,
  version: Schema.Literal(1),
  workspaceId: Schema.String,
  purpose: Schema.String,
  audience: Schema.Array(Schema.String),
  summary: Schema.optional(Schema.String),
  facts: Schema.Array(Schema.Json),
  references: Schema.Array(Schema.Json),
  artifactRefs: Schema.Array(Schema.Json),
  recentEvents: Schema.Array(Schema.Json),
  contentHash: Schema.String,
  createdAt: NonNegativeInt,
  expiresAt: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "CtxPackCapsule.Body" })

const CreatedBy = Schema.Struct({
  userId: Schema.String,
  instanceId: Schema.String,
  operationId: Schema.optional(Schema.String),
}).annotate({ identifier: "CtxPackCapsule.CreatedBy" })

const Budget = Schema.Struct({
  maximumBytes: NonNegativeInt,
  maximumEstimatedTokens: NonNegativeInt,
  maximumFacts: NonNegativeInt,
  maximumReferences: NonNegativeInt,
  maximumArtifacts: NonNegativeInt,
  maximumRecentEvents: NonNegativeInt,
}).annotate({ identifier: "CtxPackCapsule.Budget" })

// Strict excess-property allowlists: a persisted body with an unknown key is
// corrupt input, not a newer field we silently drop.
const BODY_KEYS = [
  "id",
  "version",
  "workspaceId",
  "purpose",
  "audience",
  "summary",
  "facts",
  "references",
  "artifactRefs",
  "recentEvents",
  "contentHash",
  "createdAt",
  "expiresAt",
]
const CREATED_BY_KEYS = ["userId", "instanceId", "operationId"]
const BUDGET_KEYS = [
  "maximumBytes",
  "maximumEstimatedTokens",
  "maximumFacts",
  "maximumReferences",
  "maximumArtifacts",
  "maximumRecentEvents",
]

// --- Durable table -----------------------------------------------------------
// Owned table; the raw `cm_migration` marker id is `0008-ctxpack-capsule`.
// Columns stay plain TEXT so corrupt JSON surfaces as a typed error instead of
// a driver-level parse throw.

const CmContextCapsuleTable = sqliteTable(
  "cm_context_capsule",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    purpose: text().notNull(),
    content_hash: text().notNull(),
    capsule_json: text().notNull(),
    created_by_json: text().notNull(),
    budget_json: text().notNull(),
    created_at: integer().notNull(),
    expires_at: integer(),
  },
  (table) => [index("cm_context_capsule_workspace").on(table.workspace_id, desc(table.created_at))],
)

interface CapsuleRow {
  id: string
  workspace_id: string
  purpose: string
  content_hash: string
  created_at: number
  expires_at: number | null
  capsule_json: string
  created_by_json: string
  budget_json: string
}

// --- Typed errors ------------------------------------------------------------

// Corrupt stored JSON (body, createdBy, or budget) or invalid caller input.
// Carries IDs only; content never appears here.
class CapsuleCorruptError extends Schema.TaggedErrorClass<CapsuleCorruptError>()(
  "ContextCapsule.Corrupt",
  { capsuleID: Schema.String, workspaceID: Schema.String },
) {}

// A capsule id already exists: capsules are immutable after their first write.
class CapsuleConflictError extends Schema.TaggedErrorClass<CapsuleConflictError>()(
  "ContextCapsule.Conflict",
  { capsuleID: Schema.String, workspaceID: Schema.String },
) {}

// --- Store interface ---------------------------------------------------------

export interface CtxPackCapsuleStoreOptions {
  /** Deterministic clock for expiry checks; defaults to Date.now. */
  readonly now?: () => number
}

export interface CtxPackCapsuleStore {
  store(capsule: StoredCapsule): Effect.Effect<StoredCapsule, CapsuleError>
  get(workspaceID: string, capsuleID: string): Effect.Effect<StoredCapsule | undefined, CapsuleError>
  materialize(input: {
    readonly workspaceID: string
    readonly capsuleID: string
    readonly requestedRefs: readonly string[]
    readonly budget: ContextBudget
  }): Effect.Effect<CapsuleResult, CapsuleError>
}

// --- Pure decoding -----------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

const parseJson = (raw: string): unknown => {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw)
  return Option.isSome(parsed) ? parsed.value : undefined
}

const decodeBodyValue = (value: unknown) => {
  if (!isRecord(value) || !hasOnlyKeys(value, BODY_KEYS)) return undefined
  const decoded = Schema.decodeUnknownOption(CapsuleBody)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const decodeCreatedByValue = (value: unknown) => {
  if (!isRecord(value) || !hasOnlyKeys(value, CREATED_BY_KEYS)) return undefined
  const decoded = Schema.decodeUnknownOption(CreatedBy)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const decodeBudgetValue = (value: unknown) => {
  if (!isRecord(value) || !hasOnlyKeys(value, BUDGET_KEYS)) return undefined
  const decoded = Schema.decodeUnknownOption(Budget)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const decodeStored = (row: CapsuleRow): StoredCapsule | undefined => {
  const body = decodeBodyValue(parseJson(row.capsule_json))
  if (body === undefined) return undefined
  const createdBy = decodeCreatedByValue(parseJson(row.created_by_json))
  if (createdBy === undefined) return undefined
  const budget = decodeBudgetValue(parseJson(row.budget_json))
  if (budget === undefined) return undefined
  if (row.id !== body.id || row.workspace_id !== body.workspaceId || row.purpose !== body.purpose ||
    row.content_hash !== body.contentHash || row.created_at !== body.createdAt ||
    row.expires_at !== (body.expiresAt ?? null)) return undefined
  return { ...body, createdBy, budget }
}

// --- Reference filtering -----------------------------------------------------
// CtxPack references carry { ref: { type, id } }. Entries without a string
// ref.id are always kept; entries with one are filtered by requestedRefs (all
// kept when requestedRefs is empty).

const refIDOf = (entry: unknown): string | undefined => {
  if (!isRecord(entry)) return undefined
  if (!isRecord(entry.ref)) return undefined
  return typeof entry.ref.id === "string" ? entry.ref.id : undefined
}

const filterRefs = (refs: readonly unknown[], requested: ReadonlySet<string>): unknown[] =>
  refs.filter((entry) => {
    const id = refIDOf(entry)
    return id === undefined || requested.size === 0 || requested.has(id)
  })

const collectRefIDs = (refs: readonly unknown[]): Set<string> =>
  new Set(
    refs.flatMap((entry) => {
      const id = refIDOf(entry)
      return id === undefined ? [] : [id]
    }),
  )

// --- Implementation ----------------------------------------------------------

export function makeCtxPackCapsuleStore(options: CtxPackCapsuleStoreOptions = {}) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const now = options.now ?? (() => Date.now())

    yield* db
      .run(sql`CREATE TABLE IF NOT EXISTS cm_migration (
        id TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL
      )`)
      .pipe(Effect.orDie)
    yield* db
      .run(sql`CREATE TABLE IF NOT EXISTS cm_context_capsule (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        capsule_json TEXT NOT NULL,
        created_by_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )`)
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`CREATE INDEX IF NOT EXISTS cm_context_capsule_workspace
          ON cm_context_capsule (workspace_id, created_at DESC)`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT OR IGNORE INTO cm_migration (id, completed_at)
          VALUES ('0008-ctxpack-capsule', ${Date.now()})`,
      )
      .pipe(Effect.orDie)

    const store: CtxPackCapsuleStore["store"] = Effect.fn("CtxPackCapsuleStore.store")(function* (capsule) {
      const input: unknown = capsule
      if (!isRecord(input)) return yield* new CapsuleCorruptError({ capsuleID: "", workspaceID: "" })
      const rawID = input.id
      const id = typeof rawID === "string" && rawID.length > 0 ? rawID : `ctxkpsl_${ascending()}`
      const workspaceID = typeof input.workspaceId === "string" ? input.workspaceId : ""
      // Detach with a canonical, schema-validated body. Persist stable JSON so
      // any later mutation of caller objects cannot rewrite stored data.
      const body = decodeBodyValue({
        id,
        version: input.version,
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        audience: input.audience,
        summary: input.summary,
        facts: input.facts,
        references: input.references,
        artifactRefs: input.artifactRefs,
        recentEvents: input.recentEvents,
        contentHash: input.contentHash,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      if (body === undefined) return yield* new CapsuleCorruptError({ capsuleID: id, workspaceID })
      const createdBy = decodeCreatedByValue(input.createdBy)
      if (createdBy === undefined) return yield* new CapsuleCorruptError({ capsuleID: id, workspaceID })
      const budget = decodeBudgetValue(input.budget)
      if (budget === undefined) return yield* new CapsuleCorruptError({ capsuleID: id, workspaceID })

      const capsuleJson = JSON.stringify({
        id: body.id,
        version: body.version,
        workspaceId: body.workspaceId,
        purpose: body.purpose,
        audience: body.audience,
        summary: body.summary,
        facts: body.facts,
        references: body.references,
        artifactRefs: body.artifactRefs,
        recentEvents: body.recentEvents,
        contentHash: body.contentHash,
        createdAt: body.createdAt,
        expiresAt: body.expiresAt,
      })
      const createdByJson = JSON.stringify({
        userId: createdBy.userId,
        instanceId: createdBy.instanceId,
        operationId: createdBy.operationId,
      })
      const budgetJson = JSON.stringify({
        maximumBytes: budget.maximumBytes,
        maximumEstimatedTokens: budget.maximumEstimatedTokens,
        maximumFacts: budget.maximumFacts,
        maximumReferences: budget.maximumReferences,
        maximumArtifacts: budget.maximumArtifacts,
        maximumRecentEvents: budget.maximumRecentEvents,
      })

      const inserted = yield* db
        .insert(CmContextCapsuleTable)
        .values({
          id,
          workspace_id: body.workspaceId,
          purpose: body.purpose,
          content_hash: body.contentHash,
          capsule_json: capsuleJson,
          created_by_json: createdByJson,
          budget_json: budgetJson,
          created_at: body.createdAt,
          expires_at: body.expiresAt ?? null,
        })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.orDie)
      if (inserted.length === 0) {
        return yield* new CapsuleConflictError({ capsuleID: id, workspaceID: body.workspaceId })
      }

      const stored = decodeStored({
        id,
        workspace_id: body.workspaceId,
        purpose: body.purpose,
        content_hash: body.contentHash,
        created_at: body.createdAt,
        expires_at: body.expiresAt ?? null,
        capsule_json: capsuleJson,
        created_by_json: createdByJson,
        budget_json: budgetJson,
      })
      if (stored === undefined) return yield* new CapsuleCorruptError({ capsuleID: id, workspaceID: body.workspaceId })
      return stored
    })

    const get: CtxPackCapsuleStore["get"] = Effect.fn("CtxPackCapsuleStore.get")(function* (
      workspaceID,
      capsuleID,
    ) {
      // Raw SQL so corrupt JSON surfaces as a typed CapsuleCorruptError rather
      // than a driver-level parse throw.
      const row = yield* db
        .get<CapsuleRow>(sql`SELECT * FROM cm_context_capsule WHERE id = ${capsuleID} AND workspace_id = ${workspaceID}`)
        .pipe(Effect.orDie)
      if (!row) return undefined
      const capsule = decodeStored(row)
      if (capsule === undefined) return yield* new CapsuleCorruptError({ capsuleID: row.id, workspaceID: row.workspace_id })
      return capsule
    })

    const materialize: CtxPackCapsuleStore["materialize"] = Effect.fn("CtxPackCapsuleStore.materialize")(
      function* (input) {
        const capsule = yield* get(input.workspaceID, input.capsuleID)
        if (capsule === undefined) return { status: "not-found" }
        // Nonexpiring capsules stay nonexpiring: only a present expiresAt can
        // expire and the boundary (expiresAt === now) is inclusive.
        if (capsule.expiresAt !== undefined && capsule.expiresAt <= now()) {
          return { status: "expired", expiresAt: capsule.expiresAt }
        }
        const requested = new Set(input.requestedRefs)
        const references = filterRefs(capsule.references, requested)
        const artifactRefs = filterRefs(capsule.artifactRefs, requested)
        const content = { facts: [...capsule.facts], references, artifactRefs }

        const found = collectRefIDs(capsule.references)
        for (const refID of collectRefIDs(capsule.artifactRefs)) found.add(refID)
        const unresolvedRefs = input.requestedRefs.filter((refID) => !found.has(refID))

        const json = JSON.stringify(content)
        const byteLength = new TextEncoder().encode(json).length
        const estimatedTokens = Math.ceil(byteLength / 4)
        if (byteLength > input.budget.maximumBytes) {
          return { status: "over-budget", limit: "bytes", current: byteLength, maximum: input.budget.maximumBytes }
        }
        if (estimatedTokens > input.budget.maximumEstimatedTokens) {
          return {
            status: "over-budget",
            limit: "tokens",
            current: estimatedTokens,
            maximum: input.budget.maximumEstimatedTokens,
          }
        }
        return { status: "ok", capsule, content, unresolvedRefs, byteLength, estimatedTokens }
      },
    )

    const result: CtxPackCapsuleStore = { store, get, materialize }
    return result
  })
}
