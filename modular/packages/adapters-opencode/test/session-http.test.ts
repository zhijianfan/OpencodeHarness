import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, LLMEvent, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { SessionAccessError } from "../src/session-access"
import { createSessionHttp } from "../src/session-http"
import { createSessionRuntime } from "../src/session-runtime"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const InfoResponse = Schema.Struct({ data: Session.Info })
const AdmittedResponse = Schema.Struct({ data: SessionInput.Admitted })
const MessagesResponse = Schema.Struct({
  data: Schema.Array(SessionMessage.Message),
  cursor: Schema.Struct({ previous: Schema.optional(Schema.String), next: Schema.optional(Schema.String) }),
})
const SessionsResponse = Schema.Struct({
  data: Schema.Array(Session.Info),
  cursor: Schema.Struct({ previous: Schema.optional(Schema.String), next: Schema.optional(Schema.String) }),
})
const HistoryResponse = Schema.Struct({ data: Schema.Array(SessionEvent.Durable), hasMore: Schema.Boolean })
const ErrorResponse = Schema.Struct({ _tag: Schema.String, message: Schema.String })

function completedResponse() {
  return Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text: "public answer" }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])
}

async function withHttp(
  run: (fixture: {
    runtime: ReturnType<typeof createSessionRuntime>
    http: Awaited<ReturnType<typeof createSessionHttp>>
    location: { directory: AbsolutePath; workspaceID: WorkspaceV2.ID }
    otherLocation: { directory: AbsolutePath; workspaceID: WorkspaceV2.ID }
    state: { calls: number; frozen: number; denied: boolean; invalidContext: boolean }
    request: (path: string, options?: {
      method?: string; body?: unknown; actor?: "a" | "b" | false; signal?: AbortSignal
    }) => Promise<Response>
  }) => Promise<void>,
  response: () => ReturnType<typeof completedResponse> = completedResponse,
) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-session-http-"))
  cleanup(directory)
  const location = { directory: AbsolutePath.make(join(directory, "a")), workspaceID: WorkspaceV2.ID.make("wrk_http_a") }
  const otherLocation = { directory: AbsolutePath.make(join(directory, "b")), workspaceID: WorkspaceV2.ID.make("wrk_http_b") }
  await Promise.all([mkdir(location.directory), mkdir(otherLocation.directory)])
  const state = { calls: 0, frozen: 0, denied: false, invalidContext: false }
  const model = Model.make({ id: "http-model", provider: "proof", route })
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    policy: {
      managed: () => Effect.succeed(true),
      authorize: () => Effect.void,
      freeze: () => Effect.sync(() => {
        state.frozen++
        return { apiContent: "PRIVATE_ONLY_DO_NOT_SERIALIZE", rendererVersion: state.invalidContext ? 99 : 1 }
      }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, {
        stream: () => {
          state.calls++
          return response()
        },
      })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  try {
    const http = await createSessionHttp({
      runtime,
      defaultLocation: location,
      authenticate: async (request) => {
        if (request.headers.get("Authorization") === "Bearer a") return { userID: "user-a", workspaceID: location.workspaceID }
        if (request.headers.get("Authorization") === "Bearer b") return { userID: "user-b", workspaceID: otherLocation.workspaceID }
        return undefined
      },
      policy: {
        authorize: (input) => input.actor.workspaceID === input.location.workspaceID && !state.denied
          ? Effect.void : Effect.fail(new SessionAccessError({ code: "forbidden" })),
      },
    })
    try {
      await run({
        runtime, http, location, otherLocation, state,
        request: async (path, options = {}) => {
          const headers = new Headers()
          if (options.actor !== false) headers.set("Authorization", `Bearer ${options.actor ?? "a"}`)
          if (options.body !== undefined) headers.set("Content-Type", "application/json")
          const result = await http.fetch(new Request(`http://localhost${path}`, {
            method: options.method ?? "GET", headers, signal: options.signal,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
          }))
          if (!result) throw new Error("Session ingress unexpectedly declined its route")
          return result
        },
      })
    } finally {
      await http.dispose()
    }
  } finally {
    await runtime.dispose()
  }
}

async function json(response: Response): Promise<unknown> {
  return response.json()
}

