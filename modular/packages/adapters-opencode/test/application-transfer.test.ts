/**
 * Wave 13 worker 1 — real-network application transfer acceptance.
 *
 * This suite composes two real `createApplicationAdapter` graphs (separate
 * SQLite files, the same trusted native directory/project/workspace/user
 * placement, distinct host tokens) behind two ephemeral `Bun.serve` instances
 * and drives them exclusively through `fetch` with Schema-validated JSON.
 *
 * Guarantees exercised here (all through the public adapter surface, no faked
 * projection/transfer/native services):
 *  - A fresh source Session admits a clean prompt without freezing, then admits
 *    a tagged V2 private snapshot once a valid readiness lease is granted and
 *    the proof is supplied in both context headers.
 *  - `/sync/history` capability probing never returns private payload, the same
 *    snapshot token paginates the data pull, and every canonical page stays
 *    within `MAX_SYNC_PAGE_BYTES`; large public prompts produce chunk-only pages
 *    and more than one page.
 *  - Replaying those pages into a target app transfers public events verbatim
 *    while keeping private content out of native messages/events; private
 *    inputs and legacy snapshots match the source exactly.
 *  - Exact clean/private prompt retries reconcile at the target without a target
 *    lease, a freeze, or a provider turn; changed content conflicts.
 *  - Finalize is idempotent, its receipt survives a target restart with a fresh
 *    spool, and error paths never leak private payloads or mutate the target.
 *
 * Uncertainties (reported rather than hidden):
 *  - The `/sync/history` continuation contract is inferred from the attached
 *    request/response schemas: this suite keeps `aggregates` empty and advances
 *    only `pageCursor` with the original `sourceSnapshotToken`.
 *  - Durable finalize receipts across an app restart are assumed to be stored in
 *    the native database (the spool root is rebuilt empty); the restart case
 *    asserts that behavior directly.
 *  - The `cm_private_input.request_hash` "legacy:" prefix for a transferred
 *    private identity is asserted from the brief.
 */
import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, LLMEvent, LLMRequest, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Session } from "@opencode-ai/schema/session"
import { sql, type SQL } from "drizzle-orm"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import type { AdmissionRequest } from "../src/admission"
import { createApplicationAdapter } from "../src/application"
import { interactiveContextBudget, renderContextSnapshot, type ContextSidecarAttachment } from "../src/context-renderer"
import type { SessionPolicy } from "../src/session-facade"
import { MAX_SYNC_PAGE_BYTES, canonical, digest } from "../src/transfer-spool"
import { makeTransferClient } from "../src/transfer-client"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()

const workspaceID = "wrk_transfer_e2e"
const userID = "owner"
const sourceToken = "source-transfer-token"
const targetToken = "target-transfer-token"
const sessionID = "ses_transfer_e2e"
const cleanMessageID = "msg_transfer_clean"
const privateMessageID = "msg_transfer_private"
const privateFragment = "PRIVATE_TRANSFER_FRAGMENT"
const publicCleanText = "public clean question"
const publicPrompt = "P".repeat(600 * 1024)

const reference = {
  contextCapsuleID: "capsule-transfer",
  sourceCtxPackID: "pack-transfer",
  label: "Transfer Reference",
  contentHash: "reference-transfer-hash",
} as const

/** Mirrors the Session HTTP `contextAttachments` element shape. */
const attachment = {
  contextCapsuleID: reference.contextCapsuleID,
  label: reference.label,
  contentHash: reference.contentHash,
  source: { kind: "ctxpack" as const, ctxPackID: reference.sourceCtxPackID },
}

/** The reference identity the Session facade derives from the attachment. */
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

const SessionInfoResponse = Schema.Struct({ data: Session.Info })

const HistoryResponse = Schema.Struct({
  version: Schema.Number,
  sourceSnapshotToken: Schema.String,
  manifestDigest: Schema.String,
  highWater: Schema.Record(Schema.String, Schema.Number),
  page: Schema.Struct({ records: Schema.Array(Schema.Unknown) }),
  nextCursor: Schema.optional(Schema.String),
})

