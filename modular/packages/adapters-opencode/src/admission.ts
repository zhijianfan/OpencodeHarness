import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary } from "./event-boundary"
import { decodeLegacyContext, legacyReferenceHash, type LegacyJsonObject } from "./legacy-context"

export type AdmissionRequest = {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly actor: { readonly userID: string; readonly workspaceID: string }
  readonly text: string
  readonly delivery: "steer" | "queue"
  readonly resume?: boolean
  readonly references: readonly { readonly id: string; readonly contentHash: string }[]
}

export class AdmissionError extends Schema.TaggedErrorClass<AdmissionError>()("CyberMastery.Admission", {
  code: Schema.Literals(["unauthorized", "conflict", "missing-private-context", "invalid-snapshot"]),
}) {}

export type FrozenInput = {
  readonly apiContent: string
  readonly rendererVersion: number
  /** Complete original private producer snapshot, not raw request attachments. */
  readonly context?: LegacyJsonObject
}

export type AdmissionPolicy = {
  readonly authorize: (request: AdmissionRequest) => Effect.Effect<void, AdmissionError>
  readonly freeze: (request: AdmissionRequest) => Effect.Effect<FrozenInput, AdmissionError>
}

type Stored = {
  readonly request_hash: string
  readonly api_content: string
  readonly api_content_hash: string
  readonly renderer_version: number
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Validate and detach the private producer's snapshot before entering admission. */
export function validateFrozenInput(request: AdmissionRequest, snapshot: FrozenInput): FrozenInput {
  if (snapshot.rendererVersion !== 1 && snapshot.rendererVersion !== 2)
    throw new AdmissionError({ code: "invalid-snapshot" })
  if (snapshot.context === undefined) return { apiContent: snapshot.apiContent, rendererVersion: snapshot.rendererVersion }
  const context = decodeLegacyContext(snapshot.context, request.text)
  if (context.apiContent !== snapshot.apiContent || context.apiContentHash !== digest(snapshot.apiContent) ||
    context.rendererVersion !== snapshot.rendererVersion || context.contextRequestHash !== legacyReferenceHash(request.references))
    throw new AdmissionError({ code: "invalid-snapshot" })
  return { apiContent: context.apiContent, rendererVersion: context.rendererVersion, context: context.snapshot }
}

export const privateRequestIdentity = (request: AdmissionRequest) => digest(JSON.stringify({
  sessionID: request.sessionID,
  actor: { userID: request.actor.userID, workspaceID: request.actor.workspaceID },
  text: request.text,
  delivery: request.delivery,
  references: request.references.map((reference) => ({ id: reference.id, contentHash: reference.contentHash })),
}))

/**
 * Explicit external admission facade around the native helper. This does not
 * intercept stock SessionV2.prompt or provide native provider reconstruction;
 * the production gate must remain closed until those integrations are proven.
 * This low-level proof path retains its original table dependencies. Full
 * snapshot persistence and compatibility metadata belong to the managed
 * native Session facade, not this standalone proof helper.
 */
export const admit = Effect.fn("CyberMastery.admit")(function* (
  request: AdmissionRequest,
  policy: AdmissionPolicy,
  wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>,
) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const boundary = yield* Effect.serviceOption(EventBoundary)
  const schedule = () => Option.isSome(boundary) ? boundary.value.afterCommit(wake(request.sessionID)) : wake(request.sessionID)
  if (!request.actor.userID || !request.actor.workspaceID) return yield* new AdmissionError({ code: "unauthorized" })
  yield* policy.authorize(request)
  const requestHash = privateRequestIdentity(request)
  const stored = () => database.db.get<Stored>(sql`SELECT request_hash, api_content, api_content_hash, renderer_version
    FROM cm_private_input WHERE message_id = ${request.messageID} AND session_id = ${request.sessionID}`)
  const validate = (row: Stored | undefined) => {
    if (!row) return Effect.fail(new AdmissionError({ code: "missing-private-context" }))
    if (row.request_hash !== requestHash) return Effect.fail(new AdmissionError({ code: "conflict" }))
    if (digest(row.api_content) !== row.api_content_hash) return Effect.fail(new AdmissionError({ code: "invalid-snapshot" }))
    return Effect.void
  }
  const expected = { sessionID: request.sessionID, prompt: { text: request.text }, delivery: request.delivery }
  const existing = yield* SessionInput.find(database.db, request.messageID)
  if (existing) {
    if (!SessionInput.equivalent(existing, expected)) return yield* new AdmissionError({ code: "conflict" })
    yield* validate(yield* stored())
    if (request.resume !== false) yield* schedule()
    return existing
  }
  const snapshot = yield* policy.freeze(request)
  if (snapshot.rendererVersion !== 1 && snapshot.rendererVersion !== 2) {
    return yield* new AdmissionError({ code: "invalid-snapshot" })
  }
  const delegated: EventV2.Interface = {
    ...events,
    publish: (definition, data, options) => {
      if (definition.type !== SessionEvent.PromptAdmitted.type) return Effect.die("Unexpected admission event")
      return events.publish(definition, data, {
        ...options,
        commit: (sequence) => Effect.gen(function* () {
          yield* policy.authorize(request)
          if (options?.commit) yield* options.commit(sequence)
          yield* database.db.run(sql`INSERT INTO cm_private_input
            (message_id, session_id, request_hash, api_content, api_content_hash, renderer_version)
            VALUES (${request.messageID}, ${request.sessionID}, ${requestHash}, ${snapshot.apiContent},
              ${digest(snapshot.apiContent)}, ${snapshot.rendererVersion})`).pipe(Effect.orDie)
          yield* database.db.run(sql`INSERT INTO cm_private_requirement (message_id, session_id, kind)
            VALUES (${request.messageID}, ${request.sessionID}, 'input')`).pipe(Effect.orDie)
        }).pipe(Effect.orDie),
      })
    },
  }
  const result = yield* SessionInput.admit(database.db, delegated, { id: request.messageID, ...expected })
  if (!SessionInput.equivalent(result, expected)) return yield* new AdmissionError({ code: "conflict" })
  yield* validate(yield* stored())
  if (request.resume !== false) yield* schedule()
  return result
})
