import { Effect, Schema } from "effect"
import type { privateManifest, SyncPage } from "./transfer-spool"

const Integer = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const HighWater = Schema.Record(Schema.String, Integer)
const CompleteRecord = Schema.Struct({
  kind: Schema.Literals(["event", "context", "deletion", "epoch"]),
  aggregateID: Schema.String, sourceSeq: Integer, sequence: Integer, identity: Schema.String, value: Schema.Json,
})
const ChunkRecord = Schema.Struct({
  kind: Schema.Literal("chunk"), recordKind: Schema.Literals(["event", "context", "deletion", "epoch"]),
  aggregateID: Schema.String, sourceSeq: Integer, sequence: Integer, identity: Schema.String,
  chunkIndex: Integer, chunkCount: Integer, byteLength: Integer, contentHash: Schema.String, data: Schema.String,
})
const Page = Schema.Struct({ records: Schema.Array(Schema.Union([CompleteRecord, ChunkRecord])) })

export const TransferHistoryRequest = Schema.Struct({
  version: Schema.Literal(1), capabilityOnly: Schema.Boolean,
  discoveryCursor: Schema.optional(Schema.String),
  aggregates: Schema.Record(Schema.String, Schema.Struct({ cursor: Integer, privateDigest: Schema.String })),
  sourceSnapshotToken: Schema.optional(Schema.String), pageCursor: Schema.optional(Schema.String),
  repairCursor: Schema.optional(Schema.String),
})
export type TransferHistoryRequest = typeof TransferHistoryRequest.Type

export type TransferHistoryResponse = {
  readonly version: 1
  readonly aggregates: ReadonlyArray<ReturnType<typeof privateManifest>>
  readonly discoveryCursor?: string
  readonly sourceSnapshotToken: string
  readonly manifestDigest: string
  readonly highWater: Readonly<Record<string, number>>
  readonly page: SyncPage
  readonly nextCursor?: string
}

export const TransferReplayRequest = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1), action: Schema.Literal("begin"), clientTransferID: Schema.String,
    directory: Schema.String, sourceSnapshotToken: Schema.String, highWater: HighWater,
    manifestDigest: Schema.String, expiresAt: Integer,
  }),
  Schema.Struct({
    version: Schema.Literal(1), action: Schema.Literal("append"), transferHandle: Schema.String,
    pageIndex: Integer, pageHash: Schema.String, page: Page,
  }),
  Schema.Struct({
    version: Schema.Literal(1), action: Schema.Literal("finalize"), transferHandle: Schema.String,
    expectedPageCount: Integer, manifestDigest: Schema.String,
  }),
  Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal("abort"), transferHandle: Schema.String }),
])
export type TransferReplayRequest = typeof TransferReplayRequest.Type

export type TransferReplayResponse =
  | { readonly version: 1; readonly action: "begin"; readonly transferHandle: string; readonly expiresAt: number }
  | { readonly version: 1; readonly action: "append"; readonly transferHandle: string; readonly nextPageIndex: number }
  | { readonly version: 1; readonly action: "finalize"; readonly manifestReceipt: string }
  | { readonly version: 1; readonly action: "abort"; readonly transferHandle: string }

/** Runtime schema for the private manifest element carried by history responses. */
export const PrivateManifestSchema = Schema.Struct({
  aggregateID: Schema.String,
  sourceSeq: Integer,
  privateCount: Integer,
  privateDigest: Schema.String,
  deletionCount: Integer,
  deletionDigest: Schema.String,
  epochDigest: Schema.optional(Schema.String),
})

/** Runtime schema for the `POST /sync/history` success body. */
export const TransferHistoryResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  aggregates: Schema.Array(PrivateManifestSchema),
  discoveryCursor: Schema.optional(Schema.String),
  sourceSnapshotToken: Schema.String,
  manifestDigest: Schema.String,
  highWater: HighWater,
  page: Page,
  nextCursor: Schema.optional(Schema.String),
})

/** Runtime schema for the `POST /sync/replay` success body. */
export const TransferReplayResponseSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal("begin"), transferHandle: Schema.String, expiresAt: Integer }),
  Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal("append"), transferHandle: Schema.String, nextPageIndex: Integer }),
  Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal("finalize"), manifestReceipt: Schema.String }),
  Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal("abort"), transferHandle: Schema.String }),
])

/** Runtime schema for the `POST /sync/start` success body. */
export const TransferStartResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  acceptedRevision: Schema.String,
  expiresAt: Integer,
  transferRequired: Schema.Boolean,
})

/** Runtime schema for a private error body; only the stable code is ever surfaced. */
export const TransferErrorResponseSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.optional(Schema.String),
})

/** Trusted placement and principal supplied by host composition, never request-body authority. */
export type TransferScope = {
  readonly principalID: string
  readonly ownerID: string
  readonly workspaceID?: string
  readonly projectID: string
  readonly directory: string
}

export class TransferError extends Schema.TaggedErrorClass<TransferError>()("CyberMastery.Transfer", {
  code: Schema.Literals(["invalid", "forbidden", "conflict", "restart", "snapshot-advanced", "version", "too-large", "busy", "expired"]),
  message: Schema.String,
}) {}

export type TransferPolicy = {
  readonly scope: TransferScope
  readonly authorize: (scope: TransferScope, operation: "history" | "replay") => Effect.Effect<void, TransferError>
}