const BeginResponse = Schema.Struct({
  version: Schema.Number,
  action: Schema.Literal("begin"),
  transferHandle: Schema.String,
  expiresAt: Schema.Number,
})

const AppendResponse = Schema.Struct({
  version: Schema.Number,
  action: Schema.Literal("append"),
  transferHandle: Schema.String,
  nextPageIndex: Schema.Number,
})

const FinalizeResponse = Schema.Struct({
  version: Schema.Number,
  action: Schema.Literal("finalize"),
  manifestReceipt: Schema.String,
})

const ChunkRecord = Schema.Struct({ kind: Schema.Literal("chunk") })

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

type PromptBody = {
  readonly id: string
  readonly prompt: { readonly text: string }
  readonly resume: boolean
  readonly contextAttachments?: readonly unknown[]
}

type WirePage = { readonly records: readonly unknown[] }

type TransferResult = {
  readonly cleanPrompt: PromptBody
  readonly privatePrompt: PromptBody
  readonly cleanBody: unknown
  readonly admittedBody: unknown
  readonly proof: { readonly topologyRevision: string; readonly requestToken: string }
  readonly freezeAfterClean: number
  readonly privateRowsAfterClean: number
  readonly capabilityText: string
  readonly snapshotToken: string
  readonly manifestDigest: string
  readonly highWater: Readonly<Record<string, number>>
  readonly pages: readonly WirePage[]
  readonly transferHandle: string
  readonly finalizeBody: unknown
  readonly receipt: string
}

function parseJson(text: string): unknown {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(parsed)) throw new Error("Response was not JSON")
  return parsed.value
}

function isChunk(record: unknown): boolean {
  return Option.isSome(Schema.decodeUnknownOption(ChunkRecord)(record))
}

/**
 * Counts rows for a fixed aggregate query. Table names are literals, so the
 * interpolation-free SQL carries no caller-controlled identifiers.
 */
async function scalar(app: AppHandle, query: SQL): Promise<number> {
  const row = await app.app.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.get<{ count: number }>(query)
  }))
  return row?.count ?? 0
}

const countEvents = (app: AppHandle) => scalar(app, sql`SELECT COUNT(*) AS count FROM event`)

test("native Session revert transfers its local deletion without replaying a provider", async () => {
  await withPair(async (pair) => {
    await transferAll(pair)
    expect((await pair.source.request(`/api/cybermastery/session/${sessionID}/resume`, { method: "POST" })).status).toBe(204)
    expect(pair.source.requests).toHaveLength(1)
    expect((await pair.source.request(`/api/session/${sessionID}/revert/stage`, {
      method: "POST", body: { messageID: cleanMessageID, files: false },
    })).status).toBe(200)
    expect((await pair.source.request(`/api/session/${sessionID}/revert/commit`, { method: "POST" })).status).toBe(204)
    expect(await scalar(pair.source, sql`SELECT COUNT(*) AS count FROM session_input WHERE id = ${privateMessageID}`)).toBe(0)
    const client = makeTransferClient({
      source: { url: pair.source.server.url.toString(), headers: { authorization: `Bearer ${sourceToken}` } },
      receiver: { url: pair.target.server.url.toString(), headers: { authorization: `Bearer ${targetToken}` } },
      directory: pair.directory, workspaceID,
    })
    expect((await Effect.runPromise(client.synchronize)).sessions).toBe(1)
    expect(await scalar(pair.target, sql`SELECT COUNT(*) AS count FROM session_input WHERE id = ${privateMessageID}`)).toBe(0)
    expect(await scalar(pair.target, sql`SELECT COUNT(*) AS count FROM cm_private_input WHERE message_id = ${privateMessageID}`)).toBe(0)
    const proof = await pair.target.app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* database.db.get<{ proof_json: string }>(sql`SELECT proof_json FROM cm_legacy_deletion
        WHERE aggregate_id = ${sessionID} AND message_id = ${privateMessageID}`)
    }))
    if (!proof) throw new Error("Missing transferred native-revert proof")
    expect(parseJson(proof.proof_json)).toMatchObject({ deletionCause: "input-promoted-seq" })
    expect(pair.source.requests).toHaveLength(1)
    expect(pair.target.requests).toEqual([])
    const messages = await pair.target.request(`/api/session/${sessionID}/message`)
    expect(await messages.text()).not.toContain(privateFragment)
  })
}, 60_000)

