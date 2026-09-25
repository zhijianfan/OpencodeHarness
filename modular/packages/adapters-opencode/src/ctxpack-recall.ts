// Bounded CtxPack recall adapter.
//
// Recall is advisory. `select` returns automatic attachments only: it never
// mutates the Session, creates capsules, or records usage, and native prompt
// admission may still freeze a different snapshot. Callers render explicit
// attachments first. Every admission input is detached before any effect runs,
// and permissions are evaluated only from the authenticated actor, the trusted
// target, and catalog-owned pack data.
//
// The FTS query pins BOTH the FTS row workspace and the joined pack workspace to
// the actor workspace and filters private packs before LIMIT/ranking, so a
// malicious stored FTS row can never cross workspaces or leak a private
// candidate. Candidates are re-authorized through `catalog.get` (deletion,
// current hash, and read permission) rather than trusted from the index alone.

import type { CtxPackActor, CtxPackError, CtxPackInfo } from "@cybermastery/contracts/ctxpack"
import { buildRecallTerms, isTrivialRecallTurn } from "@cybermastery/domain/ctxpack-content"
import { Database } from "@opencode-ai/core/database/database"
import { sql } from "drizzle-orm"
import { Cause, Effect, Option } from "effect"
import { renderContextSnapshot, type ContextSidecarAttachment } from "./context-renderer"
import type { CtxPackCatalog } from "./ctxpack-catalog"

export const MAX_RECALL_CANDIDATES = 16
export const MAX_AUTOMATIC_ATTACHMENTS = 4
export const MAX_COMBINED_ATTACHMENTS = 8

export type CtxPackRecallTarget = {
  readonly workspaceID: string
  readonly instanceID: string
  readonly functionalityID: string
}

export type CtxPackRecallStatus = "skipped-trivial" | "no-match" | "selected" | "unavailable"

export type CtxPackRecallResult = {
  readonly attachments: readonly ContextSidecarAttachment[]
  readonly status: CtxPackRecallStatus
}

export interface CtxPackRecallOptions {
  readonly catalog: CtxPackCatalog
  readonly authorize: (input: {
    readonly actor: CtxPackActor
    readonly operation: "ctxpack.read" | "chat.context.attach"
    readonly pack?: CtxPackInfo
    readonly target?: CtxPackRecallTarget
  }) => Effect.Effect<void, CtxPackError>
}

export interface CtxPackRecall {
  readonly select: (input: {
    readonly actor: CtxPackActor
    readonly target: CtxPackRecallTarget
    readonly promptText: string
    readonly explicit: readonly ContextSidecarAttachment[]
    readonly budget: { readonly maximumBytes: number; readonly maximumEstimatedTokens: number }
  }) => Effect.Effect<CtxPackRecallResult>
}

type Db = Database.Interface["db"]

type RecallCandidateRow = {
  readonly ctx_pack_id: string
  readonly content_hash: string
}

type RecallInput = {
  readonly actor: CtxPackActor
  readonly target: CtxPackRecallTarget
  readonly promptText: string
  readonly explicit: readonly ContextSidecarAttachment[]
  readonly budget: { readonly maximumBytes: number; readonly maximumEstimatedTokens: number }
}

type CandidateSearch =
  | { readonly ok: true; readonly rows: readonly RecallCandidateRow[] }
  | { readonly ok: false; readonly rows: readonly RecallCandidateRow[] }

export function makeCtxPackRecall(
  options: CtxPackRecallOptions,
): Effect.Effect<CtxPackRecall, never, Database.Service> {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const db: Db = database.db
    return {
      select: (input: RecallInput) => runSelect({ db, options, ...detach(input) }),
    }
  })
}

// Snapshot every caller-owned field at admission so later caller mutation cannot
// change the admitted actor, target, prompt, explicit set, or budget.
function detach(input: RecallInput): RecallInput {
  return {
    actor: { userID: input.actor.userID, workspaceID: input.actor.workspaceID },
    target: {
      workspaceID: input.target.workspaceID,
      instanceID: input.target.instanceID,
      functionalityID: input.target.functionalityID,
    },
    promptText: input.promptText,
    explicit: structuredClone(input.explicit),
    budget: {
      maximumBytes: input.budget.maximumBytes,
      maximumEstimatedTokens: input.budget.maximumEstimatedTokens,
    },
  }
}

