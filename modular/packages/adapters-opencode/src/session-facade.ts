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
import { Context, Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"
import { AdmissionError, privateRequestIdentity, type AdmissionPolicy, type AdmissionRequest } from "./admission"
import { EventBoundary, EventReplayScope, type makeEventBoundaryNode } from "./event-boundary"
import { PrivateRestoreContext } from "./restore-context"

export type PrivatePromptRequest = Pick<AdmissionRequest, "actor" | "references">
export class PrivatePromptContext extends Context.Service<PrivatePromptContext, PrivatePromptRequest>()("@cybermastery/PrivatePromptContext") {}
class PreparedInput extends Context.Service<PreparedInput, {
  readonly request: AdmissionRequest
  readonly snapshot: { readonly apiContent: string; readonly rendererVersion: number }
}>()("@cybermastery/PreparedPrivateInput") {}

export type SessionAdmissionPolicy = AdmissionPolicy & {
  /** Must be a local policy/binding lookup; also called by the atomic projector guard. */
  readonly managed: (session: SessionSchema.Info) => Effect.Effect<boolean>
}

type NativeRequirements = Database.Service | EventV2.Service | ProjectV2.Service | SessionExecution.Service | SessionStore.Service | LocationServiceMap.Service

/**
 * Explicit Session service decoration. The native constructor and every method
 * except prompt are delegated; MIME normalization and retry reconciliation stay native.
 */
export function makeSessionFacadeNode(boundary: ReturnType<typeof makeEventBoundaryNode>, policy: SessionAdmissionPolicy) {
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
    const hash = (value: string) => createHash("sha256").update(value).digest("hex")
    const commitPrompt = (
      input: Parameters<SessionV2.Interface["prompt"]>[0],
      validate: Effect.Effect<void, SessionV2.PromptConflictError> = Effect.void,
    ) => boundary.transaction(Effect.gen(function* () {
      const admitted = yield* native.prompt({ ...input, resume: false })
      yield* validate
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
      const request = prepared.value.request
      if (request.sessionID !== event.data.sessionID || request.messageID !== event.data.messageID || request.text !== event.data.prompt.text || request.delivery !== event.data.delivery) {
        return yield* Effect.die(new AdmissionError({ code: "conflict" }))
      }
      const session = yield* native.get(request.sessionID).pipe(Effect.orDie)
      if (!(yield* policy.managed(session))) return yield* Effect.die(new AdmissionError({ code: "conflict" }))
      yield* policy.authorize(request).pipe(Effect.orDie)
      const snapshot = prepared.value.snapshot
      yield* database.db.run(sql`INSERT INTO cm_private_input
        (message_id, session_id, request_hash, api_content, api_content_hash, renderer_version)
        VALUES (${request.messageID}, ${request.sessionID}, ${privateRequestIdentity(request)},
          ${snapshot.apiContent}, ${hash(snapshot.apiContent)}, ${snapshot.rendererVersion})`).pipe(Effect.orDie)
      yield* database.db.run(sql`INSERT INTO cm_private_requirement (message_id, session_id, kind)
        VALUES (${request.messageID}, ${request.sessionID}, 'input')`).pipe(Effect.orDie)
    }))

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
      const validateStored = Effect.gen(function* () {
        const row = yield* database.db.get<{ request_hash: string; api_content: string; api_content_hash: string }>(sql`
          SELECT request_hash, api_content, api_content_hash FROM cm_private_input
          WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID}`).pipe(Effect.orDie)
        if (!row) return yield* Effect.die(new AdmissionError({ code: "missing-private-context" }))
        if (row.request_hash !== privateRequestIdentity(request)) return yield* new SessionV2.PromptConflictError({ sessionID: request.sessionID, messageID: request.messageID })
        if (hash(row.api_content) !== row.api_content_hash) return yield* Effect.die(new AdmissionError({ code: "invalid-snapshot" }))
      })
      if (existing) yield* validateStored
      const snapshot = existing ? undefined : yield* policy.freeze(request).pipe(Effect.orDie)
      if (snapshot && snapshot.rendererVersion !== 1) return yield* Effect.die(new AdmissionError({ code: "invalid-snapshot" }))

      const operation = commitPrompt({ ...input, id: request.messageID }, validateStored)
      return yield* snapshot ? operation.pipe(Effect.provideService(PreparedInput, { request, snapshot })) : operation
    })
    return SessionV2.Service.of({ ...native, prompt })
  })).pipe(Layer.provide(nativeLayer))

  return makeGlobalNode({
    service: SessionV2.Service,
    layer,
    deps: [Database.node, EventV2.node, ProjectV2.node, SessionExecution.node, SessionStore.node, LocationServiceMap.node, SessionProjector.node, boundary],
  })
}
