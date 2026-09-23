import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication } from "../../host/src/app"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanupAfterTests = databaseCleanup()

test("built Solid shell saves and synchronizes static cards in independent LTR and RTL browser contexts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-browser-"))
  cleanupAfterTests(directory)
  const app = await createApplication({
    mode: "proof", filename: join(directory, "browser.db"), workspaceID: "proof-workspace", userID: "proof-user",
    token: "browser-proof-token", staticDirectory: resolve(import.meta.dir, "../dist"),
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  // Playwright's process/pipe implementation runs under Node, matching the
  // existing relay worker boundary; the application itself still runs on Bun.
  const child = Bun.spawn(["node", resolve(import.meta.dir, "browser-smoke.mjs"), server.url.toString()], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill(), 25_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`Browser smoke exited ${exitCode}: ${stderr}\n${stdout}`)
    expect(JSON.parse(stdout)).toEqual({ ltr: true, rtl: true, synchronized: true, removed: true, pageErrors: [] })
  } finally {
    clearTimeout(deadline)
    child.kill()
    await server.stop(true)
    await app.dispose()
  }
}, 30_000)
