/**
 * Wave 14 worker 2 — transfer client/peer and source cache lifecycle.
 *
 * The client suite composes two real `createApplicationAdapter` graphs (separate
 * SQLite files, the same trusted directory/project/workspace/user placement,
 * distinct host tokens) behind ephemeral `Bun.serve` instances and drives them
 * exclusively through the real `makeTransferClient` synchronize effect. Malformed
 * HTTP counterexamples use small fake servers; native restore and the global
 * environment are never faked.
 *
 * The source cache suite drives the real `/sync/history` endpoint to prove that
 * completed snapshots are reclaimed under pressure while unfinished ones are
 * protected and evicted tokens restart rather than rebinding data.
 */
import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { LLMClient, LLMEvent, LLMRequest, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { sql, type SQL } from "drizzle-orm"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import type { AdmissionRequest } from "../src/admission"
import { createApplicationAdapter } from "../src/application"
import { interactiveContextBudget, renderContextSnapshot, type ContextSidecarAttachment } from "../src/context-renderer"
import type { SessionPolicy } from "../src/session-facade"
import { makeTransferClient, makeTransferPeer } from "../src/transfer-client"
import { TransferError } from "../src/transfer-protocol"
import type { LeaseInput } from "../src/transfer-readiness"
import { makeOrchestrator, makeReadinessCoordinator, type Peer } from "../src/transfer-topology"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()

const workspaceID = "wrk_transfer_client"
const userID = "owner"
const sourceToken = "source-client-token"
const targetToken = "target-client-token"
const sessionID = "ses_transfer_client"
const cleanMessageID = "msg_client_clean"
const privateMessageID = "msg_client_private"
const privateFragment = "PRIVATE_CLIENT_FRAGMENT"
const publicCleanText = "public clean question"
const publicPrompt = "P".repeat(600 * 1024)

const reference = {
  contextCapsuleID: "capsule-client",
  sourceCtxPackID: "pack-client",
  label: "Client Reference",
  contentHash: "reference-client-hash",
} as const

const attachment = {
  contextCapsuleID: reference.contextCapsuleID,
  label: reference.label,
  contentHash: reference.contentHash,
  source: { kind: "ctxpack" as const, ctxPackID: reference.sourceCtxPackID },
}

const referenceID = JSON.stringify({
  contextCapsuleID: reference.contextCapsuleID,
  sourceCtxPackID: reference.sourceCtxPackID,
  label: reference.label,
})

const ReferenceID = Schema.Struct({
  contextCapsuleID: Schema.String,
  sourceCtxPackID: Schema.String,
  label: Schema.String,
})

const HistoryResponse = Schema.Struct({
  version: Schema.Number,
  sourceSnapshotToken: Schema.String,
  manifestDigest: Schema.String,
  highWater: Schema.Record(Schema.String, Schema.Number),
  page: Schema.Struct({ records: Schema.Array(Schema.Unknown) }),
  nextCursor: Schema.optional(Schema.String),
})

const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String })
const ActionBody = Schema.Struct({ action: Schema.String })

type PolicyState = {
  readonly freeze: AdmissionRequest[]
  readonly authorize: AdmissionRequest[]
}

type RequestOptions = {
  readonly method?: string
  readonly body?: unknown
  readonly raw?: string
  readonly credentials?: string | false
  readonly headers?: HeadersInit
}

type AppHandle = {
  readonly app: Awaited<ReturnType<typeof createApplicationAdapter>>
  readonly server: ReturnType<typeof Bun.serve>
  readonly state: PolicyState
  readonly requests: LLMRequest[]
  readonly request: (path: string, options?: RequestOptions) => Promise<Response>
  readonly stop: () => Promise<void>
}

type Pair = {
  readonly root: string
  readonly directory: string
  readonly source: AppHandle
  readonly target: AppHandle
}

function parseJson(text: string): unknown {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(parsed)) throw new Error("Response was not JSON")
  return parsed.value
}

async function scalar(app: AppHandle, query: SQL): Promise<number> {
  const row = await app.app.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.get<{ count: number }>(query)
  }))
  return row?.count ?? 0
}

