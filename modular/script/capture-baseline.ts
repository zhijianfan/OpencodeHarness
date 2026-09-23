import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const reference = resolve(process.argv[2] ?? resolve(root, "../CyberMastery"))
const pin = await Bun.file(resolve(root, "compat/upstream-pin.json")).json()
const output = resolve(root, "compat/baseline")
await mkdir(output, { recursive: true })

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, maxBuffer: 64 * 1024 * 1024 })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.toString()
}

const baseline = "d555e5aa7031ca210b7ba4ab098e746c3ee79404"
const refHead = git(reference, "rev-parse", "HEAD").trim()
if (refHead !== baseline) throw new Error("Reference HEAD changed: choose and review a new baseline explicitly")
const upstream = git(resolve(root, pin.path), "rev-parse", "HEAD").trim()
if (upstream !== pin.commit) throw new Error("Upstream pin changed")
const diff = git(reference, "diff", "--name-status", "--find-renames", pin.commit, baseline)
const paths = diff.trim().split("\n").map((line) => {
  const [status, path, renamed] = line.split("\t")
  const current = renamed ?? path
  const generated = /\/generated(?:-effect)?\/|\/gen\/|\.gen\./.test(current)
  const test = /\.test\.|\.spec\.|\/test\/|\/e2e\//.test(current)
  const docs = /^(?:specs|docs|devplan)\//.test(current) || /\.md$/.test(current)
  const feature = /(?:ctxpack|ctx-pack)/.test(current) ? "ctxpack"
    : /(?:chat-relay|chat-proxy)/.test(current) ? "chat-relay"
    : /(?:master-agent|task-batch|subagent-runner|parallel)/.test(current) ? "master-agent"
    : /(?:session-context|projection-transfer|compaction-context|context-sidecar|context-slot)/.test(current) ? "private-context"
    : /(?:workspace|canvas)/.test(current) ? "workspace-canvas"
    : /(?:skill|superpowers)/.test(current) ? "skills"
    : "requires-review"
  return {
    status,
    path: current,
    ...(renamed ? { previousPath: path } : {}),
    category: generated ? "generated-derivative" : test ? "test" : docs ? "documentation" : "source-or-tooling",
    feature,
    disposition: "pending-source-review",
    classificationEvidence: "path-based candidate only; not a completeness claim",
  }
})

const artifacts = {
  "rename-aware.diff": git(reference, "diff", "--binary", "--find-renames", pin.commit, baseline),
  "reference-staged.patch": git(reference, "diff", "--cached", "--binary"),
  "reference-unstaged.patch": git(reference, "diff", "--binary"),
  "harness-staged.patch": git(root, "diff", "--cached", "--binary"),
  "harness-unstaged.patch": git(root, "diff", "--binary"),
  "reference-tree.txt": git(reference, "ls-tree", "-r", baseline),
  "harness-tree.txt": git(root, "ls-tree", "-r", "HEAD"),
}
const manifest = []
for (const [name, contents] of Object.entries(artifacts)) {
  await Bun.write(resolve(output, name), contents)
  manifest.push({ name, sha256: createHash("sha256").update(contents).digest("hex") })
}
for (const name of ["bun.lock", ".gitmodules", "CYBERMASTERY_MODULARIZATION_ALIGNMENT_REVIEW.md", "CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md"]) {
  const contents = await Bun.file(resolve(root, name)).arrayBuffer()
  manifest.push({ name, sha256: createHash("sha256").update(new Uint8Array(contents)).digest("hex") })
}
const write = (name: string, value: unknown) => Bun.write(resolve(output, name), JSON.stringify(value, null, 2) + "\n")
await write("diff-disposition.json", paths)
await write("evidence-manifest.json", manifest)
await write("snapshot.json", {
  version: 1,
  capturedAt: new Date().toISOString(),
  harnessHead: git(root, "rev-parse", "HEAD").trim(),
  harnessTree: git(root, "rev-parse", "HEAD^{tree}").trim(),
  referenceHead: baseline,
  referenceTree: git(reference, "rev-parse", `${baseline}^{tree}`).trim(),
  comparison: pin,
  deltaPaths: paths.length,
  forkOnlyCommits: Number(git(reference, "rev-list", "--count", `${pin.commit}..${baseline}`).trim()),
  environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
  referenceStatus: git(reference, "status", "--porcelain"),
  relevantUntrackedAtStart: ["CYBERMASTERY_MODULARIZATION_ALIGNMENT_REVIEW.md", "CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md"],
  excludedUntracked: [{ path: ".opencode-tmp/", reason: "Agent scratch state, not product source; retained in the original checkout" }],
  stabilizationFiles: { state: "committed", commit: baseline, priorBaseline: "b7c82166e3ed1c7c7cb64a1ac631f2a9e15404e0" },
  completeness: "pending-per-path-review",
})
console.log(`Captured ${paths.length} path dispositions; completeness remains pending source review`)
