import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import type { CtxPackError, CtxPackSource } from "@cybermastery/contracts/ctxpack"
import {
  LIMITS,
  buildFtsQuery,
  buildRecallTerms,
  contentHash,
  estimateTokens,
  isCtxPackError,
  isTrivialRecallTurn,
  normalizeCreate,
  normalizeKeyword,
  normalizeList,
  normalizePatch,
  normalizeSelectedText,
  utf8ByteLength,
} from "./ctxpack-content"

// Fixtures --------------------------------------------------------------------

function rawSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceID: "ws-1",
    blockID: "",
    functionalityID: "",
    kind: "note",
    direction: "unknown",
    sourceTimestamp: null,
    capturedAt: 0,
    entityRef: null,
    label: null,
    metadata: {},
    sensitivity: "public",
    ...overrides,
  }
}

function typedSource(overrides: Partial<CtxPackSource> = {}): CtxPackSource {
  return {
    workspaceID: "ws-1",
    blockID: "",
    functionalityID: "",
    kind: "note",
    direction: "unknown",
    sourceTimestamp: null,
    capturedAt: 0,
    entityRef: null,
    label: null,
    metadata: {},
    sensitivity: "public",
    ...overrides,
  }
}

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceID: "ws-1",
    title: "Pack",
    keywords: [],
    sensitivity: "workspace",
    fragments: [{ clientFragmentID: "f1", text: "hello", source: rawSource() }],
    idempotencyKey: "idem-1",
    ...overrides,
  }
}

function listInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceID: "ws-1",
    query: "hello",
    keyword: null,
    sourceBlockID: null,
    sourceFunctionalityID: null,
    sourceKind: null,
    sensitivity: null,
    createdAfter: null,
    createdBefore: null,
    includeDeleted: false,
    pinnedOnly: false,
    sort: "created-desc",
    cursor: null,
    limit: 20,
    ...overrides,
  }
}

function captureError(run: () => unknown): CtxPackError {
  try {
    run()
  } catch (error) {
    if (isCtxPackError(error)) return error
    throw new Error(`expected a CtxPackError, received ${String(error)}`)
  }
  throw new Error("expected the call to throw")
}

// Normalization ---------------------------------------------------------------

describe("normalizeSelectedText", () => {
  it("normalizes CRLF/CR to LF and trims trailing spaces/tabs per line", () => {
    expect(normalizeSelectedText("  a  \r\n b\t \r c  ")).toBe("a\n b\n c")
  })

  it("trims the ends without applying NFKC", () => {
    expect(normalizeSelectedText("  \uFB01  ")).toBe("\uFB01")
  })
})

describe("normalizeKeyword", () => {
  it("applies NFKC, trims, and collapses internal whitespace", () => {
    expect(normalizeKeyword("  \uFF21  b\t c ")).toBe("A b c")
    expect(normalizeKeyword("\uFB01")).toBe("fi")
  })

  it("differs from fragment normalization for compatibility characters", () => {
    expect(normalizeSelectedText("\uFB01")).toBe("\uFB01")
    expect(normalizeKeyword("\uFB01")).toBe("fi")
  })
})

describe("utf8ByteLength / estimateTokens", () => {
  it("measures multibyte and astral text in UTF-8 bytes", () => {
    expect(utf8ByteLength("")).toBe(0)
    expect(utf8ByteLength("é")).toBe(2)
    expect(utf8ByteLength("😀")).toBe(4)
    expect(utf8ByteLength("a😀é")).toBe(1 + 4 + 2)
  })

  it("estimates tokens as ceil(bytes / 4)", () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1)).toBe(1)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
    expect(estimateTokens(LIMITS.totalMaxBytes)).toBe(LIMITS.totalMaxEstimatedTokens)
  })
})

// Hashing ---------------------------------------------------------------------

