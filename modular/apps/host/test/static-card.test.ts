import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLayoutClient } from "@cybermastery/client"
import { createApplication } from "../src/app"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanupAfterTests = databaseCleanup()

test("two authenticated HTTP clients share persisted layout and scoped SSE invalidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-host-"))
  cleanupAfterTests(directory)
  const options = {
    mode: "proof" as const,
    filename: join(directory, "host.db"),
    workspaceID: "workspace-test",
    userID: "owner-test",
    token: "test-only-token",
  }
  const application = await createApplication(options)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: application.fetch })
  const baseUrl = server.url.toString().replace(/\/$/, "")
  const clientOptions = { baseUrl, token: options.token, userID: options.userID, workspaceID: options.workspaceID }
  const first = createLayoutClient({ ...clientOptions, clientID: "client-1" })
  const second = createLayoutClient({ ...clientOptions, clientID: "client-2" })
  const abort = new AbortController()
  const ready = Promise.withResolvers<void>()
  const changed = Promise.withResolvers<void>()
  const revisions: number[] = []
  const subscription = second.subscribe((event) => {
    revisions.push(event.properties.revision)
    if (event.properties.revision === 1) changed.resolve()
  }, abort.signal, ready.resolve)
  try {
    await ready.promise
    const denied = await fetch(`${baseUrl}/api/cybermastery/layout`)
    expect(denied.status).toBe(401)
    const initial = await first.get({ claim: true })
    expect(initial.revision).toBe(0)
    const blocks = [{ id: "card", functionalityID: "proof:static-card", transform: { x: 0, y: 0, w: 160, h: 100, z: 1 } }]
    expect((await first.save(blocks, 0)).revision).toBe(1)
    await changed.promise
    expect(revisions).toContain(1)
    expect((await second.get()).blocks).toEqual(blocks)
    // A read-only event reload did not transfer the first client's authority.
    expect((await first.save(blocks, 1)).revision).toBe(2)
    await second.get({ claim: true })
    await expect(first.save([], 2)).rejects.toMatchObject({ status: 409, code: "handed-over" })
    expect((await second.save([], 2)).revision).toBe(3)
  } finally {
    abort.abort()
    await subscription
    await server.stop(true)
    await application.dispose()
  }
  const restarted = await createApplication(options)
  try {
    const response = await restarted.fetch(new Request(`http://proof/api/cybermastery/layout?workspaceID=${options.workspaceID}&clientID=after-restart`, {
      headers: { authorization: `Bearer ${options.token}` },
    }))
    expect(await response.json()).toMatchObject({ revision: 3, blocks: [] })
  } finally {
    await restarted.dispose()
  }
}, 15_000)

test("production/full startup fails closed before opening a database", async () => {
  await expect(createApplication({
    mode: "full", filename: ":memory:", workspaceID: "ws", userID: "user", token: "test-token",
  })).rejects.toMatchObject({ name: "FullParityUnavailable" })
})
