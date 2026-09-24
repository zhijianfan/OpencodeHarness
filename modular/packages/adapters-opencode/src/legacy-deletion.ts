import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Option, Schema } from "effect"
import { SENTINEL } from "./checkpoint"
import { LegacyBundleError, type LegacyDeletion, type LegacyPublicEvent } from "./legacy-bundle"
import { legacyCanonical, legacyDigest } from "./legacy-context"

export type NativeMessageIdentity = {
  readonly id: string
  readonly seq: number
}

export type NativeInputIdentity = {
  readonly id: string
  readonly admittedSeq: number
  readonly promotedSeq?: number
}

// Mirrors the receipt schema in legacy-bundle so stored proofs can be decoded
// back into their exact LegacyDeletion shape before reconciliation.
const DeletionIdentity = Schema.Struct({
  eventID: Schema.String,
  aggregateID: Schema.String,
  seq: Schema.Number,
  eventType: Schema.String,
  eventDataHash: Schema.String,
})
const DeletionRecord = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("reverted-target"),
  aggregateID: Schema.String,
  targetMessageID: Schema.String,
  targetKind: Schema.Literals(["input", "compaction"]),
  deletionCause: Schema.Literals(["message-seq", "input-admitted-seq", "input-promoted-seq"]),
  targetEvent: DeletionIdentity,
  deletingEvent: DeletionIdentity,
  boundaryMessageID: Schema.String,
  boundaryEvent: DeletionIdentity,
  promotionEvent: DeletionIdentity.pipe(Schema.optional),
})
const decodeDeletion = Schema.decodeUnknownOption(DeletionRecord, { onExcessProperty: "error" })
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const admittedType = EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)
const promptedType = EventV2.versionedType(SessionEvent.Prompted.type, 1)
const compactionType = EventV2.versionedType(SessionEvent.Compaction.Ended.type, 1)
const revertType = EventV2.versionedType(SessionEvent.RevertEvent.Committed.type, 1)
const stepType = EventV2.versionedType(SessionEvent.Step.Started.type, 1)
// Kept identical to legacy-bundle's projecting set so a boundary event is only
// accepted when the bundle validator would agree it projects the message.
const projectingTypes = new Set<string>([
  SessionEvent.AgentSwitched,
  SessionEvent.ModelSwitched,
  SessionEvent.Prompted,
  SessionEvent.ContextUpdated,
  SessionEvent.Synthetic,
  SessionEvent.Shell.Started,
  SessionEvent.Compaction.Ended,
].map((definition) => EventV2.versionedType(definition.type, 1)))

type RequiredMarker = {
  readonly kind: "input" | "compaction"
  readonly messageID: string
  readonly event: LegacyPublicEvent
}

type Target =
  | { readonly kind: "compaction"; readonly seq: number }
  | { readonly kind: "input"; readonly admittedSeq: number; readonly promotedSeq?: number }

// A V2 prompt admission or a private sentinel compaction must always have either
// a live sidecar (a context) or a proven deletion receipt in the exported bundle.

/**
 * Rebuild the deletion receipts a native revert already committed but whose
 * private sidecar has cascaded away. Native projectors remain the authority;
 * this only proves their committed effect from recorded revert history and the
 * rows still retained. A marker is never treated as deleted merely because its
 * row is absent: a genuine, ordered revert relation must exist.
 */
export function reconcileLocalDeletions(input: {
  readonly aggregateID: string
  readonly history: readonly LegacyPublicEvent[]
  readonly messages: readonly NativeMessageIdentity[]
  readonly inputs: readonly NativeInputIdentity[]
  readonly existingProofs: readonly string[]
}): readonly LegacyDeletion[] {
  const existing = input.existingProofs.map(decodeStoredDeletion)
  const byKey = new Map<string, LegacyDeletion>()
  for (const proof of existing) {
    const key = deletionKey(proof.targetKind, proof.targetMessageID)
    if (byKey.has(key)) throw new LegacyBundleError("duplicate-deletion-record")
    byKey.set(key, proof)
  }
  const presentInputs = new Set(input.inputs.map((row) => row.id))
  const presentMessages = new Set(input.messages.map((row) => row.id))
  const derived: LegacyDeletion[] = []
  const derivedKeys = new Set<string>()
  for (const marker of requiredMarkers(input.history)) {
    const key = deletionKey(marker.kind, marker.messageID)
    const present = marker.kind === "input" ? presentInputs.has(marker.messageID) : presentMessages.has(marker.messageID)
    if (present) {
      // A retained native row is never a deletion; a missing sidecar is corruption.
      if (byKey.has(key)) throw new LegacyBundleError("deleted-target-present")
      continue
    }
    const prior = byKey.get(key)
    if (prior) {
      // Imported receipts are authoritative and never rewritten, even when a
      // later revert moved the provable boundary. Only a receipt whose recorded
      // target identity disagrees with the retained marker is a conflict.
      if (legacyCanonical(prior.targetEvent) !== legacyCanonical(identity(marker.event, input.aggregateID)))
        throw new LegacyBundleError("deletion-conflict")
      continue
    }
    const proof = deriveDeletionProof({
      aggregateID: input.aggregateID,
      history: input.history,
      messages: input.messages,
      target: marker.event,
      targetKind: marker.kind,
    })
    if (!proof) throw new LegacyBundleError("incomplete-private-manifest")
    if (derivedKeys.has(key)) throw new LegacyBundleError("duplicate-private-manifest")
    derivedKeys.add(key)
    derived.push(proof)
  }
  return [...existing, ...derived].sort((left, right) => left.targetEvent.seq - right.targetEvent.seq)
}

