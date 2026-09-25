/** Owned, browser-safe CtxPack v1 wire contract. Native engines are not dependencies. */
export type CtxPackSourceKind = "message" | "tool-output" | "terminal" | "file" | "search" | "note" | "block-text"
export type CtxPackDirection = "sent" | "received" | "generated" | "unknown"
export type CtxPackSensitivity = "public" | "workspace" | "private"
export type CtxPackTag = "ParallelPlan"
export type CtxPackSort = "created-desc" | "created-asc" | "updated-desc" | "title-asc" | "tokens-desc" | "most-attached" | "recently-attached"
export type CtxPackActor = { readonly userID: string; readonly workspaceID: string }
export type CtxPackSource = {
  readonly workspaceID: string
  readonly blockID: string
  readonly functionalityID: string
  readonly kind: CtxPackSourceKind
  readonly direction: CtxPackDirection
  readonly sourceTimestamp: number | null
  readonly capturedAt: number
  readonly entityRef: { readonly type: string; readonly id: string } | null
  readonly label: string | null
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
  readonly sensitivity: CtxPackSensitivity
}
export type CtxPackFragmentInput = { readonly clientFragmentID: string; readonly text: string; readonly source: CtxPackSource }
export type CtxPackFragment = CtxPackFragmentInput & {
  readonly id: string; readonly ordinal: number; readonly contentHash: string
  readonly byteLength: number; readonly estimatedTokens: number
}
export type CtxPackUsage = { readonly attachedCount: number; readonly lastAttachedAt: number | null }
export type CtxPackInfo = {
  readonly id: string; readonly workspaceID: string; readonly title: string
  readonly keywords: readonly string[]; readonly tags?: readonly CtxPackTag[]
  readonly sensitivity: CtxPackSensitivity; readonly revision: number; readonly contentHash: string
  readonly byteLength: number; readonly estimatedTokens: number; readonly fragments: readonly CtxPackFragment[]
  readonly usage: CtxPackUsage; readonly createdByUserID: string
  readonly createdAt: number; readonly updatedAt: number; readonly deletedAt: number | null; readonly pinnedAt: number | null
}
export type CtxPackSummary = Omit<CtxPackInfo, "fragments" | "createdByUserID"> & {
  readonly fragmentCount: number; readonly sourceBlockIDs: readonly string[]
  readonly sourceFunctionalityIDs: readonly string[]; readonly sourceKinds: readonly CtxPackSourceKind[]
}
export type CtxPackCreateRequest = {
  readonly workspaceID: string; readonly title: string; readonly keywords: readonly string[]
  readonly tags?: readonly CtxPackTag[]; readonly sensitivity: CtxPackSensitivity
  readonly fragments: readonly CtxPackFragmentInput[]; readonly idempotencyKey: string
}
export type CtxPackPatchRequest = {
  readonly workspaceID: string; readonly ctxPackID: string; readonly expectedRevision: number
  readonly patch: { readonly title?: string; readonly keywords?: readonly string[]; readonly tags?: readonly CtxPackTag[]; readonly sensitivity?: CtxPackSensitivity }
  readonly idempotencyKey: string
}
export type CtxPackListRequest = {
  readonly workspaceID: string; readonly query: string; readonly keyword: string | null
  readonly sourceBlockID: string | null; readonly sourceFunctionalityID: string | null; readonly sourceKind: CtxPackSourceKind | null
  readonly sensitivity: CtxPackSensitivity | null; readonly createdAfter: number | null; readonly createdBefore: number | null
  readonly includeDeleted: boolean; readonly pinnedOnly: boolean; readonly sort: CtxPackSort; readonly cursor: string | null; readonly limit: number
}
export type CtxPackListResult = { readonly items: readonly CtxPackSummary[]; readonly nextCursor: string | null; readonly totalEstimate: number | null }
export type CtxPackError =
  | { readonly _tag: "CtxPackNotFound" | "CtxPackDeleted"; readonly ctxPackID: string }
  | { readonly _tag: "CtxPackRevisionConflict"; readonly currentRevision: number }
  | { readonly _tag: "CtxPackContentChanged"; readonly currentContentHash: string }
  | { readonly _tag: "CtxPackInvalidSelection"; readonly reason: string }
  | { readonly _tag: "CtxPackBudgetExceeded"; readonly bytes: number; readonly estimatedTokens: number }
  | { readonly _tag: "CtxPackSecretSourceDenied"; readonly clientFragmentID: string }
  | { readonly _tag: "CtxPackCrossWorkspaceDenied"; readonly sourceWorkspaceID: string }
  | { readonly _tag: "CtxPackPermissionDenied"; readonly operation: string }
  | { readonly _tag: "CtxPackSearchCursorInvalid" }
export type CtxPackChanged = { readonly type: "workspace.ctxpack.changed"; readonly properties: {
  readonly workspaceID: string; readonly ctxPackID: string; readonly revision: number
  readonly change: "created" | "metadata-updated" | "deleted" | "restored" | "used" | "pinned" | "unpinned"
} }
export type CtxPackOperation = "ctxpack.create" | "ctxpack.read" | "ctxpack.patch" | "ctxpack.remove" | "ctxpack.restore"
export type CtxPackAccess = { readonly actor: CtxPackActor; readonly operation: CtxPackOperation; readonly pack?: CtxPackInfo }
