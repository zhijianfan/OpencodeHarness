import { Location } from "@opencode-ai/core/location"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Revert } from "@opencode-ai/schema/revert"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import {
  ConflictError,
  ForbiddenError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  UnknownError,
} from "@opencode-ai/protocol/errors"
import { SessionMessagesQuery } from "@opencode-ai/protocol/groups/message"
import { SessionHistoryQuery, SessionsCursor, SessionsQuery } from "@opencode-ai/protocol/groups/session"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import { isContextAttachments, makeSessionAccess, type SessionAccessPolicy, type SessionActor } from "./session-access"
import type { createSessionRuntime } from "./session-runtime"
import { AdmissionError } from "./admission"
import { makeRequestProof } from "./transfer-readiness"

const Create = Schema.Struct({
  id: Schema.optional(SessionSchema.ID),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
  location: Schema.optional(Location.Ref),
})
const Prompt = Schema.Struct({
  id: Schema.optional(SessionMessage.ID),
  prompt: PromptInput.Prompt,
  delivery: Schema.optional(SessionInput.Delivery),
  resume: Schema.optional(Schema.Boolean),
  contextAttachments: Schema.optional(Schema.Unknown),
})
const SwitchAgent = Schema.Struct({ agent: Agent.ID })
const SwitchModel = Schema.Struct({ model: Model.Ref })
const Stage = Schema.Struct({ messageID: SessionMessage.ID, files: Schema.optional(Schema.Boolean) })
const MessageCursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Literals(["asc", "desc"]),
  direction: Schema.Literals(["previous", "next"]),
})
const encodeInfo = Schema.encodeSync(SessionSchema.Info)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const encodeEvent = Schema.encodeSync(SessionEvent.Durable)
const encodeAdmitted = Schema.encodeSync(SessionInput.Admitted)
const encodeRevert = Schema.encodeSync(Revert.State)

class SessionContextAttachmentError extends Schema.TaggedErrorClass<SessionContextAttachmentError>()(
  "SessionContextAttachmentError",
  { message: Schema.String, code: Schema.String },
) {}

class MethodNotAllowed extends Error {
  constructor(readonly allow: string) {
    super("Method not allowed")
  }
}