/** Pure port of the fork's SessionProjectionTransfer.deletionProof relation. */
export function deriveDeletionProof(input: {
  readonly aggregateID: string
  readonly history: readonly LegacyPublicEvent[]
  readonly messages: readonly NativeMessageIdentity[]
  readonly target: LegacyPublicEvent
  readonly targetKind: "input" | "compaction"
}): LegacyDeletion | undefined {
  const messageID = input.target.data.messageID
  if (typeof messageID !== "string") return undefined
  const promotion = input.targetKind === "input"
    ? input.history.find((event) => event.type === promptedType && event.data.messageID === messageID)
    : undefined
  const after = promotion?.seq ?? input.target.seq
  for (const deleting of input.history.filter((event) => event.type === revertType && event.seq > after)) {
    const boundaryMessageID = deleting.data.messageID
    if (typeof boundaryMessageID !== "string") continue
    // The boundary row must still exist and be genuinely projected by the
    // retained event at that sequence. A vanished boundary cannot be proven, so
    // skip it rather than inventing a relation the validator would reject.
    const boundary = input.messages.find((message) => message.id === boundaryMessageID)
    if (!boundary) continue
    const boundaryEvent = input.history.find((event) => event.seq === boundary.seq)
    if (!boundaryEvent || messageIDOf(boundaryEvent) !== boundaryMessageID) continue
    const cause = deletionCause(
      input.targetKind === "compaction"
        ? { kind: "compaction", seq: input.target.seq }
        : {
            kind: "input",
            admittedSeq: input.target.seq,
            ...(promotion === undefined ? {} : { promotedSeq: promotion.seq }),
          },
      boundary.seq,
    )
    if (cause === undefined) continue
    return {
      version: 1,
      kind: "reverted-target",
      aggregateID: input.aggregateID,
      targetMessageID: messageID,
      targetKind: input.targetKind,
      deletionCause: cause,
      targetEvent: identity(input.target, input.aggregateID),
      deletingEvent: identity(deleting, input.aggregateID),
      boundaryMessageID,
      boundaryEvent: identity(boundaryEvent, input.aggregateID),
      ...(cause === "input-promoted-seq" && promotion !== undefined
        ? { promotionEvent: identity(promotion, input.aggregateID) }
        : {}),
    }
  }
  return undefined
}

function requiredMarkers(history: readonly LegacyPublicEvent[]): RequiredMarker[] {
  return history.flatMap((event): RequiredMarker[] => {
    const messageID = event.data.messageID
    if (typeof messageID !== "string") return []
    if (event.type === admittedType && event.data.modelContextVersion === 2)
      return [{ kind: "input", messageID, event }]
    if (event.type === compactionType && event.data.text === SENTINEL)
      return [{ kind: "compaction", messageID, event }]
    return []
  })
}

function deletionCause(target: Target, boundarySeq: number) {
  if (target.kind === "compaction") return target.seq > boundarySeq ? ("message-seq" as const) : undefined
  if (target.admittedSeq > boundarySeq) return "input-admitted-seq" as const
  return target.promotedSeq !== undefined && target.promotedSeq > boundarySeq
    ? ("input-promoted-seq" as const)
    : undefined
}

function messageIDOf(event: LegacyPublicEvent) {
  if (event.type === stepType)
    return typeof event.data.assistantMessageID === "string" ? event.data.assistantMessageID : undefined
  if (projectingTypes.has(event.type))
    return typeof event.data.messageID === "string" ? event.data.messageID : undefined
  return undefined
}

function identity(event: LegacyPublicEvent, aggregateID: string) {
  return {
    eventID: event.id,
    aggregateID,
    seq: event.seq,
    eventType: event.type,
    eventDataHash: legacyDigest(event.data),
  }
}

function deletionKey(kind: "input" | "compaction", messageID: string) {
  return `${kind}:${messageID}`
}

function decodeStoredDeletion(proofJson: string): LegacyDeletion {
  const parsed = decodeJson(proofJson)
  if (Option.isNone(parsed)) throw new LegacyBundleError("deletion-record")
  const decoded = decodeDeletion(parsed.value)
  if (Option.isNone(decoded)) throw new LegacyBundleError("deletion-record")
  const proof: LegacyDeletion = decoded.value
  if (legacyCanonical(proof) !== proofJson) throw new LegacyBundleError("lossy-deletion-record")
  return proof
}
