import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { AdmissionError, privateRequestIdentity, validateFrozenInput, type AdmissionPolicy, type AdmissionRequest, type FrozenInput } from "./admission"
import { EventBoundary, EventReplayScope, type makeEventBoundaryNode } from "./event-boundary"
import { PrivateRestoreContext } from "./restore-context"
import { decodeLegacyContext, legacyCanonical, legacyReferenceHash, type LegacyJson } from "./legacy-context"
import { interactiveContextBudget, renderContextSnapshot } from "./context-renderer"
import { recordLegacyInputEvent } from "./legacy-projection"
import { recordV2SessionCreated } from "./session-classification"
import type { makeTransferReadiness, Mode, RequestProof } from "./transfer-readiness"

export type PrivatePromptRequest = Pick<AdmissionRequest, "actor" | "references"> & {
  readonly proof?: RequestProof
}
export class PrivatePromptContext extends Context.Service<PrivatePromptContext, PrivatePromptRequest>()("@cybermastery/PrivatePromptContext") {}

type Prepared = {
  readonly kind: "private"
  readonly request: AdmissionRequest
  readonly snapshot: FrozenInput
} | {
  readonly kind: "clean"
  readonly request: AdmissionRequest
  readonly requestHash: string
}

class PreparedInput extends Context.Service<PreparedInput, Prepared>()("@cybermastery/PreparedPrivateInput") {}

type StoredPrivate = {
  readonly request_hash: string
  readonly api_content: string
  readonly api_content_hash: string
  readonly renderer_version: number
}

export type SessionAdmissionPolicy = AdmissionPolicy & {
  /** Must be a local policy/binding lookup; also called by the atomic projector guard. */
  readonly managed: (session: SessionSchema.Info) => Effect.Effect<boolean>
  /** Runs only for a newly admitted private prompt, after native admission and before commit/wake. */
  readonly onAdmitted?: (input: { readonly request: AdmissionRequest; readonly admitted: SessionInput.Admitted;
    readonly snapshot: FrozenInput }) => Effect.Effect<void, AdmissionError>
}

export type SessionPolicy = SessionAdmissionPolicy | ((dependencies: {
  readonly database: Effect.Success<typeof Database.Service>
  readonly session: SessionV2.Interface
}) => SessionAdmissionPolicy)

type NativeRequirements = Database.Service | EventV2.Service | ProjectV2.Service | SessionExecution.Service | SessionStore.Service | LocationServiceMap.Service

/**
 * Explicit Session service decoration. The native constructor is delegated; the
 * create decoration classifies a freshly published v2 Session inside the same
 * EventBoundary transaction, prompt keeps admission reconciliation, and every
 * other method, including native MIME normalization, is delegated unchanged.
 */
