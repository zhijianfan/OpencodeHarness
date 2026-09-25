import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Config } from "@opencode-ai/core/config"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { LLMClient, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Schema, Stream } from "effect"
import { sql } from "drizzle-orm"
import { createApplicationAdapter } from "../src/application"
import { createCtxPackClient } from "../../client/src/ctxpack"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const actor = { userID: "ctxpack-owner", workspaceID: "wrk_ctxpack_app" }
const sessionID = "ses_ctxpack_app"
const messageID = "msg_ctxpack_app"
const token = "ctxpack-proof-token"

test("real catalog capsule enriches only a leased native admission and counts once on retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-ctxpack-app-"))
  cleanup(directory)
  const app = await createApplicationAdapter({
    filename: join(directory, "app.db"), directory, ...actor, token, isolated: true,
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: () => Stream.empty })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "test", provider: "proof", route })))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) })
  const client = createCtxPackClient({ baseUrl: server.url.toString(), token, workspaceID: actor.workspaceID })
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
  try {
    const created = await request("/api/session", { id: sessionID })
    expect(created.status).toBe(200)
    const pack = await app.runtime.runPromise(app.ctxpack.catalog.create(actor, {
      workspaceID: actor.workspaceID, title: "Private notes", keywords: ["context"], tags: ["ParallelPlan"],
      sensitivity: "private", idempotencyKey: "ctxpack-proof",
      fragments: [{ clientFragmentID: "first", text: "PRIVATE_PACK_BODY", source: {
        workspaceID: actor.workspaceID, blockID: "block", functionalityID: "builtin:chat", kind: "note",
        direction: "generated", sourceTimestamp: null, capturedAt: 1, entityRef: null, label: null,
        metadata: {}, sensitivity: "private",
      } }],
    }))
    expect((await client.get(pack.id)).contentHash).toBe(pack.contentHash)
    expect((await client.pin(pack.id)).fragmentCount).toBe(1)
    await client.unpin(pack.id)
    expect((await client.list({ workspaceID: actor.workspaceID, query: "", keyword: null,
      sourceBlockID: null, sourceFunctionalityID: null, sourceKind: null, sensitivity: null,
      createdAfter: null, createdBefore: null, includeDeleted: false, pinnedOnly: false,
      sort: "created-desc", cursor: null, limit: 10,
    })).items.map((item) => item.id)).toEqual([pack.id])
    const pathToPack = `/api/cybermastery/ctxpack/${pack.id}`
    expect((await app.fetch(new Request(`http://localhost${pathToPack}`))).status).toBe(401)
    const read = await app.fetch(new Request(`http://localhost${pathToPack}`, { headers: { Authorization: `Bearer ${token}` } }))
    expect(read.status).toBe(200)
    expect(await read.text()).toContain("PRIVATE_PACK_BODY")
    const clientCapsule = await client.materialize(pack.id, {
      expectedContentHash: pack.contentHash, targetInstanceID: `chat-instance:${sessionID}`,
      targetFunctionalityID: "builtin:chat",
    })
    const capsule = Schema.decodeUnknownSync(Schema.Struct({
      contextCapsuleID: Schema.String, label: Schema.String, contentHash: Schema.String,
    }))(clientCapsule)
    const attachment = { contextCapsuleID: capsule.contextCapsuleID, label: capsule.label,
      contentHash: capsule.contentHash, source: { kind: "ctxpack", ctxPackID: pack.id } }
    const path = `/api/session/${sessionID}/prompt`
    const payload = { id: messageID, prompt: { text: "Public question" }, resume: false, contextAttachments: [attachment] }
    expect((await request(path, payload)).status).toBe(400)
    const lease = { version: 1, action: "grant", workspaceID: actor.workspaceID, topologyRevision: "ctxpack-revision",
      requestToken: "a".repeat(64), expiresAt: Date.now() + 30_000 }
    expect((await request("/sync/start", lease)).status).toBe(200)
    const proof = { "x-opencode-session-context-topology": lease.topologyRevision,
      "x-opencode-session-context-lease": lease.requestToken }
    const admitted = await request(path, payload, proof)
    expect(admitted.status).toBe(200)
    const first = await admitted.json()
    const rows = await app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return {
        privateInput: yield* database.db.get<{ api_content: string; renderer_version: number }>(sql`
          SELECT api_content, renderer_version FROM cm_private_input WHERE message_id = ${messageID}`),
        usage: yield* database.db.get<{ attached_count: number }>(sql`
          SELECT attached_count FROM cm_ctx_pack WHERE id = ${pack.id}`),
        ledger: yield* database.db.all(sql`SELECT ctx_pack_id FROM cm_ctx_pack_usage_admission WHERE session_input_id = ${messageID}`),
        publicEvents: yield* database.db.all<{ data: string }>(sql`SELECT data FROM event WHERE aggregate_id = ${sessionID}`),
      }
    }))
    expect(rows.privateInput?.api_content).toContain("PRIVATE_PACK_BODY")
    expect(rows.privateInput?.renderer_version).toBe(2)
    expect(rows.usage?.attached_count).toBe(1)
    expect(rows.ledger).toHaveLength(1)
    expect(JSON.stringify(rows.publicEvents)).not.toContain("PRIVATE_PACK_BODY")
    expect((await request("/sync/start", { ...lease, action: "revoke" })).status).toBe(200)
    const retried = await request(path, payload)
    expect(retried.status).toBe(200)
    expect(await retried.json()).toEqual(first)
    expect((await app.runtime.runPromise(app.ctxpack.catalog.get(actor, pack.id))).usage.attachedCount).toBe(1)
    expect((await request(path, { ...payload, contextAttachments: [{ ...attachment, contentHash: "changed" }] })).status).toBe(409)
    expect((await request(path, { ...payload, id: "msg_ctxpack_app_new" })).status).toBe(400)
  } finally {
    server.stop(true)
    await app.dispose()
  }
}, 30_000)