describe("contentHash", () => {
  it("matches an independently constructed golden hash with sorted source keys", () => {
    const source: CtxPackSource = {
      workspaceID: "w",
      blockID: "",
      functionalityID: "",
      kind: "note",
      direction: "unknown",
      sourceTimestamp: null,
      capturedAt: 0,
      entityRef: null,
      label: null,
      metadata: { b: 1, "10": "x", "2": "y", a: true },
      sensitivity: "public",
    }
    // Hand-written canonical JSON: source keys sorted recursively, metadata
    // integer-like keys in ascending numeric order (2 before 10), then string
    // keys in sorted order.
    const canonical =
      '[{"ordinal":0,"text":"hello\\nworld","source":{"blockID":"","capturedAt":0,"direction":"unknown","entityRef":null,"functionalityID":"","kind":"note","label":null,"metadata":{"2":"y","10":"x","a":true,"b":1},"sensitivity":"public","sourceTimestamp":null,"workspaceID":"w"}}]'
    const expected = `sha256:${createHash("sha256").update(canonical).digest("hex")}`
    expect(contentHash([{ ordinal: 0, text: "hello  \r\nworld\t ", source }])).toBe(expected)
  })

  it("hashes an empty fragment list deterministically", () => {
    expect(contentHash([])).toBe(`sha256:${createHash("sha256").update("[]").digest("hex")}`)
  })

  it("normalizes fragment text before hashing", () => {
    expect(contentHash([{ ordinal: 0, text: "a\r\nb", source: typedSource() }])).toBe(
      contentHash([{ ordinal: 0, text: "a\nb", source: typedSource() }]),
    )
  })

  it("is stable across source key insertion order", () => {
    const first: CtxPackSource = {
      workspaceID: "w",
      blockID: "",
      functionalityID: "",
      kind: "note",
      direction: "unknown",
      sourceTimestamp: null,
      capturedAt: 0,
      entityRef: null,
      label: null,
      metadata: { a: 1, b: 2 },
      sensitivity: "public",
    }
    const second: CtxPackSource = {
      sensitivity: "public",
      metadata: { b: 2, a: 1 },
      label: null,
      entityRef: null,
      capturedAt: 0,
      sourceTimestamp: null,
      direction: "unknown",
      kind: "note",
      functionalityID: "",
      blockID: "",
      workspaceID: "w",
    }
    expect(contentHash([{ ordinal: 0, text: "same", source: first }])).toBe(
      contentHash([{ ordinal: 0, text: "same", source: second }]),
    )
  })

  it("changes when source provenance metadata changes", () => {
    const base: CtxPackSource = { ...typedSource(), metadata: { a: 1 } }
    const changed: CtxPackSource = { ...typedSource(), metadata: { a: 2 } }
    expect(contentHash([{ ordinal: 0, text: "x", source: base }])).not.toBe(
      contentHash([{ ordinal: 0, text: "x", source: changed }]),
    )
  })

  it("ignores pack title, keywords, and tags because it hashes content and provenance only", () => {
    const fragments = [{ clientFragmentID: "f1", text: "hello", source: rawSource() }]
    const one = normalizeCreate(createInput({ title: "One", keywords: ["alpha"], tags: ["ParallelPlan"], fragments }))
    const two = normalizeCreate(createInput({ title: "Two", keywords: ["beta"], fragments }))
    const hashOf = (fragmentsToHash: typeof one.fragments) =>
      contentHash(fragmentsToHash.map((fragment, index) => ({ ordinal: index, text: fragment.text, source: fragment.source })))
    expect(hashOf(one.fragments)).toBe(hashOf(two.fragments))
  })
})

// Create ----------------------------------------------------------------------

