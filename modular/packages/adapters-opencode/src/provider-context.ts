import { LLM, Message, type LLMRequest } from "@opencode-ai/llm"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { Effect } from "effect"
import { readPrivateHistory } from "./context-store"
import { PrivateHistoryError, type HistoryEntry } from "./history"

/** Adapter-owned request construction; it does not monkeypatch the native runner. */
export const preparePrivateTurn = Effect.fn("CyberMastery.preparePrivateTurn")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly HistoryEntry[]
  readonly request: LLMRequest
}) {
  const headers = new Headers(input.request.http?.headers)
  for (const name of ["x-session-id", "x-session-affinity"]) {
    const value = headers.get(name)
    if (value !== null && value !== input.sessionID) throw new PrivateHistoryError(input.sessionID)
  }
  const context = yield* readPrivateHistory(input.sessionID, input.entries)
  if (!context.private) return { ...context, request: input.request }
  const selected = context.entries.filter((entry) => context.inputMap.has(entry.message.id) || context.checkpointMap.has(entry.message.id))
  const replacements = new Map(toLLMMessages(selected.map((entry) => entry.message), input.request.model).map((message) => [message.id, message]))
  const publicMessages = new Map(toLLMMessages(input.entries.map((entry) => entry.message), input.request.model).map((message) => [message.id, message]))
  const matched = new Set<string>()
  const messages = input.request.messages.map((message) => {
    if (!message.id || !replacements.has(message.id)) return message
    const original = publicMessages.get(message.id)
    const replacement = replacements.get(message.id)
    if (!original || !replacement || original.role !== message.role || JSON.stringify(original.content) !== JSON.stringify(message.content)) {
      throw new PrivateHistoryError(message.id)
    }
    matched.add(message.id)
    return Message.make({ ...message, content: replacement.content })
  })
  for (const entry of selected) if (!matched.has(entry.message.id)) throw new PrivateHistoryError(entry.message.id)
  return { ...context, request: LLM.updateRequest(input.request, { messages }) }
})
