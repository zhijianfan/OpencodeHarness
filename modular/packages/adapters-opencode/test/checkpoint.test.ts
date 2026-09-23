import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { CorruptCheckpoint, SENTINEL, decodeCheckpoint, makeCheckpoint } from "../src/checkpoint"

const encoder = new TextEncoder()
const newline = String.fromCharCode(10)
const tab = String.fromCharCode(9)
const control = String.fromCharCode(1)
const backslash = String.fromCharCode(92)

const summary = "héllo 秘密"
const recent = "recent 🚀"
const createdAt = 1_700_000_000_000
const canonical = '{"version":1,"rendererVersion":1,"summary":"héllo 秘密","recent":"recent 🚀"}'

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function captureError(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error("thrown value is not an Error")
  }
  throw new Error("expected the callback to throw")
}

function makeCheckpointRaw(input: unknown) {
  return makeCheckpoint(input as { readonly summary: string; readonly recent: string; readonly createdAt: number })
}

function withoutField(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))
}

describe("SENTINEL", () => {
  test("matches the private checkpoint marker", () => {
    expect(SENTINEL).toBe("[Private model context checkpoint v1]")
  })
})

describe("CorruptCheckpoint", () => {
  test("is an Error that reports only the message id", () => {
    const error = new CorruptCheckpoint("marker-7")
    expect(error).toBeInstanceOf(Error)
    expect(error.messageID).toBe("marker-7")
    expect(error.message).toContain("marker-7")
  })
})

