import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { appendFile, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const MAX_SYNC_PAGE_BYTES = 512 * 1024
export const MAX_SYNC_PUBLIC_EVENTS = 256
export const MAX_SYNC_RECORD_CHUNKS = 64
export const MAX_ACTIVE_TRANSFERS = 8
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024
export const MAX_TOTAL_SPOOL_BYTES = 1024 * 1024 * 1024
export const TRANSFER_IDLE_TTL = 5 * 60 * 1000
export const TRANSFER_ABSOLUTE_TTL = 30 * 60 * 1000

export type SyncRecordKind = "event" | "context" | "deletion" | "epoch"
export type CompleteSyncRecord = {
  readonly kind: SyncRecordKind
  readonly aggregateID: string
  readonly sourceSeq: number
  readonly sequence: number
  readonly identity: string
  readonly value: unknown
}
export type ChunkSyncRecord = {
  readonly kind: "chunk"
  readonly recordKind: SyncRecordKind
  readonly aggregateID: string
  readonly sourceSeq: number
  readonly sequence: number
  readonly identity: string
  readonly chunkIndex: number
  readonly chunkCount: number
  readonly byteLength: number
  readonly contentHash: string
  readonly data: string
}
export type SyncPage = { readonly records: ReadonlyArray<CompleteSyncRecord | ChunkSyncRecord> }

type BeginInput = {
  readonly workspaceID?: string
  readonly directory: string
  readonly clientTransferID: string
  readonly sourceSnapshotToken: string
  readonly highWater: Readonly<Record<string, number>>
  readonly manifestDigest: string
  readonly expiresAt: number
}

type StoredRecord = {
  readonly pageIndex: number
  readonly recordIndex: number
  readonly kind: SyncRecordKind
  readonly meta: Omit<CompleteSyncRecord, "value">
}

type Finalization = {
  readonly receipt: string
  readonly expectedPageCount: number
  readonly manifestDigest: string
}
type Receipt = Finalization & { readonly expiresAt: number }
type Transfer = {
  readonly binding: string
  readonly beginKey: string
  readonly handle: string
  readonly path: string
  readonly key: Buffer
  readonly input: BeginInput
  readonly createdAt: number
  idleExpiresAt: number
  bytes: number
  readonly pages: Map<number, string>
  readonly records: StoredRecord[]
  readonly nonces: Set<string>
  chunk?: { readonly meta: Omit<ChunkSyncRecord, "data" | "chunkIndex">; readonly parts: Buffer[] }
  epochSeen: boolean
  finalized?: Finalization
}

type Options = {
  readonly root: string
  readonly now?: () => number
  readonly maxActiveTransfers?: number
  readonly maxTransferBytes?: number
  readonly maxTotalSpoolBytes?: number
}
type AppendInput = {
  readonly handle: string
  readonly pageIndex: number
  readonly pageHash: string
  readonly page: SyncPage
}
type FinalizeInput = {
  readonly handle: string
  readonly expectedPageCount: number
  readonly manifestDigest: string
}
type Bundle = {
  readonly version: 1
  readonly aggregateID: string
  readonly sourceSeq: number
  readonly events: unknown[]
  readonly contexts: unknown[]
  readonly deletions: unknown[]
  epoch: unknown
}

class SyncTransferError extends Error {
  constructor(readonly _tag: string, message: string) {
    super(message)
  }
}

export class SyncTransferConflict extends SyncTransferError {
  constructor(message: string) {
    super("SyncTransferConflict", message)
  }
}
export class SyncTransferBusy extends SyncTransferError {
  constructor() {
    super("SyncTransferBusy", "too many active transfers")
  }
}
export class SyncTransferTooLarge extends SyncTransferError {
  constructor() {
    super("SyncTransferTooLarge", "transfer resource limit exceeded")
  }
}
export class SyncTransferExpired extends SyncTransferError {
  constructor() {
    super("SyncTransferExpired", "transfer expired")
  }
}

export class SessionContextTransferSpool {
  readonly #root: string
  readonly #now: () => number
  readonly #maxActiveTransfers: number
  readonly #maxTransferBytes: number
  readonly #maxTotalSpoolBytes: number
  readonly #transfers = new Map<string, Transfer>()
  readonly #begins = new Map<string, string>()
  readonly #receipts = new Map<string, Receipt>()
  // Queues outlive removal of a transfer until every admitted operation has settled.
  readonly #queues = new Map<string, Promise<void>>()
  #closed = false
  #disposal?: Promise<void>

  private constructor(options: Options) {
    if (!options.root || path.resolve(options.root) === path.parse(path.resolve(options.root)).root)
      throw new SyncTransferConflict("dedicated transfer root required")
    this.#root = path.resolve(options.root)
    this.#now = options.now ?? Date.now
    this.#maxActiveTransfers = options.maxActiveTransfers ?? MAX_ACTIVE_TRANSFERS
    this.#maxTransferBytes = options.maxTransferBytes ?? MAX_TRANSFER_BYTES
    this.#maxTotalSpoolBytes = options.maxTotalSpoolBytes ?? MAX_TOTAL_SPOOL_BYTES
  }

  static async make(options: Options) {
    const spool = new SessionContextTransferSpool(options)
    await mkdir(spool.#root, { recursive: true, mode: 0o700 })
    await chmod(spool.#root, 0o700)
    await Promise.all(
      (await readdir(spool.#root)).map((name) => {
        const target = path.resolve(spool.#root, name)
        if (path.dirname(target) !== spool.#root) throw new SyncTransferConflict("invalid transfer spool entry")
        return rm(target, { recursive: true, force: true })
      }),
    )
    return spool
  }

  begin(input: BeginInput) {
    const snapshot = { ...input, highWater: { ...input.highWater } }
    // A separate begin queue bounds admission while file creation is in flight.
    return this.#serialized("begin", () => this.#begin(snapshot))
  }

  async #begin(input: BeginInput) {
    await this.#cleanup()
    const highWater = Object.entries(input.highWater)
    if (
      highWater.length > 128 ||
      highWater.some(([aggregateID, sequence]) =>
        aggregateID.length === 0 || aggregateID.length > 256 || !Number.isSafeInteger(sequence) || sequence < 0,
      ) ||
      Buffer.byteLength(canonical(input)) > 64 * 1024
    ) throw new SyncTransferTooLarge()
    if (input.expiresAt <= this.#now()) throw new SyncTransferExpired()
    const beginKey = `${input.workspaceID ?? ""}\0${input.clientTransferID}`
    const binding = canonical(input)
    const existing = this.#begins.get(beginKey)
    if (existing) {
      return this.#enqueue(existing, async () => {
        const transfer = await this.#live(existing)
        try {
          this.#checkLive(transfer)
          if (transfer.binding !== binding) throw new SyncTransferConflict("conflicting begin retry")
          this.#touch(transfer)
          return { handle: transfer.handle, expiresAt: transfer.input.expiresAt }
        } catch (error) {
          if (error instanceof SyncTransferExpired) await this.#remove(transfer)
          throw error
        }
      })
    }
    if (this.#transfers.size >= this.#maxActiveTransfers) throw new SyncTransferBusy()
    const createdAt = this.#now()
    const transfer: Transfer = {
      binding,
      beginKey,
      handle: randomBytes(24).toString("base64url"),
      path: path.join(this.#root, randomBytes(24).toString("hex")),
      key: randomBytes(32),
      input: { ...input, expiresAt: Math.min(input.expiresAt, createdAt + TRANSFER_ABSOLUTE_TTL) },
      createdAt,
      idleExpiresAt: Math.min(createdAt + TRANSFER_IDLE_TTL, input.expiresAt),
      bytes: 0,
      pages: new Map(),
      records: [],
      nonces: new Set(),
      epochSeen: false,
    }
    try {
      await writeFile(transfer.path, "", { mode: 0o600, flag: "wx" })
      await chmod(transfer.path, 0o600)
      this.#checkLive(transfer)
      this.#transfers.set(transfer.handle, transfer)
      this.#begins.set(beginKey, transfer.handle)
      return { handle: transfer.handle, expiresAt: transfer.input.expiresAt }
    } catch (error) {
      transfer.key.fill(0)
      await rm(transfer.path, { force: true })
      throw error
    }
  }

  append(input: AppendInput) {
    const snapshot = { ...input }
    return this.#serialized(snapshot.handle, async () => {
      try {
        return await this.#append(snapshot)
      } catch (error) {
        const transfer = this.#transfers.get(snapshot.handle)
        if (transfer) await this.#remove(transfer)
        if (error instanceof SyncTransferError) throw error
        throw new SyncTransferConflict("invalid spool page")
      }
    })
  }

  async #append(input: AppendInput) {
    const transfer = await this.#live(input.handle)
    this.#checkLive(transfer)
    const encoded = canonical(input.page)
    if (digest(encoded) !== input.pageHash) throw new SyncTransferConflict("page hash mismatch")
    const retry = transfer.pages.get(input.pageIndex)
    if (retry) {
      if (retry !== input.pageHash) throw new SyncTransferConflict("conflicting page retry")
      this.#touch(transfer)
      return { nextPageIndex: transfer.pages.size }
    }
    if (transfer.finalized) throw new SyncTransferConflict("transfer already finalized")
    if (input.pageIndex !== transfer.pages.size) throw new SyncTransferConflict("page reordering")
    if (Buffer.byteLength(encoded) > MAX_SYNC_PAGE_BYTES) throw new SyncTransferTooLarge()
    if (input.page.records.length === 0) throw new SyncTransferConflict("empty page")
    const chunks = input.page.records.filter((record) => record.kind === "chunk")
    if (chunks.length > 0 && (chunks.length !== input.page.records.length || chunks.length > MAX_SYNC_RECORD_CHUNKS))
      throw new SyncTransferTooLarge()
    if (
      chunks.length === 0 &&
      input.page.records.filter((record) => record.kind === "event" || record.kind === "deletion").length > MAX_SYNC_PUBLIC_EVENTS
    ) throw new SyncTransferTooLarge()
    this.#checkBudget(transfer, Buffer.byteLength(encoded))

    const encrypted: string[] = []
    for (const item of input.page.records) {
      const complete = item.kind === "chunk"
        ? this.#appendChunk(transfer, item)
        : { meta: recordMeta(item), bytes: Buffer.from(canonical(item.value)) }
      if (!complete) continue
      const value: unknown = JSON.parse(complete.bytes.toString("utf8"))
      validateRecord(complete.meta, value)
      if (transfer.input.highWater[complete.meta.aggregateID] !== complete.meta.sourceSeq)
        throw new SyncTransferConflict("record high-water binding")
      const previous = transfer.records.at(-1)
      if (previous && compareRecord(previous.meta, complete.meta) >= 0)
        throw new SyncTransferConflict("record reordering")
      if (transfer.epochSeen && complete.meta.kind !== "epoch") throw new SyncTransferConflict("records after epoch")
      transfer.epochSeen ||= complete.meta.kind === "epoch"
      const recordIndex = transfer.records.length
      const nonce = randomBytes(12)
      const nonceKey = nonce.toString("base64")
      if (transfer.nonces.has(nonceKey)) throw new SyncTransferConflict("nonce reuse")
      transfer.nonces.add(nonceKey)
      const cipher = createCipheriv("aes-256-gcm", transfer.key, nonce)
      cipher.setAAD(Buffer.from(`${transfer.handle}:${input.pageIndex}:${recordIndex}:${complete.meta.kind}`))
      const ciphertext = Buffer.concat([cipher.update(complete.bytes), cipher.final()])
      encrypted.push(JSON.stringify({
        nonce: nonceKey,
        tag: cipher.getAuthTag().toString("base64"),
        data: ciphertext.toString("base64"),
      }))
      transfer.records.push({ pageIndex: input.pageIndex, recordIndex, kind: complete.meta.kind, meta: complete.meta })
    }
    const encryptedPage = encrypted.length > 0 ? `${encrypted.join("\n")}\n` : ""
    const chargedBytes = Math.max(Buffer.byteLength(encoded), Buffer.byteLength(encryptedPage))
    // Check and reserve synchronously, after all waits, across every transfer queue.
    this.#checkLive(transfer)
    this.#checkBudget(transfer, chargedBytes)
    transfer.bytes += chargedBytes
    if (encryptedPage) await appendFile(transfer.path, encryptedPage, { encoding: "utf8" })
    this.#checkLive(transfer)
    transfer.pages.set(input.pageIndex, input.pageHash)
    this.#touch(transfer)
    return { nextPageIndex: transfer.pages.size }
  }

  finalize(input: FinalizeInput) {
    const snapshot = { ...input }
    return this.#serialized(snapshot.handle, async () => {
      try {
        return await this.#finalize(snapshot)
      } catch (error) {
        const transfer = this.#transfers.get(snapshot.handle)
        if (transfer && error instanceof SyncTransferExpired) await this.#remove(transfer)
        throw error
      }
    })
  }

  async #finalize(input: FinalizeInput) {
    const completed = this.#receipt(input.handle)
    if (completed) {
      reconcileFinalization(completed, input)
      return { status: "complete" as const, receipt: completed.receipt }
    }
    const transfer = await this.#live(input.handle)
    this.#checkLive(transfer)
    if (transfer.finalized) reconcileFinalization(transfer.finalized, input)
    if (
      input.expectedPageCount !== transfer.pages.size ||
      input.manifestDigest !== transfer.input.manifestDigest ||
      transfer.chunk
    ) throw new SyncTransferConflict("incomplete transfer")
    try {
      const bundles = Object.entries(transfer.input.highWater).map(([aggregateID, sourceSeq]): Bundle => ({
        version: 1 as const,
        aggregateID,
        sourceSeq,
        events: new Array<unknown>(),
        contexts: new Array<unknown>(),
        deletions: new Array<unknown>(),
        epoch: undefined,
      }))
      const byAggregate = new Map(bundles.map((bundle) => [bundle.aggregateID, bundle]))
      const lines = (await readFile(transfer.path, "utf8")).trim().split("\n").filter(Boolean)
      this.#checkLive(transfer)
      if (lines.length !== transfer.records.length) throw new SyncTransferConflict("spool record count")
      for (const [index, stored] of transfer.records.entries()) {
        const line = lines[index]
        if (line === undefined) throw new SyncTransferConflict("spool record count")
        const encrypted: unknown = JSON.parse(line)
        if (!isEncryptedRecord(encrypted)) throw new SyncTransferConflict("spool record encoding")
        const decipher = createDecipheriv("aes-256-gcm", transfer.key, Buffer.from(encrypted.nonce, "base64"))
        decipher.setAAD(Buffer.from(`${transfer.handle}:${stored.pageIndex}:${stored.recordIndex}:${stored.kind}`))
        decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"))
        const value: unknown = JSON.parse(
          Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8"),
        )
        validateRecord(stored.meta, value)
        const bundle = byAggregate.get(stored.meta.aggregateID)
        if (!bundle) throw new SyncTransferConflict("record aggregate not declared")
        if (stored.kind === "event") bundle.events.push(value)
        if (stored.kind === "context") bundle.contexts.push(value)
        if (stored.kind === "deletion") bundle.deletions.push(value)
        if (stored.kind === "epoch") {
          if (bundle.epoch !== undefined) throw new SyncTransferConflict("duplicate epoch")
          bundle.epoch = value
        }
      }
      const manifests = bundles.flatMap((bundle) =>
        bundle.contexts.length || bundle.deletions.length || bundle.epoch !== undefined ? [privateManifest(bundle)] : [],
      )
      if (manifestDigest(manifests) !== input.manifestDigest) throw new SyncTransferConflict("manifest digest mismatch")
      this.#checkLive(transfer)
      const receipt = digest(canonical({ binding: transfer.binding, pages: [...transfer.pages] }))
      transfer.finalized = { receipt, expectedPageCount: input.expectedPageCount, manifestDigest: input.manifestDigest }
      return { status: "ready" as const, receipt, bundles }
    } catch (error) {
      // Authentication/manifest failures invalidate the private payload, unlike an early finalize retry.
      await this.#remove(transfer)
      if (error instanceof SyncTransferError) throw error
      throw new SyncTransferConflict("spool authentication failed")
    }
  }

  complete(handle: string, receipt: string) {
    return this.#serialized(handle, async () => {
      const completed = this.#receipt(handle)
      if (completed) {
        if (completed.receipt !== receipt) throw new SyncTransferConflict("completion receipt mismatch")
        return
      }
      const transfer = await this.#live(handle)
      try {
        this.#checkLive(transfer)
        const finalized = transfer.finalized
        if (!finalized || finalized.receipt !== receipt) throw new SyncTransferConflict("completion receipt mismatch")
        await this.#remove(transfer)
        this.#checkLive(transfer)
        this.#receipts.set(handle, { ...finalized, expiresAt: transfer.input.expiresAt })
      } catch (error) {
        if (error instanceof SyncTransferExpired) await this.#remove(transfer)
        throw error
      }
    })
  }

  abort(handle: string) {
    return this.#serialized(handle, async () => {
      const transfer = this.#transfers.get(handle)
      if (transfer) await this.#remove(transfer)
    })
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal
    this.#closed = true
    this.#disposal = (async () => {
      await Promise.all([...this.#queues.values()])
      this.#receipts.clear()
      await Promise.all([...this.#transfers.values()].map((transfer) => this.#remove(transfer)))
      this.#begins.clear()
    })()
    return this.#disposal
  }

  #appendChunk(transfer: Transfer, chunk: ChunkSyncRecord): {
    readonly meta: Omit<CompleteSyncRecord, "value">
    readonly bytes: Buffer
  } | undefined {
    if (
      !Number.isSafeInteger(chunk.chunkCount) || !Number.isSafeInteger(chunk.chunkIndex) ||
      !Number.isSafeInteger(chunk.byteLength) || chunk.chunkCount <= 0 || chunk.chunkIndex < 0 ||
      chunk.chunkIndex >= chunk.chunkCount || chunk.byteLength < 0
    ) throw new SyncTransferConflict("chunk index")
    const bytes = Buffer.from(chunk.data, "base64")
    if (bytes.toString("base64") !== chunk.data) throw new SyncTransferConflict("non-canonical base64")
    const meta = {
      kind: chunk.kind,
      recordKind: chunk.recordKind,
      aggregateID: chunk.aggregateID,
      sourceSeq: chunk.sourceSeq,
      sequence: chunk.sequence,
      identity: chunk.identity,
      chunkCount: chunk.chunkCount,
      byteLength: chunk.byteLength,
      contentHash: chunk.contentHash,
    }
    if (!transfer.chunk) {
      if (chunk.chunkIndex !== 0) throw new SyncTransferConflict("chunk reordering")
      transfer.chunk = { meta, parts: [] }
    }
    if (canonical(transfer.chunk.meta) !== canonical(meta) || chunk.chunkIndex !== transfer.chunk.parts.length)
      throw new SyncTransferConflict("conflicting chunk")
    transfer.chunk.parts.push(bytes)
    if (transfer.chunk.parts.length !== chunk.chunkCount) return undefined
    const value = Buffer.concat(transfer.chunk.parts)
    if (value.byteLength !== chunk.byteLength || digest(value) !== chunk.contentHash)
      throw new SyncTransferConflict("chunk content")
    transfer.chunk = undefined
    return {
      meta: {
        kind: chunk.recordKind,
        aggregateID: chunk.aggregateID,
        sourceSeq: chunk.sourceSeq,
        sequence: chunk.sequence,
        identity: chunk.identity,
      },
      bytes: value,
    }
  }

  #checkLive(transfer: Transfer) {
    const now = this.#now()
    if (transfer.idleExpiresAt <= now || transfer.input.expiresAt <= now) throw new SyncTransferExpired()
  }

  async #live(handle: string) {
    const transfer = this.#transfers.get(handle)
    if (!transfer) throw new SyncTransferConflict("unknown transfer")
    try {
      this.#checkLive(transfer)
      return transfer
    } catch (error) {
      await this.#remove(transfer)
      throw error
    }
  }

  #receipt(handle: string) {
    const receipt = this.#receipts.get(handle)
    if (receipt && receipt.expiresAt <= this.#now()) {
      this.#receipts.delete(handle)
      throw new SyncTransferExpired()
    }
    return receipt
  }

  #serialized<A>(handle: string, run: () => Promise<A>): Promise<A> {
    if (this.#closed) return Promise.reject(new SyncTransferConflict("transfer spool disposed"))
    // Schedule sweeps before joining this queue: awaiting other queues from inside it
    // could deadlock two simultaneous operations. The current handle checks its own TTL.
    const cleanup = this.#cleanup(handle)
    void cleanup.catch(() => undefined)
    return this.#enqueue(handle, async () => {
      await cleanup
      return run()
    })
  }

  #enqueue<A>(handle: string, run: () => Promise<A>): Promise<A> {
    const result = (this.#queues.get(handle) ?? Promise.resolve()).then(run)
    const settled = result.then(() => undefined, () => undefined)
    this.#queues.set(handle, settled)
    void settled.then(() => {
      if (this.#queues.get(handle) === settled) this.#queues.delete(handle)
    })
    return result
  }

  #touch(transfer: Transfer) {
    transfer.idleExpiresAt = Math.min(this.#now() + TRANSFER_IDLE_TTL, transfer.input.expiresAt)
  }

  #checkBudget(transfer: Transfer, bytes: number) {
    const total = [...this.#transfers.values()].reduce((sum, item) => sum + item.bytes, 0)
    if (transfer.bytes + bytes > this.#maxTransferBytes || total + bytes > this.#maxTotalSpoolBytes)
      throw new SyncTransferTooLarge()
  }

  async #cleanup(except?: string) {
    await Promise.all([...this.#transfers.values()]
      .filter((transfer) => transfer.handle !== except &&
        (transfer.idleExpiresAt <= this.#now() || transfer.input.expiresAt <= this.#now()))
      .map((transfer) => this.#enqueue(transfer.handle, async () => {
        if (this.#transfers.get(transfer.handle) !== transfer) return
        if (transfer.idleExpiresAt <= this.#now() || transfer.input.expiresAt <= this.#now()) await this.#remove(transfer)
      })))
    for (const [handle, receipt] of this.#receipts) {
      if (handle !== except && receipt.expiresAt <= this.#now()) this.#receipts.delete(handle)
    }
  }

  async #remove(transfer: Transfer) {
    transfer.key.fill(0)
    transfer.chunk?.parts.forEach((part) => part.fill(0))
    transfer.chunk = undefined
    // Keep its budget reserved until the physical payload is gone.
    await rm(transfer.path, { force: true })
    this.#transfers.delete(transfer.handle)
    if (this.#begins.get(transfer.beginKey) === transfer.handle) this.#begins.delete(transfer.beginKey)
    transfer.records.length = 0
    transfer.nonces.clear()
  }
}

export function canonical(value: unknown) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  return value
}

export function digest(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function privateManifest(bundle: {
  readonly aggregateID: string
  readonly sourceSeq: number
  readonly contexts: ReadonlyArray<unknown>
  readonly deletions: ReadonlyArray<unknown>
  readonly epoch?: unknown
}) {
  const identities = [
    ...bundle.contexts.map(privateIdentity),
    ...bundle.deletions.map(privateIdentity),
    ...(bundle.epoch === undefined ? [] : [privateIdentity(bundle.epoch)]),
  ].sort(compareCanonical)
  const deletions = bundle.deletions.map(privateIdentity).sort(compareCanonical)
  return {
    aggregateID: bundle.aggregateID,
    sourceSeq: bundle.sourceSeq,
    privateCount: bundle.contexts.length + (bundle.epoch === undefined ? 0 : 1),
    privateDigest: digest(canonical(identities)),
    deletionCount: deletions.length,
    deletionDigest: digest(canonical(deletions)),
    epochDigest: bundle.epoch === undefined ? undefined : digest(canonical(privateIdentity(bundle.epoch))),
  }
}

export function manifestDigest(manifests: ReadonlyArray<ReturnType<typeof privateManifest>>) {
  return digest(canonical([...manifests].sort((left, right) => left.aggregateID.localeCompare(right.aggregateID))))
}

function privateIdentity(value: unknown) {
  if (value === null || typeof value !== "object") return value
  const item = objectRecord(value)
  return Object.fromEntries([
    "version", "kind", "sidecarSchemaVersion", "contentHash", "eventID", "aggregateID", "seq", "eventType",
    "eventDataHash", "messageID", "targetMessageID", "targetKind", "deletionCause", "targetEvent", "deletingEvent",
    "boundaryMessageID", "boundaryEvent", "promotionEvent", "baselineSeq", "sourceSeq", "epochSchemaVersion",
  ].flatMap((key) => item[key] === undefined ? [] : [[key, item[key]]]))
}

function compareCanonical(left: unknown, right: unknown) {
  return canonical(left).localeCompare(canonical(right))
}

function recordMeta(record: CompleteSyncRecord): Omit<CompleteSyncRecord, "value"> {
  // Retain only identities in memory, not a second plaintext copy of every value.
  return {
    kind: record.kind,
    aggregateID: record.aggregateID,
    sourceSeq: record.sourceSeq,
    sequence: record.sequence,
    identity: record.identity,
  }
}

function reconcileFinalization(finalized: Finalization, input: FinalizeInput) {
  if (finalized.expectedPageCount !== input.expectedPageCount || finalized.manifestDigest !== input.manifestDigest)
    throw new SyncTransferConflict("conflicting finalize retry")
}

function validateRecord(meta: Omit<CompleteSyncRecord, "value">, value: unknown) {
  if (value === null || typeof value !== "object") throw new SyncTransferConflict("record value")
  const item = objectRecord(value)
  if (!Number.isSafeInteger(meta.sourceSeq) || !Number.isSafeInteger(meta.sequence) || meta.sourceSeq < 0 || meta.sequence < 0)
    throw new SyncTransferConflict("record sequence")
  if (item.aggregateID !== meta.aggregateID) throw new SyncTransferConflict("record aggregate")
  if (meta.sourceSeq < meta.sequence) throw new SyncTransferConflict("record high-water")
  if (meta.kind === "event" && (item.seq !== meta.sequence || item.id !== meta.identity))
    throw new SyncTransferConflict("event identity")
  if (meta.kind === "context" && (
    item.seq !== meta.sequence || typeof item.kind !== "string" || typeof item.messageID !== "string" ||
    `${item.kind}:${item.messageID}` !== meta.identity
  )) throw new SyncTransferConflict("context identity")
  if (meta.kind === "deletion") {
    if (item.targetEvent === null || typeof item.targetEvent !== "object") throw new SyncTransferConflict("deletion identity")
    const target = objectRecord(item.targetEvent)
    if (typeof item.targetKind !== "string" || typeof item.targetMessageID !== "string" ||
      `${item.targetKind}:${item.targetMessageID}` !== meta.identity || target.seq !== meta.sequence)
      throw new SyncTransferConflict("deletion identity")
  }
  if (meta.kind === "epoch" && (item.sourceSeq !== meta.sourceSeq || meta.sequence !== meta.sourceSeq ||
    item.kind !== "context-epoch" || meta.identity !== meta.aggregateID)) throw new SyncTransferConflict("epoch identity")
}

function compareRecord(left: Omit<CompleteSyncRecord, "value">, right: Omit<CompleteSyncRecord, "value">) {
  if (left.kind === "epoch" && right.kind !== "epoch") return 1
  if (left.kind !== "epoch" && right.kind === "epoch") return -1
  return left.aggregateID.localeCompare(right.aggregateID) || left.sequence - right.sequence ||
    recordKindRank(left.kind) - recordKindRank(right.kind) || left.identity.localeCompare(right.identity)
}

function recordKindRank(kind: SyncRecordKind) {
  return kind === "event" ? 0 : kind === "deletion" ? 1 : kind === "context" ? 2 : 3
}

function objectRecord(value: object) {
  return Object.fromEntries(Object.entries(value).map(([key, item]): [string, unknown] => [key, item]))
}

function isEncryptedRecord(value: unknown): value is { readonly nonce: string; readonly tag: string; readonly data: string } {
  if (value === null || typeof value !== "object") return false
  const item = objectRecord(value)
  return typeof item.nonce === "string" && typeof item.tag === "string" && typeof item.data === "string"
}