test("Session ingress owns its prefixes and requires external authentication, including unknown routes and SSE", async () => {
  await withHttp(async ({ http, request }) => {
    expect(await http.fetch(new Request("http://localhost/api/session-other"))).toBeUndefined()
    expect(await http.fetch(new Request("http://localhost/api/cybermastery/other"))).toBeUndefined()
    for (const path of ["/api/session", "/api/session/unknown/route", "/api/session/ses_missing/event", "/api/cybermastery/session/ses_missing/resume"]) {
      const result = await request(path, { actor: false })
      expect(result.status).toBe(401)
      expect(Schema.decodeUnknownSync(ErrorResponse)(await json(result))._tag).toBe("UnauthorizedError")
    }
    const spoofed = await request("/api/session?userID=user-a&workspaceID=wrk_http_a", {
      method: "POST", actor: false, body: { actor: { userID: "user-a", workspaceID: "wrk_http_a" } },
    })
    expect(spoofed.status).toBe(401)
    expect((await request("/api/session/unknown/route")).status).toBe(404)
    expect((await request("/api/cybermastery/session/ses_missing/prompt", { method: "POST" })).status).toBe(404)
    const unsupported = await request("/api/session", { method: "DELETE" })
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get("Allow")).toBe("GET, POST")
  })
}, 30_000)

test("create/get/list preserve native wire timestamps and cursors while filtering placement", async () => {
  await withHttp(async ({ request, location, otherLocation }) => {
    const created = await request("/api/session", { method: "POST", body: { id: "ses_http_a" } })
    expect(created.status).toBe(200)
    const raw = await json(created)
    const info = Schema.decodeUnknownSync(InfoResponse)(raw).data
    expect(info.location).toEqual(location)
    expect(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ time: Schema.Struct({ created: Schema.Number }) }) }))(raw).data.time.created).toBeGreaterThan(0)
    expect((await request("/api/session", { method: "POST", body: { id: "ses_http_a2" } })).status).toBe(200)
    expect((await request("/api/session", { method: "POST", actor: "b", body: { id: "ses_http_b", location: otherLocation } })).status).toBe(200)
    const denied = await request(`/api/session/${info.id}`, { actor: "b" })
    expect(denied.status).toBe(403)
    expect((await request("/api/session", { method: "POST", body: { location: otherLocation, actor: { userID: "user-b", workspaceID: "wrk_http_b" } } })).status).toBe(403)
    // Native create adopts recorded placement; a conflicting requested location
    // cannot make an existing Session readable to another workspace.
    expect((await request("/api/session", { method: "POST", actor: "b", body: { id: info.id, location: otherLocation } })).status).toBe(403)
    const list = Schema.decodeUnknownSync(SessionsResponse)(await json(await request("/api/session")))
    expect(list.data.map((session) => String(session.id)).sort()).toEqual(["ses_http_a", "ses_http_a2"])
    const first = Schema.decodeUnknownSync(SessionsResponse)(await json(await request("/api/session?limit=1&order=asc")))
    expect(first.data).toHaveLength(1)
    if (!first.cursor.next) throw new Error("Missing native next cursor")
    const next = Schema.decodeUnknownSync(SessionsResponse)(await json(await request(`/api/session?limit=1&cursor=${encodeURIComponent(first.cursor.next)}`)))
    expect(next.data).toHaveLength(1)
    expect(next.data[0]?.id).not.toBe(first.data[0]?.id)
    if (!next.cursor.previous) throw new Error("Missing native previous cursor")
    const previous = Schema.decodeUnknownSync(SessionsResponse)(await json(await request(`/api/session?limit=1&cursor=${encodeURIComponent(next.cursor.previous)}`)))
    expect(previous.data[0]?.id).toBe(first.data[0]?.id)
    const missing = await request("/api/session/ses_http_missing")
    expect(missing.status).toBe(404)
    expect(Schema.decodeUnknownSync(ErrorResponse)(await json(missing))._tag).toBe("SessionNotFoundError")
  })
}, 30_000)

