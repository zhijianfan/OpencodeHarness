/** Server-side durable CtxPack capsule boundary; no native or fork imports. */
export type ContextBudget = {
  readonly maximumBytes: number
  readonly maximumEstimatedTokens: number
  readonly maximumFacts: number
  readonly maximumReferences: number
  readonly maximumArtifacts: number
  readonly maximumRecentEvents: number
}
export const DefaultInteractiveContextBudget: ContextBudget = {
  maximumBytes: 32 * 1024,
  maximumEstimatedTokens: 6_000,
  maximumFacts: 32,
  maximumReferences: 16,
  maximumArtifacts: 8,
  maximumRecentEvents: 8,
}
export type StoredCapsule = {
  readonly id: string
  readonly version: 1
  readonly workspaceId: string
  readonly purpose: string
  readonly audience: readonly string[]
  readonly summary?: string
  readonly facts: readonly unknown[]
  readonly references: readonly unknown[]
  readonly artifactRefs: readonly unknown[]
  readonly recentEvents: readonly unknown[]
  readonly contentHash: string
  readonly createdAt: number
  readonly expiresAt?: number
  readonly createdBy: { readonly userId: string; readonly instanceId: string; readonly operationId?: string }
  readonly budget: ContextBudget
}
export type CapsuleResult =
  | { readonly status: "not-found" }
  | { readonly status: "expired"; readonly expiresAt: number }
  | { readonly status: "over-budget"; readonly limit: "bytes" | "tokens"; readonly current: number; readonly maximum: number }
  | { readonly status: "ok"; readonly capsule: StoredCapsule; readonly content: {
    readonly facts: readonly unknown[]; readonly references: readonly unknown[]; readonly artifactRefs: readonly unknown[]
  }; readonly unresolvedRefs: readonly string[]; readonly byteLength: number; readonly estimatedTokens: number }
export type CapsuleError =
  | { readonly _tag: "ContextCapsule.Conflict"; readonly capsuleID: string; readonly workspaceID: string }
  | { readonly _tag: "ContextCapsule.Corrupt"; readonly capsuleID: string; readonly workspaceID: string }
export type CtxPackAttachment = { readonly contextCapsuleID: string; readonly label: string; readonly contentHash: string;
  readonly source: { readonly kind: "ctxpack"; readonly ctxPackID: string } }
export type CtxPackMaterializeRequest = { readonly workspaceID: string; readonly ctxPackID: string; readonly expectedContentHash: string;
  readonly targetInstanceID: string; readonly targetFunctionalityID: string }
export type CtxPackMaterializeResult = { readonly contextCapsuleID: string; readonly sourceCtxPackID: string;
  readonly label: string; readonly tags?: readonly "ParallelPlan"[]; readonly contentHash: string; readonly estimatedTokens: number }
export type CtxPackSnapshot = { readonly version: 1; readonly attachments: readonly {
  readonly contextCapsuleID: string; readonly sourceCtxPackID: string; readonly label: string;
  readonly tags?: readonly "ParallelPlan"[]; readonly contentHash: string;
  readonly fragments: readonly { readonly text: string; readonly source: import("./ctxpack").CtxPackSource; readonly contentHash: string }[]
}[]; readonly byteLength: number; readonly estimatedTokens: number; readonly createdAt: number }
export type CtxPackMaterializeError = import("./ctxpack").CtxPackError |
  { readonly _tag: "CtxPackCapabilityDenied"; readonly operation: string } |
  { readonly _tag: "CtxPackCapsuleMissing" } |
  { readonly _tag: "CtxPackCapsuleExpired"; readonly expiresAt: number } |
  { readonly _tag: "CtxPackCapsuleTargetMismatch"; readonly target: "audience" | "instance" | "purpose" | "workspace" } |
  { readonly _tag: "CtxPackSnapshotOverBudget"; readonly current: number; readonly maximum: number } |
  { readonly _tag: "CtxPackSnapshotDuplicateCapsule"; readonly contextCapsuleID: string }
