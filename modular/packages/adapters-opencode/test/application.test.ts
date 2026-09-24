import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, LLMEvent, LLMRequest, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Session } from "@opencode-ai/schema/session"
import { sql } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import type { AdmissionRequest } from "../src/admission"
import { createApplicationAdapter } from "../src/application"
import type { RunnerIdentity } from "../src/runner"
import { PrivatePromptContext, type SessionPolicy } from "../src/session-facade"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const token = "application-test-token"
const basic = `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`
const attachment = { contextCapsuleID: "capsule", label: "Reference", contentHash: "hash-one", source: { kind: "ctxpack", ctxPackID: "pack" } }
const InfoResponse = Schema.Struct({ data: Session.Info })

type Fixture = {
  app: Awaited<ReturnType<typeof createApplicationAdapter>>
  directory: string
  workspaceID: string
  requests: LLMRequest[]
  constructed: RunnerIdentity[]
  request: (path: string, options?: {
    method?: string
    body?: unknown
    credentials?: string | false
    signal?: AbortSignal
    headers?: HeadersInit
  }) => Promise<Response>
}

async function withApp(run: (fixture: Fixture) => Promise<void>, options: {
  policy?: SessionPolicy
  workspaceID?: string
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-application-"))
  cleanup(directory)
  const workspaceID = options.workspaceID ?? "proof-workspace"
  const requests: LLMRequest[] = []
  const constructed: RunnerIdentity[] = []
  const model = Model.make({ id: "application-model", provider: "proof", route })
  const app = await createApplicationAdapter({
    filename: join(directory, "application.db"), directory, workspaceID, userID: "owner", token,
    isolated: true,
    policy: options.policy,
    onRunnerConstruct: (identity) => { constructed.push(identity) },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, {
        stream: (request) => {
          requests.push(request)
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text" }),
            LLMEvent.textDelta({ id: "text", text: "public answer" }),
            LLMEvent.textEnd({ id: "text" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ])
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
    await run({
      app, directory, workspaceID, requests, constructed,
      request: (path, options = {}) => {
        const headers = new Headers(options.headers)
        if (options.credentials !== false) headers.set("Authorization", options.credentials ?? `Bearer ${token}`)
        if (options.body !== undefined) headers.set("Content-Type", "application/json")
        return app.fetch(new Request(`http://application.test${path}`, {
          method: options.method ?? "GET", headers, signal: options.signal,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }))
      },
    })
  } finally {
    await app.dispose()
  }
}

async function json(response: Response): Promise<unknown> {
  return response.json()
}

test("layout, Session ingress, native HTTP and the private runner share one selected root", async () => {
  await withApp(async ({ app, request, workspaceID, directory, requests, constructed }) => {
    const identities = Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const store = yield* SessionStore.Service
      const execution = yield* SessionExecution.Service
      const locations = yield* LocationServiceMap.Service
      const global = yield* Global.Service
      return { database, events, session, store, execution, locations, global }
    })
    const before = await app.runtime.runPromise(identities)
    expect(Object.keys(before.global).sort()).toEqual(["bin", "cache", "config", "data", "home", "log", "repos", "state", "tmp"])
    Object.values(before.global).forEach((path) => expect(path.startsWith(directory + sep)).toBe(true))
    const actor = { userID: "owner" }
    const tuple = { user: actor.userID, style: "canvas", deviceClass: "desktop" as const }
    const changes: number[] = []
    const changed = Promise.withResolvers<void>()
    const unsubscribe = await app.listen((event) => {
      changes.push(event.properties.revision)
      changed.resolve()
    })
    try {
      const initial = await app.repository.get(actor, workspaceID, tuple, "client", true)
      expect(initial.revision).toBe(0)
      const saved = await app.repository.save(actor, { workspaceID, tuple, clientID: "client", expectedRevision: 0, blocks: [] })
      expect(saved.revision).toBe(1)
      await changed.promise
      expect(changes).toEqual([1])
      expect(await app.runtime.runPromise(before.database.db.get<{ revision: number }>(sql`
        SELECT revision FROM cm_layout WHERE id = ${saved.id}`))).toEqual({ revision: 1 })

      const created = await request("/api/session", { method: "POST", body: { id: "ses_application_shared" } })
      expect(created.status).toBe(200)
      const info = Schema.decodeUnknownSync(InfoResponse)(await json(created)).data
      expect(info.location).toEqual({ directory: AbsolutePath.make(directory) })
      expect(await app.runtime.runPromise(before.session.get(info.id))).toEqual(info)
      expect((await request(`/api/session/${info.id}/prompt`, { method: "POST", body: {
        id: "msg_application_shared", prompt: { text: "public question" }, resume: false,
      } })).status).toBe(200)
      expect(requests).toHaveLength(0)
      expect((await request(`/api/cybermastery/session/${info.id}/resume`, { method: "POST" })).status).toBe(204)
      expect(requests).toHaveLength(1)
      expect(constructed).toHaveLength(1)
      const runner = constructed[0]
      if (!runner) throw new Error("Missing private runner identity")
      expect(runner.database).toBe(before.database)
      expect(runner.events).toBe(before.events)
      expect(runner.store).toBe(before.store)
      expect(runner.location.directory).toBe(info.location.directory)
      expect(runner.location.workspaceID).toBe(info.location.workspaceID)
      expect((await request("/api/health")).status).toBe(200)
      const after = await app.runtime.runPromise(identities)
      expect(after.database).toBe(before.database)
      expect(after.events).toBe(before.events)
      expect(after.session).toBe(before.session)
      expect(after.store).toBe(before.store)
      expect(after.execution).toBe(before.execution)
      expect(after.locations).toBe(before.locations)
      expect(after.global).toBe(before.global)
      const messages = await request(`/api/session/${info.id}/message`)
      expect(messages.status).toBe(200)
      expect(await messages.text()).toContain("public answer")
    } finally {
      await unsubscribe()
    }
  })
}, 30_000)

test("Bearer, Basic and query credentials bind only the configured actor and protect native OpenAPI", async () => {
  await withApp(async ({ app, request, workspaceID }) => {
    const invalid: readonly (string | false)[] = [false, "Bearer wrong", `Basic ${Buffer.from("wrong:" + token).toString("base64")}`, `Basic ${Buffer.from("opencode:wrong").toString("base64")}`]
    for (const path of ["/api/health", "/openapi.json", "/api/session", "/api/session/unknown/route", "/api/cybermastery/session/unknown/resume"]) {
      for (const credentials of invalid) {
        expect((await request(path, { credentials })).status).toBe(401)
      }
    }
    for (const credentials of [`Bearer ${token}`, basic]) {
      const health = await request("/api/health", { credentials })
      expect(health.status).toBe(200)
      expect(await json(health)).toEqual({ healthy: true })
      const openapi = await request("/openapi.json", { credentials })
      expect(openapi.status).toBe(200)
      expect(await json(openapi)).toMatchObject({ paths: { "/api/health": { get: expect.anything() } } })
      expect((await request("/api/session", { credentials })).status).toBe(200)
      expect(app.authenticate(new Request("http://application.test/?userID=attacker&workspaceID=other", {
        headers: { Authorization: credentials },
      }))).toEqual({ userID: "owner", workspaceID })
    }
    const query = encodeURIComponent(Buffer.from(`opencode:${token}`).toString("base64"))
    expect((await request(`/api/health?auth_token=${query}`, { credentials: false })).status).toBe(200)
    expect((await request(`/api/session?auth_token=${query}`, { credentials: false })).status).toBe(200)
    expect((await request("/api/health?auth_token=malformed!", { credentials: false })).status).toBe(401)
    // Authenticated Bearer requests cannot be overridden by native query auth.
    expect((await request("/api/health?auth_token=wrong")).status).toBe(200)
    expect((await request(`/api/health?auth_token=${query}`, { credentials: "Bearer wrong" })).status).toBe(401)
    expect((await request("/api/session?userID=owner&workspaceID=proof-workspace", {
      method: "POST", credentials: false, body: { actor: { userID: "owner", workspaceID } },
    })).status).toBe(401)
    expect((await request("/api/session/unknown/route")).status).toBe(404)
    expect((await request("/api/cybermastery/session/ses_unknown/prompt", { method: "POST" })).status).toBe(404)
  })
}, 30_000)

test("supplied policy freezes private attachments once and the Session overlay never exposes the snapshot", async () => {
  const frozen: AdmissionRequest[] = []
  const authorized: AdmissionRequest[] = []
  const captured: { database?: Effect.Success<typeof Database.Service>; session?: SessionV2.Interface } = {}
  const privateContent = "PRIVATE_APPLICATION_SNAPSHOT"
  await withApp(async ({ app, request, requests, workspaceID }) => {
    const proof = { topologyRevision: "application-private", requestToken: "a".repeat(64) }
    expect((await request("/sync/start", { method: "POST", body: {
      version: 1, action: "grant", ...proof, expiresAt: Date.now() + 30_000,
    } })).status).toBe(200)
    expect((await request("/api/session", { method: "POST", body: { id: "ses_application_private" }, credentials: basic })).status).toBe(200)
    const payload = {
      id: "msg_application_private", prompt: { text: "public question" }, resume: false,
      contextAttachments: [attachment], actor: { userID: "attacker", workspaceID: "other" },
    }
    const path = "/api/session/ses_application_private/prompt"
    const first = await request(path, { method: "POST", body: payload, headers: {
      "x-opencode-session-context-topology": proof.topologyRevision,
      "x-opencode-session-context-lease": proof.requestToken,
    } })
    expect(first.status).toBe(200)
    const admitted = await json(first)
    const retry = await request(path, { method: "POST", body: payload, credentials: basic })
    expect(retry.status).toBe(200)
    expect(await json(retry)).toEqual(admitted)
    expect(frozen).toHaveLength(1)
    expect(authorized.length).toBeGreaterThanOrEqual(3)
    expect(frozen[0]?.actor).toEqual({ userID: "owner", workspaceID })
    expect(frozen[0]?.references).toEqual([{
      id: JSON.stringify({ contextCapsuleID: attachment.contextCapsuleID, sourceCtxPackID: attachment.source.ctxPackID, label: attachment.label }),
      contentHash: attachment.contentHash,
    }])
    expect((await request(path, { method: "POST", body: { ...payload, contextAttachments: [{ ...attachment, contentHash: "different" }] } })).status).toBe(409)
    expect((await request(path, { method: "POST", body: { ...payload, contextAttachments: [{ ...attachment, content: "caller-controlled private text" }] } })).status).toBe(400)
    expect(requests).toHaveLength(0)
    const database = await app.runtime.runPromise(Database.Service)
    expect(captured.database).toBe(database)
    if (!captured.session) throw new Error("Missing native policy dependency")
    expect((await app.runtime.runPromise(captured.session.get(Session.ID.make("ses_application_private")))).id).toBe(Session.ID.make("ses_application_private"))
    expect(await app.runtime.runPromise(database.db.get<{ api_content: string }>(sql`
      SELECT api_content FROM cm_private_input WHERE message_id = 'msg_application_private'`))).toEqual({ api_content: privateContent })
    expect((await request("/api/cybermastery/session/ses_application_private/resume", { method: "POST" })).status).toBe(204)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain(privateContent)
    expect(frozen).toHaveLength(1)
    for (const suffix of ["message", "context", "history"]) {
      const response = await request(`/api/session/ses_application_private/${suffix}`)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain("public question")
      expect(text).not.toContain(privateContent)
    }
  }, {
    policy: (dependencies) => {
      captured.database = dependencies.database
      captured.session = dependencies.session
      return {
        managed: () => Effect.succeed(true),
        authorize: (request) => Effect.sync(() => { authorized.push(request) }),
        freeze: (request) => Effect.sync(() => {
          frozen.push(request)
          return { apiContent: privateContent, rendererVersion: 1 }
        }),
      }
    },
  })
}, 30_000)

test("default admission fails closed for references and rechecks recorded workspace ownership on retries", async () => {
  await withApp(async ({ app, request, requests, workspaceID }) => {
    expect((await request("/api/session", { method: "POST", body: { id: "ses_application_default" } })).status).toBe(200)
    const path = "/api/session/ses_application_default/prompt"
    const payload = { id: "msg_application_default", prompt: { text: "plain public question" }, resume: false }
    const unsupported = await request(path, { method: "POST", body: { ...payload, contextAttachments: [attachment] } })
    expect(unsupported.status).toBe(400)
    expect(await json(unsupported)).toMatchObject({ _tag: "SessionContextAttachmentError", code: "transfer-unavailable" })
    expect(requests).toHaveLength(0)
    const database = await app.runtime.runPromise(Database.Service)
    expect(await app.runtime.runPromise(database.db.get<{ message_id: string }>(sql`SELECT message_id FROM cm_private_input`))).toBeUndefined()
    expect((await request(path, { method: "POST", body: payload })).status).toBe(200)
    expect((await request(path, { method: "POST", body: payload })).status).toBe(200)
    expect(await app.runtime.runPromise(database.db.get(sql`SELECT message_id FROM cm_private_input WHERE message_id = ${payload.id}`)))
      .toBeUndefined()
    expect(await app.runtime.runPromise(database.db.get<{ message_id: string }>(sql`
      SELECT message_id FROM cm_clean_input WHERE message_id = ${payload.id}`))).toEqual({ message_id: payload.id })
    await app.runtime.runPromise(database.db.run(sql`UPDATE cm_workspace SET owner_id = 'other-owner' WHERE id = ${workspaceID}`))
    const denied = await request(path, { method: "POST", body: payload })
    expect(denied.status).toBe(400)
    expect(await json(denied)).toMatchObject({ code: "unauthorized" })
    expect((await request(path, { method: "POST", body: { ...payload, id: "msg_application_revoked" } })).status).toBe(400)
    expect(requests).toHaveLength(0)
  })
}, 30_000)

test("native workspace placement is enforced on requested and reused Session identities", async () => {
  await withApp(async ({ app, request, directory, workspaceID }) => {
    const created = await request("/api/session", { method: "POST", body: { id: "ses_application_placement" } })
    expect(created.status).toBe(200)
    expect(Schema.decodeUnknownSync(InfoResponse)(await json(created)).data.location).toEqual({
      directory: AbsolutePath.make(directory), workspaceID: WorkspaceV2.ID.make(workspaceID),
    })
    const other = { directory: AbsolutePath.make(join(directory, "other")), workspaceID: WorkspaceV2.ID.make("wrk_other") }
    await mkdir(other.directory)
    expect((await request("/api/session", { method: "POST", body: { location: other } })).status).toBe(403)
    expect((await request("/api/session", { method: "POST", body: { location: { directory } } })).status).toBe(403)
    const session = await app.runtime.runPromise(SessionV2.Service)
    const foreign = await app.runtime.runPromise(session.create({ id: Session.ID.make("ses_application_foreign"), location: other }))
    expect((await request("/api/session", { method: "POST", body: { id: foreign.id } })).status).toBe(403)
    expect((await request(`/api/session/${foreign.id}`)).status).toBe(403)
    expect((await app.runtime.runPromise(session.get(foreign.id))).location).toEqual(other)
    // Even an owned internal caller cannot bypass default admission placement.
    await expect(app.runtime.runPromise(session.prompt({ sessionID: foreign.id, prompt: { text: "foreign" }, resume: false }).pipe(
      Effect.provideService(PrivatePromptContext, { actor: { userID: "owner", workspaceID }, references: [] }),
    ))).rejects.toThrow()
  }, { workspaceID: "wrk_application" })
}, 30_000)

test("disposal joins Session streams before closing the shared runtime and is repeatable", async () => {
  await withApp(async ({ app, request }) => {
    expect((await request("/api/session", { method: "POST", body: { id: "ses_application_disposal" } })).status).toBe(200)
    const response = await request("/api/session/ses_application_disposal/event")
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/event-stream")
    if (!response.body) throw new Error("Missing Session event stream")
    const first = app.dispose()
    expect(app.dispose()).toBe(first)
    await first
    await response.body.cancel()
    expect(app.dispose()).toBe(first)
    await app.dispose()
    await expect(request("/api/health")).rejects.toThrow("Application adapter has been disposed")
    await expect(request("/api/session")).rejects.toThrow("Application adapter has been disposed")
    await expect(app.runtime.runPromise(Database.Service)).rejects.toThrow()
  })
}, 30_000)

test("blank credentials are rejected before graph or filesystem construction", async () => {
  for (const credentials of [
    { token: " ", userID: "owner", workspaceID: "workspace" },
    { token, userID: " ", workspaceID: "workspace" },
    { token, userID: "owner", workspaceID: " " },
  ]) {
    await expect(createApplicationAdapter({
      ...credentials,
      get filename(): string { throw new Error("Graph inputs must not be read for invalid credentials") },
      isolated: true,
    })).rejects.toThrow(credentials.token.trim() ? "An explicit user and workspace are required" : "An explicit authentication token is required")
  }
})