const countEvents = (app: AppHandle) => scalar(app, sql`SELECT COUNT(*) AS count FROM event`)

function createPolicy(state: PolicyState): SessionPolicy {
  return () => ({
    managed: () => Effect.succeed(true),
    authorize: (request) => Effect.sync(() => { state.authorize.push(request) }),
    freeze: (request) => Effect.sync(() => {
      state.freeze.push(request)
      if (request.references.length === 0) return { apiContent: request.text, rendererVersion: 1 }
      const attachments = request.references.map((item): ContextSidecarAttachment => {
        const parsed = Schema.decodeUnknownSync(ReferenceID)(parseJson(item.id))
        return {
          selection: "explicit",
          contextCapsuleID: parsed.contextCapsuleID,
          sourceCtxPackID: parsed.sourceCtxPackID,
          label: parsed.label,
          tags: ["ParallelPlan"],
          contentHash: item.contentHash,
          fragments: [{ contentHash: reference.contentHash, text: privateFragment }],
        }
      })
      const snapshot = renderContextSnapshot({
        promptText: request.text,
        attachments,
        recall: { policy: "disabled", status: "disabled" },
        budget: interactiveContextBudget,
        createdAt: 42,
      })
      return { apiContent: snapshot.apiContent, rendererVersion: snapshot.rendererVersion, context: snapshot.snapshot }
    }),
  })
}

async function createApp(input: {
  readonly filename: string
  readonly token: string
  readonly directory: string
}): Promise<AppHandle> {
  const state: PolicyState = { freeze: [], authorize: [] }
  const requests: LLMRequest[] = []
  const model = Model.make({ id: "transfer-client-model", provider: "proof", route })
  const app = await createApplicationAdapter({
    filename: input.filename,
    directory: input.directory,
    workspaceID,
    userID,
    token: input.token,
    isolated: true,
    policy: createPolicy(state),
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) })
  let stopped = false
  return {
    app,
    server,
    state,
    requests,
    request: (path, options = {}) => {
      const headers = new Headers(options.headers)
      if (options.credentials !== false) headers.set("authorization", options.credentials ?? `Bearer ${input.token}`)
      const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
      if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
      return fetch(new URL(path, server.url), { method: options.method ?? "GET", headers, body })
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      server.stop(true)
      await app.dispose()
    },
  }
}

async function withPair(run: (pair: Pair) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cybermastery-transfer-client-"))
  cleanup(root)
  const directory = join(root, "native")
  await mkdir(directory, { recursive: true })
  const source = await createApp({ filename: join(root, "source.db"), token: sourceToken, directory })
  const target = await createApp({ filename: join(root, "target.db"), token: targetToken, directory })
  try {
    await run({ root, directory, source, target })
  } finally {
    await source.stop()
    await target.stop()
  }
}

async function admit(pair: Pair) {
  const created = await pair.source.request("/api/session", { method: "POST", body: { id: sessionID } })
  expect(created.status).toBe(200)
  const cleanPrompt = { id: cleanMessageID, prompt: { text: publicCleanText }, resume: false }
  const clean = await pair.source.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: cleanPrompt })
  expect(clean.status).toBe(200)
  const proof = { topologyRevision: "client-revision", requestToken: "b".repeat(64) }
  const granted = await pair.source.request("/sync/start", { method: "POST", body: {
    version: 1,
    action: "grant",
    workspaceID,
    topologyRevision: proof.topologyRevision,
    expiresAt: Date.now() + 60_000,
    requestToken: proof.requestToken,
  } })
  expect(granted.status).toBe(200)
  const privatePrompt = {
    id: privateMessageID,
    prompt: { text: publicPrompt },
    resume: false,
    contextAttachments: [attachment],
  }
  const admitted = await pair.source.request(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: privatePrompt,
    headers: {
      "x-opencode-session-context-topology": proof.topologyRevision,
      "x-opencode-session-context-lease": proof.requestToken,
    },
  })
  expect(admitted.status).toBe(200)
  return { proof, cleanPrompt, privatePrompt }
}