/**
 * Host policy that records admission decisions and renders a real V2 snapshot
 * for explicit references, exactly as a host composition would.
 */
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
          fragments: [{ contentHash: digest(privateFragment), text: privateFragment }],
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
  const model = Model.make({ id: "application-transfer-model", provider: "proof", route })
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
  const root = await mkdtemp(join(tmpdir(), "cybermastery-transfer-"))
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

/**
 * Performs the full source admission + history pull + target replay and returns
 * the raw evidence each test asserts over. Transport stays in the adapter; this
 * helper never recomputes transfer semantics by copying implementation logic.
 */
async function transferAll(pair: Pair): Promise<TransferResult> {
  const { directory, source, target } = pair

  const created = await source.request("/api/session", { method: "POST", body: { id: sessionID } })
  expect(created.status).toBe(200)
  const info = Schema.decodeUnknownSync(SessionInfoResponse)(parseJson(await created.text())).data
  expect(info.location).toEqual({ directory: AbsolutePath.make(directory), workspaceID: WorkspaceV2.ID.make(workspaceID) })

  const cleanPrompt: PromptBody = { id: cleanMessageID, prompt: { text: publicCleanText }, resume: false }
  const cleanResponse = await source.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: cleanPrompt })
  expect(cleanResponse.status).toBe(200)
  const cleanBody = parseJson(await cleanResponse.text())
  const freezeAfterClean = source.state.freeze.length
  const privateRowsAfterClean = await scalar(source, sql`SELECT COUNT(*) AS count FROM cm_private_input`)

  const proof = { topologyRevision: "transfer-revision", requestToken: "a".repeat(64) }
  const granted = await source.request("/sync/start", { method: "POST", body: {
    version: 1,
    action: "grant",
    workspaceID,
    topologyRevision: proof.topologyRevision,
    expiresAt: Date.now() + 60_000,
    requestToken: proof.requestToken,
  } })
  expect(granted.status).toBe(200)

  const privatePrompt: PromptBody = {
    id: privateMessageID,
    prompt: { text: publicPrompt },
    resume: false,
    contextAttachments: [attachment],
  }
  const admitted = await source.request(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: privatePrompt,
    headers: {
      "x-opencode-session-context-topology": proof.topologyRevision,
      "x-opencode-session-context-lease": proof.requestToken,
    },
  })
  expect(admitted.status).toBe(200)
  const admittedBody = parseJson(await admitted.text())

  const capability = await source.request("/sync/history", { method: "POST", body: {
    version: 1,
    capabilityOnly: true,
    aggregates: {},
  } })
  expect(capability.status).toBe(200)
  const capabilityText = await capability.text()
  const capabilityBody = Schema.decodeUnknownSync(HistoryResponse)(parseJson(capabilityText))
  expect(capabilityBody.page.records).toHaveLength(0)
  const snapshotToken = capabilityBody.sourceSnapshotToken

  const pages: WirePage[] = []
  let pageCursor: string | undefined = undefined
  let manifestDigest = capabilityBody.manifestDigest
  let highWater: Readonly<Record<string, number>> = { ...capabilityBody.highWater }
  while (true) {
    const response = await source.request("/sync/history", { method: "POST", body: {
      version: 1,
      capabilityOnly: false,
      aggregates: {},
      sourceSnapshotToken: snapshotToken,
      ...(pageCursor === undefined ? {} : { pageCursor }),
    } })
    expect(response.status).toBe(200)
    const body = Schema.decodeUnknownSync(HistoryResponse)(parseJson(await response.text()))
    expect(Buffer.byteLength(canonical(body))).toBeLessThanOrEqual(MAX_SYNC_PAGE_BYTES)
    pages.push(body.page)
    manifestDigest = body.manifestDigest
    highWater = { ...body.highWater }
    if (body.nextCursor === undefined) break
    pageCursor = body.nextCursor
  }
  const firstPage = pages[0]
  if (!firstPage) throw new Error("History produced no pages")

  const begin = await target.request("/sync/replay", { method: "POST", body: {
    version: 1,
    action: "begin",
    clientTransferID: "transfer-e2e",
    directory,
    sourceSnapshotToken: snapshotToken,
    highWater,
    manifestDigest,
    expiresAt: Date.now() + 120_000,
  } })
  expect(begin.status).toBe(200)
  const transferHandle = Schema.decodeUnknownSync(BeginResponse)(parseJson(await begin.text())).transferHandle

  for (const [index, page] of pages.entries()) {
    const appended = await target.request("/sync/replay", { method: "POST", body: {
      version: 1,
      action: "append",
      transferHandle,
      pageIndex: index,
      pageHash: digest(canonical(page)),
      page,
    } })
    expect(appended.status).toBe(200)
    expect(Schema.decodeUnknownSync(AppendResponse)(parseJson(await appended.text())).nextPageIndex).toBe(index + 1)
  }

  const retry = await target.request("/sync/replay", { method: "POST", body: {
    version: 1,
    action: "append",
    transferHandle,
    pageIndex: 0,
    pageHash: digest(canonical(firstPage)),
    page: firstPage,
  } })
  expect(retry.status).toBe(200)

  const finalizeBody = { version: 1, action: "finalize", transferHandle, expectedPageCount: pages.length, manifestDigest }
  const finalized = await target.request("/sync/replay", { method: "POST", body: finalizeBody })
  expect(finalized.status).toBe(200)
  const receipt = Schema.decodeUnknownSync(FinalizeResponse)(parseJson(await finalized.text())).manifestReceipt

  return {
    cleanPrompt, privatePrompt, cleanBody, admittedBody, proof, freezeAfterClean, privateRowsAfterClean,
    capabilityText, snapshotToken, manifestDigest, highWater, pages, transferHandle, finalizeBody, receipt,
  }
}

