import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  MAX_ACTIVE_TRANSFERS,
  MAX_SYNC_PAGE_BYTES,
  MAX_SYNC_PUBLIC_EVENTS,
  MAX_SYNC_RECORD_CHUNKS,
  MAX_TOTAL_SPOOL_BYTES,
  MAX_TRANSFER_BYTES,
  SessionContextTransferSpool,
  SyncTransferConflict,
  TRANSFER_ABSOLUTE_TTL,
  TRANSFER_IDLE_TTL,
  canonical,
  digest,
  manifestDigest,
  privateManifest,
} from "../src/transfer-spool"
import type { ChunkSyncRecord, CompleteSyncRecord, SyncPage } from "../src/transfer-spool"

const record = {
  kind: "event" as const,
  aggregateID: "session-1",
  sourceSeq: 0,
  sequence: 0,
  identity: "event-1",
  value: { id: "event-1", aggregateID: "session-1", seq: 0, type: "session.created", data: {} },
}
const emptyManifest = digest(canonical([]))

async function fixture(
  options: Omit<Parameters<typeof SessionContextTransferSpool.make>[0], "root"> = {},
  init?: (root: string, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "adapter-transfer-spool-"))
  const root = path.join(directory, "spool")
  try {
    await mkdir(root)
    await init?.(root, directory)
    const spool = await SessionContextTransferSpool.make({ ...options, root })
    return {
      directory,
      root,
      spool,
      input: {
        workspaceID: "workspace-1",
        directory,
        clientTransferID: "client-1",
        sourceSnapshotToken: "snapshot-1",
        highWater: { "session-1": 0 },
        manifestDigest: emptyManifest,
        expiresAt: (options.now?.() ?? Date.now()) + 60 * 60 * 1000,
      },
      async [Symbol.asyncDispose]() {
        try {
          await spool.dispose()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function append(spool: SessionContextTransferSpool, handle: string, page: SyncPage, pageIndex = 0) {
  return spool.append({ handle, pageIndex, pageHash: digest(canonical(page)), page })
}

async function payload(root: string) {
  const files = await readdir(root)
  expect(files).toHaveLength(1)
  const file = files[0]
  if (file === undefined) throw new Error("expected one spool payload")
  return path.join(root, file)
}

function chunks(count: number): ChunkSyncRecord[] {
  const bytes = Buffer.from(canonical(record.value))
  return Array.from({ length: count }, (_, index) => ({
    kind: "chunk",
    recordKind: "event",
    aggregateID: record.aggregateID,
    sourceSeq: record.sourceSeq,
    sequence: record.sequence,
    identity: record.identity,
    chunkIndex: index,
    chunkCount: count,
    byteLength: bytes.byteLength,
    contentHash: digest(bytes),
    data: bytes.subarray(Math.floor(index * bytes.length / count), Math.floor((index + 1) * bytes.length / count)).toString("base64"),
  }))
}

function publicRecords(count: number, kind: "event" | "deletion"): CompleteSyncRecord[] {
  return Array.from({ length: count }, (_, sequence) => ({
    kind,
    aggregateID: "session-1",
    sourceSeq: count - 1,
    sequence,
    identity: kind === "event" ? `event-${sequence}` : `message:message-${sequence}`,
    value: kind === "event"
      ? { ...record.value, id: `event-${sequence}`, seq: sequence }
      : {
          aggregateID: "session-1",
          targetKind: "message",
          targetMessageID: `message-${sequence}`,
          targetEvent: { seq: sequence },
        },
  }))
}

describe("session context transfer spool", () => {
  test("preserves wire constants, locale canonicalization and known digests", () => {
    expect(MAX_SYNC_PAGE_BYTES).toBe(512 * 1024)
    expect(MAX_SYNC_PUBLIC_EVENTS).toBe(256)
    expect(MAX_SYNC_RECORD_CHUNKS).toBe(64)
    expect(MAX_ACTIVE_TRANSFERS).toBe(8)
    expect(MAX_TRANSFER_BYTES).toBe(512 * 1024 * 1024)
    expect(MAX_TOTAL_SPOOL_BYTES).toBe(1024 * 1024 * 1024)
    expect(TRANSFER_IDLE_TTL).toBe(5 * 60 * 1000)
    expect(TRANSFER_ABSOLUTE_TTL).toBe(30 * 60 * 1000)
    expect(canonical({ B: 2, a: { z: undefined, b: 2, a: 1 }, omitted: undefined })).toBe('{"a":{"a":1,"b":2},"B":2}')
    expect(canonical([undefined, { b: 2, a: 1 }])).toBe('[null,{"a":1,"b":2}]')
    expect(digest("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(emptyManifest).toBe("sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945")
    const manifest = privateManifest({ aggregateID: "s", sourceSeq: 0, contexts: [], deletions: [] })
    expect(manifest).toEqual({
      aggregateID: "s", sourceSeq: 0, privateCount: 0, privateDigest: emptyManifest,
      deletionCount: 0, deletionDigest: emptyManifest, epochDigest: undefined,
    })
    const context = { aggregateID: "s", kind: "message", messageID: "m", seq: 0, contentHash: "hash" }
    expect(privateManifest({ aggregateID: "s", sourceSeq: 0, contexts: [{ ...context, payload: "secret" }], deletions: [] }))
      .toEqual(privateManifest({ aggregateID: "s", sourceSeq: 0, contexts: [context], deletions: [] }))
    const other = { ...manifest, aggregateID: "a" }
    expect(manifestDigest([manifest, other])).toBe(manifestDigest([other, manifest]))
  })

  test("encrypts records and makes equal begin and append retries no-ops", async () => {
    await using tmp = await fixture()
    const [first, concurrent] = await Promise.all([tmp.spool.begin(tmp.input), tmp.spool.begin(tmp.input)])
    expect(concurrent).toEqual(first)
    expect(await tmp.spool.begin(tmp.input)).toEqual(first)
    await expect(tmp.spool.begin({ ...tmp.input, sourceSnapshotToken: "conflict" }))
      .rejects.toBeInstanceOf(SyncTransferConflict)
    const page = { records: [record] }
    expect(await Promise.all([append(tmp.spool, first.handle, page), append(tmp.spool, first.handle, page)]))
      .toEqual([{ nextPageIndex: 1 }, { nextPageIndex: 1 }])
    const file = await payload(tmp.root)
    const encrypted = await readFile(file, "utf8")
    expect(encrypted).not.toContain("session.created")
    expect(encrypted).not.toContain("session-1")
    if (process.platform !== "win32") {
      expect((await stat(tmp.root)).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    await expect(tmp.spool.append({ handle: first.handle, pageIndex: 0, pageHash: digest("conflict"), page }))
      .rejects.toBeInstanceOf(SyncTransferConflict)
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("reassembles canonical base64 chunks and keeps a bound completion receipt", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    for (const [pageIndex, chunk] of chunks(2).entries()) {
      await append(tmp.spool, begin.handle, { records: [chunk] }, pageIndex)
    }
    const input = { handle: begin.handle, expectedPageCount: 2, manifestDigest: emptyManifest }
    const ready = await tmp.spool.finalize(input)
    if (ready.status !== "ready") throw new Error("expected ready transfer")
    expect(ready.bundles[0]?.events).toEqual([record.value])
    expect(await tmp.spool.finalize(input)).toEqual(ready)
    await tmp.spool.complete(begin.handle, ready.receipt)
    await tmp.spool.complete(begin.handle, ready.receipt)
    expect(await readdir(tmp.root)).toEqual([])
    expect(await tmp.spool.finalize(input)).toEqual({ status: "complete", receipt: ready.receipt })
    await expect(tmp.spool.finalize({ ...input, expectedPageCount: 1 })).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.finalize({ ...input, manifestDigest: digest("conflict") })).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.complete(begin.handle, "arbitrary")).rejects.toBeInstanceOf(SyncTransferConflict)
    expect(await tmp.spool.finalize(input)).toEqual({ status: "complete", receipt: ready.receipt })
  })

  test("sweeps only the dedicated startup root and bounds concurrent admissions", async () => {
    await using tmp = await fixture({ maxActiveTransfers: 1 }, async (root, directory) => {
      await writeFile(path.join(root, "orphan"), "private")
      await writeFile(path.join(directory, "outside"), "outside")
    })
    expect(await readdir(tmp.root)).toEqual([])
    const results = await Promise.allSettled([
      tmp.spool.begin(tmp.input),
      tmp.spool.begin({ ...tmp.input, clientTransferID: "client-2" }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const failure = results.find((result) => result.status === "rejected")
    if (!failure || failure.status !== "rejected") throw new Error("expected rejected admission")
    expect(failure.reason).toMatchObject({ _tag: "SyncTransferBusy" })
    await tmp.spool.dispose()
    expect(await readdir(tmp.root)).toEqual([])
    expect(await readFile(path.join(tmp.directory, "outside"), "utf8")).toBe("outside")
  })

  test("enforces the default eight active transfers", async () => {
    await using tmp = await fixture()
    await Promise.all(Array.from({ length: MAX_ACTIVE_TRANSFERS }, (_, index) =>
      tmp.spool.begin({ ...tmp.input, clientTransferID: `client-${index}` }),
    ))
    await expect(tmp.spool.begin({ ...tmp.input, clientTransferID: "ninth" }))
      .rejects.toMatchObject({ _tag: "SyncTransferBusy" })
  })

  test("expires idle transfers and deletes oversized partial spools", async () => {
    const clock = { now: 0 }
    await using tmp = await fixture({ now: () => clock.now })
    const begin = await tmp.spool.begin(tmp.input)
    clock.now = TRANSFER_IDLE_TTL
    await expect(append(tmp.spool, begin.handle, { records: [record] }))
      .rejects.toMatchObject({ _tag: "SyncTransferExpired" })
    expect(await readdir(tmp.root)).toEqual([])
    await using limited = await fixture({ maxTransferBytes: 32 })
    const next = await limited.spool.begin(limited.input)
    await expect(append(limited.spool, next.handle, { records: [record] }))
      .rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
    expect(await readdir(limited.root)).toEqual([])
  })

  test("absolute TTL cannot be extended by activity", async () => {
    const clock = { now: 0 }
    await using tmp = await fixture({ now: () => clock.now })
    const begin = await tmp.spool.begin(tmp.input)
    expect(begin.expiresAt).toBe(TRANSFER_ABSOLUTE_TTL)
    const page = { records: [record] }
    await append(tmp.spool, begin.handle, page)
    for (const now of [4, 8, 12, 16, 20, 24, 28].map((minute) => minute * 60 * 1000)) {
      clock.now = now
      await append(tmp.spool, begin.handle, page)
    }
    clock.now = TRANSFER_ABSOLUTE_TTL
    await expect(tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }))
      .rejects.toMatchObject({ _tag: "SyncTransferExpired" })
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("an expired finalized transfer cannot be completed", async () => {
    const clock = { now: 0 }
    await using tmp = await fixture({ now: () => clock.now })
    const begin = await tmp.spool.begin(tmp.input)
    await append(tmp.spool, begin.handle, { records: [record] })
    const ready = await tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest })
    clock.now = TRANSFER_IDLE_TTL
    await expect(tmp.spool.complete(begin.handle, ready.receipt)).rejects.toMatchObject({ _tag: "SyncTransferExpired" })
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("completed receipts expire at the absolute deadline", async () => {
    const clock = { now: 0 }
    await using tmp = await fixture({ now: () => clock.now })
    const begin = await tmp.spool.begin(tmp.input)
    const input = { handle: begin.handle, expectedPageCount: 0, manifestDigest: emptyManifest }
    const ready = await tmp.spool.finalize(input)
    await tmp.spool.complete(begin.handle, ready.receipt)
    clock.now = TRANSFER_ABSOLUTE_TTL
    await expect(tmp.spool.finalize(input)).rejects.toMatchObject({ _tag: "SyncTransferExpired" })
  })

  for (const operation of ["append", "finalize", "complete"] as const) {
    test(`${operation} rechecks TTL after filesystem waits`, async () => {
      // Advance the supplied clock only at the post-I/O check. No filesystem or crypto mocks.
      const clock = { now: 0, remaining: Number.POSITIVE_INFINITY }
      await using tmp = await fixture({ now: () => {
        clock.remaining--
        if (clock.remaining === 0) clock.now = TRANSFER_IDLE_TTL
        return clock.now
      } })
      const begin = await tmp.spool.begin(tmp.input)
      const input = { handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }
      if (operation === "append") {
        // live lookup, post-lookup check, budget reservation, then post-write check.
        clock.remaining = 4
        await expect(append(tmp.spool, begin.handle, { records: [record] }))
          .rejects.toMatchObject({ _tag: "SyncTransferExpired" })
      }
      if (operation === "finalize") {
        await append(tmp.spool, begin.handle, { records: [record] })
        clock.remaining = 3
        await expect(tmp.spool.finalize(input)).rejects.toMatchObject({ _tag: "SyncTransferExpired" })
      }
      if (operation === "complete") {
        await append(tmp.spool, begin.handle, { records: [record] })
        const ready = await tmp.spool.finalize(input)
        clock.remaining = 3
        await expect(tmp.spool.complete(begin.handle, ready.receipt)).rejects.toMatchObject({ _tag: "SyncTransferExpired" })
        await expect(tmp.spool.finalize(input)).rejects.toBeInstanceOf(SyncTransferConflict)
      }
      expect(clock.now).toBe(TRANSFER_IDLE_TTL)
      expect(await readdir(tmp.root)).toEqual([])
    })
  }

  test("rejects authenticated-spool tampering and deletes the payload", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    await append(tmp.spool, begin.handle, { records: [record] })
    const file = await payload(tmp.root)
    const encrypted: unknown = JSON.parse(await readFile(file, "utf8"))
    if (encrypted === null || typeof encrypted !== "object" ||
      !("data" in encrypted) || typeof encrypted.data !== "string") throw new Error("invalid encrypted fixture")
    await writeFile(file, JSON.stringify({
      ...encrypted,
      data: `${encrypted.data[0] === "A" ? "B" : "A"}${encrypted.data.slice(1)}`,
    }))
    await expect(tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }))
      .rejects.toBeInstanceOf(SyncTransferConflict)
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("uses distinct nonces and authenticates record position with AAD", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin({ ...tmp.input, highWater: { "session-1": 1 } })
    for (const [index, item] of publicRecords(2, "event").entries()) {
      await append(tmp.spool, begin.handle, { records: [item] }, index)
    }
    const file = await payload(tmp.root)
    const lines = (await readFile(file, "utf8")).trim().split("\n")
    const nonces = lines.map((line) => {
      const value: unknown = JSON.parse(line)
      if (value === null || typeof value !== "object" || !("nonce" in value) || typeof value.nonce !== "string")
        throw new Error("invalid encrypted fixture")
      expect(Buffer.from(value.nonce, "base64").length).toBe(12)
      return value.nonce
    })
    expect(new Set(nonces).size).toBe(2)
    await writeFile(file, `${lines.reverse().join("\n")}\n`)
    await expect(tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 2, manifestDigest: emptyManifest }))
      .rejects.toBeInstanceOf(SyncTransferConflict)
    expect(await readdir(tmp.root)).toEqual([])
  })

  for (const extra of [0, 1]) {
    test(`page byte boundary: limit + ${extra}`, async () => {
      await using tmp = await fixture()
      const begin = await tmp.spool.begin(tmp.input)
      const base = { records: [{ ...record, value: { ...record.value, data: "" } }] }
      const page = { records: [{ ...record, value: {
        ...record.value, data: "x".repeat(MAX_SYNC_PAGE_BYTES - Buffer.byteLength(canonical(base)) + extra),
      } }] }
      expect(Buffer.byteLength(canonical(page))).toBe(MAX_SYNC_PAGE_BYTES + extra)
      const result = append(tmp.spool, begin.handle, page)
      if (extra === 0) {
        expect(await result).toEqual({ nextPageIndex: 1 })
        return
      }
      await expect(result).rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
      expect(await readdir(tmp.root)).toEqual([])
    })
  }

  for (const kind of ["event", "deletion"] as const) {
    for (const count of [MAX_SYNC_PUBLIC_EVENTS, MAX_SYNC_PUBLIC_EVENTS + 1]) {
      test(`${kind} record count boundary: ${count}`, async () => {
        await using tmp = await fixture()
        const begin = await tmp.spool.begin({ ...tmp.input, highWater: { "session-1": count - 1 } })
        const result = append(tmp.spool, begin.handle, { records: publicRecords(count, kind) })
        if (count === MAX_SYNC_PUBLIC_EVENTS) {
          expect(await result).toEqual({ nextPageIndex: 1 })
          return
        }
        await expect(result).rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
        expect(await readdir(tmp.root)).toEqual([])
      })
    }
  }

  for (const count of [MAX_SYNC_RECORD_CHUNKS, MAX_SYNC_RECORD_CHUNKS + 1]) {
    test(`chunk count boundary: ${count}`, async () => {
      await using tmp = await fixture()
      const begin = await tmp.spool.begin(tmp.input)
      const result = append(tmp.spool, begin.handle, { records: chunks(count) })
      if (count === MAX_SYNC_RECORD_CHUNKS) {
        expect(await result).toEqual({ nextPageIndex: 1 })
        const ready = await tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest })
        if (ready.status !== "ready") throw new Error("expected ready transfer")
        expect(ready.bundles[0]?.events).toEqual([record.value])
        return
      }
      await expect(result).rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
      expect(await readdir(tmp.root)).toEqual([])
    })
  }

  test("configurable transfer and total budgets include encrypted expansion at the exact boundary", async () => {
    const page = { records: [{ ...record, value: { ...record.value, data: "x".repeat(2048) } }] }
    await using calibration = await fixture()
    const first = await calibration.spool.begin(calibration.input)
    await append(calibration.spool, first.handle, page)
    const charged = (await stat(await payload(calibration.root))).size
    expect(charged).toBeGreaterThan(Buffer.byteLength(canonical(page)))
    for (const option of ["maxTransferBytes", "maxTotalSpoolBytes"] as const) {
      for (const extra of [0, -1]) {
        await using tmp = await fixture(option === "maxTransferBytes"
          ? { maxTransferBytes: charged + extra }
          : { maxTotalSpoolBytes: charged + extra })
        const begin = await tmp.spool.begin(tmp.input)
        const result = append(tmp.spool, begin.handle, page)
        if (extra === 0) {
          expect(await result).toEqual({ nextPageIndex: 1 })
          continue
        }
        await expect(result).rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
        expect(await readdir(tmp.root)).toEqual([])
      }
    }
  })

  test("parallel append queues cannot oversubscribe the shared budget", async () => {
    const page = { records: [{ ...record, value: { ...record.value, data: "x".repeat(2048) } }] }
    await using calibration = await fixture()
    const sample = await calibration.spool.begin(calibration.input)
    await append(calibration.spool, sample.handle, page)
    const charged = (await stat(await payload(calibration.root))).size
    await using tmp = await fixture({ maxTotalSpoolBytes: charged })
    const transfers = await Promise.all([tmp.spool.begin(tmp.input), tmp.spool.begin({ ...tmp.input, clientTransferID: "second" })])
    const results = await Promise.allSettled(transfers.map((transfer) => append(tmp.spool, transfer.handle, page)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const failed = results.find((result) => result.status === "rejected")
    if (!failed || failed.status !== "rejected") throw new Error("expected a budget rejection")
    expect(failed.reason).toMatchObject({ _tag: "SyncTransferTooLarge" })
    expect(await readdir(tmp.root)).toHaveLength(1)
    expect((await stat(await payload(tmp.root))).size).toBe(charged)
    for (const transfer of transfers) await tmp.spool.abort(transfer.handle)
    const next = await tmp.spool.begin({ ...tmp.input, clientTransferID: "reclaimed" })
    expect(await append(tmp.spool, next.handle, page)).toEqual({ nextPageIndex: 1 })
  })

  test("completion requires a successful finalize of the same frozen transfer", async () => {
    await using tmp = await fixture()
    const first = await tmp.spool.begin(tmp.input)
    const second = await tmp.spool.begin({ ...tmp.input, clientTransferID: "second" })
    await expect(tmp.spool.complete(first.handle, "arbitrary")).rejects.toBeInstanceOf(SyncTransferConflict)
    const input = { handle: first.handle, expectedPageCount: 0, manifestDigest: emptyManifest }
    const ready = await tmp.spool.finalize(input)
    await expect(tmp.spool.complete(second.handle, ready.receipt)).rejects.toBeInstanceOf(SyncTransferConflict)
    const other = await tmp.spool.finalize({ ...input, handle: second.handle })
    await expect(tmp.spool.complete(second.handle, ready.receipt)).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.complete(first.handle, other.receipt)).rejects.toBeInstanceOf(SyncTransferConflict)
    await tmp.spool.complete(first.handle, ready.receipt)
    await tmp.spool.complete(second.handle, other.receipt)
  })

  test("a ready transfer rejects additional pages and invalidates its receipt", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const ready = await tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 0, manifestDigest: emptyManifest })
    await expect(append(tmp.spool, begin.handle, { records: [record] })).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.complete(begin.handle, ready.receipt)).rejects.toBeInstanceOf(SyncTransferConflict)
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("equal frozen-page retries are harmless and conflicting ready-finalize retries are rejected", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const page = { records: [record] }
    await append(tmp.spool, begin.handle, page)
    const input = { handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }
    const ready = await tmp.spool.finalize(input)
    expect(await append(tmp.spool, begin.handle, page)).toEqual({ nextPageIndex: 1 })
    await expect(tmp.spool.finalize({ ...input, expectedPageCount: 2 })).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.finalize({ ...input, manifestDigest: digest("conflict") })).rejects.toBeInstanceOf(SyncTransferConflict)
    await tmp.spool.complete(begin.handle, ready.receipt)
  })

  test("a finalize waiting behind append validates the resulting page count", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const results = await Promise.allSettled([
      append(tmp.spool, begin.handle, { records: [record] }),
      tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 0, manifestDigest: emptyManifest }),
    ])
    expect(results[0]?.status).toBe("fulfilled")
    const finalized = results[1]
    if (!finalized || finalized.status !== "rejected") throw new Error("expected stale finalize to fail")
    expect(finalized.reason).toBeInstanceOf(SyncTransferConflict)
  })

  test("queued finalize parameters cannot be mutated while waiting", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const appending = append(tmp.spool, begin.handle, { records: [record] })
    const input = { handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }
    const finalizing = tmp.spool.finalize(input)
    input.expectedPageCount = 0
    input.manifestDigest = digest("conflict")
    const [, ready] = await Promise.all([appending, finalizing])
    expect(ready.status).toBe("ready")
    await tmp.spool.complete(begin.handle, ready.receipt)
  })

  test("validates begin aggregate and metadata boundaries", async () => {
    await using tmp = await fixture()
    const highWater = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`aggregate-${index}`, 0]))
    const begin = await tmp.spool.begin({ ...tmp.input, highWater })
    await tmp.spool.abort(begin.handle)
    await expect(tmp.spool.begin({ ...tmp.input, highWater: { ...highWater, overflow: 0 } }))
      .rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
    const invalid: ReadonlyArray<Readonly<Record<string, number>>> = [
      { "": 0 }, { s: -1 }, { s: 0.5 }, { ["s".repeat(257)]: 0 },
    ]
    for (const highWater of invalid) {
      await expect(tmp.spool.begin({ ...tmp.input, highWater })).rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
    }
    const base = { ...tmp.input, sourceSnapshotToken: "" }
    const exact = { ...base, sourceSnapshotToken: "x".repeat(64 * 1024 - Buffer.byteLength(canonical(base))) }
    expect(Buffer.byteLength(canonical(exact))).toBe(64 * 1024)
    const accepted = await tmp.spool.begin(exact)
    await tmp.spool.abort(accepted.handle)
    await expect(tmp.spool.begin({ ...exact, sourceSnapshotToken: `${exact.sourceSnapshotToken}x` }))
      .rejects.toMatchObject({ _tag: "SyncTransferTooLarge" })
  })

  test("binds high-water values to an immutable begin snapshot", async () => {
    await using tmp = await fixture()
    const highWater = { "session-1": 0 }
    const pending = tmp.spool.begin({ ...tmp.input, highWater })
    highWater["session-1"] = 1
    const begin = await pending
    expect(await append(tmp.spool, begin.handle, { records: [record] })).toEqual({ nextPageIndex: 1 })
    const ready = await tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest })
    if (ready.status !== "ready") throw new Error("expected ready transfer")
    expect(ready.bundles[0]?.sourceSeq).toBe(0)
  })

  test("rejects incomplete chunks, noncanonical base64, mixed pages and reordering", async () => {
    const first = chunks(2)[0]
    if (!first) throw new Error("expected first chunk")
    const cases: ReadonlyArray<{ readonly page: SyncPage; readonly pageIndex?: number; readonly tag: string }> = [
      { page: { records: [{ ...first, data: `${first.data}\n` }] }, tag: "SyncTransferConflict" },
      { page: { records: [{ ...first, chunkIndex: 1 }] }, tag: "SyncTransferConflict" },
      { page: { records: [{ ...first, chunkCount: 1, contentHash: digest("wrong") }] }, tag: "SyncTransferConflict" },
      { page: { records: [first, record] }, tag: "SyncTransferTooLarge" },
      { page: { records: [record] }, pageIndex: 1, tag: "SyncTransferConflict" },
      { page: { records: [] }, tag: "SyncTransferConflict" },
      { page: { records: [record, record] }, tag: "SyncTransferConflict" },
      { page: { records: [{ ...record, sourceSeq: 1 }] }, tag: "SyncTransferConflict" },
    ]
    for (const item of cases) {
      await using tmp = await fixture()
      const begin = await tmp.spool.begin(tmp.input)
      await expect(append(tmp.spool, begin.handle, item.page, item.pageIndex)).rejects.toMatchObject({ _tag: item.tag })
      expect(await readdir(tmp.root)).toEqual([])
    }
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    await append(tmp.spool, begin.handle, { records: [first] })
    await expect(tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }))
      .rejects.toBeInstanceOf(SyncTransferConflict)
    expect(await readdir(tmp.root)).toHaveLength(1)
    await tmp.spool.abort(begin.handle)
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("private context, deletion and epoch identities reconcile their manifest", async () => {
    await using tmp = await fixture()
    const context = { aggregateID: "session-1", seq: 0, kind: "message", messageID: "m", contentHash: "hash", payload: "private" }
    const deletion = { aggregateID: "session-1", targetKind: "message", targetMessageID: "m", targetEvent: { seq: 0 } }
    const epoch = { aggregateID: "session-1", kind: "context-epoch", sourceSeq: 0, epochSchemaVersion: 1 }
    const manifest = manifestDigest([privateManifest({
      aggregateID: "session-1", sourceSeq: 0, contexts: [context], deletions: [deletion], epoch,
    })])
    const begin = await tmp.spool.begin({ ...tmp.input, manifestDigest: manifest })
    await append(tmp.spool, begin.handle, { records: [
      record,
      { ...record, kind: "deletion", identity: "message:m", value: deletion },
      { ...record, kind: "context", identity: "message:m", value: context },
      { ...record, kind: "epoch", identity: "session-1", value: epoch },
    ] })
    const ready = await tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: manifest })
    if (ready.status !== "ready") throw new Error("expected ready transfer")
    expect(ready.bundles).toEqual([{
      version: 1, aggregateID: "session-1", sourceSeq: 0, events: [record.value], contexts: [context], deletions: [deletion], epoch,
    }])
  })

  test("payload parsing errors do not reveal private text", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const bytes = Buffer.from("private-secret-invalid-json")
    const first = chunks(1)[0]
    if (!first) throw new Error("expected chunk")
    const result = await Promise.allSettled([append(tmp.spool, begin.handle, { records: [{
      ...first, data: bytes.toString("base64"), byteLength: bytes.length, contentHash: digest(bytes),
    }] })])
    const rejected = result[0]
    if (!rejected || rejected.status !== "rejected" || !(rejected.reason instanceof Error))
      throw new Error("expected parsing failure")
    expect(rejected.reason).toBeInstanceOf(SyncTransferConflict)
    expect(rejected.reason.message).not.toContain("private-secret")
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("disposal drains admitted operations, removes active payloads and rejects new operations", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const appending = append(tmp.spool, begin.handle, { records: [record] })
    const finalizing = tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest })
    const beginning = tmp.spool.begin({ ...tmp.input, clientTransferID: "in-flight" })
    const disposal = tmp.spool.dispose()
    expect(tmp.spool.dispose()).toBe(disposal)
    await expect(tmp.spool.begin({ ...tmp.input, clientTransferID: "too-late" })).rejects.toBeInstanceOf(SyncTransferConflict)
    await Promise.all([appending, finalizing, beginning, disposal])
    expect(await readdir(tmp.root)).toEqual([])
    await expect(append(tmp.spool, begin.handle, { records: [record] })).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest }))
      .rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.complete(begin.handle, "receipt")).rejects.toBeInstanceOf(SyncTransferConflict)
    await expect(tmp.spool.abort(begin.handle)).rejects.toBeInstanceOf(SyncTransferConflict)
  })

  test("disposal waits for an append already writing its encrypted payload", async () => {
    const writing = Promise.withResolvers<void>()
    const clock = { checks: Number.POSITIVE_INFINITY }
    await using tmp = await fixture({ now: () => {
      clock.checks--
      if (clock.checks === 0) writing.resolve()
      return 0
    } })
    const begin = await tmp.spool.begin(tmp.input)
    // The third live check reserves the budget immediately before appendFile.
    // Its signal resumes this test while the real filesystem write is awaited.
    clock.checks = 3
    const appending = append(tmp.spool, begin.handle, { records: [{
      ...record, value: { ...record.value, data: "x".repeat(128 * 1024) },
    }] })
    await writing.promise
    const finalizing = tmp.spool.finalize({ handle: begin.handle, expectedPageCount: 1, manifestDigest: emptyManifest })
    const disposing = tmp.spool.dispose()
    expect(await appending).toEqual({ nextPageIndex: 1 })
    expect((await finalizing).status).toBe("ready")
    await disposing
    expect(await readdir(tmp.root)).toEqual([])
  })

  test("disposal clears completed receipts without sweeping unrelated new root entries", async () => {
    await using tmp = await fixture()
    const begin = await tmp.spool.begin(tmp.input)
    const input = { handle: begin.handle, expectedPageCount: 0, manifestDigest: emptyManifest }
    const ready = await tmp.spool.finalize(input)
    await tmp.spool.complete(begin.handle, ready.receipt)
    await writeFile(path.join(tmp.root, "caller-owned"), "keep")
    await tmp.spool.dispose()
    expect(await readdir(tmp.root)).toEqual(["caller-owned"])
    await expect(tmp.spool.finalize(input)).rejects.toBeInstanceOf(SyncTransferConflict)
    await tmp.spool.dispose()
  })
})