/** Owns HTTP subscriptions only; the selected Session graph belongs to the host. */
export async function createSessionHttp(input: {
  readonly runtime: Pick<ReturnType<typeof createSessionRuntime>, "runPromise" | "runFork">
  readonly policy: SessionAccessPolicy
  readonly defaultLocation: Location.Ref
  readonly authenticate: (request: Request) => Promise<SessionActor | undefined>
}) {
  const access = await input.runtime.runPromise(makeSessionAccess(input.policy))
  const streams = new Set<{ stop: () => void; done: Promise<void> }>()
  const lifecycle = { disposed: false }

  return {
    async fetch(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      const native = url.pathname === "/api/session" || url.pathname.startsWith("/api/session/")
      const extension = url.pathname === "/api/cybermastery/session" || url.pathname.startsWith("/api/cybermastery/session/")
      if (!native && !extension) return undefined

      // Resolve failures inside the Effect so typed errors never become opaque
      // FiberFailure rejections. Abort still interrupts this request's fiber.
      async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
        const result = await input.runtime.runPromise(effect.pipe(
          Effect.catchDefect((error) => error instanceof AdmissionError ? Effect.fail(error) : Effect.die(error)),
          Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        })), { signal: request.signal })
        if (!result.ok) throw result.error
        return result.value
      }

      try {
        const actor = await input.authenticate(request)
        if (!actor || !actor.userID.trim() || !actor.workspaceID.trim()) {
          throw new UnauthorizedError({ message: "Authentication required" })
        }
        if (request.signal.aborted) throw request.signal.reason
        if (lifecycle.disposed) throw new ServiceUnavailableError({ message: "Session ingress is disposed", service: "session.http" })
        const parts = url.pathname.slice(extension ? "/api/cybermastery/session".length : "/api/session".length)
          .split("/").slice(1).map(decodeURIComponent)
        const path = parts.slice(1).join("/")
        const query = Object.fromEntries(url.searchParams)
        const method = (expected: string) => {
          if (request.method !== expected) throw new MethodNotAllowed(expected)
        }
        const body = async () => {
          const mime = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
          if (mime !== "application/json") throw new InvalidRequestError({ message: "Expected application/json" })
          return required(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(await request.text()))
        }

        if (native && parts.length === 0) {
          if (request.method === "POST") {
            const payload = required(Schema.decodeUnknownOption(Create)(await body()))
            return Response.json({ data: encodeInfo(await run(access.create(actor, {
              ...payload, location: payload.location ?? input.defaultLocation,
            }))) })
          }
          if (request.method !== "GET") throw new MethodNotAllowed("GET, POST")
          const decoded = required(Schema.decodeUnknownOption(SessionsQuery)(query))
          const page = decoded.cursor === undefined ? decoded : await run(SessionsCursor.parse(decoded.cursor).pipe(
            Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
          ))
          const sessions = await run(access.list(actor, { ...page, workspaceID: page.workspace, limit: decoded.limit ?? 50 }))
          const first = sessions[0]
          const last = sessions.at(-1)
          return Response.json({
            data: sessions.map((info) => encodeInfo(info)),
            cursor: {
              previous: first ? SessionsCursor.make({ ...page, anchor: {
                id: first.id, time: DateTime.toEpochMillis(first.time.created), direction: "previous",
              } }) : undefined,
              next: last ? SessionsCursor.make({ ...page, anchor: {
                id: last.id, time: DateTime.toEpochMillis(last.time.created), direction: "next",
              } }) : undefined,
            },
          })
        }
        if (native && parts.length === 1 && parts[0] === "active") {
          method("GET")
          return Response.json({ data: Object.fromEntries(Array.from(await run(access.active(actor)), (id) => [id, { type: "running" }])) })
        }

        const reads = ["", "context", "history", "message", "event"]
        const writes = ["prompt", "agent", "model", "interrupt", "revert/stage", "revert/clear", "revert/commit", "compact", "wait"]
        const singleMessage = parts.length === 3 && parts[1] === "message"
        if (extension ? parts.length !== 2 || path !== "resume" :
          parts.length === 0 || (!reads.includes(path) && !writes.includes(path) && !singleMessage)) {
          return new Response(null, { status: 404 })
        }
        method(extension || writes.includes(path) ? "POST" : "GET")
        const sessionID = required(Schema.decodeUnknownOption(SessionSchema.ID)(parts[0]))
        if (extension) {
          await run(access.resume(actor, sessionID))
          return new Response(null, { status: 204 })
        }
        if (singleMessage) {
          const messageID = required(Schema.decodeUnknownOption(SessionMessage.ID)(parts[2]))
          const message = await run(access.message(actor, { sessionID, messageID }))
          if (!message) throw new MessageNotFoundError({ sessionID, messageID, message: `Message not found: ${messageID}` })
          return Response.json({ data: encodeMessage(message) })
        }
        if (path === "") return Response.json({ data: encodeInfo(await run(access.get(actor, sessionID))) })
        if (path === "prompt") {
          const payload = required(Schema.decodeUnknownOption(Prompt)(await body()))
          const attachments = payload.contextAttachments
          if (attachments !== undefined && !isContextAttachments(attachments)) throw attachmentError()
          // Readiness proof is transport-only. Never accept a proof or actor
          // shape from the request body, and a partial pair grants nothing.
          const topologyRevision = request.headers.get("x-opencode-session-context-topology")
          const requestToken = request.headers.get("x-opencode-session-context-lease")
          const contextTransferProof = topologyRevision !== null && requestToken !== null
            ? makeRequestProof({ topologyRevision, requestToken })
            : undefined
          return Response.json({ data: encodeAdmitted(await run(access.prompt(actor, {
            sessionID, id: payload.id, prompt: payload.prompt, delivery: payload.delivery, resume: payload.resume,
            contextAttachments: attachments, contextTransferProof,
          }))) })
        }
        if (path === "agent") {
          const payload = required(Schema.decodeUnknownOption(SwitchAgent)(await body()))
          await run(access.switchAgent(actor, { sessionID, ...payload }))
          return new Response(null, { status: 204 })
        }
        if (path === "model") {
          const payload = required(Schema.decodeUnknownOption(SwitchModel)(await body()))
          await run(access.switchModel(actor, { sessionID, ...payload }))
          return new Response(null, { status: 204 })
        }
        if (path === "interrupt") {
          await run(access.interrupt(actor, sessionID))
          return new Response(null, { status: 204 })
        }
        if (path === "revert/stage") {
          const payload = required(Schema.decodeUnknownOption(Stage)(await body()))
          return Response.json({ data: encodeRevert(await run(access.revertStage(actor, { sessionID, ...payload }))) })
        }
        if (path === "revert/clear" || path === "revert/commit") {
          await run(path === "revert/clear" ? access.revertClear(actor, sessionID) : access.revertCommit(actor, sessionID))
          return new Response(null, { status: 204 })
        }
        if (path === "compact" || path === "wait") {
          await run(access.get(actor, sessionID))
          throw new ServiceUnavailableError({ message: `Session ${path} is not available yet`, service: `session.${path}` })
        }
        if (path === "context") return Response.json({ data: (await run(access.context(actor, sessionID))).map((message) => encodeMessage(message)) })
        if (path === "history") {
          const decoded = required(Schema.decodeUnknownOption(SessionHistoryQuery)(query))
          const page = await run(access.history(actor, { sessionID, after: decoded.after, limit: decoded.limit ?? 50 }))
          return Response.json({ data: page.events.map((event) => encodeEvent(event)), hasMore: page.hasMore })
        }
        if (path === "message") {
          const decoded = required(Schema.decodeUnknownOption(SessionMessagesQuery)(query))
          if (decoded.cursor && decoded.order !== undefined) throw new InvalidCursorError({ message: "Cursor cannot be combined with order" })
          const cursor = decoded.cursor ? required(Schema.decodeUnknownOption(Schema.fromJsonString(MessageCursor))(
            Buffer.from(decoded.cursor, "base64url").toString("utf8"),
          ), true) : undefined
          const order = cursor?.order ?? decoded.order ?? "desc"
          const messages = await run(access.messages(actor, { sessionID, order, limit: decoded.limit ?? 50,
            cursor: cursor ? { id: cursor.id, direction: cursor.direction } : undefined,
          }))
          const first = messages[0]
          const last = messages.at(-1)
          return Response.json({ data: messages.map((message) => encodeMessage(message)), cursor: {
            previous: first ? Buffer.from(JSON.stringify({ id: first.id, order, direction: "previous" })).toString("base64url") : undefined,
            next: last ? Buffer.from(JSON.stringify({ id: last.id, order, direction: "next" })).toString("base64url") : undefined,
          } })
        }
        if (path === "event") {
          const decoded = required(Schema.decodeUnknownOption(SessionHistoryQuery)({ after: query.after }))
          await run(access.get(actor, sessionID))
          return openEvents(request, access.events(actor, { sessionID, after: decoded.after }))
        }
        return new Response(null, { status: 404 })
      } catch (error) {
        if (request.signal.aborted) throw error
        return errorResponse(error)
      }
    },
    async dispose(): Promise<void> {
      lifecycle.disposed = true
      const owned = Array.from(streams)
      owned.forEach((stream) => stream.stop())
      await Promise.all(owned.map((stream) => stream.done))
    },
  }

  function openEvents<E>(request: Request, events: Stream.Stream<typeof SessionEvent.Durable.Type, E>): Response {
    const abort = new AbortController()
    const state: {
      closed: boolean
      controller?: ReadableStreamDefaultController<Uint8Array>
      release?: () => void
    } = { closed: false }
    const close = () => {
      if (state.closed) return
      state.closed = true
      state.controller?.close()
    }
    const owned = {
      stop: () => {
        abort.abort()
        state.release?.()
        state.release = undefined
        close()
      },
      done: Promise.resolve(),
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) { state.controller = controller },
      pull() {
        state.release?.()
        state.release = undefined
      },
      cancel() {
        state.closed = true
        owned.stop()
        return owned.done
      },
    }, { highWaterMark: 1 })
    request.signal.addEventListener("abort", owned.stop, { once: true })
    streams.add(owned)
    if (request.signal.aborted || lifecycle.disposed) owned.stop()
    // No speculative handshake: only the subscribed durable source can emit
    // frames. Demand bounds the transport to one queued frame plus one in flight.
    owned.done = input.runtime.runPromise(events.pipe(Stream.runForEach((event) => Effect.gen(function* () {
      if ((state.controller?.desiredSize ?? 0) <= 0 && !state.closed) {
        yield* Effect.tryPromise({
          try: () => new Promise<void>((resolve) => {
            // Demand/abort may change while this fiber yields before installing
            // its waiter. Recheck here so a completed pull cannot be lost.
            if (state.closed || (state.controller?.desiredSize ?? 0) > 0) return resolve()
            state.release = resolve
          }),
          catch: () => new UnknownError({ message: "Session event stream closed" }),
        })
      }
      if (state.closed) return
      state.controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`))
    }))), { signal: abort.signal }).then(close, () => {
      if (state.closed) return
      state.closed = true
      // Stream failures must not serialize provider failures or private context.
      state.controller?.error(new Error("Session event stream closed"))
    }).finally(() => {
      request.signal.removeEventListener("abort", owned.stop)
      state.release?.()
      state.release = undefined
      streams.delete(owned)
    })
    return new Response(body, { headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    } })
  }
}

function required<A>(value: Option.Option<A>, cursor = false): A {
  if (Option.isSome(value)) return value.value
  if (cursor) throw new InvalidCursorError({ message: "Invalid cursor" })
  throw new InvalidRequestError({ message: "Invalid request" })
}

function attachmentError(code = "invalid-attachments") {
  return new SessionContextAttachmentError({ message: `Context attachment admission failed: ${code}`, code })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorResponse(error: unknown): Response {
  if (error instanceof AdmissionError) return errorResponse(attachmentError(error.code))
  if (error instanceof MethodNotAllowed) return new Response(null, { status: 405, headers: { Allow: error.allow } })
  if (error instanceof URIError) return errorResponse(new InvalidRequestError({ message: "Invalid request" }))
  if (error instanceof InvalidRequestError) return Response.json(Schema.encodeSync(InvalidRequestError)(error), { status: 400 })
  if (error instanceof InvalidCursorError) return Response.json(Schema.encodeSync(InvalidCursorError)(error), { status: 400 })
  if (error instanceof SessionContextAttachmentError) return Response.json(Schema.encodeSync(SessionContextAttachmentError)(error), { status: 400 })
  if (error instanceof UnauthorizedError) return Response.json(Schema.encodeSync(UnauthorizedError)(error), { status: 401 })
  if (error instanceof ForbiddenError) return Response.json(Schema.encodeSync(ForbiddenError)(error), { status: 403 })
  if (error instanceof SessionNotFoundError) return Response.json(Schema.encodeSync(SessionNotFoundError)(error), { status: 404 })
  if (error instanceof MessageNotFoundError) return Response.json(Schema.encodeSync(MessageNotFoundError)(error), { status: 404 })
  if (error instanceof ConflictError) return Response.json(Schema.encodeSync(ConflictError)(error), { status: 409 })
  if (error instanceof ServiceUnavailableError) return Response.json(Schema.encodeSync(ServiceUnavailableError)(error), { status: 503 })
  if (record(error)) {
    if (error._tag === "CyberMastery.SessionAccess") {
      if (error.code === "unauthorized") return errorResponse(new UnauthorizedError({ message: "Authentication required" }))
      if (error.code === "forbidden") return errorResponse(new ForbiddenError({ message: "Session access denied" }))
      if (error.code === "invalid-attachments") return errorResponse(attachmentError())
    }
    if (error._tag === "Session.NotFoundError" && typeof error.sessionID === "string") {
      return errorResponse(new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` }))
    }
    if (error._tag === "Session.MessageNotFoundError" && typeof error.sessionID === "string" && typeof error.messageID === "string") {
      return errorResponse(new MessageNotFoundError({ sessionID: error.sessionID, messageID: error.messageID, message: `Message not found: ${error.messageID}` }))
    }
    if (error._tag === "Session.PromptConflictError" && typeof error.messageID === "string") {
      return errorResponse(new ConflictError({ resource: error.messageID, message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}` }))
    }
  }
  return Response.json(Schema.encodeSync(UnknownError)(new UnknownError({ message: "Unexpected server error. Check server logs for details." })), { status: 500 })
}
