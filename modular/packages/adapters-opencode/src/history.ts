import { createHash } from "node:crypto"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Token } from "@opencode-ai/core/util/token"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { decodeCheckpoint, SENTINEL, type PrivateCheckpoint } from "./checkpoint"

const TRUNCATE_LENGTH = 2000

export type HistoryEntry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

export type PrivateInput = {
  readonly apiContent: string
  readonly apiContentHash: string
}

export class PrivateHistoryError extends Error {
  readonly messageID: string

  constructor(messageID: string) {
    super(`private history entry ${messageID} is invalid`)
    this.name = "PrivateHistoryError"
    this.messageID = messageID
  }
}

export function enrichEntries(
  entries: readonly HistoryEntry[],
  inputs: ReadonlyMap<string, PrivateInput>,
  checkpoints: ReadonlyMap<string, PrivateCheckpoint>,
  requiredInputs: ReadonlySet<string> = new Set(),
): readonly HistoryEntry[] {
  return entries.map((entry) => {
    const id = entry.message.id
    const input = inputs.get(id)
    const checkpoint = checkpoints.get(id)

    if (entry.message.type === "user") {
      if (input) {
        if (sha256(input.apiContent) !== input.apiContentHash) throw new PrivateHistoryError(id)
        if (checkpoint) throw new PrivateHistoryError(id)
        return { seq: entry.seq, message: { ...entry.message, text: input.apiContent } }
      }
      if (requiredInputs.has(id)) throw new PrivateHistoryError(id)
      if (checkpoint) throw new PrivateHistoryError(id)
      return entry
    }

    if (input) throw new PrivateHistoryError(id)

    if (entry.message.type !== "compaction") {
      if (checkpoint) throw new PrivateHistoryError(id)
      return entry
    }

    if (entry.message.summary !== SENTINEL) {
      if (checkpoint) throw new PrivateHistoryError(id)
      return entry
    }

    if (!checkpoint) throw new PrivateHistoryError(id)
    const decoded = decodePrivateCheckpoint(checkpoint, id)
    return { seq: entry.seq, message: { ...entry.message, summary: decoded.summary, recent: decoded.recent } }
  })
}

export function serializeEntry(message: SessionMessage.Message): string {
  switch (message.type) {
    case "user": {
      const attachments = (message.files ?? []).map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`)
      return [`[User]: ${message.text}`, ...attachments].join("\n")
    }
    case "assistant": {
      const lines = message.content.map((part) => {
        switch (part.type) {
          case "text":
            return `[Assistant]: ${part.text}`
          case "reasoning":
            return part.text ? `[Assistant reasoning]: ${part.text}` : ""
          case "tool": {
            const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
            const call = `[Assistant tool call]: ${part.name}(${input})`
            if (part.state.status === "completed")
              return `${call}\n[Tool result]: ${truncate(SessionCompaction.serializeToolContent(part.state.content))}`
            if (part.state.status === "error") return `${call}\n[Tool error]: ${part.state.error.message}`
            return call
          }
          default:
            return ""
        }
      })
      return lines.filter((line) => line !== "").join("\n")
    }
    case "system":
      return `[System update]: ${message.text}`
    case "synthetic":
      return `[Synthetic context]: ${message.text}`
    case "shell":
      return `[Shell]: ${message.command}\n${truncate(message.output)}`
    default:
      return ""
  }
}

export function renderEntries(entries: readonly HistoryEntry[]): string {
  return entries
    .map((entry) => serializeEntry(entry.message))
    .filter((text) => text !== "")
    .join("\n\n")
}

export function splitEntries(
  entries: readonly HistoryEntry[],
  keepTokens: number,
): { readonly head: readonly HistoryEntry[]; readonly recent: readonly HistoryEntry[] } | undefined {
  if (!Number.isFinite(keepTokens) || keepTokens < 0)
    throw new RangeError("keepTokens must be a finite number greater than or equal to zero")

  const candidates = entries.flatMap((entry) => {
    const text = serializeEntry(entry.message)
    return text === "" ? [] : [{ entry, text }]
  })
  if (candidates.length === 0) return undefined

  let kept = 0
  let total = 0
  for (const candidate of [...candidates].reverse()) {
    const next = total + Token.estimate(candidate.text)
    if (next > keepTokens) break
    total = next
    kept += 1
  }
  const boundary = candidates.length - kept
  return {
    head: candidates.slice(0, boundary).map((candidate) => candidate.entry),
    recent: candidates.slice(boundary).map((candidate) => candidate.entry),
  }
}

function truncate(text: string): string {
  if (text.length <= TRUNCATE_LENGTH) return text
  return `${text.slice(0, TRUNCATE_LENGTH)}\n[truncated]`
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function decodePrivateCheckpoint(checkpoint: PrivateCheckpoint, messageID: string): PrivateCheckpoint {
  try {
    return decodeCheckpoint(checkpoint, messageID)
  } catch {
    throw new PrivateHistoryError(messageID)
  }
}
