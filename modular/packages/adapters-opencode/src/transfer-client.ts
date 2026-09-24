import { randomBytes } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import {
  TransferError,
  TransferErrorResponseSchema,
  TransferHistoryResponseSchema,
  TransferReplayResponseSchema,
  TransferStartResponseSchema,
} from "./transfer-protocol"
import {
  MAX_SYNC_PAGE_BYTES,
  MAX_SYNC_PUBLIC_EVENTS,
  MAX_SYNC_RECORD_CHUNKS,
  MAX_TRANSFER_BYTES,
  canonical,
  digest,
} from "./transfer-spool"
import { validateTarget, type Peer } from "./transfer-topology"
import type { LeaseInput } from "./transfer-readiness"

const MAX_SYNC_AGGREGATES = 128
const REQUEST_TIMEOUT_MS = 60_000
const OVERALL_TIMEOUT_MS = 30 * 60 * 1000
const CLEANUP_TIMEOUT_MS = 5_000
const TRANSFER_LEASE_MS = 30 * 60 * 1000

type TransferCode =
  | "invalid"
  | "forbidden"
  | "conflict"
  | "restart"
  | "snapshot-advanced"
  | "version"
  | "too-large"
  | "busy"
  | "expired"

const TRANSFER_CODES = new Set<string>([
  "invalid",
  "forbidden",
  "conflict",
  "restart",
  "snapshot-advanced",
  "version",
  "too-large",
  "busy",
  "expired",
])

type HistoryResponse = typeof TransferHistoryResponseSchema.Type
type ReplayResponse = typeof TransferReplayResponseSchema.Type
type StartResponse = typeof TransferStartResponseSchema.Type

export type TransferEndpointOptions = {
  readonly url: string
  readonly headers: HeadersInit
  readonly confidential?: boolean
}

export type TransferClientOptions = {
  readonly source: TransferEndpointOptions
  readonly receiver: TransferEndpointOptions
  readonly directory: string
  readonly workspaceID?: string
  readonly now?: () => number
}

export type TransferPeerOptions = {
  readonly url: string
  readonly headers: HeadersInit
  readonly confidential?: boolean
  readonly workspaceID?: string
}

type Endpoint = {
  readonly url: string
  readonly headers: Headers
  readonly confidential?: boolean
}

type PrivateRequest = Endpoint & {
  readonly path: string
  readonly signal: AbortSignal
}

type FrozenSnapshot = {
  readonly token: string
  readonly manifest: string
  readonly highWater: Readonly<Record<string, number>>
  readonly responseCursor: string | undefined
}

/**
 * Synchronous factory over a re-runnable synchronize effect. Endpoint URL and headers are frozen
 * here, and each operation validates its target before any network request. Credentials always
 * travel in an explicit Authorization header, never in the URL query or request body.
 */
