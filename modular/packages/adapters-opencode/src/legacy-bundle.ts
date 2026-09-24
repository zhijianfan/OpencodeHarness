import { EventV2 } from "@opencode-ai/core/event"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Option, Schema } from "effect"
import { decodeCheckpoint, type PrivateCheckpoint, SENTINEL } from "./checkpoint"
import { decodeLegacyContext, legacyCanonical, legacyDigest, type LegacyInputContext, type LegacyJson } from "./legacy-context"

const PublicEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  seq: Schema.Number,
  aggregateID: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
})

const identityFields = {
  eventID: Schema.String,
  aggregateID: Schema.String,
  seq: Schema.Number,
  eventType: Schema.String,
  eventDataHash: Schema.String,
}
const Identity = Schema.Struct(identityFields)
const ContextEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  ...identityFields,
  messageID: Schema.String,
  kind: Schema.Literals(["input", "compaction"]),
  sidecarSchemaVersion: Schema.Number,
  contentHash: Schema.String,
  payload: Schema.String,
})
const EpochEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("context-epoch"),
  aggregateID: Schema.String,
  sourceSeq: Schema.Number,
  baselineSeq: Schema.Number,
  epochSchemaVersion: Schema.Literal(1),
  contentHash: Schema.String,
  payload: Schema.String,
})
const Deletion = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("reverted-target"),
  aggregateID: Schema.String,
  targetMessageID: Schema.String,
  targetKind: Schema.Literals(["input", "compaction"]),
  deletionCause: Schema.Literals(["message-seq", "input-admitted-seq", "input-promoted-seq"]),
  targetEvent: Identity,
  deletingEvent: Identity,
  boundaryMessageID: Schema.String,
  boundaryEvent: Identity,
  promotionEvent: Identity.pipe(Schema.optional),
})
const Bundle = Schema.Struct({
  version: Schema.Literal(1),
  aggregateID: Schema.String,
  sourceSeq: Schema.Number,
  events: Schema.Array(PublicEvent),
  contexts: Schema.Array(ContextEnvelope),
  deletions: Schema.Array(Deletion),
  epoch: EpochEnvelope.pipe(Schema.optional),
})
const EpochPayload = Schema.Struct({ baseline: Schema.String, snapshot: SystemContext.Snapshot })

export type LegacyPublicEvent = typeof PublicEvent.Type
export type LegacyBundle = typeof Bundle.Type
export type LegacyContextEnvelope = typeof ContextEnvelope.Type
export type LegacyDeletion = typeof Deletion.Type
export type ValidatedLegacyBundle = {
  readonly bundle: LegacyBundle
  readonly history: readonly LegacyPublicEvent[]
  readonly inputs: readonly { readonly envelope: LegacyContextEnvelope; readonly context: LegacyInputContext }[]
  readonly checkpoints: readonly { readonly envelope: LegacyContextEnvelope; readonly context: PrivateCheckpoint }[]
  readonly epoch?: {
    readonly envelope: typeof EpochEnvelope.Type
    readonly payload: { readonly baseline: string; readonly snapshot: LegacyJson }
  }
}

export class LegacyBundleError extends Error {
  readonly code: string

  constructor(code: string) {
    super("Invalid legacy session bundle")
    this.name = "LegacyBundleError"
    this.code = code
  }
}

const decodeBundle = Schema.decodeUnknownOption(Bundle, { onExcessProperty: "error" })
const decodeEvents = Schema.decodeUnknownOption(Schema.Array(PublicEvent), { onExcessProperty: "error" })
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeJsonValue = Schema.decodeUnknownOption(Schema.Json)
const decodeEpoch = Schema.decodeUnknownOption(EpochPayload, { onExcessProperty: "error" })
const admittedType = EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)
const promptedType = EventV2.versionedType(SessionEvent.Prompted.type, 1)
const compactionType = EventV2.versionedType(SessionEvent.Compaction.Ended.type, 1)
const revertType = EventV2.versionedType(SessionEvent.RevertEvent.Committed.type, 1)
const stepType = EventV2.versionedType(SessionEvent.Step.Started.type, 1)
const projectingTypes = new Set<string>([
  SessionEvent.AgentSwitched,
  SessionEvent.ModelSwitched,
  SessionEvent.Prompted,
  SessionEvent.ContextUpdated,
  SessionEvent.Synthetic,
  SessionEvent.Shell.Started,
  SessionEvent.Compaction.Ended,
].map((definition) => EventV2.versionedType(definition.type, 1)))