test("source admits clean then tagged V2 private context and transfers it to a second real server", async () => {
  await withPair(async (pair) => {
    const { source, target } = pair
    const result = await transferAll(pair)

    // 1. Clean admit-only never froze and never wrote private rows.
    expect(result.freezeAfterClean).toBe(0)
    expect(result.privateRowsAfterClean).toBe(0)
    // The private admit froze exactly once with the exact reference identity.
    expect(source.state.freeze).toHaveLength(1)
    expect(source.state.freeze[0]?.actor).toEqual({ userID, workspaceID })
    expect(source.state.freeze[0]?.references).toEqual([{ id: referenceID, contentHash: reference.contentHash }])
    expect(source.requests).toHaveLength(0)
    expect(target.requests).toHaveLength(0)

    // 2. Capability probe leaked no private payload; pagination actually happened.
    expect(result.capabilityText).not.toContain(privateFragment)
    expect(result.capabilityText).not.toContain("workspace-context")
    expect(result.capabilityText).not.toContain(publicPrompt.slice(0, 128))
    expect(result.pages.length).toBeGreaterThan(1)
    const chunkPages = result.pages.filter((page) => page.records.some(isChunk))
    expect(chunkPages.length).toBeGreaterThan(0)
    for (const page of result.pages) {
      const kinds = page.records.map(isChunk)
      expect(kinds.every((value) => value) || kinds.every((value) => !value)).toBe(true)
    }

    // 3. Target native state matches the source, private content never surfaces.
    const sourceDb = await source.app.runtime.runPromise(Database.Service)
    const targetDb = await target.app.runtime.runPromise(Database.Service)
    expect(await countEvents(target)).toBe(await countEvents(source))
    const sourceEventIDs = await source.app.runtime.runPromise(sourceDb.db.all<{ id: string }>(sql`SELECT id FROM event ORDER BY id`))
    const targetEventIDs = await target.app.runtime.runPromise(targetDb.db.all<{ id: string }>(sql`SELECT id FROM event ORDER BY id`))
    expect(targetEventIDs).toEqual(sourceEventIDs)

    const targetEvents = await target.app.runtime.runPromise(targetDb.db.all(sql`SELECT * FROM event`))
    expect(JSON.stringify(targetEvents)).not.toContain(privateFragment)
    expect(JSON.stringify(targetEvents)).not.toContain("workspace-context")

    const sourcePrivate = await source.app.runtime.runPromise(sourceDb.db.get<{
      api_content: string
      api_content_hash: string
      renderer_version: number
    }>(sql`SELECT api_content, api_content_hash, renderer_version FROM cm_private_input WHERE message_id = ${privateMessageID}`))
    const targetPrivate = await target.app.runtime.runPromise(targetDb.db.get<{
      api_content: string
      api_content_hash: string
      renderer_version: number
    }>(sql`SELECT api_content, api_content_hash, renderer_version FROM cm_private_input WHERE message_id = ${privateMessageID}`))
    expect(targetPrivate).toEqual(sourcePrivate)
    expect(sourcePrivate?.api_content).toContain(privateFragment)

    const sourceLegacy = await source.app.runtime.runPromise(sourceDb.db.all(sql`SELECT * FROM cm_legacy_input`))
    const targetLegacy = await target.app.runtime.runPromise(targetDb.db.all(sql`SELECT * FROM cm_legacy_input`))
    const canonicalRows = (rows: readonly unknown[]) => rows.map((row) => canonical(row)).sort()
    expect(canonicalRows(targetLegacy)).toEqual(canonicalRows(sourceLegacy))

    const targetClean = await target.app.runtime.runPromise(targetDb.db.all<{ request_hash: string }>(sql`SELECT request_hash FROM cm_clean_input`))
    expect(targetClean.some((row) => String(row.request_hash).startsWith("legacy:"))).toBe(true)
    const targetPrivateHash = await target.app.runtime.runPromise(targetDb.db.get<{ request_hash: string }>(sql`
      SELECT request_hash FROM cm_private_input WHERE message_id = ${privateMessageID}`))
    expect(String(targetPrivateHash?.request_hash).startsWith("legacy:")).toBe(true)

    const messages = await target.request(`/api/session/${sessionID}/message`)
    expect(messages.status).toBe(200)
    const messagesText = await messages.text()
    // Both inputs are admitted-only; replay must not promote them or run a provider.
    expect(parseJson(messagesText)).toMatchObject({ data: [] })
    expect(messagesText).not.toContain(privateFragment)

    const targetHistory = await target.request("/sync/history", { method: "POST", body: {
      version: 1,
      capabilityOnly: false,
      aggregates: {},
    } })
    expect(targetHistory.status).toBe(200)
    const targetHistoryBody = Schema.decodeUnknownSync(HistoryResponse)(parseJson(await targetHistory.text()))
    expect(targetHistoryBody.highWater).toEqual(result.highWater)

    // Replay never started a provider on either side.
    expect(source.requests).toHaveLength(0)
    expect(target.requests).toHaveLength(0)
  })
}, 60_000)