export function makeTransferClient(options: TransferClientOptions) {
  const source: Endpoint = Object.freeze({
    url: options.source.url,
    headers: new Headers(options.source.headers),
    confidential: options.source.confidential,
  })
  const receiver: Endpoint = Object.freeze({
    url: options.receiver.url,
    headers: new Headers(options.receiver.headers),
    confidential: options.receiver.confidential,
  })
  const directory = options.directory
  const now = options.now ?? Date.now

  const synchronize: Effect.Effect<
    { readonly sessions: number; readonly pages: number; readonly receipts: readonly string[] },
    TransferError
  > = Effect.gen(function* () {
    yield* requireAuthorization(source.headers, "source")
    yield* requireAuthorization(receiver.headers, "receiver")
    const overall = AbortSignal.timeout(OVERALL_TIMEOUT_MS)
    const receipts: string[] = []
    let sessions = 0
    let pages = 0
    let requestCursor: string | undefined
    const discoveries = new Set<string>()
    while (true) {
      const capability = yield* fetchHistory(
        { ...source, path: "/sync/history", signal: overall },
        {
          version: 1,
          capabilityOnly: true,
          aggregates: {},
          ...(requestCursor === undefined ? {} : { discoveryCursor: requestCursor }),
        },
      )
      // A capability response must never smuggle private payload; discovery pages carry no records.
      if (capability.page.records.length !== 0)
        return yield* new TransferError({ code: "invalid", message: "capability response carried records" })
      if (capability.aggregates.length > MAX_SYNC_AGGREGATES)
        return yield* new TransferError({ code: "invalid", message: "too many discovered aggregates" })
      if (capability.aggregates.length > 0 && Object.keys(capability.highWater).length > 0) {
        const transferred = yield* transferSnapshot({ source, receiver, directory, now, requestCursor, capability, overall })
        sessions += capability.aggregates.length
        pages += transferred.pages
        receipts.push(transferred.receipt)
      }
      if (capability.discoveryCursor === undefined) break
      // A discovery cursor that does not advance would loop forever without making progress.
      if (discoveries.has(capability.discoveryCursor))
        return yield* new TransferError({ code: "conflict", message: "discovery cursor did not advance" })
      discoveries.add(capability.discoveryCursor)
      requestCursor = capability.discoveryCursor
    }
    return { sessions, pages, receipts }
  })

  return { synchronize }
}

/**
 * Remote readiness peer backed by the real `/sync/history` capability probe and `/sync/start`
 * grant/revoke. Mismatched acknowledgements fail the effect so an orchestrator can never activate
 * a topology from a stale or foreign lease.
 */