export function validateLegacyBundle(value: unknown, retained: readonly LegacyPublicEvent[] = []): ValidatedLegacyBundle {
  // This boundary also sanitizes errors from schemas, canonicalization and private decoders.
  try {
    const original = legacyCanonical(value)
    const retainedBytes = legacyCanonical(retained)
    const decoded = decodeBundle(value)
    const prefix = decodeEvents(retained)
    if (Option.isNone(decoded) || Option.isNone(prefix)) throw new LegacyBundleError("bundle-schema")
    const bundle = structuredClone(decoded.value)
    const previous = structuredClone(prefix.value)
    if (legacyCanonical(bundle) !== original || legacyCanonical(previous) !== retainedBytes)
      throw new LegacyBundleError("lossy-bundle-schema")
    if (!bundle.aggregateID.startsWith("ses") || !isSequence(bundle.sourceSeq))
      throw new LegacyBundleError("bundle-identity")
    const incomingIDs = new Set<string>()
    for (const [index, event] of bundle.events.entries()) {
      const prior = bundle.events[index - 1]
      if ((prior !== undefined && event.seq !== prior.seq + 1) || incomingIDs.has(event.id))
        throw new LegacyBundleError("bundle-sequence")
      incomingIDs.add(event.id)
    }
    const bySequence = new Map<number, LegacyPublicEvent>()
    const byID = new Map<string, LegacyPublicEvent>()
    for (const event of [...previous, ...bundle.events]) {
      if (event.aggregateID !== bundle.aggregateID || !isSequence(event.seq) || event.seq > bundle.sourceSeq)
        throw new LegacyBundleError("bundle-identity")
      if (event.data.sessionID !== undefined && event.data.sessionID !== bundle.aggregateID)
        throw new LegacyBundleError("event-aggregate")
      const bytes = legacyCanonical(event)
      const sameSequence = bySequence.get(event.seq)
      const sameID = byID.get(event.id)
      if ((sameSequence !== undefined && legacyCanonical(sameSequence) !== bytes) ||
        (sameID !== undefined && legacyCanonical(sameID) !== bytes))
        throw new LegacyBundleError("event-conflict")
      bySequence.set(event.seq, event)
      byID.set(event.id, event)
    }
    const history = [...bySequence.values()].sort((left, right) => left.seq - right.seq)
    if (history.length - 1 !== bundle.sourceSeq || history.some((event, index) => event.seq !== index))
      throw new LegacyBundleError("incomplete-history")

    const inputs: { envelope: LegacyContextEnvelope; context: LegacyInputContext }[] = []
    const checkpoints: { envelope: LegacyContextEnvelope; context: PrivateCheckpoint }[] = []
    const manifest = new Map<string, number>()
    for (const envelope of bundle.contexts) {
      if (envelope.aggregateID !== bundle.aggregateID || !isSequence(envelope.sidecarSchemaVersion))
        throw new LegacyBundleError("context-schema")
      const event = requireIdentity(bySequence, envelope)
      if (event.data.messageID !== envelope.messageID) throw new LegacyBundleError("context-event-identity")
      claimManifest(manifest, envelope.kind, envelope.messageID, event.seq)
      const payload = requirePayload(envelope, "context-payload")
      if (envelope.kind === "input") {
        if (event.type !== admittedType) throw new LegacyBundleError("context-event-type")
        const prompt = event.data.prompt
        if (!isObject(prompt) || typeof prompt.text !== "string") throw new LegacyBundleError("input-prompt")
        const context = requireInput(payload, prompt.text)
        if (context.version !== envelope.sidecarSchemaVersion) throw new LegacyBundleError("context-schema")
        inputs.push({ envelope, context })
        continue
      }
      if (event.type !== compactionType || event.data.text !== SENTINEL)
        throw new LegacyBundleError("context-event-type")
      const context = requireCheckpoint(payload, envelope.messageID)
      if (context.version !== envelope.sidecarSchemaVersion) throw new LegacyBundleError("context-schema")
      checkpoints.push({ envelope, context })
    }
    for (const deletion of bundle.deletions) {
      if (deletion.aggregateID !== bundle.aggregateID) throw new LegacyBundleError("bundle-identity")
      validateDeletion(bySequence, deletion)
      claimManifest(manifest, deletion.targetKind, deletion.targetMessageID, deletion.targetEvent.seq)
    }
    for (const event of history) {
      const kind = event.type === admittedType && event.data.modelContextVersion === 2
        ? "input"
        : event.type === compactionType && event.data.text === SENTINEL ? "compaction" : undefined
      if (kind === undefined) continue
      if (typeof event.data.messageID !== "string" || manifest.get(`${kind}:${event.data.messageID}`) !== event.seq)
        throw new LegacyBundleError("incomplete-private-manifest")
    }
    const epoch = bundle.epoch === undefined ? undefined : prepareEpoch(bundle.epoch, bundle)
    // Detach from caller-owned inputs and freeze the entire validated graph, including decoder results.
    return freeze(structuredClone({ bundle, history, inputs, checkpoints, ...(epoch === undefined ? {} : { epoch }) }))
  } catch (error) {
    if (error instanceof LegacyBundleError) throw error
    throw new LegacyBundleError("bundle-schema")
  }
}