describe("normalizeCreate", () => {
  it("normalizes title, keywords, tags, and fragment text", () => {
    const normalized = normalizeCreate(
      createInput({
        title: "  Hi  ",
        keywords: ["  Foo  ", "foo", "FOO", "bar"],
        tags: ["ParallelPlan", "ParallelPlan"],
        fragments: [{ clientFragmentID: "f1", text: "a  \r\nb\t ", source: rawSource() }],
      }),
    )
    expect(normalized.title).toBe("Hi")
    expect(normalized.keywords).toEqual(["Foo", "bar"])
    expect(normalized.tags).toEqual(["ParallelPlan"])
    expect(normalized.fragments[0]?.text).toBe("a\nb")
  })

  it("defaults omitted tags to an empty list", () => {
    expect(normalizeCreate(createInput({ tags: undefined })).tags).toEqual([])
  })

  it("counts title length in Unicode code points, not UTF-16 units", () => {
    expect(normalizeCreate(createInput({ title: "😀".repeat(LIMITS.titleMaxCodePoints) })).title).toBe(
      "😀".repeat(LIMITS.titleMaxCodePoints),
    )
    expect(() => normalizeCreate(createInput({ title: "😀".repeat(LIMITS.titleMaxCodePoints + 1) }))).toThrow()
  })

  it("enforces keyword count and code-point bounds after normalization", () => {
    const maxKeywords = Array.from({ length: LIMITS.keywordMaxCount }, (_, index) => `k${index}`)
    expect(normalizeCreate(createInput({ keywords: maxKeywords })).keywords).toHaveLength(LIMITS.keywordMaxCount)
    expect(() => normalizeCreate(createInput({ keywords: [...maxKeywords, "overflow"] }))).toThrow()
    expect(normalizeCreate(createInput({ keywords: ["Ａ"] })).keywords).toEqual(["A"])
    expect(() =>
      normalizeCreate(createInput({ keywords: ["a".repeat(LIMITS.keywordMaxCodePoints + 1)] })),
    ).toThrow()
  })

  it("rejects unknown tags", () => {
    expect(() => normalizeCreate(createInput({ tags: ["Other"] }))).toThrow()
  })

  it("rejects unsupported top-level, fragment, and source fields", () => {
    expect(() => normalizeCreate(createInput({ extra: true }))).toThrow()
    expect(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource(), extra: true }] }),
      ),
    ).toThrow()
    expect(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ extra: true }) }] }),
      ),
    ).toThrow()
  })

  it("rejects fragments that normalize to empty text", () => {
    expect(() =>
      normalizeCreate(createInput({ fragments: [{ clientFragmentID: "f1", text: "   \r\n\t ", source: rawSource() }] })),
    ).toThrow()
  })

  it("rejects malformed source metadata and timestamps", () => {
    expect(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ metadata: { nested: { a: 1 } } }) }] }),
      ),
    ).toThrow()
    expect(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ metadata: { n: Number.NaN } }) }] }),
      ),
    ).toThrow()
    expect(() =>
      normalizeCreate(
        createInput({
          fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ metadata: { n: Number.POSITIVE_INFINITY } }) }],
        }),
      ),
    ).toThrow()
    expect(() =>
      normalizeCreate(createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ capturedAt: 1.5 }) }] })),
    ).toThrow()
  })

  it("rejects secret or unknown source sensitivity", () => {
    const secret = captureError(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ sensitivity: "secret" }) }] }),
      ),
    )
    expect(secret).toMatchObject({ _tag: "CtxPackSecretSourceDenied", clientFragmentID: "f1" })

    const unknown = captureError(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f2", text: "hi", source: rawSource({ sensitivity: "top-secret" }) }] }),
      ),
    )
    expect(unknown).toMatchObject({ _tag: "CtxPackSecretSourceDenied", clientFragmentID: "f2" })
  })

  it("rejects a source from another workspace", () => {
    const error = captureError(() =>
      normalizeCreate(
        createInput({ fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ workspaceID: "ws-2" }) }] }),
      ),
    )
    expect(error).toMatchObject({ _tag: "CtxPackCrossWorkspaceDenied", sourceWorkspaceID: "ws-2" })
  })

  it("rejects a pack sensitivity weaker than the strictest fragment source", () => {
    const error = captureError(() =>
      normalizeCreate(
        createInput({
          sensitivity: "workspace",
          fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ sensitivity: "private" }) }],
        }),
      ),
    )
    expect(error._tag).toBe("CtxPackInvalidSelection")
  })

  it("keeps the pack sensitivity when it is at least as strict as every source", () => {
    const normalized = normalizeCreate(
      createInput({
        sensitivity: "private",
        fragments: [{ clientFragmentID: "f1", text: "hi", source: rawSource({ sensitivity: "private" }) }],
      }),
    )
    expect(normalized.sensitivity).toBe("private")
  })

  it("rejects 33 fragments and accepts 32", () => {
    const makeFragments = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        clientFragmentID: `f${index}`,
        text: "x",
        source: rawSource(),
      }))
    expect(normalizeCreate(createInput({ fragments: makeFragments(LIMITS.fragmentMaxCount) })).fragments).toHaveLength(
      LIMITS.fragmentMaxCount,
    )
    expect(() => normalizeCreate(createInput({ fragments: makeFragments(LIMITS.fragmentMaxCount + 1) }))).toThrow()
  })

  it("does not split a fragment exactly at 16KiB of multibyte text", () => {
    const exact = "é".repeat(LIMITS.fragmentMaxBytes / 2)
    const normalized = normalizeCreate(
      createInput({ fragments: [{ clientFragmentID: "exact", text: exact, source: rawSource() }] }),
    )
    expect(normalized.fragments).toHaveLength(1)
    expect(normalized.fragments[0]?.clientFragmentID).toBe("exact")
    expect(utf8ByteLength(normalized.fragments[0]?.text ?? "")).toBe(LIMITS.fragmentMaxBytes)
  })

  it("rejects a split that increases 32 valid input fragments to 33", () => {
    const fragments = [
      ...Array.from({ length: 31 }, (_, index) => ({ clientFragmentID: `small-${index}`, text: "x", source: rawSource() })),
      { clientFragmentID: "split", text: "x".repeat(LIMITS.fragmentMaxBytes + 1), source: rawSource() },
    ]
    expect(captureError(() => normalizeCreate(createInput({ fragments })))).toMatchObject({ _tag: "CtxPackInvalidSelection" })
  })

  it("splits multibyte text past 16KiB on code-point boundaries with suffixed ids", () => {
    const over = "é".repeat(LIMITS.fragmentMaxBytes / 2 + 1)
    const normalized = normalizeCreate(
      createInput({ fragments: [{ clientFragmentID: "over", text: over, source: rawSource() }] }),
    )
    expect(normalized.fragments).toHaveLength(2)
    expect(normalized.fragments[0]?.clientFragmentID).toBe("over:1")
    expect(normalized.fragments[1]?.clientFragmentID).toBe("over:2")
    expect(utf8ByteLength(normalized.fragments[0]?.text ?? "")).toBe(LIMITS.fragmentMaxBytes)
    expect(utf8ByteLength(normalized.fragments[1]?.text ?? "")).toBe(2)
    expect(normalized.fragments.map((fragment) => fragment.text).join("")).toBe(over)
  })

  it("never splits astral code points across chunk boundaries", () => {
    const astral = "😀".repeat(5000)
    const normalized = normalizeCreate(
      createInput({ fragments: [{ clientFragmentID: "big", text: astral, source: rawSource() }] }),
    )
    expect(normalized.fragments).toHaveLength(2)
    for (const fragment of normalized.fragments) {
      expect(utf8ByteLength(fragment.text)).toBeLessThanOrEqual(LIMITS.fragmentMaxBytes)
      expect([...fragment.text].every((point) => point === "😀")).toBe(true)
    }
    expect(normalized.fragments.map((fragment) => fragment.text).join("")).toBe(astral)
  })

  it("accepts exactly 64KiB total and rejects one byte over", () => {
    const makeFragments = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        clientFragmentID: `f${index}`,
        text: "x".repeat(LIMITS.fragmentMaxBytes),
        source: rawSource(),
      }))
    const exact = normalizeCreate(createInput({ fragments: makeFragments(4) }))
    expect(exact.fragments).toHaveLength(4)

    const over = captureError(() =>
      normalizeCreate(
        createInput({ fragments: [...makeFragments(4), { clientFragmentID: "extra", text: "x", source: rawSource() }] }),
      ),
    )
    expect(over).toMatchObject({
      _tag: "CtxPackBudgetExceeded",
      bytes: LIMITS.totalMaxBytes + 1,
      estimatedTokens: estimateTokens(LIMITS.totalMaxBytes + 1),
    })
  })

  it("never includes fragment text in emitted errors", () => {
    const secret = "SUPER_SECRET_FRAGMENT_TEXT"
    const fragments = Array.from({ length: 5 }, (_, index) => ({
      clientFragmentID: `f${index}`,
      text: index === 0 ? secret.padEnd(LIMITS.fragmentMaxBytes, "x") : "x".repeat(LIMITS.fragmentMaxBytes),
      source: rawSource(),
    }))
    const budget = captureError(() => normalizeCreate(createInput({ fragments })))
    expect(JSON.stringify(budget)).not.toContain(secret)

    const invalid = captureError(() =>
      normalizeCreate(
        createInput({ title: "t".repeat(LIMITS.titleMaxCodePoints + 1), fragments: [{ clientFragmentID: "f", text: secret, source: rawSource() }] }),
      ),
    )
    expect(JSON.stringify(invalid)).not.toContain(secret)
  })

  it("deeply detaches caller arrays and source objects", () => {
    const mutableSource = rawSource({ metadata: { a: "b" } })
    const mutableFragments = [{ clientFragmentID: "f1", text: "hello", source: mutableSource }]
    const keywords = ["keep"]
    const normalized = normalizeCreate(createInput({ fragments: mutableFragments, keywords }))

    mutableFragments.push({ clientFragmentID: "f2", text: "more", source: rawSource() })
    mutableSource.metadata = { a: "changed" }
    keywords.push("leak")

    expect(normalized.fragments).toHaveLength(1)
    expect(normalized.fragments[0]?.source.metadata).toEqual({ a: "b" })
    expect(normalized.keywords).toEqual(["keep"])
  })
})

