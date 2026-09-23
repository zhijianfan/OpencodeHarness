import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { DateTime, Schema } from "effect"
import { Session } from "@opencode-ai/schema/session"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Token } from "@opencode-ai/core/util/token"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SENTINEL, makeCheckpoint, type PrivateCheckpoint } from "../src/checkpoint"
import {
  PrivateHistoryError,
  enrichEntries,
  renderEntries,
  serializeEntry,
  splitEntries,
  type HistoryEntry,
  type PrivateInput,
} from "../src/history"

const created = DateTime.makeUnsafe(0)

function userMessage(id: string, text: string): SessionMessage.Message {
  return SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    type: "user",
    text,
    time: { created },
  })
}

function userMessageWithFiles(id: string): SessionMessage.Message {
  return SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    type: "user",
    text: "hello",
    time: { created },
    files: [
      { mime: "text/plain", name: "note.txt", uri: "file:///note.txt" },
      { mime: "image/png", uri: "file:///img.png" },
    ],
  })
}

function compactionMessage(id: string, summary: string, recent: string): SessionMessage.Message {
  return {
    id: SessionMessage.ID.make(id),
    type: "compaction",
    summary,
    recent,
    time: { created },
    reason: "auto",
  }
}

function assistantMessage(): SessionMessage.Message {
  return Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: "msg_assistant",
    type: "assistant",
    agent: "proof",
    model: { id: "proof-model", providerID: "proof-provider" },
    content: [
      { type: "text", id: "text-1", text: "hello" },
      { type: "reasoning", id: "reasoning-1", text: "" },
      { type: "reasoning", id: "reasoning-2", text: "thinking" },
      {
        type: "tool",
        id: "read-1",
        name: "read",
        time: { created: 0 },
        state: { status: "completed", input: { path: "a" }, structured: {}, content: [{ type: "text", text: "file body" }] },
      },
      { type: "tool", id: "write-1", name: "write", time: { created: 0 }, state: { status: "error", input: { path: "b" }, structured: {}, content: [], error: { type: "unknown", message: "nope" } } },
      { type: "tool", id: "glob-1", name: "glob", time: { created: 0 }, state: { status: "pending", input: "{}" } },
    ],
    time: { created: 0 },
  })
}

function entry(seq: number, message: SessionMessage.Message): HistoryEntry {
  return { seq, message }
}

function at(entries: readonly HistoryEntry[], index: number): HistoryEntry {
  const value = entries[index]
  if (!value) throw new Error(`expected an entry at index ${index}`)
  return value
}

function asUser(message: SessionMessage.Message) {
  if (message.type !== "user") throw new Error(`expected a user message, received ${message.type}`)
  return message
}

