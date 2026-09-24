import { mkdir, realpath, symlink, lstat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const upstream = resolve(root, "../vendor/opencode")
const pin = "b02acc1e30ef55f7f181fec8d2f241d26f022683"
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: upstream })
if (head.exitCode !== 0 || head.stdout.toString().trim() !== pin) throw new Error("Native source pin mismatch")

// This explicit source-package installation writes only ignored extension
// node_modules links. Every target is the official dependency's real module;
// no native import is redirected to an extension implementation.
const core = join(upstream, "packages/core")
const links = {
  "@opencode-ai/core": core,
  "@opencode-ai/schema": join(upstream, "packages/schema"),
  "@opencode-ai/llm": join(upstream, "packages/llm"),
  "@opencode-ai/protocol": join(upstream, "packages/protocol"),
  "@opencode-ai/server": join(upstream, "packages/server"),
  effect: resolve(dirname(Bun.resolveSync("effect", core)), ".."),
  "drizzle-orm": dirname(Bun.resolveSync("drizzle-orm", core)),
}
const target = join(root, "packages/adapters-opencode/node_modules")
for (const [name, source] of Object.entries(links)) {
  const destination = join(target, name)
  const canonical = await realpath(source)
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (existing) {
    if ((await realpath(destination)) !== canonical) throw new Error(`Unexpected native package at ${destination}`)
    continue
  }
  await mkdir(dirname(destination), { recursive: true })
  await symlink(canonical, destination, process.platform === "win32" ? "junction" : "dir")
  console.log(`${name} -> ${canonical}`)
}
