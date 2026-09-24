import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Schema } from "effect"
import type { LegacyPublicEvent } from "../src/legacy-bundle"
import { legacyCanonical } from "../src/legacy-context"
import { adaptLegacyEvent, LegacyEventError, restoreLegacyEvent, type LegacyEventMetadata } from "../src/legacy-event"

const sessionID = "ses_legacy_event"
const eventID = EventV2.ID.create()
const sessionDefinitions = [SessionV1.Event.Created, SessionV1.Event.Updated, SessionV1.Event.Deleted]
const info = {
  id: sessionID,
  slug: "legacy-event",
  projectID: "global",
  directory: "/workspace",
  title: "Legacy event",
  version: "1.0.0",
  time: { created: 0, updated: 1 },
}

function admitted(): LegacyPublicEvent {
  return {
    id: eventID,
    type: EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
    seq: 0,
    aggregateID: sessionID,
    data: {
      sessionID,
      timestamp: 0,
      messageID: "msg_legacy_event",
      prompt: { text: "Hello" },
      delivery: "steer",
    },
  }
}

function sessionEvent(definition: (typeof sessionDefinitions)[number], runtime?: LegacyEventMetadata["runtime"]): LegacyPublicEvent {
  if (!definition.durable) throw new Error("Missing native durable definition")
  return {
    id: eventID,
    type: EventV2.versionedType(definition.type, definition.durable.version),
    seq: 0,
    aggregateID: sessionID,
    data: { sessionID, info: { ...info, ...(runtime === undefined ? {} : { runtime }) } },
  }
}

