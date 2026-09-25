// Authorized CtxPack materialization + session-input snapshots.
//
// This adapter ports the baseline `ctxpack/materialize.ts` behavior onto the
// mediated catalog + durable capsule store. It owns no tables and imports no
// native/fork engine: `materialize()` reads through the authorized catalog,
// freezes an immutable `ctxpack-attachment` capsule via the capsule store, and
// `snapshotForSessionInput()` resolves the CURRENT pack rows for a set of
// caller-supplied attachments.
//
// Redaction contract: errors and diagnostics carry ids/hashes/bytes/counts
// only. Fragment text appears ONLY in the durable capsule reference summary
// and in the returned snapshot (whose purpose is to carry it).

import type { CtxPackActor, CtxPackFragment, CtxPackInfo, CtxPackTag } from "@cybermastery/contracts/ctxpack"
import {
  DefaultInteractiveContextBudget,
  type ContextBudget,
  type CtxPackAttachment,
  type CtxPackMaterializeError,
  type CtxPackMaterializeRequest,
  type CtxPackMaterializeResult,
  type CtxPackSnapshot,
  type StoredCapsule,
} from "@cybermastery/contracts/ctxpack-capsule"
import { ascending } from "@opencode-ai/schema/identifier"
import { Effect, Option, Schema } from "effect"
import type { CtxPackCatalog } from "./ctxpack-catalog"
import type { CtxPackCapsuleStore } from "./ctxpack-capsule"

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const MAX_SNAPSHOT_ATTACHMENTS = 8

export type CtxPackAuthorizeOperation = "ctxpack.materialize" | "chat.context.attach" | "ctxpack.read"

export type CtxPackAuthorizeTarget = {
  readonly workspaceID: string
  readonly instanceID: string
  readonly functionalityID: string
}

export type CtxPackAuthorizeInput = {
  readonly actor: CtxPackActor
  readonly operation: CtxPackAuthorizeOperation
  readonly pack?: CtxPackInfo
  readonly target?: CtxPackAuthorizeTarget
}

export type CtxPackDiagnosticsEntry = {
  readonly operation: "materialize" | "snapshot"
  readonly workspaceID: string
  readonly attachmentCount: number
  readonly byteLength: number
  readonly estimatedTokens: number
}

export interface CtxPackMaterializerOptions {
  readonly catalog: CtxPackCatalog
  readonly capsules: CtxPackCapsuleStore
  readonly authorize: (input: CtxPackAuthorizeInput) => Effect.Effect<void, CtxPackMaterializeError>
  readonly now?: () => number
  readonly diagnostics?: (entry: CtxPackDiagnosticsEntry) => Effect.Effect<void>
}

export interface CtxPackSnapshotInput {
  readonly actor: CtxPackActor
  readonly targetInstanceID: string
  readonly targetFunctionalityID: string
  readonly attachments: readonly CtxPackAttachment[]
  readonly budget: ContextBudget
}

export interface CtxPackMaterializer {
  readonly materialize: (
    actor: CtxPackActor,
    request: CtxPackMaterializeRequest,
  ) => Effect.Effect<CtxPackMaterializeResult, CtxPackMaterializeError>
  readonly snapshotForSessionInput: (
    input: CtxPackSnapshotInput,
  ) => Effect.Effect<CtxPackSnapshot, CtxPackMaterializeError>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(value, key)
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

const ctxPackRef = (pack: CtxPackInfo) => ({ type: "ctxpack", id: pack.id })

const ctxPackReference = (pack: CtxPackInfo) => ({
  kind: "ctxpack",
  ref: ctxPackRef(pack),
  label: pack.title,
  contentHash: pack.contentHash,
  sensitivity: pack.sensitivity,
})

// Fragment text appears ONLY in this durable capsule reference summary.
const fragmentReference = (fragment: CtxPackFragment) => ({
  kind: "ctxpack.fragment",
  ref: { type: "ctxpack-fragment", id: fragment.id },
  label: fragment.source.label ?? `Fragment ${fragment.ordinal + 1}`,
  summary: fragment.text,
  contentHash: fragment.contentHash,
  sensitivity: fragment.source.sensitivity,
})

const isFragmentReference = (
  entry: unknown,
): entry is { readonly ref: { readonly type: "ctxpack-fragment"; readonly id: string } } => {
  if (!isRecord(entry)) return false
  const ref = entry.ref
  if (!isRecord(ref)) return false
  return ref.type === "ctxpack-fragment" && typeof ref.id === "string"
}

const TagArray = Schema.Array(Schema.Literal("ParallelPlan"))

// Tags are read from the capsule's frozen `ctxpack.tags` fact, never from the
// current pack metadata. A present-but-invalid fact is corrupt stored data.
const tagsFromFacts = (facts: readonly unknown[]): readonly CtxPackTag[] | undefined => {
  for (const fact of facts) {
    if (!isRecord(fact) || fact.key !== "ctxpack.tags") continue
    const decoded = Schema.decodeUnknownOption(TagArray)(fact.value)
    return Option.isSome(decoded) ? decoded.value : undefined
  }
  return []
}

// Capsule-store failures (conflict/corrupt) are storage-level and sanitized to
// a body-free defect; the frozen error union has no storage variant.
const storageDefect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.catch(() => Effect.die(new Error("CtxPack capsule storage failure"))),
    Effect.catchDefect(() => Effect.die(new Error("CtxPack capsule storage failure"))),
  )