test("prompt admission preserves delivery, exact retry, MIME validation and strict attachment identities", async () => {
  await withHttp(async ({ request, http, state }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_prompt" } })
    const path = "/api/session/ses_http_prompt/prompt"
    const attachment = { contextCapsuleID: "capsule", label: "Reference", contentHash: "hash-one", source: { kind: "ctxpack", ctxPackID: "pack" } }
    const payload = { id: "msg_http_prompt", prompt: { text: "public question" }, delivery: "queue", resume: false, contextAttachments: [attachment] }
    const first = await request(path, { method: "POST", body: payload })
    expect(first.status).toBe(200)
    const admitted = Schema.decodeUnknownSync(AdmittedResponse)(await json(first))
    const retry = await request(path, { method: "POST", body: payload })
    expect(retry.status).toBe(200)
    expect(Schema.decodeUnknownSync(AdmittedResponse)(await json(retry))).toEqual(admitted)
    expect(state.frozen).toBe(1)
    expect(state.calls).toBe(0)
    expect((await request(path, { method: "POST", body: { ...payload, delivery: "steer" } })).status).toBe(409)
    expect((await request(path, { method: "POST", body: { ...payload, prompt: { text: "different" } } })).status).toBe(409)
    for (const contextAttachments of [null, {}, [{ ...attachment, content: "PRIVATE_FRAGMENT" }], [{ ...attachment, source: { ...attachment.source, body: "PRIVATE_FRAGMENT" } }], [attachment, attachment]]) {
      const invalid = await request(path, { method: "POST", body: { ...payload, contextAttachments } })
      expect(invalid.status).toBe(400)
      const error = await invalid.text()
      expect(error).toContain("SessionContextAttachmentError")
      expect(error).not.toContain("PRIVATE_FRAGMENT")
    }
    const wrongMime = await http.fetch(new Request(`http://localhost${path}`, {
      method: "POST", headers: { Authorization: "Bearer a", "Content-Type": "text/plain" }, body: JSON.stringify(payload),
    }))
    expect(wrongMime?.status).toBe(400)
    expect((await request(path, { method: "POST", body: { ...payload, delivery: "invalid" } })).status).toBe(400)
    expect((await request(path, { method: "POST", body: { ...payload, resume: "false" } })).status).toBe(400)
    expect(state.frozen).toBe(1)
    expect(state.calls).toBe(0)
  })
}, 30_000)

test("attachment retry conflicts retain the native conflict response without private details", async () => {
  await withHttp(async ({ request, state }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_attachment" } })
    const path = "/api/session/ses_http_attachment/prompt"
    const attachment = { contextCapsuleID: "capsule", label: "Reference", contentHash: "hash-one", source: { kind: "ctxpack", ctxPackID: "pack" } }
    const payload = { id: "msg_http_attachment", prompt: { text: "public question" }, resume: false, contextAttachments: [attachment] }
    expect((await request(path, { method: "POST", body: payload })).status).toBe(200)
    const conflict = await request(path, { method: "POST", body: { ...payload, contextAttachments: [{ ...attachment, contentHash: "PRIVATE_CONFLICT_HASH" }] } })
    expect(conflict.status).toBe(409)
    const text = await conflict.text()
    expect(text).toContain("ConflictError")
    expect(text).not.toContain("PRIVATE_CONFLICT_HASH")
    expect(text).not.toContain("PRIVATE_ONLY_DO_NOT_SERIALIZE")
    expect(state.frozen).toBe(1)
  })
}, 30_000)

test("private admission defects retain stable attachment error codes without private content", async () => {
  await withHttp(async ({ request, state }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_context_failure" } })
    state.invalidContext = true
    const response = await request("/api/session/ses_http_context_failure/prompt", {
      method: "POST", body: { prompt: { text: "public" }, resume: false },
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      _tag: "SessionContextAttachmentError",
      message: "Context attachment admission failed: invalid-snapshot",
      code: "invalid-snapshot",
    })
    expect(state.calls).toBe(0)
    const history = await request("/api/session/ses_http_context_failure/history")
    expect(await history.text()).not.toContain("PRIVATE_ONLY_DO_NOT_SERIALIZE")
  })
}, 30_000)

test("malformed JSON, native IDs and query/cursor inputs fail closed", async () => {
  await withHttp(async ({ http, request }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_bad" } })
    const malformed = await http.fetch(new Request("http://localhost/api/session", {
      method: "POST", headers: { Authorization: "Bearer a", "Content-Type": "application/json" }, body: "{PRIVATE_MALFORMED",
    }))
    expect(malformed?.status).toBe(400)
    expect(await malformed?.text()).not.toContain("PRIVATE_MALFORMED")
    for (const path of [
      "/api/session/not-a-session-id",
      "/api/session?cursor=invalid",
      "/api/session?limit=0",
      "/api/session/ses_http_bad/history?limit=101",
      "/api/session/ses_http_bad/history?limit=Infinity",
      "/api/session/ses_http_bad/history?after=-1",
      "/api/session/ses_http_bad/event?after=1.5",
      "/api/session/ses_http_bad/message?limit=201",
      "/api/session/ses_http_bad/message?cursor=invalid",
      "/api/session/ses_http_bad/message?cursor=invalid&order=asc",
      "/api/session/ses_http_bad/message/not-a-message-id",
    ]) expect((await request(path)).status).toBe(400)
    for (const operation of ["compact", "wait"]) {
      expect((await request(`/api/session/ses_http_bad/${operation}`, { method: "POST", actor: "b" })).status).toBe(403)
      const unavailable = await request(`/api/session/ses_http_bad/${operation}`, { method: "POST" })
      expect(unavailable.status).toBe(503)
      expect(await json(unavailable)).toEqual({ _tag: "ServiceUnavailableError", message: `Session ${operation} is not available yet`, service: `session.${operation}` })
    }
  })
}, 30_000)