/** A small public-only session whose history fits a single terminal data page. */
async function seedSmallSession(pair: Pair) {
  const created = await pair.source.request("/api/session", { method: "POST", body: { id: sessionID } })
  expect(created.status).toBe(200)
  const clean = await pair.source.request(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: { id: cleanMessageID, prompt: { text: publicCleanText }, resume: false },
  })
  expect(clean.status).toBe(200)
}

function clientFor(pair: Pair) {
  return makeTransferClient({
    source: { url: pair.source.server.url.toString(), headers: { authorization: `Bearer ${sourceToken}` } },
    receiver: { url: pair.target.server.url.toString(), headers: { authorization: `Bearer ${targetToken}` } },
    directory: pair.directory,
    workspaceID,
  })
}

function fakeClient(source: string, receiver: string) {
  return makeTransferClient({
    source: { url: source, headers: { authorization: "Bearer source-token" } },
    receiver: { url: receiver, headers: { authorization: "Bearer receiver-token" } },
    directory: "/tmp/transfer-client",
  })
}

test("client synchronizes clean and tagged private context between real application servers", async () => {
  await withPair(async (pair) => {
    await admit(pair)
    const result = await Effect.runPromise(clientFor(pair).synchronize)
    expect(result.sessions).toBeGreaterThanOrEqual(1)
    expect(result.pages).toBeGreaterThanOrEqual(1)
    expect(result.receipts).toHaveLength(1)

    const sourceDb = await pair.source.app.runtime.runPromise(Database.Service)
    const targetDb = await pair.target.app.runtime.runPromise(Database.Service)
    expect(await countEvents(pair.target)).toBe(await countEvents(pair.source))
    const sourceEventIDs = await pair.source.app.runtime.runPromise(sourceDb.db.all<{ id: string }>(sql`SELECT id FROM event ORDER BY id`))
    const targetEventIDs = await pair.target.app.runtime.runPromise(targetDb.db.all<{ id: string }>(sql`SELECT id FROM event ORDER BY id`))
    expect(targetEventIDs).toEqual(sourceEventIDs)

    const sourcePrivate = await pair.source.app.runtime.runPromise(sourceDb.db.get<{ api_content: string }>(sql`
      SELECT api_content FROM cm_private_input WHERE message_id = ${privateMessageID}`))
    const targetPrivate = await pair.target.app.runtime.runPromise(targetDb.db.get<{ api_content: string }>(sql`
      SELECT api_content FROM cm_private_input WHERE message_id = ${privateMessageID}`))
    expect(targetPrivate).toEqual(sourcePrivate)
    expect(sourcePrivate?.api_content).toContain(privateFragment)

    const targetEvents = await pair.target.app.runtime.runPromise(targetDb.db.all(sql`SELECT * FROM event`))
    expect(JSON.stringify(targetEvents)).not.toContain(privateFragment)

    // The large public prompt forces chunk-only pages and more than one page.
    expect(result.pages).toBeGreaterThan(1)
    // Neither side ran a provider turn during replay.
    expect(pair.source.requests).toHaveLength(0)
    expect(pair.target.requests).toHaveLength(0)
  })
}, 60_000)

test("repeated client synchronization reconciles exactly at the target", async () => {
  await withPair(async (pair) => {
    await admit(pair)
    const client = clientFor(pair)
    const first = await Effect.runPromise(client.synchronize)
    const eventsAfterFirst = await countEvents(pair.target)
    const second = await Effect.runPromise(client.synchronize)
    expect(second.receipts).toHaveLength(1)
    expect(second.pages).toBe(first.pages)
    expect(await countEvents(pair.target)).toBe(eventsAfterFirst)
  })
}, 60_000)

test("completed source snapshots are evicted before new admissions fail busy", async () => {
  await withPair(async (pair) => {
    await seedSmallSession(pair)
    for (let index = 0; index < 10; index++) {
      const capability = await pair.source.request("/sync/history", { method: "POST", body: {
        version: 1,
        capabilityOnly: true,
        aggregates: {},
      } })
      expect(capability.status).toBe(200)
      const token = Schema.decodeUnknownSync(HistoryResponse)(parseJson(await capability.text())).sourceSnapshotToken
      const data = await pair.source.request("/sync/history", { method: "POST", body: {
        version: 1,
        capabilityOnly: false,
        aggregates: {},
        sourceSnapshotToken: token,
      } })
      expect(data.status).toBe(200)
    }
  })
}, 60_000)