// ---------------------------------------------------------------------------
// Local shapes
// ---------------------------------------------------------------------------

type DetachedAttachment = {
  readonly contextCapsuleID: string
  readonly label: string
  readonly contentHash: string
  readonly source: { readonly kind: "ctxpack"; readonly ctxPackID: string }
}

type SnapshotFragment = {
  readonly text: string
  readonly source: CtxPackFragment["source"]
  readonly contentHash: string
}

type ResolvedAttachment = {
  readonly attachment: DetachedAttachment
  readonly tags: readonly CtxPackTag[]
  readonly fragments: readonly SnapshotFragment[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function makeCtxPackMaterializer(options: CtxPackMaterializerOptions): CtxPackMaterializer {
  const catalog = options.catalog
  const capsules = options.capsules
  const authorize = options.authorize
  const now = options.now ?? (() => Date.now())
  const record: (entry: CtxPackDiagnosticsEntry) => Effect.Effect<void> =
    options.diagnostics ?? (() => Effect.void)

  const materialize: CtxPackMaterializer["materialize"] = (actor, request) => {
    // Detach every caller input before the first await so later mutation cannot
    // change what was authorized or stored.
    const userID = actor.userID
    const workspaceID = actor.workspaceID
    const ctxPackID = request.ctxPackID
    const expectedContentHash = request.expectedContentHash
    const targetInstanceID = request.targetInstanceID
    const targetFunctionalityID = request.targetFunctionalityID

    return Effect.gen(function* () {
      // includeDeleted=true so a deleted pack surfaces as CtxPackDeleted below
      // instead of being hidden; catalog.get also applies the deny-first private
      // policy and the catalog-level read authorization.
      const pack = yield* catalog.get({ userID, workspaceID }, ctxPackID, true)
      yield* authorize({ actor: { userID, workspaceID }, operation: "ctxpack.materialize", pack })
      yield* authorize({
        actor: { userID, workspaceID },
        operation: "chat.context.attach",
        target: { workspaceID, instanceID: targetInstanceID, functionalityID: targetFunctionalityID },
      })
      if (pack.deletedAt !== null) {
        return yield* Effect.fail({ _tag: "CtxPackDeleted", ctxPackID: pack.id } satisfies CtxPackMaterializeError)
      }
      if (pack.contentHash !== expectedContentHash) {
        return yield* Effect.fail({
          _tag: "CtxPackContentChanged",
          currentContentHash: pack.contentHash,
        } satisfies CtxPackMaterializeError)
      }

      const ref = ctxPackRef(pack)
      const capsule: StoredCapsule = {
        id: `ctxkpsl_${ascending()}`,
        version: 1,
        workspaceId: pack.workspaceID,
        purpose: "ctxpack-attachment",
        audience: [targetFunctionalityID],
        createdBy: { userId: userID, instanceId: targetInstanceID },
        summary: pack.title,
        facts: [
          { key: "ctxpack.id", value: pack.id, sourceRef: ref, sensitivity: pack.sensitivity },
          { key: "ctxpack.fragmentCount", value: pack.fragments.length, sourceRef: ref, sensitivity: pack.sensitivity },
          ...(pack.tags && pack.tags.length > 0
            ? [{ key: "ctxpack.tags", value: pack.tags, sourceRef: ref, sensitivity: pack.sensitivity }]
            : []),
        ],
        references: [ctxPackReference(pack), ...pack.fragments.map(fragmentReference)],
        artifactRefs: [],
        recentEvents: [],
        budget: DefaultInteractiveContextBudget,
        contentHash: pack.contentHash,
        createdAt: now(),
        expiresAt: undefined,
      }

      const stored = yield* storageDefect(capsules.store(capsule))
      yield* record({
        operation: "materialize",
        workspaceID,
        attachmentCount: 1,
        byteLength: pack.byteLength,
        estimatedTokens: pack.estimatedTokens,
      })

      // No usage-counter change: usage is the admitted-only separate lane.
      return {
        contextCapsuleID: stored.id,
        sourceCtxPackID: pack.id,
        label: pack.title,
        ...(pack.tags && pack.tags.length > 0 ? { tags: pack.tags } : {}),
        contentHash: pack.contentHash,
        estimatedTokens: pack.estimatedTokens,
      }
    })
  }

  const snapshotForSessionInput: CtxPackMaterializer["snapshotForSessionInput"] = (input) => {
    // Detach every caller input before the first await.
    const userID = input.actor.userID
    const workspaceID = input.actor.workspaceID
    const targetInstanceID = input.targetInstanceID
    const targetFunctionalityID = input.targetFunctionalityID
    const attachments: readonly DetachedAttachment[] = input.attachments.map((attachment) => ({
      contextCapsuleID: attachment.contextCapsuleID,
      label: attachment.label,
      contentHash: attachment.contentHash,
      source: { kind: "ctxpack", ctxPackID: attachment.source.ctxPackID },
    }))
    const budget: ContextBudget = {
      maximumBytes: input.budget.maximumBytes,
      maximumEstimatedTokens: input.budget.maximumEstimatedTokens,
      maximumFacts: input.budget.maximumFacts,
      maximumReferences: input.budget.maximumReferences,
      maximumArtifacts: input.budget.maximumArtifacts,
      maximumRecentEvents: input.budget.maximumRecentEvents,
    }

    return Effect.gen(function* () {
      // The target capability is required even when nothing is attached.
      yield* authorize({
        actor: { userID, workspaceID },
        operation: "chat.context.attach",
        target: { workspaceID, instanceID: targetInstanceID, functionalityID: targetFunctionalityID },
      })

      if (attachments.length === 0) {
        const empty: CtxPackSnapshot = {
          version: 1,
          attachments: [],
          byteLength: 0,
          estimatedTokens: 0,
          createdAt: now(),
        }
        yield* record({ operation: "snapshot", workspaceID, attachmentCount: 0, byteLength: 0, estimatedTokens: 0 })
        return deepFreeze(empty)
      }

      // Identity collisions reject before the count limit.
      const seen = new Set<string>()
      for (const attachment of attachments) {
        if (seen.has(attachment.contextCapsuleID)) {
          return yield* Effect.fail({
            _tag: "CtxPackSnapshotDuplicateCapsule",
            contextCapsuleID: attachment.contextCapsuleID,
          } satisfies CtxPackMaterializeError)
        }
        seen.add(attachment.contextCapsuleID)
      }
      if (attachments.length > MAX_SNAPSHOT_ATTACHMENTS) {
        return yield* Effect.fail({
          _tag: "CtxPackInvalidSelection",
          reason: "too-many-attachments",
        } satisfies CtxPackMaterializeError)
      }

      const resolved: ResolvedAttachment[] = []
      for (const attachment of attachments) {
        const capsule = yield* storageDefect(capsules.get(workspaceID, attachment.contextCapsuleID))
        if (!capsule) return yield* Effect.fail({ _tag: "CtxPackCapsuleMissing" } satisfies CtxPackMaterializeError)
        if (capsule.workspaceId !== workspaceID) {
          return yield* Effect.fail({
            _tag: "CtxPackCapsuleTargetMismatch",
            target: "workspace",
          } satisfies CtxPackMaterializeError)
        }
        if (capsule.purpose !== "ctxpack-attachment") {
          return yield* Effect.fail({
            _tag: "CtxPackCapsuleTargetMismatch",
            target: "purpose",
          } satisfies CtxPackMaterializeError)
        }
        if (capsule.createdBy.instanceId !== targetInstanceID) {
          return yield* Effect.fail({
            _tag: "CtxPackCapsuleTargetMismatch",
            target: "instance",
          } satisfies CtxPackMaterializeError)
        }
        if (!capsule.audience.includes(targetFunctionalityID)) {
          return yield* Effect.fail({
            _tag: "CtxPackCapsuleTargetMismatch",
            target: "audience",
          } satisfies CtxPackMaterializeError)
        }
        if (capsule.expiresAt !== undefined && capsule.expiresAt !== null && capsule.expiresAt <= now()) {
          return yield* Effect.fail({
            _tag: "CtxPackCapsuleExpired",
            expiresAt: capsule.expiresAt,
          } satisfies CtxPackMaterializeError)
        }

        // Fragment texts come from the CURRENT pack row, never from the caller
        // body or the capsule summary.
        const pack = yield* catalog.get({ userID, workspaceID }, attachment.source.ctxPackID, true)
        yield* authorize({ actor: { userID, workspaceID }, operation: "ctxpack.read", pack })
        if (pack.deletedAt !== null) {
          return yield* Effect.fail({ _tag: "CtxPackDeleted", ctxPackID: pack.id } satisfies CtxPackMaterializeError)
        }
        if (capsule.contentHash !== attachment.contentHash || capsule.contentHash !== pack.contentHash) {
          return yield* Effect.fail({
            _tag: "CtxPackContentChanged",
            currentContentHash: pack.contentHash,
          } satisfies CtxPackMaterializeError)
        }

        const fragmentsById = new Map<string, CtxPackFragment>(
          pack.fragments.map((fragment) => [fragment.id, fragment]),
        )
        const fragments: SnapshotFragment[] = []
        for (const reference of capsule.references.filter(isFragmentReference)) {
          const fragment = fragmentsById.get(reference.ref.id)
          if (!fragment) {
            return yield* Effect.fail({
              _tag: "CtxPackContentChanged",
              currentContentHash: pack.contentHash,
            } satisfies CtxPackMaterializeError)
          }
          fragments.push({ text: fragment.text, source: fragment.source, contentHash: fragment.contentHash })
        }

        const tags = tagsFromFacts(capsule.facts)
        if (tags === undefined) return yield* Effect.die(new Error("CtxPack capsule tags are corrupt"))
        resolved.push({ attachment, tags, fragments })
      }

      const snapshotAttachments = resolved.map(({ attachment, tags, fragments }) => ({
        contextCapsuleID: attachment.contextCapsuleID,
        sourceCtxPackID: attachment.source.ctxPackID,
        label: attachment.label,
        ...(tags.length > 0 ? { tags } : {}),
        contentHash: attachment.contentHash,
        fragments,
      }))

      const createdAt = now()
      const payload = { version: 1 as const, attachments: snapshotAttachments, createdAt }
      const byteLength = new TextEncoder().encode(JSON.stringify(payload)).length
      const estimatedTokens = Math.ceil(byteLength / 4)
      if (byteLength > budget.maximumBytes) {
        return yield* Effect.fail({
          _tag: "CtxPackSnapshotOverBudget",
          current: byteLength,
          maximum: budget.maximumBytes,
        } satisfies CtxPackMaterializeError)
      }
      if (estimatedTokens > budget.maximumEstimatedTokens) {
        return yield* Effect.fail({
          _tag: "CtxPackSnapshotOverBudget",
          current: estimatedTokens,
          maximum: budget.maximumEstimatedTokens,
        } satisfies CtxPackMaterializeError)
      }

      const snapshot: CtxPackSnapshot = { ...payload, byteLength, estimatedTokens }
      yield* record({
        operation: "snapshot",
        workspaceID,
        attachmentCount: attachments.length,
        byteLength,
        estimatedTokens,
      })
      // Deep immutable: later pack mutation/deletion cannot change this object.
      return deepFreeze(snapshot)
    })
  }

  return { materialize, snapshotForSessionInput }
}