function isSequence(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}

function isObject(value: LegacyJson | undefined): value is { readonly [key: string]: LegacyJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireIdentity(history: ReadonlyMap<number, LegacyPublicEvent>, identity: typeof Identity.Type) {
  const event = history.get(identity.seq)
  if (!isSequence(identity.seq) || event === undefined || event.id !== identity.eventID ||
    event.type !== identity.eventType || event.aggregateID !== identity.aggregateID ||
    legacyDigest(event.data) !== identity.eventDataHash)
    throw new LegacyBundleError("event-identity")
  return event
}

function requirePayload(envelope: { readonly payload: string; readonly contentHash: string }, code: string): LegacyJson {
  const parsed = decodeJson(envelope.payload)
  if (Option.isNone(parsed)) throw new LegacyBundleError(code)
  const json = decodeJsonValue(parsed.value)
  if (Option.isNone(json) || legacyCanonical(json.value) !== envelope.payload || legacyDigest(json.value) !== envelope.contentHash)
    throw new LegacyBundleError(code)
  return json.value
}

function requireInput(payload: LegacyJson, prompt: string) {
  try {
    return decodeLegacyContext(payload, prompt)
  } catch {
    throw new LegacyBundleError("input-context")
  }
}

function requireCheckpoint(payload: LegacyJson, messageID: string) {
  try {
    return decodeCheckpoint(payload, messageID)
  } catch {
    throw new LegacyBundleError("compaction-context")
  }
}

function claimManifest(manifest: Map<string, number>, kind: string, messageID: string, seq: number) {
  const key = `${kind}:${messageID}`
  if (manifest.has(key)) throw new LegacyBundleError("duplicate-private-manifest")
  manifest.set(key, seq)
}

function validateDeletion(history: ReadonlyMap<number, LegacyPublicEvent>, deletion: LegacyDeletion) {
  const target = requireIdentity(history, deletion.targetEvent)
  const deleting = requireIdentity(history, deletion.deletingEvent)
  const boundary = requireIdentity(history, deletion.boundaryEvent)
  const promotion = deletion.promotionEvent === undefined ? undefined : requireIdentity(history, deletion.promotionEvent)
  if (target.data.messageID !== deletion.targetMessageID || deleting.type !== revertType ||
    deleting.data.messageID !== deletion.boundaryMessageID || messageIDOf(boundary) !== deletion.boundaryMessageID ||
    (promotion !== undefined && (promotion.type !== promptedType || promotion.data.messageID !== deletion.targetMessageID ||
      promotion.seq <= target.seq)) || deleting.seq <= (promotion?.seq ?? target.seq))
    throw new LegacyBundleError("deletion-relation")
  const cause = deletion.targetKind === "compaction"
    ? target.seq > boundary.seq ? "message-seq" : undefined
    : target.seq > boundary.seq ? "input-admitted-seq"
    : promotion !== undefined && promotion.seq > boundary.seq ? "input-promoted-seq" : undefined
  if (cause !== deletion.deletionCause || (cause === "input-promoted-seq") !== (promotion !== undefined) ||
    (deletion.targetKind === "input" && target.type !== admittedType) ||
    (deletion.targetKind === "compaction" && (target.type !== compactionType || target.data.text !== SENTINEL)))
    throw new LegacyBundleError("deletion-cause")
}

function messageIDOf(event: LegacyPublicEvent) {
  if (event.type === stepType) return event.data.assistantMessageID
  if (projectingTypes.has(event.type)) return event.data.messageID
}

function prepareEpoch(envelope: typeof EpochEnvelope.Type, bundle: LegacyBundle) {
  if (envelope.aggregateID !== bundle.aggregateID || envelope.sourceSeq !== bundle.sourceSeq ||
    !isSequence(envelope.sourceSeq) || !isSequence(envelope.baselineSeq) || envelope.baselineSeq > envelope.sourceSeq)
    throw new LegacyBundleError("epoch-identity")
  const payload = requirePayload(envelope, "epoch-payload")
  const decoded = decodeEpoch(payload)
  if (Option.isNone(decoded) || !isObject(payload) || typeof payload.baseline !== "string" || payload.snapshot === undefined)
    throw new LegacyBundleError("epoch-schema")
  if (legacyCanonical(Schema.encodeUnknownSync(EpochPayload)(decoded.value)) !== envelope.payload)
    throw new LegacyBundleError("epoch-schema")
  return { envelope, payload: { baseline: payload.baseline, snapshot: payload.snapshot } }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