// Patch -----------------------------------------------------------------------

describe("normalizePatch", () => {
  const baseInput = {
    workspaceID: "ws-1",
    ctxPackID: "ctxpk_abc",
    expectedRevision: 2,
    patch: { title: "  New  ", keywords: [" K "], tags: ["ParallelPlan"], sensitivity: "private" },
    idempotencyKey: "idem-2",
  }

  it("normalizes patch fields and requires a ctxpk_ identifier", () => {
    const normalized = normalizePatch(baseInput, [typedSource({ sensitivity: "private" })])
    expect(normalized.patch).toEqual({
      title: "New",
      keywords: ["K"],
      tags: ["ParallelPlan"],
      sensitivity: "private",
    })
    expect(normalized.ctxPackID).toBe("ctxpk_abc")
  })

  it("allows metadata-only patches without touching fragment sensitivity", () => {
    const normalized = normalizePatch({ ...baseInput, patch: { tags: ["ParallelPlan"] } }, [
      typedSource({ sensitivity: "private" }),
    ])
    expect(normalized.patch).toEqual({ tags: ["ParallelPlan"] })
  })

  it("cannot weaken the pack below the strictest fragment source", () => {
    const error = captureError(() =>
      normalizePatch({ ...baseInput, patch: { sensitivity: "workspace" } }, [typedSource({ sensitivity: "private" })]),
    )
    expect(error._tag).toBe("CtxPackInvalidSelection")
  })

  it("can strengthen the pack beyond every fragment source", () => {
    const normalized = normalizePatch({ ...baseInput, patch: { sensitivity: "private" } }, [
      typedSource({ sensitivity: "public" }),
    ])
    expect(normalized.patch.sensitivity).toBe("private")
  })

  it("rejects unsupported patch fields, bad ids, and negative revisions", () => {
    expect(() => normalizePatch({ ...baseInput, patch: { bogus: 1 } }, [])).toThrow()
    expect(() => normalizePatch({ ...baseInput, ctxPackID: "bad" }, [])).toThrow()
    expect(() => normalizePatch({ ...baseInput, expectedRevision: -1 }, [])).toThrow()
  })

  it("detaches the patch keywords array", () => {
    const keywords = ["a"]
    const normalized = normalizePatch({ ...baseInput, patch: { keywords } }, [])
    keywords.push("b")
    expect(normalized.patch.keywords).toEqual(["a"])
  })
})