export function makeTransferPeer(options: TransferPeerOptions): Peer {
  const endpoint = new URL(options.url).toString()
  const headers = new Headers(options.headers)
  const confidential = options.confidential
  const post = (path: string, body: unknown) => Effect.suspend(() =>
    postJson({ url: endpoint, path, headers, confidential, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, body))
  return {
    workspaceID: options.workspaceID,
    endpoint,
    version: 1,
    probe: post("/sync/history", { version: 1, capabilityOnly: true, aggregates: {} }).pipe(Effect.flatMap(decodeProbe)),
    grant: (lease: LeaseInput) =>
      post("/sync/start", { ...lease, action: "grant" }).pipe(Effect.flatMap((value) => decodeLease(value, lease))),
    revoke: (lease: LeaseInput) =>
      post("/sync/start", { ...lease, action: "revoke" }).pipe(Effect.flatMap((value) => decodeLease(value, lease, false))),
  }
}

function transferSnapshot(input: {
  readonly source: Endpoint
  readonly receiver: Endpoint
  readonly directory: string
  readonly now: () => number
  readonly requestCursor: string | undefined
  readonly capability: HistoryResponse
  readonly overall: AbortSignal
}): Effect.Effect<{ readonly pages: number; readonly receipt: string }, TransferError> {
  return Effect.gen(function* () {
    const frozen: FrozenSnapshot = {
      token: input.capability.sourceSnapshotToken,
      manifest: input.capability.manifestDigest,
      highWater: input.capability.highWater,
      responseCursor: input.capability.discoveryCursor,
    }
    const sourceTarget: PrivateRequest = { ...input.source, path: "/sync/history", signal: input.overall }
    const receiverTarget: PrivateRequest = { ...input.receiver, path: "/sync/replay", signal: input.overall }
    const begun = yield* fetchReplay(receiverTarget, {
      version: 1,
      action: "begin",
      clientTransferID: randomBytes(32).toString("hex"),
      directory: input.directory,
      sourceSnapshotToken: frozen.token,
      highWater: frozen.highWater,
      manifestDigest: frozen.manifest,
      expiresAt: input.now() + TRANSFER_LEASE_MS,
    })
    if (begun.action !== "begin")
      return yield* new TransferError({ code: "invalid", message: "invalid begin acknowledgement" })
    const handle = begun.transferHandle
    const state = { completed: false }
    return yield* Effect.gen(function* () {
      if (begun.expiresAt <= input.now())
        return yield* new TransferError({ code: "expired", message: "begin acknowledgement expired" })
      let pageCursor: string | undefined
      let pageIndex = 0
      let totalBytes = 0
      const seen = new Set<string>()
      while (true) {
        const response = yield* fetchHistory(sourceTarget, {
          version: 1,
          capabilityOnly: false,
          aggregates: {},
          ...(input.requestCursor === undefined ? {} : { discoveryCursor: input.requestCursor }),
          sourceSnapshotToken: frozen.token,
          ...(pageCursor === undefined ? {} : { pageCursor }),
        })
        yield* validateDataPage(response, frozen)
        totalBytes += Buffer.byteLength(canonical(response))
        if (totalBytes > MAX_TRANSFER_BYTES)
          return yield* new TransferError({ code: "too-large", message: "transfer wire budget exceeded" })
        const appended = yield* fetchReplay(receiverTarget, {
          version: 1,
          action: "append",
          transferHandle: handle,
          pageIndex,
          pageHash: digest(canonical(response.page)),
          page: response.page,
        })
        if (appended.action !== "append" || appended.transferHandle !== handle || appended.nextPageIndex !== pageIndex + 1)
          return yield* new TransferError({ code: "invalid", message: "invalid append acknowledgement" })
        pageIndex += 1
        if (response.nextCursor === undefined) break
        if (seen.has(response.nextCursor)) return yield* new TransferError({ code: "conflict", message: "page cursor cycle" })
        seen.add(response.nextCursor)
        pageCursor = response.nextCursor
      }
      const finalized = yield* fetchReplay(receiverTarget, {
        version: 1,
        action: "finalize",
        transferHandle: handle,
        expectedPageCount: pageIndex,
        manifestDigest: frozen.manifest,
      })
      if (finalized.action !== "finalize" || !/^sha256:[a-f0-9]{64}$/.test(finalized.manifestReceipt))
        return yield* new TransferError({ code: "invalid", message: "invalid finalize acknowledgement" })
      state.completed = true
      return { pages: pageIndex, receipt: finalized.manifestReceipt }
    }).pipe(
      // Any failure or interruption after begin aborts the handle under its own short deadline,
      // without replacing the original error or touching a completed receipt.
      Effect.ensuring(
        Effect.suspend(() =>
          state.completed
            ? Effect.void
            : fetchReplay(
                { ...receiverTarget, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
                { version: 1, action: "abort", transferHandle: handle },
              ).pipe(Effect.ignore),
        ),
      ),
    )
  })
}

function validateDataPage(response: HistoryResponse, frozen: FrozenSnapshot): Effect.Effect<void, TransferError> {
  if (response.sourceSnapshotToken !== frozen.token)
    return Effect.fail(new TransferError({ code: "snapshot-advanced", message: "source snapshot changed" }))
  if (response.manifestDigest !== frozen.manifest)
    return Effect.fail(new TransferError({ code: "snapshot-advanced", message: "manifest digest changed" }))
  if (canonical(response.highWater) !== canonical(frozen.highWater))
    return Effect.fail(new TransferError({ code: "snapshot-advanced", message: "high water changed" }))
  if (response.discoveryCursor !== frozen.responseCursor)
    return Effect.fail(new TransferError({ code: "snapshot-advanced", message: "discovery cursor changed" }))
  if (response.aggregates.length > MAX_SYNC_AGGREGATES)
    return Effect.fail(new TransferError({ code: "invalid", message: "too many aggregates" }))
  if (response.nextCursor !== undefined && response.page.records.length === 0)
    return Effect.fail(new TransferError({ code: "invalid", message: "empty nonterminal page" }))
  const chunks = response.page.records.filter((record) => record.kind === "chunk")
  if (chunks.length > 0 && (chunks.length !== response.page.records.length || chunks.length > MAX_SYNC_RECORD_CHUNKS))
    return Effect.fail(new TransferError({ code: "too-large", message: "record chunk budget exceeded" }))
  if (
    chunks.length === 0 &&
    response.page.records.filter((record) => record.kind === "event" || record.kind === "deletion").length >
      MAX_SYNC_PUBLIC_EVENTS
  )
    return Effect.fail(new TransferError({ code: "too-large", message: "public event budget exceeded" }))
  return Effect.void
}

function requireAuthorization(headers: Headers, label: string): Effect.Effect<void, TransferError> {
  const value = headers.get("authorization")
  return value !== null && value.trim().length > 0
    ? Effect.void
    : Effect.fail(new TransferError({ code: "invalid", message: `missing ${label} authorization` }))
}

function fetchHistory(request: PrivateRequest, body: unknown): Effect.Effect<HistoryResponse, TransferError> {
  return postJson(request, body).pipe(Effect.flatMap(decodeHistory))
}

function fetchReplay(request: PrivateRequest, body: unknown): Effect.Effect<ReplayResponse, TransferError> {
  return postJson(request, body).pipe(Effect.flatMap(decodeReplay))
}

function decodeHistory(value: unknown): Effect.Effect<HistoryResponse, TransferError> {
  return Effect.gen(function* () {
    yield* requireBodyVersion(value)
    const decoded = Schema.decodeUnknownOption(TransferHistoryResponseSchema, { onExcessProperty: "error" })(value)
    if (Option.isNone(decoded)) return yield* new TransferError({ code: "invalid", message: "invalid history response" })
    const entries = Object.entries(decoded.value.highWater)
    if (entries.length > MAX_SYNC_AGGREGATES || entries.length !== decoded.value.aggregates.length ||
      new Set(decoded.value.aggregates.map((entry) => entry.aggregateID)).size !== entries.length ||
      decoded.value.aggregates.some((entry) => !Object.hasOwn(decoded.value.highWater, entry.aggregateID) ||
        decoded.value.highWater[entry.aggregateID] !== entry.sourceSeq))
      return yield* new TransferError({ code: "invalid", message: "inconsistent source manifest" })
    return decoded.value
  })
}

function decodeReplay(value: unknown): Effect.Effect<ReplayResponse, TransferError> {
  return Effect.gen(function* () {
    yield* requireBodyVersion(value)
    const decoded = Schema.decodeUnknownOption(TransferReplayResponseSchema)(value)
    if (Option.isNone(decoded)) return yield* new TransferError({ code: "invalid", message: "invalid replay response" })
    return decoded.value
  })
}

function decodeProbe(value: unknown): Effect.Effect<{ readonly transferRequired: boolean }, TransferError> {
  return decodeHistory(value).pipe(
    Effect.map((response) => ({
      transferRequired: response.aggregates.some(
        (manifest) => manifest.privateCount > 0 || manifest.deletionCount > 0 || manifest.epochDigest !== undefined,
      ),
    })),
  )
}

function decodeLease(
  value: unknown,
  lease: LeaseInput,
  requireLive = true,
): Effect.Effect<StartResponse, TransferError> {
  const decoded = Schema.decodeUnknownOption(TransferStartResponseSchema)(value)
  if (Option.isNone(decoded))
    return Effect.fail(new TransferError({ code: "invalid", message: "invalid lease acknowledgement" }))
  const ack = decoded.value
  if (ack.acceptedRevision !== lease.topologyRevision)
    return Effect.fail(new TransferError({ code: "conflict", message: "lease revision mismatch" }))
  // The peer may shorten a lease but never extend it past the requested bound or into the past.
  if ((requireLive && ack.expiresAt <= Date.now()) || ack.expiresAt > lease.expiresAt)
    return Effect.fail(new TransferError({ code: "conflict", message: "lease bounds rejected" }))
  return Effect.succeed(ack)
}

function requireBodyVersion(value: unknown): Effect.Effect<void, TransferError> {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.Literal(1) }))(value)
  return Option.isNone(decoded)
    ? Effect.fail(new TransferError({ code: "version", message: "unsupported sync version" }))
    : Effect.void
}

