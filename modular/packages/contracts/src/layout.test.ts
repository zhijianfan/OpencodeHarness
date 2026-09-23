import { describe, expect, test } from "bun:test"
import { decodeLayoutCommand, decodeLayoutTuple, InvalidLayoutCommand } from "./layout"

function validTransform() {
  return { x: 0, y: 0, w: 1, h: 1, z: 0 }
}

function validCommand() {
  return {
    workspaceID: "ws_1",
    tuple: { user: "user_1", style: "compact", deviceClass: "desktop" },
    clientID: "client_1",
    expectedRevision: 7,
    blocks: [
      { id: "block_a", functionalityID: "clock", transform: { x: -12.5, y: 4, w: 100.25, h: 40, z: 1 } },
      { id: "block_b", functionalityID: "notes", transform: { x: 0, y: -0.5, w: 1, h: 2, z: 0 } },
    ],
  }
}

function omit(source: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source }
  delete copy[key]
  return copy
}

function withTuple(tuple: object) {
  return { ...validCommand(), tuple }
}

function withBlock(block: object) {
  return { ...validCommand(), blocks: [block] }
}

function withTransform(transform: object) {
  return withBlock({ id: "block_a", functionalityID: "clock", transform })
}

describe("decodeLayoutCommand", () => {
  test("decodes a valid command with negative and fractional coordinates", () => {
    const decoded = decodeLayoutCommand(validCommand())

    expect(decoded.workspaceID).toBe("ws_1")
    expect(decoded.clientID).toBe("client_1")
    expect(decoded.expectedRevision).toBe(7)
    expect(decoded.tuple).toEqual({ user: "user_1", style: "compact", deviceClass: "desktop" })
    expect(decoded.blocks).toHaveLength(2)
    expect(decoded.blocks[0].transform).toEqual({ x: -12.5, y: 4, w: 100.25, h: 40, z: 1 })
    expect(decoded.blocks[1].transform).toEqual({ x: 0, y: -0.5, w: 1, h: 2, z: 0 })
  })

  test("decodes an empty block list", () => {
    const decoded = decodeLayoutCommand({ ...validCommand(), blocks: [] })

    expect(decoded.blocks).toEqual([])
  })

  test("decodes revision zero and the maximum safe integer", () => {
    expect(decodeLayoutCommand({ ...validCommand(), expectedRevision: 0 }).expectedRevision).toBe(0)
    expect(decodeLayoutCommand({ ...validCommand(), expectedRevision: Number.MAX_SAFE_INTEGER }).expectedRevision).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  test("preserves identity strings without trimming", () => {
    const decoded = decodeLayoutCommand({
      ...validCommand(),
      workspaceID: " ws_1 ",
      clientID: "\tclient_1",
      tuple: { user: " user_1 ", style: " compact ", deviceClass: "mobile" },
      blocks: [{ id: " block_a ", functionalityID: " clock ", transform: validTransform() }],
    })

    expect(decoded.workspaceID).toBe(" ws_1 ")
    expect(decoded.clientID).toBe("\tclient_1")
    expect(decoded.tuple.user).toBe(" user_1 ")
    expect(decoded.blocks[0].id).toBe(" block_a ")
    expect(decoded.blocks[0].functionalityID).toBe(" clock ")
  })

  test("rejects null, arrays and non-object commands", () => {
    expect(() => decodeLayoutCommand(null)).toThrow(InvalidLayoutCommand)
    expect(() => decodeLayoutCommand(null)).toThrow(/^layoutCommand: /)
    expect(() => decodeLayoutCommand([])).toThrow(/^layoutCommand: /)
    expect(() => decodeLayoutCommand("command")).toThrow(/^layoutCommand: /)
    expect(() => decodeLayoutCommand(undefined)).toThrow(/^layoutCommand: /)
  })

  test("rejects missing and malformed identity strings", () => {
    expect(() => decodeLayoutCommand(omit(validCommand(), "workspaceID"))).toThrow(/layoutCommand\.workspaceID/)
    expect(() => decodeLayoutCommand({ ...validCommand(), workspaceID: "" })).toThrow(/layoutCommand\.workspaceID/)
    expect(() => decodeLayoutCommand({ ...validCommand(), workspaceID: "   " })).toThrow(/layoutCommand\.workspaceID/)
    expect(() => decodeLayoutCommand({ ...validCommand(), workspaceID: 42 })).toThrow(/layoutCommand\.workspaceID/)
    expect(() => decodeLayoutCommand(omit(validCommand(), "clientID"))).toThrow(/layoutCommand\.clientID/)
    expect(() => decodeLayoutCommand({ ...validCommand(), clientID: " " })).toThrow(/layoutCommand\.clientID/)
    expect(() => decodeLayoutCommand({ ...validCommand(), clientID: null })).toThrow(/layoutCommand\.clientID/)
  })

  test("rejects missing and malformed tuples", () => {
    expect(() => decodeLayoutCommand(omit(validCommand(), "tuple"))).toThrow(/layoutCommand\.tuple/)
    expect(() => decodeLayoutCommand({ ...validCommand(), tuple: null })).toThrow(/layoutCommand\.tuple/)
    expect(() => decodeLayoutCommand({ ...validCommand(), tuple: [] })).toThrow(/layoutCommand\.tuple/)
    expect(() =>
      decodeLayoutCommand(withTuple(omit({ user: "user_1", style: "compact", deviceClass: "desktop" }, "style"))),
    ).toThrow(/layoutCommand\.tuple\.style/)
    expect(() => decodeLayoutCommand(withTuple({ user: "  ", style: "compact", deviceClass: "desktop" }))).toThrow(
      /layoutCommand\.tuple\.user/,
    )
    expect(() => decodeLayoutCommand(withTuple({ user: "user_1", style: 7, deviceClass: "desktop" }))).toThrow(
      /layoutCommand\.tuple\.style/,
    )
  })

  test("rejects unknown properties at every level", () => {
    expect(() => decodeLayoutCommand({ ...validCommand(), extra: true })).toThrow(/layoutCommand\.extra/)
    expect(() => decodeLayoutCommand(withTuple({ user: "user_1", style: "compact", deviceClass: "desktop", extra: 1 }))).toThrow(
      /layoutCommand\.tuple\.extra/,
    )
    expect(() =>
      decodeLayoutCommand(withBlock({ id: "block_a", functionalityID: "clock", transform: validTransform(), extra: 1 })),
    ).toThrow(/layoutCommand\.blocks\[0\]\.extra/)
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), extra: 1 }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.extra/,
    )
  })

  test("rejects runtime, session and content fields in blocks", () => {
    expect(() =>
      decodeLayoutCommand(withBlock({ id: "block_a", functionalityID: "clock", transform: validTransform(), runtime: {} })),
    ).toThrow(/layoutCommand\.blocks\[0\]\.runtime/)
    expect(() =>
      decodeLayoutCommand(withBlock({ id: "block_a", functionalityID: "clock", transform: validTransform(), session: "s_1" })),
    ).toThrow(/layoutCommand\.blocks\[0\]\.session/)
    expect(() =>
      decodeLayoutCommand(withBlock({ id: "block_a", functionalityID: "clock", transform: validTransform(), content: "text" })),
    ).toThrow(/layoutCommand\.blocks\[0\]\.content/)
  })

  test("rejects invalid revisions", () => {
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: -1 })).toThrow(
      /layoutCommand\.expectedRevision/,
    )
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: 1.5 })).toThrow(
      /layoutCommand\.expectedRevision/,
    )
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: Number.NaN })).toThrow(
      /layoutCommand\.expectedRevision/,
    )
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: Number.POSITIVE_INFINITY })).toThrow(
      /layoutCommand\.expectedRevision/,
    )
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /layoutCommand\.expectedRevision/,
    )
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: "7" })).toThrow(
      /layoutCommand\.expectedRevision/,
    )
    expect(() => decodeLayoutCommand(omit(validCommand(), "expectedRevision"))).toThrow(
      /layoutCommand\.expectedRevision/,
    )
  })

  test("rejects Infinity, NaN, zero and negative sizes", () => {
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), x: Number.POSITIVE_INFINITY }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.x/,
    )
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), y: Number.NaN }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.y/,
    )
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), z: Number.NEGATIVE_INFINITY }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.z/,
    )
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), w: 0 }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.w/,
    )
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), w: Number.NaN }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.w/,
    )
    expect(() => decodeLayoutCommand(withTransform({ ...validTransform(), h: -3 }))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.h/,
    )
  })

  test("requires every transform field", () => {
    expect(() => decodeLayoutCommand(withTransform(omit(validTransform(), "x")))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.x/,
    )
    expect(() => decodeLayoutCommand(withTransform(omit(validTransform(), "z")))).toThrow(
      /layoutCommand\.blocks\[0\]\.transform\.z/,
    )
  })

  test("rejects duplicate block ids", () => {
    const command = {
      ...validCommand(),
      blocks: [
        { id: "block_a", functionalityID: "clock", transform: validTransform() },
        { id: "block_a", functionalityID: "notes", transform: validTransform() },
      ],
    }

    expect(() => decodeLayoutCommand(command)).toThrow(/layoutCommand\.blocks\[1\]\.id/)
  })

  test("allows distinct block ids with the same functionality id", () => {
    const command = {
      ...validCommand(),
      blocks: [
        { id: "block_a", functionalityID: "clock", transform: validTransform() },
        { id: "block_b", functionalityID: "clock", transform: validTransform() },
      ],
    }

    expect(decodeLayoutCommand(command).blocks).toHaveLength(2)
  })

  test("rejects blank or non-string block identities", () => {
    expect(() =>
      decodeLayoutCommand(withBlock({ id: " ", functionalityID: "clock", transform: validTransform() })),
    ).toThrow(/layoutCommand\.blocks\[0\]\.id/)
    expect(() => decodeLayoutCommand(withBlock({ id: 1, functionalityID: "clock", transform: validTransform() }))).toThrow(
      /layoutCommand\.blocks\[0\]\.id/,
    )
    expect(() =>
      decodeLayoutCommand(withBlock({ id: "block_a", functionalityID: "", transform: validTransform() })),
    ).toThrow(/layoutCommand\.blocks\[0\]\.functionalityID/)
    expect(() => decodeLayoutCommand(withBlock({ id: "block_a", transform: validTransform() }))).toThrow(
      /layoutCommand\.blocks\[0\]\.functionalityID/,
    )
  })

  test("rejects non-array and non-object block values", () => {
    expect(() => decodeLayoutCommand(omit(validCommand(), "blocks"))).toThrow(/layoutCommand\.blocks/)
    expect(() => decodeLayoutCommand({ ...validCommand(), blocks: null })).toThrow(/layoutCommand\.blocks/)
    expect(() => decodeLayoutCommand({ ...validCommand(), blocks: {} })).toThrow(/layoutCommand\.blocks/)
    expect(() => decodeLayoutCommand({ ...validCommand(), blocks: [null] })).toThrow(/layoutCommand\.blocks\[0\]/)
    expect(() => decodeLayoutCommand({ ...validCommand(), blocks: [[]] })).toThrow(/layoutCommand\.blocks\[0\]/)
    expect(() =>
      decodeLayoutCommand({ ...validCommand(), blocks: [{ id: "block_a", functionalityID: "clock", transform: null }] }),
    ).toThrow(/layoutCommand\.blocks\[0\]\.transform/)
    expect(() =>
      decodeLayoutCommand({ ...validCommand(), blocks: [{ id: "block_a", functionalityID: "clock", transform: [] }] }),
    ).toThrow(/layoutCommand\.blocks\[0\]\.transform/)
  })

  test("does not retain references to input objects", () => {
    const input = validCommand()
    const decoded = decodeLayoutCommand(input)

    input.workspaceID = "mutated"
    input.tuple.user = "mutated"
    input.blocks[0].id = "mutated"
    input.blocks[0].transform.x = 999
    input.blocks.push({ id: "block_c", functionalityID: "extra", transform: { x: 1, y: 1, w: 1, h: 1, z: 1 } })

    expect(decoded.workspaceID).toBe("ws_1")
    expect(decoded.tuple.user).toBe("user_1")
    expect(decoded.blocks).toHaveLength(2)
    expect(decoded.blocks[0].id).toBe("block_a")
    expect(decoded.blocks[0].transform.x).toBe(-12.5)
  })

  test("throws InvalidLayoutCommand with the failing field path in the message", () => {
    expect(() => decodeLayoutCommand({ ...validCommand(), expectedRevision: -1 })).toThrow(
      /^layoutCommand\.expectedRevision: /,
    )
  })
})