function runSelect(input: {
  readonly db: Db
  readonly options: CtxPackRecallOptions
  readonly actor: CtxPackActor
  readonly target: CtxPackRecallTarget
  readonly promptText: string
  readonly explicit: readonly ContextSidecarAttachment[]
  readonly budget: { readonly maximumBytes: number; readonly maximumEstimatedTokens: number }
}): Effect.Effect<CtxPackRecallResult> {
  const select = Effect.gen(function* () {
    if (isTrivialRecallTurn(input.promptText)) return skippedTrivial()
    if (input.actor.workspaceID !== input.target.workspaceID) return unavailable()

    const terms = buildRecallTerms(input.promptText)
    if (terms.length === 0) return noMatch()

    const canAttach = yield* input.options.authorize({
      actor: input.actor, operation: "chat.context.attach", target: input.target,
    }).pipe(Effect.option)
    if (Option.isNone(canAttach)) return unavailable()

    const search = yield* searchCandidates(input.db, input.actor, terms)
    if (!search.ok) return unavailable()

    const automatic: ContextSidecarAttachment[] = []
    for (const candidate of search.rows) {
      if (automatic.length >= MAX_AUTOMATIC_ATTACHMENTS) break
      if (input.explicit.length + automatic.length >= MAX_COMBINED_ATTACHMENTS) break
      if (isDuplicate(candidate, input.explicit, automatic)) continue

      const targetAllowed = yield* input.options
        .authorize({ actor: input.actor, operation: "chat.context.attach", target: input.target })
        .pipe(Effect.option)
      if (Option.isNone(targetAllowed)) continue

      const loaded = yield* input.options.catalog.get(input.actor, candidate.ctx_pack_id, true).pipe(Effect.option)
      if (Option.isNone(loaded)) continue
      const info = loaded.value
      if (info.deletedAt !== null) continue
      if (info.contentHash !== candidate.content_hash) continue

      const readAllowed = yield* input.options
        .authorize({ actor: input.actor, operation: "ctxpack.read", pack: info })
        .pipe(Effect.option)
      if (Option.isNone(readAllowed)) continue

      const attachment = automaticAttachment(info)
      const fits = yield* fitsBudget(input.promptText, input.explicit, input.budget, automatic, attachment)
      if (!fits) continue

      automatic.push(attachment)
    }

    if (automatic.length > 0) {
      const revalidated = yield* input.options
        .authorize({ actor: input.actor, operation: "chat.context.attach", target: input.target })
        .pipe(Effect.option)
      if (Option.isNone(revalidated)) return unavailable()
    }

    return automatic.length === 0 ? noMatch() : { attachments: automatic, status: "selected" as const }
  })

  // Database/search/programming defects fail closed to `unavailable`; interrupts
  // always propagate.
  return select.pipe(
    Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(unavailable())),
  )
}

function searchCandidates(db: Db, actor: CtxPackActor, terms: readonly string[]): Effect.Effect<CandidateSearch> {
  const query = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
  return db.all<RecallCandidateRow>(sql`
    SELECT p.id AS ctx_pack_id, p.content_hash
    FROM cm_ctx_pack_fts
    INNER JOIN cm_ctx_pack p
      ON p.id = cm_ctx_pack_fts.ctx_pack_id AND p.workspace_id = cm_ctx_pack_fts.workspace_id
    WHERE cm_ctx_pack_fts.workspace_id = ${actor.workspaceID}
      AND p.workspace_id = ${actor.workspaceID}
      AND p.time_deleted IS NULL
      AND (p.sensitivity != 'private' OR p.created_by_user_id = ${actor.userID})
      AND cm_ctx_pack_fts MATCH ${query}
    ORDER BY bm25(cm_ctx_pack_fts) ASC, p.id ASC
    LIMIT ${MAX_RECALL_CANDIDATES}
  `).pipe(
    Effect.map((rows) => ({ ok: true as const, rows })),
    Effect.catchCause((cause) => Cause.hasInterrupts(cause)
      ? Effect.interrupt
      : Effect.succeed({ ok: false as const, rows: [] as readonly RecallCandidateRow[] })),
  )
}

function automaticAttachment(info: CtxPackInfo): ContextSidecarAttachment {
  return {
    selection: "automatic",
    sourceCtxPackID: info.id,
    label: info.title,
    ...(info.tags !== undefined && info.tags.length > 0 ? { tags: info.tags } : {}),
    contentHash: info.contentHash,
    fragments: info.fragments.map((fragment) => ({ contentHash: fragment.contentHash, text: fragment.text })),
  }
}

// Budget admission must run the real snapshot renderer under the caller budget
// with the candidate appended, so an oversized candidate is skipped without
// discarding valid later candidates.
function fitsBudget(
  promptText: string,
  explicit: readonly ContextSidecarAttachment[],
  budget: { readonly maximumBytes: number; readonly maximumEstimatedTokens: number },
  automatic: readonly ContextSidecarAttachment[],
  attachment: ContextSidecarAttachment,
): Effect.Effect<boolean> {
  return Effect.sync(() => {
    renderContextSnapshot({
      promptText,
      attachments: [...explicit, ...automatic, attachment],
      recall: { policy: "operating-chat-v1", status: "selected" },
      budget,
      createdAt: 0,
    })
    return true
  }).pipe(Effect.catchDefect(() => Effect.succeed(false)))
}

function isDuplicate(
  candidate: RecallCandidateRow,
  explicit: readonly ContextSidecarAttachment[],
  automatic: readonly ContextSidecarAttachment[],
): boolean {
  return [...explicit, ...automatic].some(
    (attachment) =>
      attachment.sourceCtxPackID === candidate.ctx_pack_id && attachment.contentHash === candidate.content_hash,
  )
}

function skippedTrivial(): CtxPackRecallResult {
  return { attachments: [], status: "skipped-trivial" }
}

function noMatch(): CtxPackRecallResult {
  return { attachments: [], status: "no-match" }
}

function unavailable(): CtxPackRecallResult {
  return { attachments: [], status: "unavailable" }
}