test("only a trusted bound OperatingChat admission recalls private context and records usage once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-operating-recall-"))
  cleanup(directory)
  let hostAuthorized = true
  const app = await createApplicationAdapter({
    filename: join(directory, "app.db"), directory, ...actor, token, isolated: true,
    operatingChat: { authorize: () => Effect.suspend(() => hostAuthorized ? Effect.void : Effect.fail({
      _tag: "OperatingChatBinding.Error", code: "unauthorized" as const,
    })) },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: () => Stream.empty })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "test", provider: "proof", route })))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
  try {
    const boundID = SessionSchema.ID.make("ses_operating_bound")
    const genericID = SessionSchema.ID.make("ses_operating_generic")
    expect((await request("/api/session", { id: boundID })).status).toBe(200)
    expect((await request("/api/session", { id: genericID })).status).toBe(200)
    const pack = await app.runtime.runPromise(app.ctxpack.catalog.create(actor, {
      workspaceID: actor.workspaceID, title: "Deployment notes", keywords: ["deployment"],
      sensitivity: "private", idempotencyKey: "operating-recall-proof",
      fragments: [{ clientFragmentID: "private", text: "DEPLOYMENT_PRIVATE_BODY", source: {
        workspaceID: actor.workspaceID, blockID: "operating-block", functionalityID: "builtin:operating-chat-session",
        kind: "note", direction: "generated", sourceTimestamp: null, capturedAt: 1,
        entityRef: null, label: null, metadata: {}, sensitivity: "private",
      } }],
    }))
    if (!app.operatingChat) throw new Error("trusted host binding was not initialized")
    const profile = await app.runtime.runPromise(app.operatingChat.bind({ actor, sessionID: boundID, descriptor: {
      workspaceID: actor.workspaceID, workspaceName: "Operating Chat", blockID: "operating-block",
      functionalityID: "builtin:operating-chat-session", functionalityInstanceID: "operating-instance",
      directory: directory.replaceAll("\\", "/"), operatingAgent: "build",
    } }))
    expect(profile.generation).toBe(1)
    const lease = { version: 1, action: "grant", workspaceID: actor.workspaceID, topologyRevision: "operating-recall",
      requestToken: "a".repeat(64), expiresAt: Date.now() + 30_000 }
    expect((await request("/sync/start", lease)).status).toBe(200)
    const proof = { "x-opencode-session-context-topology": lease.topologyRevision,
      "x-opencode-session-context-lease": lease.requestToken }
    const path = (id: string) => `/api/session/${id}/prompt`
    const payload = { id: "msg_operating_recall", prompt: { text: "deployment details" }, resume: false }
    const generic = await request(path(genericID), { ...payload, id: "msg_generic_recall" }, proof)
    expect(generic.status).toBe(200)
    const bound = await request(path(boundID), payload, proof)
    expect(bound.status).toBe(200)
    const rows = await app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return {
        bound: yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input
          WHERE message_id = ${payload.id}`),
        generic: yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input
          WHERE message_id = 'msg_generic_recall'`),
        usage: yield* database.db.get<{ attached_count: number }>(sql`SELECT attached_count FROM cm_ctx_pack WHERE id = ${pack.id}`),
        events: yield* database.db.all<{ data: string }>(sql`SELECT data FROM event WHERE aggregate_id = ${boundID}`),
      }
    }))
    expect(rows.bound?.api_content).toContain("DEPLOYMENT_PRIVATE_BODY")
    expect(rows.generic?.api_content).not.toContain("DEPLOYMENT_PRIVATE_BODY")
    expect(rows.usage?.attached_count).toBe(1)
    expect(JSON.stringify(rows.events)).not.toContain("DEPLOYMENT_PRIVATE_BODY")
    const explicitPack = await app.runtime.runPromise(app.ctxpack.catalog.create(actor, {
      workspaceID: actor.workspaceID, title: "Operator selected", keywords: ["selected"],
      sensitivity: "private", idempotencyKey: "operating-explicit-proof",
      fragments: [{ clientFragmentID: "explicit", text: "EXPLICIT_CONTEXT_BODY", source: {
        workspaceID: actor.workspaceID, blockID: "operating-block", functionalityID: "builtin:operating-chat-session",
        kind: "note", direction: "generated", sourceTimestamp: null, capturedAt: 1,
        entityRef: null, label: null, metadata: {}, sensitivity: "private",
      } }],
    }))
    const capsule = await app.runtime.runPromise(app.ctxpack.materializer.materialize(actor, {
      workspaceID: actor.workspaceID, ctxPackID: explicitPack.id, expectedContentHash: explicitPack.contentHash,
      targetInstanceID: `chat-instance:${boundID}`, targetFunctionalityID: "builtin:chat",
    }))
    const mixedID = "msg_operating_mixed"
    const mixed = await request(path(boundID), { id: mixedID, prompt: payload.prompt, resume: false,
      contextAttachments: [{ contextCapsuleID: capsule.contextCapsuleID, label: capsule.label,
        contentHash: capsule.contentHash, source: { kind: "ctxpack", ctxPackID: explicitPack.id } }],
    }, proof)
    expect(mixed.status).toBe(200)
    const mixedContent = await app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input
        WHERE message_id = ${mixedID}`)
    }))
    expect(mixedContent?.api_content).toContain("DEPLOYMENT_PRIVATE_BODY")
    expect(mixedContent?.api_content).toContain("EXPLICIT_CONTEXT_BODY")
    expect(mixedContent?.api_content.indexOf("EXPLICIT_CONTEXT_BODY")).toBeLessThan(
      mixedContent?.api_content.indexOf("DEPLOYMENT_PRIVATE_BODY") ?? -1,
    )
    expect((await app.runtime.runPromise(app.ctxpack.catalog.get(actor, pack.id))).usage.attachedCount).toBe(2)
    expect((await app.runtime.runPromise(app.ctxpack.catalog.get(actor, explicitPack.id))).usage.attachedCount).toBe(1)
    expect((await request("/sync/start", { ...lease, action: "revoke" })).status).toBe(200)
    expect((await request(path(boundID), payload)).status).toBe(200)
    expect((await app.runtime.runPromise(app.ctxpack.catalog.get(actor, pack.id))).usage.attachedCount).toBe(2)
    hostAuthorized = false
    expect((await request("/sync/start", lease)).status).toBe(200)
    expect((await request(path(boundID), { ...payload, id: "msg_revoked_recall" }, proof)).status).not.toBe(200)
    expect(await app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* database.db.get(sql`SELECT id FROM session_input WHERE id = 'msg_revoked_recall'`)
    }))).toBeUndefined()
    expect((await app.runtime.runPromise(app.ctxpack.catalog.get(actor, pack.id))).usage.attachedCount).toBe(2)
    hostAuthorized = true
    await app.runtime.runPromise(app.operatingChat.reset({ actor, sessionID: boundID, expectedRevision: profile.revision }))
    expect((await app.runtime.runPromise(app.operatingChat.resolve(boundID)))).toBeUndefined()
  } finally {
    await app.dispose()
  }
}, 30_000)