// List ------------------------------------------------------------------------

describe("normalizeList", () => {
  const sorts = [
    "created-desc",
    "created-asc",
    "updated-desc",
    "title-asc",
    "tokens-desc",
    "most-attached",
    "recently-attached",
  ] as const

  it("accepts every sort and rejects unknown ones", () => {
    for (const sort of sorts) {
      expect(normalizeList(listInput({ sort })).sort).toBe(sort)
    }
    expect(() => normalizeList(listInput({ sort: "nope" }))).toThrow()
  })

  it("enforces the 1..50 limit bound", () => {
    expect(normalizeList(listInput({ limit: LIMITS.listLimitMin })).limit).toBe(LIMITS.listLimitMin)
    expect(normalizeList(listInput({ limit: LIMITS.listLimitMax })).limit).toBe(LIMITS.listLimitMax)
    expect(() => normalizeList(listInput({ limit: 0 }))).toThrow()
    expect(() => normalizeList(listInput({ limit: LIMITS.listLimitMax + 1 }))).toThrow()
    expect(() => normalizeList(listInput({ limit: 2.5 }))).toThrow()
  })

  it("returns the raw query but bounds it by Unicode code points", () => {
    expect(normalizeList(listInput({ query: "  Raw Query  " })).query).toBe("  Raw Query  ")
    expect(normalizeList(listInput({ query: "😀".repeat(LIMITS.queryMaxCodePoints) })).query).toHaveLength(
      LIMITS.queryMaxCodePoints * 2,
    )
    expect(() => normalizeList(listInput({ query: "😀".repeat(LIMITS.queryMaxCodePoints + 1) }))).toThrow()
  })

  it("enforces exact enum and nullable field shapes", () => {
    const normalized = normalizeList(
      listInput({
        keyword: "k",
        sourceBlockID: "b",
        sourceFunctionalityID: "fn",
        sourceKind: "tool-output",
        sensitivity: "private",
        createdAfter: 5,
        createdBefore: 10,
        includeDeleted: true,
        pinnedOnly: true,
        cursor: "cursor-1",
      }),
    )
    expect(normalized).toMatchObject({
      keyword: "k",
      sourceBlockID: "b",
      sourceFunctionalityID: "fn",
      sourceKind: "tool-output",
      sensitivity: "private",
      createdAfter: 5,
      createdBefore: 10,
      includeDeleted: true,
      pinnedOnly: true,
      cursor: "cursor-1",
    })

    expect(() => normalizeList(listInput({ keyword: 5 }))).toThrow()
    expect(() => normalizeList(listInput({ sensitivity: "secret" }))).toThrow()
    expect(() => normalizeList(listInput({ sourceKind: "bogus" }))).toThrow()
    expect(() => normalizeList(listInput({ includeDeleted: "yes" }))).toThrow()
    expect(() => normalizeList(listInput({ createdAfter: -1 }))).toThrow()
  })

  it("rejects unknown fields and missing required fields", () => {
    expect(() => normalizeList(listInput({ extra: true }))).toThrow()
    const partial = listInput()
    delete partial.limit
    expect(() => normalizeList(partial)).toThrow()
  })
})

