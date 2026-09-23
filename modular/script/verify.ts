import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { attestUpstream } from "../packages/compat/src/upstream"

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = resolve(workspace, "..")
const pin = await Bun.file(resolve(root, "compat/upstream-pin.json")).json()
const before = await attestUpstream(resolve(root, pin.path), pin)
const checks = [
  { cwd: "packages/contracts", command: ["bun", "typecheck"] },
  { cwd: "packages/contracts", command: ["bun", "test", "src"] },
  { cwd: "packages/canvas", command: ["bun", "typecheck"] },
  { cwd: "packages/canvas", command: ["bun", "test", "src"] },
  { cwd: "packages/compat", command: ["bun", "typecheck"] },
  { cwd: "packages/compat", command: ["bun", "test", "src"] },
  { cwd: "packages/domain", command: ["bun", "typecheck"] },
  { cwd: "packages/client", command: ["bun", "typecheck"] },
  { cwd: "packages/client", command: ["bun", "test", "src"] },
  { cwd: "packages/adapters-opencode", command: ["bun", "typecheck"] },
  { cwd: "packages/adapters-opencode", command: ["bun", "test", "test"] },
  { cwd: "apps/host", command: ["bun", "typecheck"] },
  { cwd: "apps/host", command: ["bun", "test", "test"] },
  { cwd: "apps/web", command: ["bun", "typecheck"] },
  { cwd: "apps/web", command: ["bun", "run", "build"] },
  { cwd: "apps/web", command: ["bun", "run", "test:smoke"] },
]
const results = []
for (const check of checks) {
  const child = Bun.spawn(check.command, { cwd: resolve(workspace, check.cwd), stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  const output = stdout + stderr
  console.log(`${check.cwd}: ${check.command.join(" ")} -> ${exitCode}`)
  if (exitCode !== 0) console.error(output)
  const count = (kind: string) => Number(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`).exec(output)?.[1] ?? 0)
  results.push({ ...check, exitCode, pass: count("pass"), fail: count("fail"), skip: count("skip"), outputHash: createHash("sha256").update(output).digest("hex"), output })
}
const after = await attestUpstream(resolve(root, pin.path), pin)
const sourceUnchanged = before.sourceDigest === after.sourceDigest && before.commit === after.commit
const success = sourceUnchanged && results.every((result) => result.exitCode === 0)
await Bun.write(resolve(root, "compat/verification.json"), JSON.stringify({
  capturedAt: new Date().toISOString(),
  scope: "modular proof workspace only; not full feature parity",
  release: "blocked-see-gates.json",
  success,
  sourceUnchanged,
  before,
  after,
  results,
}, null, 2) + "\n")
if (!success) process.exitCode = 1
