import { Location } from "@opencode-ai/core/location"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Effect, Schema, Stream } from "effect"
import { PrivatePromptContext } from "./session-facade"
import type { RequestProof } from "./transfer-readiness"

export type SessionActor = { readonly userID: string; readonly workspaceID: string }
export type ContextAttachment = {
  readonly contextCapsuleID: string
  readonly label: string
  readonly contentHash: string
  readonly source: { readonly kind: "ctxpack"; readonly ctxPackID: string }
}
export type SessionAction = "create" | "read" | "prompt" | "resume" | "interrupt" | "configure" | "revert"

export class SessionAccessError extends Schema.TaggedErrorClass<SessionAccessError>()("CyberMastery.SessionAccess", {
  code: Schema.Literals(["unauthorized", "forbidden", "invalid-attachments"]),
}) {}

export type SessionAccessPolicy = {
  readonly authorize: (input: {
    readonly actor: SessionActor
    readonly action: SessionAction
    readonly location: Location.Ref
    readonly session?: SessionSchema.Info
  }) => Effect.Effect<void, SessionAccessError>
}

/** Captures the selected graph's Session service; callers supply authenticated actors. */
export const makeSessionAccess = Effect.fn("SessionAccess.make")(function* (policy: SessionAccessPolicy) {
  const session = yield* SessionV2.Service
  const requireActor = (actor: SessionActor) => Effect.gen(function* () {
    if (!nonempty(actor.userID) || !nonempty(actor.workspaceID)) {
      return yield* new SessionAccessError({ code: "unauthorized" })
    }
  })
  const authorize = (actor: SessionActor, action: SessionAction, info: SessionSchema.Info) =>
    policy.authorize({ actor, action, location: info.location, session: info })
  const existing = (actor: SessionActor, action: SessionAction, sessionID: SessionSchema.ID) => Effect.gen(function* () {
    yield* requireActor(actor)
    const info = yield* session.get(sessionID)
    yield* authorize(actor, action, info)
    return info
  })
  const withSession = <A, E, R>(
    actor: SessionActor,
    action: SessionAction,
    sessionID: SessionSchema.ID,
    operation: () => Effect.Effect<A, E, R>,
  ) => existing(actor, action, sessionID).pipe(Effect.flatMap(operation))
  const readable = (actor: SessionActor, info: SessionSchema.Info) => authorize(actor, "read", info).pipe(
    Effect.as(true),
    Effect.catchTag("CyberMastery.SessionAccess", (error) => error.code === "forbidden"
      ? Effect.succeed(false)
      : Effect.fail(error)),
  )

  return {
    create: (actor: SessionActor, input: Parameters<SessionV2.Interface["create"]>[0]) => Effect.gen(function* () {
      yield* requireActor(actor)
      yield* policy.authorize({ actor, action: "create", location: input.location })
      if (input.id !== undefined) {
        // Native create adopts recorded placement, regardless of the requested location.
        const recorded = yield* session.get(input.id).pipe(
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
        )
        if (recorded) yield* authorize(actor, "create", recorded)
      }
      const created = yield* session.create(input)
      // Also covers a concurrent creator winning the native projection race.
      return yield* existing(actor, "create", created.id)
    }),
    get: (actor: SessionActor, sessionID: SessionSchema.ID) => existing(actor, "read", sessionID),
    context: (actor: SessionActor, sessionID: SessionSchema.ID) =>
      withSession(actor, "read", sessionID, () => session.context(sessionID)),
    messages: (actor: SessionActor, input: Parameters<SessionV2.Interface["messages"]>[0]) =>
      withSession(actor, "read", input.sessionID, () => session.messages(input)),
    message: (actor: SessionActor, input: Parameters<SessionV2.Interface["message"]>[0]) =>
      withSession(actor, "read", input.sessionID, () => session.message(input)),
    history: (actor: SessionActor, input: Parameters<SessionV2.Interface["history"]>[0]) =>
      withSession(actor, "read", input.sessionID, () => session.history(input)),
    list: (actor: SessionActor, input: Parameters<SessionV2.Interface["list"]>[0] = {}) => Effect.gen(function* () {
      yield* requireActor(actor)
      const candidates = yield* session.list(input)
      const visible = yield* Effect.forEach(candidates, (info) => readable(actor, info).pipe(
        Effect.map((allowed) => allowed ? [info] : []),
      ))
      return visible.flat()
    }),
    active: (actor: SessionActor) => Effect.gen(function* () {
      yield* requireActor(actor)
      const candidates = yield* session.active
      const visible = yield* Effect.forEach(candidates, (sessionID) => Effect.gen(function* () {
        const info = yield* session.get(sessionID)
        return (yield* readable(actor, info)) ? [sessionID] : []
      }))
      return new Set(visible.flat())
    }),
    prompt: (actor: SessionActor, input: Parameters<SessionV2.Interface["prompt"]>[0] & {
      readonly contextAttachments?: readonly ContextAttachment[]
      readonly contextTransferProof?: RequestProof
    }) => Effect.gen(function* () {
      yield* requireActor(actor)
      const attachments = input.contextAttachments === undefined ? [] : input.contextAttachments
      if (!isContextAttachments(attachments)) return yield* new SessionAccessError({ code: "invalid-attachments" })
      yield* existing(actor, "prompt", input.sessionID)
      const { contextAttachments, contextTransferProof, ...nativeInput } = input
      return yield* session.prompt(nativeInput).pipe(Effect.provideService(PrivatePromptContext, {
        actor,
        references: attachments.map((attachment) => ({
          id: JSON.stringify({
            contextCapsuleID: attachment.contextCapsuleID,
            sourceCtxPackID: attachment.source.ctxPackID,
            label: attachment.label,
          }),
          contentHash: attachment.contentHash,
        })),
        proof: contextTransferProof,
      }))
    }),
    resume: (actor: SessionActor, sessionID: SessionSchema.ID) =>
      withSession(actor, "resume", sessionID, () => session.resume(sessionID)),
    interrupt: (actor: SessionActor, sessionID: SessionSchema.ID) =>
      withSession(actor, "interrupt", sessionID, () => session.interrupt(sessionID)),
    switchAgent: (actor: SessionActor, input: Parameters<SessionV2.Interface["switchAgent"]>[0]) =>
      withSession(actor, "configure", input.sessionID, () => session.switchAgent(input)),
    switchModel: (actor: SessionActor, input: Parameters<SessionV2.Interface["switchModel"]>[0]) =>
      withSession(actor, "configure", input.sessionID, () => session.switchModel(input)),
    revertStage: (actor: SessionActor, input: Parameters<SessionV2.Interface["revert"]["stage"]>[0]) =>
      withSession(actor, "revert", input.sessionID, () => session.revert.stage(input)),
    revertClear: (actor: SessionActor, sessionID: SessionSchema.ID) =>
      withSession(actor, "revert", sessionID, () => session.revert.clear(sessionID)),
    revertCommit: (actor: SessionActor, sessionID: SessionSchema.ID) =>
      withSession(actor, "revert", sessionID, () => session.revert.commit(sessionID)),
    events: (actor: SessionActor, input: Parameters<SessionV2.Interface["events"]>[0]) => Stream.unwrap(
      existing(actor, "read", input.sessionID).pipe(Effect.map(() => session.events(input))),
    ).pipe(Stream.mapEffect((event) => existing(actor, "read", input.sessionID).pipe(Effect.as(event)))),
  }
})

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function record(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function array(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** A synchronous boundary: unknown identity fields and private bodies are never stripped. */
export function isContextAttachments(value: unknown): value is readonly ContextAttachment[] {
  if (!array(value) || value.length > 8) return false
  const ids = new Set<string>()
  return Array.from(value).every((attachment) => {
    if (!record(attachment) || Reflect.ownKeys(attachment).some((key) =>
      key !== "contextCapsuleID" && key !== "label" && key !== "contentHash" && key !== "source",
    )) return false
    if (!nonempty(attachment.contextCapsuleID) || !nonempty(attachment.label) || !nonempty(attachment.contentHash)) return false
    if (!record(attachment.source) || Reflect.ownKeys(attachment.source).some((key) => key !== "kind" && key !== "ctxPackID")) return false
    if (attachment.source.kind !== "ctxpack" || !nonempty(attachment.source.ctxPackID) || ids.has(attachment.contextCapsuleID)) return false
    ids.add(attachment.contextCapsuleID)
    return true
  })
}