describe("makeCheckpoint", () => {
  test("matches an independently computed canonical fixture", () => {
    const expectedByteLength = encoder.encode(canonical).byteLength
    expect(JSON.stringify({ version: 1, rendererVersion: 1, summary, recent })).toBe(canonical)
    expect(expectedByteLength).toBeGreaterThan(canonical.length)
    expect(makeCheckpoint({ summary, recent, createdAt })).toEqual({
      version: 1,
      rendererVersion: 1,
      summary,
      recent,
      contentHash: sha256(canonical),
      byteLength: expectedByteLength,
      estimatedTokens: Math.ceil(expectedByteLength / 4),
      createdAt,
    })
  })

  test("preserves summary and recent byte-for-byte", () => {
    const spacedSummary = `  keep${newline}${tab} spacing  `
    const trailingRecent = `${newline} trailing `
    const checkpoint = makeCheckpoint({ summary: spacedSummary, recent: trailingRecent, createdAt: 0 })
    expect(checkpoint.summary).toBe(spacedSummary)
    expect(checkpoint.recent).toBe(trailingRecent)
  })

  test("is deterministic and excludes createdAt from the content hash", () => {
    const early = makeCheckpoint({ summary, recent, createdAt: 0 })
    const late = makeCheckpoint({ summary, recent, createdAt: Number.MAX_SAFE_INTEGER })
    expect(early.contentHash).toBe(late.contentHash)
    expect(early.byteLength).toBe(late.byteLength)
    expect(early.estimatedTokens).toBe(late.estimatedTokens)
    expect(early.createdAt).toBe(0)
    expect(late.createdAt).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("rejects invalid arguments with TypeError", () => {
    expect(() => makeCheckpointRaw(null)).toThrow(TypeError)
    expect(() => makeCheckpointRaw({ summary: 1, recent: "r", createdAt: 0 })).toThrow(TypeError)
    expect(() => makeCheckpointRaw({ summary: "s", recent: null, createdAt: 0 })).toThrow(TypeError)
    expect(() => makeCheckpointRaw({ summary: "s", recent: "r", createdAt: -1 })).toThrow(TypeError)
    expect(() => makeCheckpointRaw({ summary: "s", recent: "r", createdAt: 1.5 })).toThrow(TypeError)
    expect(() => makeCheckpointRaw({ summary: "s", recent: "r", createdAt: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError)
  })
})

describe("decodeCheckpoint", () => {
  const checkpoint = makeCheckpoint({ summary, recent, createdAt })

  test("roundtrips from JSON text", () => {
    expect(decodeCheckpoint(JSON.stringify(checkpoint), "roundtrip-text")).toEqual(checkpoint)
  })

  test("roundtrips from an object into a fresh record", () => {
    const decoded = decodeCheckpoint(checkpoint, "roundtrip-object")
    expect(decoded).toEqual(checkpoint)
    expect(decoded).not.toBe(checkpoint)
  })

  test("returns exactly the eight documented fields", () => {
    expect(Object.keys(decodeCheckpoint(checkpoint, "fields")).sort()).toEqual([
      "byteLength",
      "contentHash",
      "createdAt",
      "estimatedTokens",
      "recent",
      "rendererVersion",
      "summary",
      "version",
    ])
  })

  test("isolates the decoded record from later input mutation", () => {
    const input: Record<string, unknown> = { ...checkpoint }
    const decoded = decodeCheckpoint(input, "isolation-input")
    input.summary = "mutated summary"
    input.contentHash = "0".repeat(64)
    input.byteLength = 0
    expect(decoded.summary).toBe(summary)
    expect(decoded.contentHash).toBe(checkpoint.contentHash)
    expect(decoded.byteLength).toBe(checkpoint.byteLength)
  })

  test("isolates the input from later decoded mutation", () => {
    const input: Record<string, unknown> = { ...checkpoint }
    const decoded = decodeCheckpoint(input, "isolation-output")
    Reflect.set(decoded, "summary", "mutated summary")
    expect(input.summary).toBe(summary)
  })

  test("rejects versions other than 1", () => {
    expect(() => decodeCheckpoint({ ...checkpoint, version: 2 }, "version")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, version: 0 }, "version-zero")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, rendererVersion: 2 }, "renderer")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, version: "1" }, "version-string")).toThrow(CorruptCheckpoint)
  })

  test("rejects extra and missing fields", () => {
    expect(() => decodeCheckpoint({ ...checkpoint, extra: true }, "extra-field")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint(withoutField(checkpoint, "version"), "missing-version")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint(withoutField(checkpoint, "recent"), "missing-recent")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint(withoutField(checkpoint, "createdAt"), "missing-created")).toThrow(CorruptCheckpoint)
  })

  test("rejects arrays, null, and other non-object values", () => {
    expect(() => decodeCheckpoint(null, "null")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint(undefined, "undefined")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint([], "array")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint([checkpoint], "array-with-checkpoint")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint(42, "number")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint("null", "json-null")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint("[]", "json-array")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint('"text"', "json-string")).toThrow(CorruptCheckpoint)
  })

  test("rejects malformed JSON text", () => {
    expect(() => decodeCheckpoint('{"version":1,', "malformed")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint(JSON.stringify(checkpoint).slice(0, -1), "truncated")).toThrow(CorruptCheckpoint)
  })

  test("rejects a tampered summary", () => {
    expect(() => decodeCheckpoint({ ...checkpoint, summary: `${summary}!` }, "tampered-summary")).toThrow(CorruptCheckpoint)
  })

  test("rejects a tampered content hash", () => {
    expect(() => decodeCheckpoint({ ...checkpoint, contentHash: sha256("something else") }, "tampered-hash")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, contentHash: checkpoint.contentHash.toUpperCase() }, "uppercase-hash")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, contentHash: 1 }, "non-string-hash")).toThrow(CorruptCheckpoint)
  })

  test("rejects tampered byte and token counters", () => {
    expect(() => decodeCheckpoint({ ...checkpoint, byteLength: checkpoint.byteLength + 1 }, "tampered-bytes")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, estimatedTokens: checkpoint.estimatedTokens + 1 }, "tampered-tokens")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, byteLength: `${checkpoint.byteLength}` }, "string-bytes")).toThrow(CorruptCheckpoint)
  })

  test("rejects negative, fractional, and unsafe numbers", () => {
    expect(() => decodeCheckpoint({ ...checkpoint, createdAt: -1 }, "negative-created")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, createdAt: 1.5 }, "fractional-created")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, createdAt: Number.NaN }, "nan-created")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, createdAt: Number.MAX_SAFE_INTEGER + 1 }, "unsafe-created")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, byteLength: -1 }, "negative-bytes")).toThrow(CorruptCheckpoint)
    expect(() => decodeCheckpoint({ ...checkpoint, estimatedTokens: 1.5 }, "fractional-tokens")).toThrow(CorruptCheckpoint)
  })

  test("computes byte length from canonical JSON rather than raw text", () => {
    const controlSummary = `${control}${newline}`
    const escapedRecent = `${backslash}`
    const escaped = makeCheckpoint({ summary: controlSummary, recent: escapedRecent, createdAt: 0 })
    const expected = JSON.stringify({ version: 1, rendererVersion: 1, summary: controlSummary, recent: escapedRecent })
    expect(escaped.byteLength).toBe(encoder.encode(expected).byteLength)
    expect(escaped.byteLength).not.toBe(encoder.encode(`${controlSummary}${escapedRecent}`).byteLength)
    expect(decodeCheckpoint(escaped, "canonical-bytes").byteLength).toBe(escaped.byteLength)
  })

  test("reports corruption without leaking private text or raw JSON", () => {
    const secretSummary = "PRIVATE-SUMMARY-a1b2c3"
    const secretRecent = "PRIVATE-RECENT-d4e5f6"
    const secret = makeCheckpoint({ summary: secretSummary, recent: secretRecent, createdAt: 5 })
    const error = captureError(() => decodeCheckpoint({ ...secret, contentHash: sha256("tampered") }, "hash-mismatch"))
    expect(error).toBeInstanceOf(CorruptCheckpoint)
    if (!(error instanceof CorruptCheckpoint)) throw new Error("expected CorruptCheckpoint")
    expect(error.messageID).toBe("hash-mismatch")
    expect(error.message).toContain("hash-mismatch")
    expect(error.message).not.toContain(secretSummary)
    expect(error.message).not.toContain(secretRecent)
    expect(error.message).not.toContain(sha256("tampered"))
    expect(error.message).not.toContain("{")
  })

  test("malformed JSON errors do not echo the raw payload", () => {
    const raw = '{"summary":"PRIVATE-SUMMARY-a1b2c3", oops'
    const error = captureError(() => decodeCheckpoint(raw, "malformed-private"))
    expect(error).toBeInstanceOf(CorruptCheckpoint)
    expect(error.message).not.toContain("PRIVATE-SUMMARY-a1b2c3")
  })
})