describe("decodeLayoutTuple", () => {
  test("decodes every device class", () => {
    expect(decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: "desktop" })).toEqual({
      user: "user_1",
      style: "compact",
      deviceClass: "desktop",
    })
    expect(decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: "mobile" }).deviceClass).toBe("mobile")
    expect(decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: "tablet" }).deviceClass).toBe("tablet")
  })

  test("preserves identity strings without trimming", () => {
    expect(decodeLayoutTuple({ user: " user_1 ", style: " compact ", deviceClass: "desktop" })).toEqual({
      user: " user_1 ",
      style: " compact ",
      deviceClass: "desktop",
    })
  })

  test("rejects non-object values", () => {
    expect(() => decodeLayoutTuple(null)).toThrow(/^layoutTuple: /)
    expect(() => decodeLayoutTuple([])).toThrow(/^layoutTuple: /)
    expect(() => decodeLayoutTuple("tuple")).toThrow(/^layoutTuple: /)
    expect(() => decodeLayoutTuple(undefined)).toThrow(/^layoutTuple: /)
  })

  test("rejects missing, empty and malformed fields", () => {
    expect(() => decodeLayoutTuple({ user: "user_1", style: "compact" })).toThrow(/layoutTuple\.deviceClass/)
    expect(() => decodeLayoutTuple({ user: "user_1", deviceClass: "desktop" })).toThrow(/layoutTuple\.style/)
    expect(() => decodeLayoutTuple({ style: "compact", deviceClass: "desktop" })).toThrow(/layoutTuple\.user/)
    expect(() => decodeLayoutTuple({ user: " ", style: "compact", deviceClass: "desktop" })).toThrow(/layoutTuple\.user/)
    expect(() => decodeLayoutTuple({ user: null, style: "compact", deviceClass: "desktop" })).toThrow(/layoutTuple\.user/)
  })

  test("rejects unknown properties", () => {
    expect(() =>
      decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: "desktop", extra: true }),
    ).toThrow(/layoutTuple\.extra/)
  })

  test("rejects device classes that differ by case or are unknown", () => {
    expect(() => decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: "Desktop" })).toThrow(
      /layoutTuple\.deviceClass/,
    )
    expect(() => decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: "console" })).toThrow(
      /layoutTuple\.deviceClass/,
    )
    expect(() => decodeLayoutTuple({ user: "user_1", style: "compact", deviceClass: 1 })).toThrow(
      /layoutTuple\.deviceClass/,
    )
  })

  test("does not retain references to the input object", () => {
    const input = { user: "user_1", style: "compact", deviceClass: "desktop" }
    const decoded = decodeLayoutTuple(input)

    input.user = "mutated"
    input.deviceClass = "mobile"

    expect(decoded.user).toBe("user_1")
    expect(decoded.deviceClass).toBe("desktop")
  })
})