function asCompaction(message: SessionMessage.Message) {
  if (message.type !== "compaction") throw new Error(`expected a compaction message, received ${message.type}`)
  return message
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function privateInput(apiContent: string): PrivateInput {
  return { apiContent, apiContentHash: sha256(apiContent) }
}

function capture(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("expected the operation to fail")
}

function messageIDOf(error: unknown): string {
  if (!(error instanceof PrivateHistoryError)) throw new Error(`expected PrivateHistoryError, received ${String(error)}`)
  return error.messageID
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw new Error("expected an Error")
  return error.message
}

function checkpointFixture(summary: string, recent: string, _messageID: string): PrivateCheckpoint {
  return makeCheckpoint({ summary, recent, createdAt: 0 })
}

describe("serializeEntry", () => {
  test("serializes user text and attachments", () => {
    expect(serializeEntry(userMessageWithFiles("msg_user"))).toBe(
      "[User]: hello\n[Attached text/plain: note.txt]\n[Attached image/png: file:///img.png]",
    )
  })

  test("serializes system, synthetic, and shell messages", () => {
    const system: SessionMessage.Message = {
      id: SessionMessage.ID.make("msg_system"),
      type: "system",
      text: "update",
      time: { created },
    }
    const synthetic: SessionMessage.Message = {
      id: SessionMessage.ID.make("msg_synthetic"),
      type: "synthetic",
      sessionID: Session.ID.make("ses_history"),
      text: "context",
      time: { created },
    }
    const shell: SessionMessage.Message = {
      id: SessionMessage.ID.make("msg_shell"),
      type: "shell",
      callID: "shell-1",
      command: "ls",
      output: "out",
      time: { created },
    }
    expect(serializeEntry(system)).toBe("[System update]: update")
    expect(serializeEntry(synthetic)).toBe("[Synthetic context]: context")
    expect(serializeEntry(shell)).toBe("[Shell]: ls\nout")
  })

  test("serializes assistant text, reasoning, and tool parts", () => {
    const toolResult = SessionCompaction.serializeToolContent([{ type: "text", text: "file body" }])
    expect(serializeEntry(assistantMessage())).toBe(
      [
        "[Assistant]: hello",
        "[Assistant reasoning]: thinking",
        `[Assistant tool call]: read({"path":"a"})`,
        `[Tool result]: ${toolResult}`,
        `[Assistant tool call]: write({"path":"b"})`,
        "[Tool error]: nope",
        "[Assistant tool call]: glob({})",
      ].join("\n"),
    )
  })

  test("omits compaction messages", () => {
    expect(serializeEntry(compactionMessage("msg_compaction", "clean summary", "clean recent"))).toBe("")
  })

  test("truncates long shell output at 2000 characters", () => {
    const shell: SessionMessage.Message = {
      id: SessionMessage.ID.make("msg_shell"),
      type: "shell",
      callID: "shell-2",
      command: "cat",
      output: "a".repeat(2001),
      time: { created },
    }
    expect(serializeEntry(shell)).toBe(`[Shell]: cat\n${"a".repeat(2000)}\n[truncated]`)
  })
})

describe("renderEntries", () => {
  test("joins non-empty entries with a blank line", () => {
    const entries = [
      entry(1, userMessage("msg_a", "alpha")),
      entry(2, compactionMessage("msg_b", "summary", "recent")),
      entry(3, userMessage("msg_c", "gamma")),
    ]
    expect(renderEntries(entries)).toBe("[User]: alpha\n\n[User]: gamma")
  })

  test("returns an empty string when nothing renders", () => {
    expect(renderEntries([entry(1, compactionMessage("msg_compaction", "summary", "recent"))])).toBe("")
  })
})

describe("enrichEntries", () => {
  test("keeps clean user messages untouched", () => {
    const message = userMessage("msg_user", "clean text")
    const result = enrichEntries([entry(3, message)], new Map(), new Map())
    expect(result).toHaveLength(1)
    expect(at(result, 0).seq).toBe(3)
    expect(asUser(at(result, 0).message).text).toBe("clean text")
    expect(asUser(message).text).toBe("clean text")
  })

  test("projects private input over a visible user message without mutating it", () => {
    const message = userMessage("msg_user", "clean text")
    const entries = [entry(1, message)]
    const inputs = new Map<string, PrivateInput>([["msg_user", privateInput("private text")]])
    const result = enrichEntries(entries, inputs, new Map())
    const enriched = at(result, 0)
    expect(enriched.seq).toBe(1)
    expect(enriched.message).not.toBe(message)
    expect(asUser(enriched.message).text).toBe("private text")
    expect(asUser(message).text).toBe("clean text")
    expect(entries[0]?.message).toBe(message)
  })

  test("fails when a private input hash does not match its content", () => {
    const entries = [entry(1, userMessage("msg_user", "clean text"))]
    const inputs = new Map<string, PrivateInput>([
      ["msg_user", { apiContent: "private text", apiContentHash: sha256("other text") }],
    ])
    const error = capture(() => enrichEntries(entries, inputs, new Map()))
    expect(messageIDOf(error)).toBe("msg_user")
    expect(errorMessage(error)).not.toContain("private text")
  })

  test("fails when a required private input is missing", () => {
    const entries = [entry(1, userMessage("msg_user", "clean text"))]
    const error = capture(() => enrichEntries(entries, new Map(), new Map(), new Set(["msg_user"])))
    expect(messageIDOf(error)).toBe("msg_user")
  })

  test("restores private summary and recent from a checkpoint", () => {
    const message = compactionMessage("msg_compaction", SENTINEL, "clean recent")
    const checkpoints = new Map<string, PrivateCheckpoint>([
      ["msg_compaction", checkpointFixture("private summary", "private recent", "msg_compaction")],
    ])
    const result = enrichEntries([entry(2, message)], new Map(), checkpoints)
    const restored = asCompaction(at(result, 0).message)
    expect(restored.summary).toBe("private summary")
    expect(restored.recent).toBe("private recent")
    expect(asCompaction(message).summary).toBe(SENTINEL)
    expect(asCompaction(message).recent).toBe("clean recent")
  })

  test("fails when a sentinel compaction has no checkpoint", () => {
    const entries = [entry(1, compactionMessage("msg_compaction", SENTINEL, "clean recent"))]
    const error = capture(() => enrichEntries(entries, new Map(), new Map()))
    expect(messageIDOf(error)).toBe("msg_compaction")
  })

  test("fails when a checkpoint content hash is corrupt", () => {
    const message = compactionMessage("msg_compaction", SENTINEL, "clean recent")
    const fixture = checkpointFixture("private summary", "private recent", "msg_compaction")
    const checkpoints = new Map<string, PrivateCheckpoint>([
      ["msg_compaction", { ...fixture, contentHash: sha256("tampered") }],
    ])
    const error = capture(() => enrichEntries([entry(1, message)], new Map(), checkpoints))
    expect(messageIDOf(error)).toBe("msg_compaction")
    expect(errorMessage(error)).not.toContain("private summary")
  })

  test("fails when a checkpoint byte length is corrupt", () => {
    const message = compactionMessage("msg_compaction", SENTINEL, "clean recent")
    const fixture = checkpointFixture("private summary", "private recent", "msg_compaction")
    const checkpoints = new Map<string, PrivateCheckpoint>([
      ["msg_compaction", { ...fixture, byteLength: fixture.byteLength + 1 }],
    ])
    const error = capture(() => enrichEntries([entry(1, message)], new Map(), checkpoints))
    expect(messageIDOf(error)).toBe("msg_compaction")
  })

  test("fails when private input is keyed to a visible non-user message", () => {
    const entries = [entry(1, compactionMessage("msg_compaction", "clean summary", "clean recent"))]
    const inputs = new Map<string, PrivateInput>([["msg_compaction", privateInput("private text")]])
    const error = capture(() => enrichEntries(entries, inputs, new Map()))
    expect(messageIDOf(error)).toBe("msg_compaction")
  })

  test("fails when a checkpoint is keyed to a visible non-compaction message", () => {
    const entries = [entry(1, userMessage("msg_user", "clean text"))]
    const checkpoints = new Map<string, PrivateCheckpoint>([
      ["msg_user", checkpointFixture("private summary", "private recent", "msg_user")],
    ])
    const error = capture(() => enrichEntries(entries, new Map(), checkpoints))
    expect(messageIDOf(error)).toBe("msg_user")
  })

  test("fails when a checkpoint is attached to a non-sentinel compaction", () => {
    const entries = [entry(1, compactionMessage("msg_compaction", "clean summary", "clean recent"))]
    const checkpoints = new Map<string, PrivateCheckpoint>([
      ["msg_compaction", checkpointFixture("private summary", "private recent", "msg_compaction")],
    ])
    const error = capture(() => enrichEntries(entries, new Map(), checkpoints))
    expect(messageIDOf(error)).toBe("msg_compaction")
  })

  test("ignores private records for messages outside the selected history", () => {
    const entries = [entry(1, userMessage("msg_user", "clean text"))]
    const inputs = new Map<string, PrivateInput>([["msg_other", privateInput("private text")]])
    const checkpoints = new Map<string, PrivateCheckpoint>([
      ["msg_other", checkpointFixture("private summary", "private recent", "msg_other")],
    ])
    const result = enrichEntries(entries, inputs, checkpoints)
    expect(result).toHaveLength(1)
    expect(asUser(at(result, 0).message).text).toBe("clean text")
  })

  test("preserves metadata and attachments when projecting private input", () => {
    const message = userMessageWithFiles("msg_user")
    const inputs = new Map<string, PrivateInput>([["msg_user", privateInput("private text")]])
    const result = enrichEntries([entry(5, message)], inputs, new Map())
    const enriched = asUser(at(result, 0).message)
    const original = asUser(message)
    expect(at(result, 0).seq).toBe(5)
    expect(enriched.id).toBe(original.id)
    expect(enriched.time).toBe(original.time)
    expect(enriched.files).toEqual(original.files)
    expect(enriched.text).toBe("private text")
    expect(original.text).toBe("hello")
  })
})

describe("splitEntries", () => {
  test("keeps the most recent entries within the token budget", () => {
    const entries = [
      entry(1, userMessage("msg_a", "alpha ".repeat(10))),
      entry(2, userMessage("msg_b", "beta ".repeat(10))),
    ]
    const split = splitEntries(entries, Token.estimate(serializeEntry(at(entries, 1).message)))
    expect(split?.head.map((item) => item.seq)).toEqual([1])
    expect(split?.recent.map((item) => item.seq)).toEqual([2])
  })

  test("measures the budget against enriched text rather than clean text", () => {
    const clean = entry(1, userMessage("msg_clean", "tiny"))
    const target = entry(2, userMessage("msg_private", "tiny"))
    const privateContent = "x".repeat(4000)
    const enriched = enrichEntries([clean, target], new Map([["msg_private", privateInput(privateContent)]]), new Map())
    const budget = Token.estimate(serializeEntry(at(enriched, 1).message))
    expect(budget).toBeGreaterThan(Token.estimate(serializeEntry(target.message)))
    expect(renderEntries(enriched)).toContain(privateContent)
    const split = splitEntries(enriched, budget)
    expect(split?.head.map((item) => item.seq)).toEqual([1])
    expect(split?.recent.map((item) => item.seq)).toEqual([2])
  })

  test("orders head and recent in sequence at both budget extremes", () => {
    const entries = [
      entry(1, userMessage("msg_a", "alpha ".repeat(10))),
      entry(2, userMessage("msg_b", "beta ".repeat(10))),
      entry(3, userMessage("msg_c", "gamma ".repeat(10))),
    ]
    const zero = splitEntries(entries, 0)
    expect(zero?.head.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(zero?.recent).toEqual([])
    const full = splitEntries(entries, Number.MAX_SAFE_INTEGER)
    expect(full?.head).toEqual([])
    expect(full?.recent.map((item) => item.seq)).toEqual([1, 2, 3])
  })

  test("excludes entries with empty serialization and returns undefined when nothing remains", () => {
    const entries = [
      entry(1, userMessage("msg_user", "hello")),
      entry(2, compactionMessage("msg_compaction", "clean summary", "clean recent")),
    ]
    const split = splitEntries(entries, 0)
    expect(split?.head.map((item) => item.seq)).toEqual([1])
    expect(split?.recent).toEqual([])
    expect(splitEntries([entry(1, compactionMessage("msg_only", "clean summary", "clean recent"))], 100)).toBeUndefined()
  })

  test("rejects invalid token budgets", () => {
    const entries = [entry(1, userMessage("msg_user", "hello"))]
    expect(() => splitEntries(entries, -1)).toThrow()
    expect(() => splitEntries(entries, Number.NaN)).toThrow()
    expect(() => splitEntries(entries, Number.POSITIVE_INFINITY)).toThrow()
  })
})