test("unexpected authentication and policy failures never echo private errors", async () => {
  await withHttp(async ({ runtime, location }) => {
    for (const failure of ["authentication", "policy"]) {
      const http = await createSessionHttp({
        runtime, defaultLocation: location,
        authenticate: async () => {
          if (failure === "authentication") throw new Error("PRIVATE_PROVIDER_CREDENTIAL")
          return { userID: "user-a", workspaceID: location.workspaceID }
        },
        policy: { authorize: () => Effect.die(new Error("PRIVATE_POLICY_CONTEXT")) },
      })
      try {
        const response = await http.fetch(new Request("http://localhost/api/session", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        }))
        expect(response?.status).toBe(500)
        const text = await response?.text()
        expect(text).toContain("UnknownError")
        expect(text).not.toContain("PRIVATE_PROVIDER_CREDENTIAL")
        expect(text).not.toContain("PRIVATE_POLICY_CONTEXT")
      } finally {
        await http.dispose()
      }
    }
  })
}, 30_000)

test("omitted delivery reconciles an explicit steer retry without running the model", async () => {
  await withHttp(async ({ request, state }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_steer" } })
    const payload = { id: "msg_http_steer", prompt: { text: "public question" }, resume: false }
    const first = await request("/api/session/ses_http_steer/prompt", { method: "POST", body: payload })
    expect(first.status).toBe(200)
    const admitted = Schema.decodeUnknownSync(AdmittedResponse)(await json(first))
    const retry = await request("/api/session/ses_http_steer/prompt", { method: "POST", body: { ...payload, delivery: "steer" } })
    expect(retry.status).toBe(200)
    expect(Schema.decodeUnknownSync(AdmittedResponse)(await json(retry))).toEqual(admitted)
    expect(state.frozen).toBe(1)
    expect(state.calls).toBe(0)
  })
}, 30_000)

test("explicit resume uses the native runner and serializes public messages, context and history", async () => {
  await withHttp(async ({ request, state }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_run" } })
    expect((await request("/api/session/ses_http_run/prompt", { method: "POST", body: {
      id: "msg_http_run", prompt: { text: "public question" }, resume: false,
    } })).status).toBe(200)
    expect(state.calls).toBe(0)
    expect((await request("/api/cybermastery/session/ses_http_run/resume", { method: "POST", actor: "b" })).status).toBe(403)
    expect((await request("/api/cybermastery/session/ses_http_run/resume", { method: "POST" })).status).toBe(204)
    expect(state.calls).toBe(1)
    const messages = Schema.decodeUnknownSync(MessagesResponse)(await json(await request("/api/session/ses_http_run/message")))
    expect(messages.data.some((message) => message.type === "user" && message.text === "public question")).toBe(true)
    expect(JSON.stringify(messages)).toContain("public answer")
    const one = await request("/api/session/ses_http_run/message/msg_http_run")
    expect(one.status).toBe(200)
    Schema.decodeUnknownSync(Schema.Struct({ data: SessionMessage.Message }))(await json(one))
    const page = Schema.decodeUnknownSync(MessagesResponse)(await json(await request("/api/session/ses_http_run/message?limit=1&order=asc")))
    if (!page.cursor.next) throw new Error("Missing message cursor")
    const next = Schema.decodeUnknownSync(MessagesResponse)(await json(await request(`/api/session/ses_http_run/message?limit=1&cursor=${encodeURIComponent(page.cursor.next)}`)))
    expect(next.data[0]?.id).not.toBe(page.data[0]?.id)
    if (!next.cursor.previous) throw new Error("Missing previous message cursor")
    const previous = Schema.decodeUnknownSync(MessagesResponse)(await json(await request(`/api/session/ses_http_run/message?limit=1&cursor=${encodeURIComponent(next.cursor.previous)}`)))
    expect(previous.data[0]?.id).toBe(page.data[0]?.id)
    for (const path of ["message", "context", "history"]) {
      const result = await request(`/api/session/ses_http_run/${path}`)
      expect(result.status).toBe(200)
      const text = await result.text()
      expect(text).not.toContain("PRIVATE_ONLY_DO_NOT_SERIALIZE")
      expect(text).not.toContain("DateTime.Utc")
      if (path === "history") Schema.decodeUnknownSync(Schema.fromJsonString(HistoryResponse))(text)
    }
    expect((await request("/api/session/ses_http_run/interrupt", { method: "POST" })).status).toBe(204)
    expect(await json(await request("/api/session/active"))).toEqual({ data: {} })
  })
}, 30_000)