function assertNative(event: EventV2.SerializedEvent) {
  const definition = Durable.get(event.type)
  if (!definition?.durable) throw new Error("Missing native durable definition")
  const decoded = Schema.decodeUnknownSync(definition.data)(event.data)
  expect(legacyCanonical(Schema.encodeUnknownSync(definition.data)(decoded))).toBe(legacyCanonical(event.data))
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

describe("legacy event adaptation", () => {
  test("native PromptAdmitted roundtrips without materializing metadata", () => {
    const event = freeze(admitted())
    const adapted = adaptLegacyEvent(event)
    expect(adapted.original).toEqual(event)
    expect(legacyCanonical(adapted.native)).toBe(legacyCanonical(event))
    expect(adapted.metadata).toEqual({})
    assertNative(adapted.native)
    const restored = restoreLegacyEvent(adapted.native, adapted.metadata)
    expect(restored).toEqual(event)
    expect(Object.hasOwn(restored.data, "modelContextVersion")).toBe(false)
  })

  test("PromptAdmitted modelContextVersion is retained only out of band", () => {
    const base = admitted()
    const event = freeze({ ...base, data: { ...base.data, modelContextVersion: 2 } })
    const bytes = legacyCanonical(event)
    const adapted = adaptLegacyEvent(event)
    expect(adapted.original).toEqual(event)
    expect(legacyCanonical(adapted.native)).toBe(legacyCanonical(base))
    expect(adapted.metadata).toEqual({ modelContextVersion: 2 })
    expect(Object.hasOwn(adapted.native.data, "modelContextVersion")).toBe(false)
    assertNative(adapted.native)
    expect(restoreLegacyEvent(freeze(adapted.native), freeze(adapted.metadata))).toEqual(event)
    expect(legacyCanonical(event)).toBe(bytes)
  })

  test("unsupported model context versions fail rather than disappearing", () => {
    const event = admitted()
    for (const modelContextVersion of [1, 3, null, "2", false, {}]) {
      expect(() => adaptLegacyEvent({ ...event, data: { ...event.data, modelContextVersion } }))
        .toThrow(LegacyEventError)
    }
  })

  for (const definition of sessionDefinitions) {
    for (const runtime of ["legacy", "v2", "mixed"] satisfies readonly LegacyEventMetadata["runtime"][]) {
      test(`${definition.type} preserves runtime ${runtime} out of band`, () => {
        const event = freeze(sessionEvent(definition, runtime))
        const bytes = legacyCanonical(event)
        const adapted = adaptLegacyEvent(event)
        expect(adapted.original).toEqual(event)
        expect(legacyCanonical(adapted.native)).toBe(legacyCanonical(sessionEvent(definition)))
        expect(adapted.metadata).toEqual({ runtime })
        assertNative(adapted.native)
        expect(restoreLegacyEvent(freeze(adapted.native), freeze(adapted.metadata))).toEqual(event)
        expect(legacyCanonical(event)).toBe(bytes)
      })
    }

    test(`${definition.type} does not invent the historical runtime default`, () => {
      const event = sessionEvent(definition)
      const adapted = adaptLegacyEvent(event)
      expect(adapted.metadata).toEqual({})
      expect(adapted.original).toEqual(event)
      expect(adapted.native.data.info).toEqual(info)
      assertNative(adapted.native)
      expect(restoreLegacyEvent(adapted.native, {})).toEqual(event)
    })
  }

  test("optional SessionInfo fields and numeric JSON keys survive native projection", () => {
    const event = sessionEvent(SessionV1.Event.Updated)
    const optionalInfo = {
      ...info,
      path: "/workspace/subdir",
      summary: { additions: 1, deletions: 2, files: 3 },
      cost: 0.5,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      share: { url: "https://example.test/session" },
      agent: "build",
      metadata: { "10": "ten", "2": "two", a: [true, null, { preserved: "value" }] },
      time: { created: 0, updated: 1, compacting: 2, archived: 3 },
    }
    const original = { ...event, data: { sessionID, info: { ...optionalInfo, runtime: "mixed" } } }
    const adapted = adaptLegacyEvent(original)
    expect(adapted.native.data.info).toEqual(optionalInfo)
    assertNative(adapted.native)
    expect(legacyCanonical(restoreLegacyEvent(adapted.native, adapted.metadata))).toBe(legacyCanonical(original))
  })

  test("runtime values must belong to the exact owned enum", () => {
    const event = sessionEvent(SessionV1.Event.Created)
    for (const runtime of ["unknown", 2, null, false, {}]) {
      expect(() => adaptLegacyEvent({ ...event, data: { sessionID, info: { ...info, runtime } } }))
        .toThrow(LegacyEventError)
    }
  })

  test("unrelated event kinds cannot borrow the owned metadata field names", () => {
    const event = {
      ...admitted(),
      type: EventV2.versionedType(SessionV1.Event.MessageRemoved.type, 1),
      data: { sessionID, messageID: "msg_legacy_event" },
    }
    const adapted = adaptLegacyEvent(event)
    expect(adapted.metadata).toEqual({})
    expect(restoreLegacyEvent(adapted.native, {})).toEqual(event)
    const extras: readonly LegacyPublicEvent["data"][] = [
      { runtime: "mixed" },
      { modelContextVersion: 2 },
      { info: { runtime: "legacy" } },
    ]
    for (const extra of extras) {
      expect(() => adaptLegacyEvent({ ...event, data: { ...event.data, ...extra } })).toThrow(LegacyEventError)
    }
  })

  test("owned field names at the wrong path and private extras fail", () => {
    const event = sessionEvent(SessionV1.Event.Created)
    const payloads: readonly LegacyPublicEvent["data"][] = [
      { sessionID, info, runtime: "mixed" },
      { sessionID, info, modelContextVersion: 2 },
      { sessionID, info: { ...info, modelContextVersion: 2 } },
      { sessionID, info: { ...info, runtime: "legacy", privateSnapshot: { body: "secret" } } },
      { sessionID, info: { ...info, time: { ...info.time, privateSnapshot: "secret" } } },
    ]
    for (const data of payloads) {
      expect(() => adaptLegacyEvent({ ...event, data })).toThrow(LegacyEventError)
    }
    const prompt = admitted()
    expect(() => adaptLegacyEvent({ ...prompt, data: { ...prompt.data, runtime: "legacy" } }))
      .toThrow(LegacyEventError)
    const extraEnvelope = { ...event, privateSnapshot: "secret" }
    expect(() => adaptLegacyEvent(extraEnvelope)).toThrow(LegacyEventError)
  })

  test("same-named keys inside native opaque JSON stay in place", () => {
    const event = sessionEvent(SessionV1.Event.Created)
    const original = {
      ...event,
      data: { sessionID, info: { ...info, metadata: { runtime: "not-a-classification", modelContextVersion: 1 } } },
    }
    const adapted = adaptLegacyEvent(original)
    expect(adapted.metadata).toEqual({})
    expect(legacyCanonical(adapted.native)).toBe(legacyCanonical(original))
    assertNative(adapted.native)
    expect(restoreLegacyEvent(adapted.native, {})).toEqual(original)
  })

  test("unknown durable types, unsupported versions, and live-only events fail", () => {
    const event = admitted()
    for (const type of [
      "not-a-durable-event",
      EventV2.versionedType(SessionEvent.PromptAdmitted.type, 999),
      EventV2.versionedType(SessionEvent.Text.Delta.type, 1),
    ]) {
      expect(() => adaptLegacyEvent({ ...event, type })).toThrow(LegacyEventError)
    }
  })

  test("IDs, sequence values, and aggregate identities are validated", () => {
    const event = sessionEvent(SessionV1.Event.Created)
    expect(() => adaptLegacyEvent({ ...event, id: "invalid" })).toThrow(LegacyEventError)
    expect(() => adaptLegacyEvent({ ...event, aggregateID: "invalid" })).toThrow(LegacyEventError)
    for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => adaptLegacyEvent({ ...event, seq })).toThrow(LegacyEventError)
    }
    expect(adaptLegacyEvent({ ...event, seq: Number.MAX_SAFE_INTEGER }).native.seq).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => adaptLegacyEvent({ ...event, aggregateID: "ses_other" })).toThrow(LegacyEventError)
    expect(() => adaptLegacyEvent({ ...event, data: { sessionID: "ses_other", info } })).toThrow(LegacyEventError)
    expect(() => adaptLegacyEvent({ ...event, data: { sessionID, info: { ...info, id: "ses_other" } } }))
      .toThrow(LegacyEventError)
  })

  test("restoration rejects unknown metadata and incorrect placement", () => {
    const session = adaptLegacyEvent(sessionEvent(SessionV1.Event.Created)).native
    const prompt = adaptLegacyEvent(admitted()).native
    const extra: LegacyEventMetadata & { privateSnapshot: string } = { runtime: "legacy", privateSnapshot: "secret" }
    expect(() => restoreLegacyEvent(session, extra)).toThrow(LegacyEventError)
    expect(() => restoreLegacyEvent(session, { modelContextVersion: 2 })).toThrow(LegacyEventError)
    expect(() => restoreLegacyEvent(prompt, { runtime: "mixed" })).toThrow(LegacyEventError)
    expect(() => restoreLegacyEvent(prompt, { modelContextVersion: 2, runtime: "legacy" })).toThrow(LegacyEventError)
    const unrelated = adaptLegacyEvent({
      ...admitted(),
      type: EventV2.versionedType(SessionV1.Event.MessageRemoved.type, 1),
      data: { sessionID, messageID: "msg_legacy_event" },
    }).native
    expect(() => restoreLegacyEvent(unrelated, { runtime: "legacy" })).toThrow(LegacyEventError)
    expect(() => restoreLegacyEvent(unrelated, { modelContextVersion: 2 })).toThrow(LegacyEventError)
  })

  test("restoration rejects malformed metadata values, including explicit undefined", () => {
    const session = adaptLegacyEvent(sessionEvent(SessionV1.Event.Created)).native
    const prompt = adaptLegacyEvent(admitted()).native
    for (const value of [undefined, null, 1, "unsupported", {}]) {
      const runtime: LegacyEventMetadata = {}
      const version: LegacyEventMetadata = {}
      Object.defineProperty(runtime, "runtime", { value, enumerable: true })
      Object.defineProperty(version, "modelContextVersion", { value, enumerable: true })
      expect(() => restoreLegacyEvent(session, runtime)).toThrow(LegacyEventError)
      expect(() => restoreLegacyEvent(prompt, version)).toThrow(LegacyEventError)
    }
  })

  test("restoration cannot override fields in dirty or mutated native payloads", () => {
    const session = adaptLegacyEvent(sessionEvent(SessionV1.Event.Created)).native
    const prompt = adaptLegacyEvent(admitted()).native
    const payloads: readonly LegacyPublicEvent["data"][] = [
      { sessionID, info: { ...info, runtime: "legacy" } },
      { sessionID, info: { ...info, id: "ses_other" } },
      { sessionID, info: { ...info, title: 123 } },
      { sessionID, info, privateSnapshot: "secret" },
    ]
    for (const data of payloads) {
      expect(() => restoreLegacyEvent({ ...session, data }, { runtime: "mixed" })).toThrow(LegacyEventError)
    }
    expect(() => restoreLegacyEvent({ ...prompt, data: { ...prompt.data, modelContextVersion: 2 } }, { modelContextVersion: 2 }))
      .toThrow(LegacyEventError)
    expect(() => restoreLegacyEvent({ ...session, seq: -1 }, {})).toThrow(LegacyEventError)
    expect(() => restoreLegacyEvent({ ...session, aggregateID: "ses_other" }, {})).toThrow(LegacyEventError)
  })

  test("non-JSON values and hidden properties cannot cross the boundary", () => {
    const native = adaptLegacyEvent(sessionEvent(SessionV1.Event.Created)).native
    for (const value of [undefined, Infinity, new Date(0), () => "secret"]) {
      expect(() => restoreLegacyEvent({ ...native, data: { ...native.data, privateSnapshot: value } }, {}))
        .toThrow(LegacyEventError)
    }
    const hidden = sessionEvent(SessionV1.Event.Created)
    Object.defineProperty(hidden.data, "privateSnapshot", { value: "secret", enumerable: false })
    expect(() => adaptLegacyEvent(hidden)).toThrow(LegacyEventError)
    const explicit = sessionEvent(SessionV1.Event.Created)
    Object.defineProperty(explicit.data, "runtime", { value: undefined, enumerable: true })
    expect(() => adaptLegacyEvent(explicit)).toThrow(LegacyEventError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => restoreLegacyEvent({ ...native, data: cyclic }, {})).toThrow(LegacyEventError)
  })

  test("returned graphs are detached from callers and from each other", () => {
    const event = sessionEvent(SessionV1.Event.Created, "mixed")
    const bytes = legacyCanonical(event)
    const adapted = adaptLegacyEvent(event)
    expect(adapted.original).not.toBe(event)
    expect(adapted.original.data).not.toBe(event.data)
    expect(adapted.original.data.info).not.toBe(event.data.info)
    expect(adapted.native.data.info).not.toBe(adapted.original.data.info)
    const restored = restoreLegacyEvent(adapted.native, adapted.metadata)
    expect(restored.data.info).not.toBe(adapted.native.data.info)
    Object.assign(restored.data.info ?? {}, { title: "Restored output mutation" })
    Object.assign(adapted.native.data.info ?? {}, { title: "Native output mutation" })
    expect(legacyCanonical(event)).toBe(bytes)
    expect(legacyCanonical(adapted.original)).toBe(bytes)
  })

  test("errors expose stable codes without event contents", () => {
    const secret = "private-event-content-do-not-include"
    const event = sessionEvent(SessionV1.Event.Created)
    try {
      adaptLegacyEvent({ ...event, data: { sessionID, info: { ...info, runtime: secret } } })
    } catch (error) {
      if (!(error instanceof LegacyEventError)) throw error
      expect(error.code).toBe("session-runtime")
      expect(error.message).toBe("Invalid legacy event")
      expect(error.message).not.toContain(secret)
      return
    }
    throw new Error("Expected legacy event validation to fail")
  })
})