export function makeSessionFacadeNode(
  boundary: ReturnType<typeof makeEventBoundaryNode>,
  policyInput: SessionPolicy,
  readinessInput?: Effect.Success<ReturnType<typeof makeTransferReadiness>>,
  replayOwner?: string,
) {
  const implementation = SessionV2.node.implementation
  if (!implementation) throw new Error("Pinned native Session node has no implementation")
  // LayerNode deliberately erases implementation types. This exact-pin bridge
  // restores the constructor's verified service requirements; no import is shadowed.
  const nativeLayer = implementation as Layer.Layer<SessionV2.Service, never, NativeRequirements>
  const layer = Layer.effect(SessionV2.Service, Effect.gen(function* () {
    const native = yield* SessionV2.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const boundary = yield* EventBoundary
    const policy = typeof policyInput === "function" ? policyInput({ database, session: native }) : policyInput
    const hash = (value: string) => createHash("sha256").update(value).digest("hex")
    const commitPrompt = (
      input: Parameters<SessionV2.Interface["prompt"]>[0],
      validate: (admitted: Effect.Success<ReturnType<SessionV2.Interface["prompt"]>>) => Effect.Effect<void, SessionV2.PromptConflictError> = () => Effect.void,
    ) => boundary.transaction(Effect.gen(function* () {
      const admitted = yield* native.prompt({ ...input, resume: false })
      yield* validate(admitted)
      if (input.resume !== false) yield* boundary.afterCommit(execution.wake(admitted.sessionID))
      return admitted
    })).pipe(Effect.catch((error) => error instanceof SessionV2.NotFoundError || error instanceof SessionV2.PromptConflictError
      ? Effect.fail(error) : Effect.die(error)))

    yield* events.project(SessionEvent.PromptAdmitted, (event) => Effect.gen(function* () {
      const prepared = yield* Effect.serviceOption(PreparedInput)
      if (Option.isNone(prepared)) {
        const replay = yield* Effect.serviceOption(EventReplayScope)
        const restore = yield* Effect.serviceOption(PrivateRestoreContext)
        if (Option.isSome(replay) && replay.value?.aggregateID === event.data.sessionID && Option.isSome(restore) && restore.value.sessionID === event.data.sessionID) return
        const session = yield* native.get(event.data.sessionID).pipe(Effect.orDie)
        if (yield* policy.managed(session)) return yield* Effect.die(new AdmissionError({ code: "missing-private-context" }))
        return
      }
      const preparedValue = prepared.value
      const request = preparedValue.request
      if (request.sessionID !== event.data.sessionID || request.messageID !== event.data.messageID || request.text !== event.data.prompt.text || request.delivery !== event.data.delivery) {
        return yield* Effect.die(new AdmissionError({ code: "conflict" }))
      }
      const session = yield* native.get(request.sessionID).pipe(Effect.orDie)
      if (!(yield* policy.managed(session))) return yield* Effect.die(new AdmissionError({ code: "conflict" }))
      yield* policy.authorize(request).pipe(Effect.orDie)
      if (preparedValue.kind === "clean") {
        // Native events have no private-version field. Clean admissions never
        // call recordLegacyInputEvent, which records that compatibility marker.
        yield* database.db.run(sql`INSERT INTO cm_clean_input (message_id, session_id, request_hash)
          VALUES (${request.messageID}, ${request.sessionID}, ${preparedValue.requestHash})`).pipe(Effect.orDie)
        return
      }
      const snapshot = preparedValue.snapshot
      yield* database.db.run(sql`INSERT INTO cm_private_input
        (message_id, session_id, request_hash, api_content, api_content_hash, renderer_version)
        VALUES (${request.messageID}, ${request.sessionID}, ${privateRequestIdentity(request)},
          ${snapshot.apiContent}, ${hash(snapshot.apiContent)}, ${snapshot.rendererVersion})`).pipe(Effect.orDie)
      yield* database.db.run(sql`INSERT INTO cm_private_requirement (message_id, session_id, kind)
        VALUES (${request.messageID}, ${request.sessionID}, 'input')`).pipe(Effect.orDie)
      // Empty clean inputs are the only snapshots we can safely synthesize. Use
      // the native event's admission clock, not an earlier freeze timestamp.
      const context = snapshot.context ?? (request.references.length === 0 && snapshot.apiContent === request.text
        ? decodeLegacyContext({
            ...renderContextSnapshot({
              promptText: request.text, attachments: [], recall: { policy: "disabled", status: "disabled" },
              budget: interactiveContextBudget,
              createdAt: Schema.decodeUnknownSync(Schema.Struct({ timestamp: Schema.Number }))(
                Schema.encodeUnknownSync(SessionEvent.PromptAdmitted.data)(event.data),
              ).timestamp,
            }).snapshot,
            rendererVersion: snapshot.rendererVersion,
          }, request.text).snapshot
        : undefined)
      if (context) yield* database.db.run(sql`INSERT INTO cm_legacy_input (message_id, session_id, snapshot_json)
        VALUES (${request.messageID}, ${request.sessionID}, ${legacyCanonical(context)})`).pipe(Effect.orDie)
    }))

    // Generate the branded identity once, then adopt or create inside a single
    // boundary transaction so a fresh Created event and its runtime
    // classification commit (or roll back) together. Historical rows are never
    // silently reclassified: classification runs only when no Session existed.
    const create: SessionV2.Interface["create"] = (input) => {
      const sessionID = input.id ?? SessionSchema.ID.create()
      return boundary.transaction(Effect.gen(function* () {
        const existing = yield* native.get(sessionID).pipe(Effect.option)
        if (Option.isSome(existing)) return existing.value
        const session = yield* native.create({ ...input, id: sessionID })
        yield* recordV2SessionCreated(sessionID).pipe(
          Effect.provideService(Database.Service, database), Effect.orDie,
        )
        if (replayOwner !== undefined) yield* events.claim(sessionID, replayOwner)
        return session
      })).pipe(Effect.orDie)
    }

    const conflict = (request: AdmissionRequest) =>
      new SessionV2.PromptConflictError({ sessionID: request.sessionID, messageID: request.messageID })

    // Exact retries reconcile the existing native immutable input before any
    // readiness or freeze. This reauthorizes inside the owning transaction and
    // distinguishes explicit clean/private identities without rewriting rows.
    const reconcileStored = (request: AdmissionRequest) => Effect.gen(function* () {
      yield* policy.authorize(request).pipe(Effect.orDie)
      const privateRow = yield* database.db.get<StoredPrivate>(sql`
        SELECT request_hash, api_content, api_content_hash, renderer_version FROM cm_private_input
        WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID}`).pipe(Effect.orDie)
      const cleanRow = yield* database.db.get<{ request_hash: string }>(sql`
        SELECT request_hash FROM cm_clean_input
        WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID}`).pipe(Effect.orDie)
      // Both markers is corruption, never a fallback.
      if (privateRow && cleanRow) return yield* Effect.die(new AdmissionError({ code: "conflict" }))
      if (!privateRow) {
        const requirement = yield* database.db.get<{ message_id: string }>(sql`
          SELECT message_id FROM cm_private_requirement
          WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID} AND kind = 'input'`).pipe(Effect.orDie)
        // A missing private context with a private requirement, or a bare native
        // input, must never be silently treated as clean.
        if (!cleanRow || requirement) return yield* Effect.die(new AdmissionError({ code: "missing-private-context" }))
        const marked = yield* database.db.get(sql`SELECT message_id FROM cm_legacy_input
          WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID}
          UNION ALL SELECT i.id FROM session_input i JOIN event e
          ON e.aggregate_id = i.session_id AND e.seq = i.admitted_seq
          JOIN cm_legacy_event l ON l.event_id = e.id
          WHERE i.id = ${request.messageID} AND i.session_id = ${request.sessionID}
          AND json_extract(l.original_json, '$.data.modelContextVersion') = 2`).pipe(Effect.orDie)
        if (marked) return yield* Effect.die(new AdmissionError({ code: "missing-private-context" }))
        const expected = cleanRow.request_hash.startsWith("legacy:")
          ? "legacy:" + (yield* Effect.try({
              try: () => legacyReferenceHash(request.references),
              catch: () => conflict(request),
            }))
          : privateRequestIdentity(request)
        if (cleanRow.request_hash !== expected) return yield* conflict(request)
        return
      }
      const expected = privateRow.request_hash.startsWith("legacy:")
        ? "legacy:" + (yield* Effect.try({
            try: () => legacyReferenceHash(request.references),
            catch: () => conflict(request),
          }))
        : privateRequestIdentity(request)
      if (privateRow.request_hash !== expected) return yield* conflict(request)
      if (hash(privateRow.api_content) !== privateRow.api_content_hash || (privateRow.renderer_version !== 1 && privateRow.renderer_version !== 2))
        return yield* Effect.die(new AdmissionError({ code: "invalid-snapshot" }))
      const legacy = yield* database.db.get<{ snapshot_json: string }>(sql`SELECT snapshot_json FROM cm_legacy_input
        WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID}`).pipe(Effect.orDie)
      if (legacy || privateRow.request_hash.startsWith("legacy:")) {
        const admitted = yield* SessionInput.find(database.db, request.messageID)
        if (!admitted || admitted.sessionID !== request.sessionID) return yield* Effect.die(new AdmissionError({ code: "invalid-snapshot" }))
        const context = yield* Effect.try({
          try: () => decodeLegacyContext(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(legacy?.snapshot_json), admitted.prompt.text),
          catch: () => new AdmissionError({ code: "invalid-snapshot" }),
        }).pipe(Effect.orDie)
        const referenceHash = yield* Effect.try({
          try: () => legacyReferenceHash(request.references),
          catch: () => new AdmissionError({ code: "invalid-snapshot" }),
        }).pipe(Effect.orDie)
        if (referenceHash !== context.contextRequestHash || privateRow.api_content !== context.apiContent ||
          privateRow.api_content_hash !== context.apiContentHash || privateRow.renderer_version !== context.rendererVersion) {
          return yield* Effect.die(new AdmissionError({ code: "invalid-snapshot" }))
        }
      }
    })

    const prompt: SessionV2.Interface["prompt"] = (input) => Effect.gen(function* () {
      const session = yield* native.get(input.sessionID)
      if (!(yield* policy.managed(session))) return yield* commitPrompt(input)
      const scope = yield* Effect.serviceOption(PrivatePromptContext)
      if (Option.isNone(scope)) return yield* Effect.die(new AdmissionError({ code: "unauthorized" }))
      const request: AdmissionRequest = {
        sessionID: input.sessionID, messageID: input.id ?? SessionMessage.ID.create(), text: input.prompt.text,
        delivery: input.delivery ?? "steer", resume: input.resume, actor: scope.value.actor, references: scope.value.references,
      }
      if (!request.actor.userID || !request.actor.workspaceID) return yield* Effect.die(new AdmissionError({ code: "unauthorized" }))
      yield* policy.authorize(request).pipe(Effect.orDie)

      const existing = yield* SessionInput.find(database.db, request.messageID)
      if (existing) {
        yield* reconcileStored(request)
        return yield* commitPrompt({ ...input, id: request.messageID }, () => reconcileStored(request))
      }

      const admitPrivate = (mode: Mode | undefined) => Effect.gen(function* () {
        const preparedRequest: AdmissionRequest = mode === undefined ? request : { ...request, mode }
        const frozen = yield* policy.freeze(preparedRequest).pipe(Effect.orDie)
        const snapshot = yield* Effect.try({
          try: () => validateFrozenInput(preparedRequest, frozen),
          catch: () => new AdmissionError({ code: "invalid-snapshot" }),
        }).pipe(Effect.orDie)
        // v1-local-explicit must not silently accept producer recall.
        if (mode === "v1-local-explicit" && hasAutomaticSelection(snapshot))
          return yield* Effect.die(new AdmissionError({ code: "invalid-snapshot" }))
        const operation = commitPrompt({ ...input, id: request.messageID }, (admitted) => Effect.gen(function* () {
          yield* reconcileStored(request)
          // Native projectors run before the event INSERT. Its immediate FK is
          // safe only here, still inside the owning notification/wake boundary.
          yield* recordLegacyInputEvent(admitted.sessionID, admitted.id, admitted.admittedSeq).pipe(
            Effect.provideService(Database.Service, database), Effect.orDie,
          )
          if (policy.onAdmitted) yield* policy.onAdmitted({ request: preparedRequest, admitted, snapshot }).pipe(Effect.orDie)
        }))
        return yield* operation.pipe(Effect.provideService(PreparedInput, { kind: "private", request: preparedRequest, snapshot }))
      })

      const admitClean = Effect.gen(function* () {
        // Explicit references need enrichment a clean-only admission cannot
        // provide. Reject before freeze or any native mutation.
        if (request.references.length > 0) return yield* Effect.die(new AdmissionError({ code: "transfer-unavailable" }))
        const operation = commitPrompt({ ...input, id: request.messageID }, () => reconcileStored(request))
        return yield* operation.pipe(Effect.provideService(PreparedInput, {
          kind: "clean", request, requestHash: privateRequestIdentity(request),
        }))
      })

      if (readinessInput === undefined) return yield* admitPrivate(undefined)
      // Placement is the recorded Session workspace plus the transport proof. The
      // caller actor still only drives authorization and private identity.
      return yield* readinessInput.withPermit(
        { sessionID: request.sessionID, workspaceID: session.location.workspaceID, proof: scope.value.proof },
        (mode) => mode === "v1-clean-only" ? admitClean : admitPrivate(mode),
        boundary.afterTransaction,
      )
    })
    return SessionV2.Service.of({ ...native, create, prompt })
  })).pipe(Layer.provide(nativeLayer))

  return makeGlobalNode({
    service: SessionV2.Service,
    layer,
    deps: [Database.node, EventV2.node, ProjectV2.node, SessionExecution.node, SessionStore.node, LocationServiceMap.node, SessionProjector.node, boundary],
  })
}

// Explicit v1-local context may only carry operator-selected capsules. A producer
// that silently ran automatic recall must not have that recall persisted.
function hasAutomaticSelection(snapshot: FrozenInput): boolean {
  const context = snapshot.context
  if (context === undefined) return false
  const attachments = context.attachments
  if (!isJsonArray(attachments)) return false
  return attachments.some((attachment) => isAutomaticSelection(attachment))
}

function isJsonArray(value: LegacyJson): value is readonly LegacyJson[] {
  return Array.isArray(value)
}

function isAutomaticSelection(attachment: LegacyJson): boolean {
  return typeof attachment === "object" && attachment !== null && !isJsonArray(attachment) &&
    attachment.selection === "automatic"
}