test("unfinished source snapshots are never evicted to satisfy admission", async () => {
  await withPair(async (pair) => {
    // Eight capability-only probes that were never consumed stay unfinished.
    for (let index = 0; index < 8; index++) {
      const response = await pair.source.request("/sync/history", { method: "POST", body: {
        version: 1,
        capabilityOnly: true,
        aggregates: {},
        discoveryCursor: `zzz-unfinished-${index}`,
      } })
      expect(response.status).toBe(200)
    }
    const busy = await pair.source.request("/sync/history", { method: "POST", body: {
      version: 1,
      capabilityOnly: true,
      aggregates: {},
    } })
    expect(busy.status).toBe(503)
    expect(Schema.decodeUnknownSync(ErrorBody)(parseJson(await busy.text())).code).toBe("busy")
  })
}, 60_000)

test("an evicted completed snapshot restarts instead of rebinding data", async () => {
  await withPair(async (pair) => {
    await seedSmallSession(pair)
    const capability = await pair.source.request("/sync/history", { method: "POST", body: {
      version: 1,
      capabilityOnly: true,
      aggregates: {},
    } })
    const token = Schema.decodeUnknownSync(HistoryResponse)(parseJson(await capability.text())).sourceSnapshotToken
    const data = await pair.source.request("/sync/history", { method: "POST", body: {
      version: 1,
      capabilityOnly: false,
      aggregates: {},
      sourceSnapshotToken: token,
    } })
    expect(data.status).toBe(200)

    // Fill the cache with unfinished probes so the completed snapshot is reclaimed.
    for (let index = 0; index < 8; index++) {
      const response = await pair.source.request("/sync/history", { method: "POST", body: {
        version: 1,
        capabilityOnly: true,
        aggregates: {},
        discoveryCursor: `yyy-pressure-${index}`,
      } })
      expect(response.status).toBe(200)
    }

    const restarted = await pair.source.request("/sync/history", { method: "POST", body: {
      version: 1,
      capabilityOnly: false,
      aggregates: {},
      sourceSnapshotToken: token,
    } })
    expect(restarted.status).toBe(409)
    expect(Schema.decodeUnknownSync(ErrorBody)(parseJson(await restarted.text())).code).toBe("restart")
  })
}, 60_000)

test("client rejects non-confidential remote HTTP before any network request", async () => {
  let hits = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits += 1; return Response.json({}) } })
  try {
    const client = fakeClient(`http://localhost:${server.port}/`, server.url.toString())
    const error = await Effect.runPromise(client.synchronize.pipe(Effect.flip))
    expect(error instanceof TransferError).toBe(true)
    expect(error instanceof TransferError && error.code).toBe("forbidden")
    expect(hits).toBe(0)
  } finally {
    server.stop(true)
  }
}, 30_000)

test("client rejects redirects without forwarding credentials or body", async () => {
  let forwarded = 0
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => { forwarded += 1; return Response.json({}) },
  })
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 302, headers: { location: destination.url.toString() } }),
  })
  try {
    const client = fakeClient(redirect.url.toString(), destination.url.toString())
    const error = await Effect.runPromise(client.synchronize.pipe(Effect.flip))
    expect(error instanceof TransferError).toBe(true)
    expect(forwarded).toBe(0)
  } finally {
    redirect.stop(true)
    destination.stop(true)
  }
}, 30_000)

test("client rejects a missing or wrong body version", async () => {
  const wrong = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ version: 2, aggregates: [], sourceSnapshotToken: "t", manifestDigest: "sha256:m", highWater: {}, page: { records: [] } }),
  })
  const missing = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ aggregates: [], sourceSnapshotToken: "t", manifestDigest: "sha256:m", highWater: {}, page: { records: [] } }),
  })
  try {
    const wrongError = await Effect.runPromise(fakeClient(wrong.url.toString(), wrong.url.toString()).synchronize.pipe(Effect.flip))
    expect(wrongError instanceof TransferError && wrongError.code).toBe("version")
    const missingError = await Effect.runPromise(fakeClient(missing.url.toString(), missing.url.toString()).synchronize.pipe(Effect.flip))
    expect(missingError instanceof TransferError && missingError.code).toBe("version")
  } finally {
    wrong.stop(true)
    missing.stop(true)
  }
}, 30_000)