// Error guard -----------------------------------------------------------------

describe("isCtxPackError", () => {
  it("accepts every contract error shape", () => {
    expect(isCtxPackError({ _tag: "CtxPackNotFound", ctxPackID: "ctxpk_a" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackDeleted", ctxPackID: "ctxpk_a" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackRevisionConflict", currentRevision: 3 })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackContentChanged", currentContentHash: "sha256:x" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackInvalidSelection", reason: "nope" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackBudgetExceeded", bytes: 1, estimatedTokens: 1 })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackSecretSourceDenied", clientFragmentID: "f" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackCrossWorkspaceDenied", sourceWorkspaceID: "w" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackPermissionDenied", operation: "ctxpack.read" })).toBe(true)
    expect(isCtxPackError({ _tag: "CtxPackSearchCursorInvalid" })).toBe(true)
  })

  it("rejects malformed and unrelated values", () => {
    expect(isCtxPackError(null)).toBe(false)
    expect(isCtxPackError("CtxPackInvalidSelection")).toBe(false)
    expect(isCtxPackError({})).toBe(false)
    expect(isCtxPackError({ _tag: "Nope" })).toBe(false)
    expect(isCtxPackError({ _tag: "CtxPackBudgetExceeded", bytes: 1 })).toBe(false)
    expect(isCtxPackError({ _tag: "CtxPackInvalidSelection", reason: 5 })).toBe(false)
  })
})

// FTS query -------------------------------------------------------------------

describe("buildFtsQuery", () => {
  it("quotes whitespace tokens and escapes embedded quotes", () => {
    expect(buildFtsQuery("session.input")).toBe('"session.input"')
    expect(buildFtsQuery("foo\r\nbar")).toBe('"foo" "bar"')
    expect(buildFtsQuery('he said "drop')).toBe('"he" "said" """drop"')
  })

  it("returns null for empty or punctuation-only queries", () => {
    expect(buildFtsQuery("")).toBeNull()
    expect(buildFtsQuery("   ")).toBeNull()
    expect(buildFtsQuery("!!! ... ???")).toBeNull()
  })
})

// Recall ----------------------------------------------------------------------

describe("buildRecallTerms", () => {
  it("normalizes, lowercases, and drops stop words", () => {
    expect(buildRecallTerms("The quick brown fox")).toEqual(["quick", "brown", "fox"])
  })

  it("keeps Unicode letters and stable dedup, capped at 8", () => {
    expect(buildRecallTerms("Café Straße")).toEqual(["café", "straße"])
    expect(buildRecallTerms("Alpha alpha ALPHA beta")).toEqual(["alpha", "beta"])
    expect(buildRecallTerms("one two three four five six seven eight nine ten")).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ])
  })
})

describe("isTrivialRecallTurn", () => {
  it("recognizes trivial turns after NFKC, lowercasing, and punctuation removal", () => {
    expect(isTrivialRecallTurn("Hi!")).toBe(true)
    expect(isTrivialRecallTurn("  THANKS!!  ")).toBe(true)
    expect(isTrivialRecallTurn("thank you")).toBe(true)
    expect(isTrivialRecallTurn("okay?")).toBe(true)
    expect(isTrivialRecallTurn("\uFF28\uFF29")).toBe(true)
  })

  it("rejects substantive turns", () => {
    expect(isTrivialRecallTurn("Hello, there")).toBe(false)
    expect(isTrivialRecallTurn("what is the plan")).toBe(false)
  })
})