test("a disconnected resume waiter does not cancel execution; only interrupt owns the drain", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const finalized = Deferred.makeUnsafe<void>()
  await withHttp(async ({ request, runtime, state }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_interrupt" } })
    await request("/api/session/ses_http_interrupt/prompt", { method: "POST", body: { prompt: { text: "public question" }, resume: false } })
    const abort = new AbortController()
    const waiter = request("/api/cybermastery/session/ses_http_interrupt/resume", { method: "POST", signal: abort.signal }).then(
      () => "completed", () => "aborted",
    )
    try {
      await runtime.runPromise(Deferred.await(entered).pipe(Effect.timeout("5 seconds")))
      expect(await json(await request("/api/session/active"))).toEqual({ data: { ses_http_interrupt: { type: "running" } } })
      expect(await json(await request("/api/session/active", { actor: "b" }))).toEqual({ data: {} })
      abort.abort()
      expect(await waiter).toBe("aborted")
      expect(await json(await request("/api/session/active"))).toEqual({ data: { ses_http_interrupt: { type: "running" } } })
      expect((await request("/api/session/ses_http_interrupt/interrupt", { method: "POST" })).status).toBe(204)
      await runtime.runPromise(Deferred.await(finalized).pipe(Effect.timeout("5 seconds")))
      expect(await json(await request("/api/session/active"))).toEqual({ data: {} })
      expect(state.calls).toBe(1)
    } finally {
      abort.abort()
      await request("/api/session/ses_http_interrupt/interrupt", { method: "POST" })
      await waiter
    }
  }, () => Stream.unwrap(Deferred.succeed(entered, undefined).pipe(
    Effect.andThen(Deferred.await(release)), Effect.as(completedResponse()),
  )).pipe(Stream.ensuring(Deferred.succeed(finalized, undefined))))
}, 30_000)

test("durable SSE emits native public frames, cleans up abort/cancel/dispose, and leaves the runtime borrowed", async () => {
  await withHttp(async ({ request, http, runtime }) => {
    await request("/api/session", { method: "POST", body: { id: "ses_http_events" } })
    await request("/api/session/ses_http_events/prompt", { method: "POST", body: {
      id: "msg_http_events", prompt: { text: "public event question" }, resume: false,
    } })
    expect((await request("/api/cybermastery/session/ses_http_events/resume", { method: "POST" })).status).toBe(204)
    expect((await request("/api/session/ses_http_events/event", { actor: "b" })).status).toBe(403)
    const abort = new AbortController()
    const response = await request("/api/session/ses_http_events/event?after=1", { signal: abort.signal })
    expect(response.headers.get("Content-Type")).toBe("text/event-stream")
    if (!response.body) throw new Error("Missing event stream")
    const reader = response.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      const text = new TextDecoder().decode(first.value)
      expect(text.startsWith("data: ")).toBe(true)
      expect(text.endsWith("\n\n")).toBe(true)
      const event = Schema.decodeUnknownSync(Schema.fromJsonString(SessionEvent.Durable))(text.slice(6).trim())
      const history = Schema.decodeUnknownSync(HistoryResponse)(await json(await request("/api/session/ses_http_events/history?after=1&limit=1")))
      expect(event).toEqual(history.data[0])
      expect(text).not.toContain("PRIVATE_ONLY_DO_NOT_SERIALIZE")
      abort.abort()
      // Buffered public frames may remain readable after close; cancellation
      // discards them and joins the stream's effect finalization.
      await reader.cancel()
    } finally {
      abort.abort()
      await reader.cancel()
    }
    const cancelled = await request("/api/session/ses_http_events/event")
    await cancelled.body?.cancel()
    const slow = await request("/api/session/ses_http_events/event")
    await http.dispose()
    await slow.body?.cancel()
    const info = await runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      return yield* session.get(Session.ID.make("ses_http_events"))
    }))
    expect(info.id).toBe(Session.ID.make("ses_http_events"))
    expect((await request("/api/session")).status).toBe(503)
  })
}, 30_000)