/**
 * Single bounded JSON transport. `redirect: "manual"` guarantees every 3xx is rejected before any
 * credential or body can be replayed elsewhere, and the reader enforces the byte budget from the
 * actual stream rather than trusting Content-Length.
 */
function postJson(request: PrivateRequest, body: unknown): Effect.Effect<unknown, TransferError> {
  return Effect.gen(function* () {
    yield* requireAuthorization(request.headers, "peer")
    const base = yield* validateTarget({ url: request.url, confidential: request.confidential }).pipe(
      Effect.mapError(() => new TransferError({ code: "forbidden", message: "private transport rejected" })),
    )
    const endpoint = route(base, request.path)
    const headers = new Headers(request.headers)
    headers.set("content-type", "application/json")
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const bound = requestSignal(signal, request.signal)
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            redirect: "manual",
            signal: bound.signal,
          })
          if (response.status >= 300 && response.status < 400)
            throw new TransferError({ code: "invalid", message: "unexpected redirect" })
          const version = response.headers.get("x-opencode-session-sync-version")
          if (version !== null && version !== "1")
            throw new TransferError({ code: "version", message: "unsupported sync version" })
          const text = await readBoundedText(response, MAX_SYNC_PAGE_BYTES)
          if (response.status < 200 || response.status >= 300) throw serverError(response.status, text)
          const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
          if (Option.isNone(parsed)) throw new TransferError({ code: "invalid", message: "invalid response" })
          return parsed.value
        } finally {
          bound.dispose()
        }
      },
      catch: toTransferError,
    })
  })
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const body = response.body
  if (body === null) return ""
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new TransferError({ code: "too-large", message: "response exceeds byte budget" })
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function serverError(status: number, text: string): TransferError {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  const code = Option.isSome(parsed) ? errorCode(parsed.value) : undefined
  // Never surface the peer body: it may carry private payload or credentials.
  return new TransferError({ code: code ?? statusCode(status), message: "private transfer request failed" })
}

