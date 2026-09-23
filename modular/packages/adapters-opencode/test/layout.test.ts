import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLayoutService } from "@cybermastery/domain/layout"
import { createLayoutRepository } from "../src/layout"
import { createKernel } from "../src/kernel"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanupAfterTests = databaseCleanup()

test("adds extension storage to an existing official-native database without changing its migration ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-upgrade-"))
  cleanupAfterTests(directory)
  const filename = join(directory, "native.db")
  const native = createKernel(filename)
  const migrationIDs = Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)
  })
  const before = await native.runPromise(migrationIDs)
  await native.dispose()
  const extension = await createLayoutRepository({ filename, workspaceID: "ws", ownerID: "user" })
  const inspect = createKernel(filename)
  try {
    expect(before.length).toBeGreaterThan(0)
    expect(await inspect.runPromise(migrationIDs)).toEqual(before)
    const initialized = await extension.repository.get({ userID: "user" }, "ws", { user: "user", style: "canvas", deviceClass: "desktop" }, "client")
    expect(initialized.revision).toBe(0)
  } finally {
    await extension.dispose()
    await inspect.dispose()
  }
})

test("independent database connections enforce revision and authority with notifications after committed saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-layout-"))
  cleanupAfterTests(directory)
  const config = { filename: join(directory, "layout.db"), workspaceID: "workspace-1", ownerID: "user-1" }
  const first = await createLayoutRepository(config)
  const second = await createLayoutRepository(config)
  const actor = { userID: "user-1" }
  const tuple = { user: "user-1", style: "canvas", deviceClass: "desktop" as const }
  const catalogue = new Map([["proof:static-card", { minW: 1, minH: 1 }]])
  const left = createLayoutService(first.repository, catalogue)
  const right = createLayoutService(second.repository, catalogue)
  const notifications: number[] = []
  const unsubscribe = await first.listen((event) => notifications.push(event.properties.revision))
  try {
    const initial = await left.get(actor, config.workspaceID, tuple, "client-1")
    const command = {
      workspaceID: config.workspaceID, tuple, clientID: "client-1", expectedRevision: initial.revision,
      blocks: [{ id: "card-1", functionalityID: "proof:static-card", transform: { x: 0, y: 0, w: 1, h: 1, z: 0 } }],
    }
    const outcomes = await Promise.allSettled([left.save(actor, command), right.save(actor, command)])
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1)
    const after = await right.get(actor, config.workspaceID, tuple, "client-2")
    expect(after.revision).toBe(1)
    expect(after.blocks).toEqual(command.blocks)
    await expect(left.save(actor, { ...command, expectedRevision: 1 })).rejects.toMatchObject({ code: "handed-over" })
    await expect(right.save({ userID: "other" }, { ...command, clientID: "client-2", expectedRevision: 1 })).rejects.toMatchObject({ code: "forbidden" })
    await expect(right.save(actor, { ...command, clientID: "client-2", expectedRevision: 1, blocks: [{ ...command.blocks[0], functionalityID: "missing" }] })).rejects.toMatchObject({ code: "invalid-functionality" })
    const saved = await right.save(actor, { ...command, clientID: "client-2", expectedRevision: 1, blocks: [] })
    expect(saved.revision).toBe(2)
    // Only the first connection's process-local Event service is subscribed.
    expect(notifications.every((revision) => revision === 1)).toBe(true)
  } finally {
    await unsubscribe()
    await first.dispose()
    await second.dispose()
  }
})
