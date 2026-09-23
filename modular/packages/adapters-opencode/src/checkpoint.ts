import { createHash } from "node:crypto"

export const SENTINEL = "[Private model context checkpoint v1]"

export type PrivateCheckpoint = {
  readonly version: 1
  readonly rendererVersion: 1
  readonly summary: string
  readonly recent: string
  readonly contentHash: string
  readonly byteLength: number
  readonly estimatedTokens: number
  readonly createdAt: number
}

const CHECKPOINT_FIELDS = [
  "version",
  "rendererVersion",
  "summary",
  "recent",
  "contentHash",
  "byteLength",
  "estimatedTokens",
  "createdAt",
]

const encoder = new TextEncoder()

export class CorruptCheckpoint extends Error {
  readonly messageID: string

  constructor(messageID: string) {
    super(`corrupt checkpoint: ${messageID}`)
    this.name = "CorruptCheckpoint"
    this.messageID = messageID
  }
}

// Invalid constructor arguments are programmer errors, so fail fast with TypeError.
// Corrupted existing checkpoints are reported by decodeCheckpoint as CorruptCheckpoint.
export function makeCheckpoint(input: {
  readonly summary: string
  readonly recent: string
  readonly createdAt: number
}): PrivateCheckpoint {
  const candidate: unknown = input
  if (!isRecord(candidate)) throw new TypeError("checkpoint input must be an object")
  const summary = candidate.summary
  if (typeof summary !== "string") throw new TypeError("checkpoint summary must be a string")
  const recent = candidate.recent
  if (typeof recent !== "string") throw new TypeError("checkpoint recent must be a string")
  const createdAt = candidate.createdAt
  if (!isNonNegativeSafeInteger(createdAt)) throw new TypeError("checkpoint createdAt must be a nonnegative safe integer")
  const canonical = canonicalize(summary, recent)
  const byteLength = utf8ByteLength(canonical)
  return {
    version: 1,
    rendererVersion: 1,
    summary,
    recent,
    contentHash: hashCanonical(canonical),
    byteLength,
    estimatedTokens: Math.ceil(byteLength / 4),
    createdAt,
  }
}

export function decodeCheckpoint(value: unknown, messageID: string): PrivateCheckpoint {
  const parsed = typeof value === "string" ? parseCheckpointJson(value, messageID) : value
  const fields = requireCheckpointFields(parsed, messageID)
  const canonical = canonicalize(fields.summary, fields.recent)
  const byteLength = utf8ByteLength(canonical)
  const estimatedTokens = Math.ceil(byteLength / 4)
  const contentHash = hashCanonical(canonical)
  if (fields.contentHash !== contentHash) throw new CorruptCheckpoint(messageID)
  if (fields.byteLength !== byteLength) throw new CorruptCheckpoint(messageID)
  if (fields.estimatedTokens !== estimatedTokens) throw new CorruptCheckpoint(messageID)
  return {
    version: 1,
    rendererVersion: 1,
    summary: fields.summary,
    recent: fields.recent,
    contentHash,
    byteLength,
    estimatedTokens,
    createdAt: fields.createdAt,
  }
}

function requireCheckpointFields(value: unknown, messageID: string) {
  if (!isRecord(value)) throw new CorruptCheckpoint(messageID)
  const keys = Object.keys(value)
  if (keys.length !== CHECKPOINT_FIELDS.length) throw new CorruptCheckpoint(messageID)
  if (!CHECKPOINT_FIELDS.every((field) => keys.includes(field))) throw new CorruptCheckpoint(messageID)
  if (value.version !== 1) throw new CorruptCheckpoint(messageID)
  if (value.rendererVersion !== 1) throw new CorruptCheckpoint(messageID)
  const summary = value.summary
  if (typeof summary !== "string") throw new CorruptCheckpoint(messageID)
  const recent = value.recent
  if (typeof recent !== "string") throw new CorruptCheckpoint(messageID)
  const contentHash = value.contentHash
  if (typeof contentHash !== "string") throw new CorruptCheckpoint(messageID)
  const byteLength = value.byteLength
  if (!isNonNegativeSafeInteger(byteLength)) throw new CorruptCheckpoint(messageID)
  const estimatedTokens = value.estimatedTokens
  if (!isNonNegativeSafeInteger(estimatedTokens)) throw new CorruptCheckpoint(messageID)
  const createdAt = value.createdAt
  if (!isNonNegativeSafeInteger(createdAt)) throw new CorruptCheckpoint(messageID)
  return { summary, recent, contentHash, byteLength, estimatedTokens, createdAt }
}

function parseCheckpointJson(value: string, messageID: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new CorruptCheckpoint(messageID)
  }
}

function canonicalize(summary: string, recent: string): string {
  return JSON.stringify({ version: 1, rendererVersion: 1, summary, recent })
}

function hashCanonical(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex")
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