function errorCode(value: unknown): TransferCode | undefined {
  const decoded = Schema.decodeUnknownOption(TransferErrorResponseSchema)(value)
  if (Option.isNone(decoded)) return undefined
  return isTransferCode(decoded.value.code) ? decoded.value.code : undefined
}

function isTransferCode(value: string): value is TransferCode {
  return TRANSFER_CODES.has(value)
}

function statusCode(status: number): TransferCode {
  if (status === 401 || status === 403) return "forbidden"
  if (status === 409) return "conflict"
  if (status === 410) return "expired"
  if (status === 413) return "too-large"
  if (status === 503) return "busy"
  return "invalid"
}

function toTransferError(cause: unknown): TransferError {
  return cause instanceof TransferError
    ? cause
    : new TransferError({ code: "conflict", message: "private transfer request failed" })
}

/**
 * Binds a request to both the fiber's interruption signal and the operation-wide deadline, with a
 * bounded per-request timeout. Listeners and the timer are released once the request settles so a
 * long paginated pull cannot accumulate them on the shared signals.
 */
function requestSignal(effectSignal: AbortSignal, overall: AbortSignal): {
  readonly signal: AbortSignal
  readonly dispose: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const removals = [effectSignal, overall].flatMap((source) => {
    if (source.aborted) {
      controller.abort()
      return []
    }
    const listener = () => controller.abort()
    source.addEventListener("abort", listener, { once: true })
    return [() => source.removeEventListener("abort", listener)]
  })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      for (const remove of removals) remove()
    },
  }
}

function route(base: URL, path: string): URL {
  const next = new URL(base)
  next.pathname = `${next.pathname.replace(/\/$/, "")}${path}`
  next.search = ""
  next.hash = ""
  return next
}