test("exact clean and private retries reconcile at the target without a lease, freeze or provider turn", async () => {
  await withPair(async (pair) => {
    const { source, target } = pair
    const result = await transferAll(pair)
    const freezeBefore = target.state.freeze.length

    const cleanRetry = await target.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: result.cleanPrompt })
    expect(cleanRetry.status).toBe(200)
    expect(parseJson(await cleanRetry.text())).toEqual(result.cleanBody)

    const privateRetry = await target.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: result.privatePrompt })
    expect(privateRetry.status).toBe(200)
    expect(parseJson(await privateRetry.text())).toEqual(result.admittedBody)
    expect(target.state.freeze).toHaveLength(freezeBefore)

    const changedReference = await target.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: {
      ...result.privatePrompt,
      contextAttachments: [{ ...attachment, contentHash: "changed-reference-hash" }],
    } })
    expect(changedReference.status).toBe(409)

    const changedText = await target.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: {
      ...result.privatePrompt,
      prompt: { text: "changed public prompt" },
    } })
    expect(changedText.status).toBe(409)

    const revoked = await source.request("/sync/start", { method: "POST", body: {
      version: 1,
      action: "revoke",
      workspaceID,
      topologyRevision: result.proof.topologyRevision,
      expiresAt: Date.now() + 60_000,
      requestToken: result.proof.requestToken,
    } })
    expect(revoked.status).toBe(200)

    const retryAfterRevoke = await target.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: result.privatePrompt })
    expect(retryAfterRevoke.status).toBe(200)
    expect(parseJson(await retryAfterRevoke.text())).toEqual(result.admittedBody)

    const newPrivate = await target.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: {
      id: "msg_transfer_new_private",
      prompt: { text: publicPrompt },
      resume: false,
      contextAttachments: [attachment],
    } })
    expect(newPrivate.status).toBe(400)

    expect(target.state.freeze).toHaveLength(freezeBefore)
    expect(target.requests).toHaveLength(0)
  })
}, 60_000)