test("client rejects a header version that is not 1", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(
      { version: 1, aggregates: [], sourceSnapshotToken: "t", manifestDigest: "sha256:m", highWater: {}, page: { records: [] } },
      { headers: { "x-opencode-session-sync-version": "2" } },
    ),
  })
  try {
    const error = await Effect.runPromise(fakeClient(server.url.toString(), server.url.toString()).synchronize.pipe(Effect.flip))
    expect(error instanceof TransferError && error.code).toBe("version")
  } finally {
    server.stop(true)
  }
}, 30_000)

test("client rejects a mismatched page binding", async () => {
  let calls = 0
  const manifest = { aggregateID: "ses_x", sourceSeq: 0, privateCount: 1, privateDigest: "sha256:p", deletionCount: 0, deletionDigest: "sha256:n" }
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls += 1
      if (calls === 1)
        return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [] } })
      return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-b", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [] } })
    },
  })
  const receiver = fakeReceiver()
  try {
    const error = await Effect.runPromise(fakeClient(source.url.toString(), receiver.server.url.toString()).synchronize.pipe(Effect.flip))
    expect(error instanceof TransferError && error.code).toBe("snapshot-advanced")
  } finally {
    source.stop(true)
    receiver.server.stop(true)
  }
}, 30_000)

test("client rejects a wrong append acknowledgement and aborts the handle", async () => {
  const manifest = { aggregateID: "ses_x", sourceSeq: 0, privateCount: 1, privateDigest: "sha256:p", deletionCount: 0, deletionDigest: "sha256:n" }
  const record = { kind: "event", aggregateID: "ses_x", sourceSeq: 0, sequence: 0, identity: "e1", value: { seq: 0, id: "e1", aggregateID: "ses_x" } }
  let calls = 0
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls += 1
      if (calls === 1)
        return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [] } })
      return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [record] } })
    },
  })
  const receiver = fakeReceiver({ appendNext: 99 })
  try {
    const error = await Effect.runPromise(fakeClient(source.url.toString(), receiver.server.url.toString()).synchronize.pipe(Effect.flip))
    expect(error instanceof TransferError && error.code).toBe("invalid")
    expect(receiver.requests).toContain("abort")
  } finally {
    source.stop(true)
    receiver.server.stop(true)
  }
}, 30_000)

test("client aborts the receiver handle after a mid-transfer HTTP failure", async () => {
  const manifest = { aggregateID: "ses_x", sourceSeq: 0, privateCount: 1, privateDigest: "sha256:p", deletionCount: 0, deletionDigest: "sha256:n" }
  const record = { kind: "event", aggregateID: "ses_x", sourceSeq: 0, sequence: 0, identity: "e1", value: { seq: 0, id: "e1", aggregateID: "ses_x" } }
  let calls = 0
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls += 1
      if (calls === 1)
        return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [] } })
      if (calls === 2)
        return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [record] }, nextCursor: "next-page" })
      return new Response(JSON.stringify({ code: "conflict", message: "boom" }), { status: 409, headers: { "content-type": "application/json" } })
    },
  })
  const receiver = fakeReceiver()
  try {
    const error = await Effect.runPromise(fakeClient(source.url.toString(), receiver.server.url.toString()).synchronize.pipe(Effect.flip))
    expect(error instanceof TransferError).toBe(true)
    expect(receiver.requests).toContain("abort")
  } finally {
    source.stop(true)
    receiver.server.stop(true)
  }
}, 30_000)

test("client aborts the receiver handle when the synchronize fiber is interrupted", async () => {
  const manifest = { aggregateID: "ses_x", sourceSeq: 0, privateCount: 1, privateDigest: "sha256:p", deletionCount: 0, deletionDigest: "sha256:n" }
  const record = { kind: "event", aggregateID: "ses_x", sourceSeq: 0, sequence: 0, identity: "e1", value: { seq: 0, id: "e1", aggregateID: "ses_x" } }
  let releaseHold: () => void = () => {}
  const hold = new Promise<void>((resolve) => { releaseHold = resolve })
  let signalReached: () => void = () => {}
  const reached = new Promise<void>((resolve) => { signalReached = resolve })
  let calls = 0
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      calls += 1
      if (calls === 1)
        return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [] } })
      if (calls === 2)
        return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [record] }, nextCursor: "next-page" })
      signalReached()
      await hold
      return Response.json({ version: 1, aggregates: [manifest], sourceSnapshotToken: "token-a", manifestDigest: "sha256:manifest", highWater: { ses_x: 0 }, page: { records: [record] } })
    },
  })
  const receiver = fakeReceiver()
  try {
    const fiber = Effect.runFork(fakeClient(source.url.toString(), receiver.server.url.toString()).synchronize)
    await reached
    await Effect.runPromise(Fiber.interrupt(fiber))
    releaseHold()
    expect(receiver.requests).toContain("abort")
  } finally {
    source.stop(true)
    receiver.server.stop(true)
  }
}, 30_000)

test("makeTransferPeer drives real /sync/start and revocation clears local proofs", async () => {
  await withPair(async (pair) => {
    await seedSmallSession(pair)
    const peer = makeTransferPeer({
      url: pair.source.server.url.toString(),
      headers: { authorization: `Bearer ${sourceToken}` },
      workspaceID,
    })
    const leases: LeaseInput[] = []
    const recording: Peer = {
      ...peer,
      grant: (lease) => peer.grant(lease).pipe(Effect.tap(() => Effect.sync(() => { leases.push(lease) }))),
      revoke: (lease) => peer.revoke(lease).pipe(Effect.tap(() => Effect.sync(() => { leases.push(lease) }))),
    }
    const coordinator = makeReadinessCoordinator()
    const orchestrator = makeOrchestrator({ coordinator })
    const activated = await Effect.runPromise(orchestrator.activate([recording]))
    expect(activated).toBeDefined()
    const revision = orchestrator.revision()
    if (revision === undefined) throw new Error("Missing active topology revision")
    expect(coordinator.proof(workspaceID)).toBeDefined()

    const grant = leases[0]
    expect(grant?.workspaceID).toBe(workspaceID)
    expect(grant?.topologyRevision).toBe(revision)
    expect(grant?.requestToken).toBeTruthy()

    const transferRequired = await Effect.runPromise(orchestrator.beforeMutation)
    expect(typeof transferRequired).toBe("boolean")
    expect(coordinator.proof(workspaceID)).toBeUndefined()
  })
}, 60_000)

test("a mismatched lease acknowledgement fails the peer grant", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ version: 1, acceptedRevision: "other-revision", expiresAt: Date.now() + 60_000, transferRequired: true }),
  })
  try {
    const peer = makeTransferPeer({ url: server.url.toString(), headers: { authorization: "Bearer fake" }, workspaceID })
    const lease: LeaseInput = {
      version: 1,
      workspaceID,
      topologyRevision: "expected-revision",
      requestToken: "c".repeat(64),
      expiresAt: Date.now() + 60_000,
    }
    const error = await Effect.runPromise(peer.grant(lease).pipe(Effect.flip))
    expect(error instanceof TransferError).toBe(true)
  } finally {
    server.stop(true)
  }
}, 30_000)

function fakeReceiver(overrides: { readonly appendNext?: number } = {}) {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const action = Schema.decodeUnknownSync(ActionBody)(parseJson(await request.text())).action
      requests.push(action)
      if (action === "begin")
        return Response.json({ version: 1, action: "begin", transferHandle: "handle-1", expiresAt: Date.now() + 60_000 })
      if (action === "append")
        return Response.json({ version: 1, action: "append", transferHandle: "handle-1", nextPageIndex: overrides.appendNext ?? 1 })
      if (action === "abort")
        return Response.json({ version: 1, action: "abort", transferHandle: "handle-1" })
      return Response.json({ version: 1, action: "finalize", manifestReceipt: "receipt-1" })
    },
  })
  return { server, requests }
}