test("finalize is idempotent and its durable receipt survives a target restart with a fresh spool", async () => {
  await withPair(async (pair) => {
    const { root, directory, source, target } = pair
    const result = await transferAll(pair)
    const eventsBefore = await countEvents(target)

    const repeated = await target.request("/sync/replay", { method: "POST", body: result.finalizeBody })
    expect(repeated.status).toBe(200)
    expect(Schema.decodeUnknownSync(FinalizeResponse)(parseJson(await repeated.text())).manifestReceipt).toBe(result.receipt)
    expect(await countEvents(target)).toBe(eventsBefore)

    const historyBody = { version: 1, capabilityOnly: true, aggregates: {} }
    const queryOnly = await target.request(`/sync/history?auth_token=${encodeURIComponent(`opencode:${targetToken}`)}`, {
      method: "POST",
      credentials: false,
      body: historyBody,
    })
    expect(queryOnly.status).toBe(401)
    const wrong = await target.request("/sync/history", { method: "POST", credentials: "Bearer wrong", body: historyBody })
    expect(wrong.status).toBe(401)
    const crossToken = await target.request("/sync/history", { method: "POST", credentials: `Bearer ${sourceToken}`, body: historyBody })
    expect(crossToken.status).toBe(401)
    const versioned = await target.request("/sync/history", { method: "POST", body: { version: 2, capabilityOnly: true, aggregates: {} } })
    expect(versioned.status).toBe(409)
    const malformed = await target.request("/sync/history", { method: "POST", raw: "{" })
    expect(malformed.status).toBe(400)
    const scopeMismatch = await target.request("/sync/replay", { method: "POST", body: {
      version: 1,
      action: "begin",
      clientTransferID: "scope-mismatch",
      directory: join(directory, "elsewhere"),
      sourceSnapshotToken: result.snapshotToken,
      highWater: result.highWater,
      manifestDigest: result.manifestDigest,
      expiresAt: Date.now() + 60_000,
    } })
    expect(scopeMismatch.status).toBe(403)
    const unknownHandle = await target.request("/sync/replay", { method: "POST", body: {
      version: 1,
      action: "append",
      transferHandle: "unknown-transfer-handle",
      pageIndex: 0,
      pageHash: digest("unknown"),
      page: { records: [] },
    } })
    expect(unknownHandle.status).toBe(403)

    for (const response of [queryOnly, wrong, crossToken, versioned, malformed, scopeMismatch, unknownHandle]) {
      expect(await response.text()).not.toContain(privateFragment)
    }
    expect(await countEvents(target)).toBe(eventsBefore)

    await target.stop()
    const restarted = await createApp({ filename: join(root, "target.db"), token: targetToken, directory })
    try {
      const afterRestart = await restarted.request("/sync/replay", { method: "POST", body: result.finalizeBody })
      expect(afterRestart.status).toBe(200)
      expect(Schema.decodeUnknownSync(FinalizeResponse)(parseJson(await afterRestart.text())).manifestReceipt).toBe(result.receipt)
      expect(await countEvents(restarted)).toBe(eventsBefore)
    } finally {
      await restarted.stop()
    }
  })
}, 60_000)
