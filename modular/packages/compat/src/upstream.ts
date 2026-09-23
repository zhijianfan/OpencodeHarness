// Official-source attestation for a vendored upstream checkout.
//
// This guard inspects a local Git worktree read-only: it never fetches and never
// mutates Git configuration. It is meant to run before and after native proof
// tests, but it is not a read-only mount and cannot prove that temporary
// modifications were impossible while nothing was watching.
//
// sourceDigest is an integrity manifest over the pinned Git objects (mode,
// object hash, path), not a fingerprint of raw working-tree bytes. Git may
// legitimately hold CRLF working files whose canonical blobs (after clean
// conversion such as core.autocrlf) contain LF, so the digest is computed over
// the canonical object hashes produced by Git itself.

import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { Stats } from "node:fs"
import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

export type UpstreamPin = {
  readonly commit: string
  readonly repository: string
}

export type Attestation = {
  readonly commit: string
  readonly tree: string
  readonly repository: string
  readonly trackedFiles: number
  readonly sourceDigest: string
}

export class UpstreamIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UpstreamIntegrityError"
  }
}

export async function attestUpstream(directory: string, pin: UpstreamPin): Promise<Attestation> {
  try {
    return await attest(directory, pin)
  } catch (error) {
    if (error instanceof UpstreamIntegrityError) throw error
    throw new UpstreamIntegrityError(`Failed to attest upstream at "${directory}": ${errorMessage(error)}`)
  }
}

type GitResult = {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

type TreeEntry = {
  readonly mode: string
  readonly type: string
  readonly hash: string
  readonly path: string
  readonly pathBytes: Uint8Array
}

const TAB = 0x09
const NUL = 0x00
const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d
const DOUBLE_QUOTE = 0x22
const BACKSLASH = 0x5c

const NUL_BYTES = new Uint8Array([NUL])
const LINE_FEED_BYTES = new Uint8Array([LINE_FEED])
const textDecoder = new TextDecoder("utf-8")
const textEncoder = new TextEncoder()

const gitEnvironment = createGitEnvironment()

// Ambient GIT_* repository selection variables would silently redirect these
// commands at a different repository than the directory being attested.
function createGitEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  }
  delete environment["GIT_DIR"]
  delete environment["GIT_WORK_TREE"]
  delete environment["GIT_INDEX_FILE"]
  delete environment["GIT_OBJECT_DIRECTORY"]
  delete environment["GIT_ALTERNATE_OBJECT_DIRECTORIES"]
  delete environment["GIT_COMMON_DIR"]
  delete environment["GIT_NAMESPACE"]
  return environment
}

async function attest(directory: string, pin: UpstreamPin): Promise<Attestation> {
  const root = await requireWorktreeRoot(directory)

  const commit = await requireGitText(root, ["rev-parse", "HEAD"], "resolve HEAD")
  if (commit !== pin.commit) {
    throw new UpstreamIntegrityError(`HEAD at "${root}" is ${commit}, expected pinned commit ${pin.commit}`)
  }

  const repository = await requireGitText(root, ["remote", "get-url", "origin"], "resolve the origin remote URL")
  if (repository !== pin.repository) {
    throw new UpstreamIntegrityError(
      `Origin at "${root}" is "${repository}", expected pinned repository "${pin.repository}"`,
    )
  }

  const tree = await requireGitText(root, ["rev-parse", "HEAD^{tree}"], "resolve the HEAD tree")
  const entries = parseTreeEntries(
    await requireGitBytes(root, ["ls-tree", "-r", "-z", "HEAD"], "list tracked tree entries"),
  )

  await requireCleanWorktree(root)
  await verifyWorkingTree(root, entries)

  return {
    commit,
    tree,
    repository,
    trackedFiles: entries.length,
    sourceDigest: digestTree(entries),
  }
}

async function requireWorktreeRoot(directory: string): Promise<string> {
  const result = await runGit(directory, ["rev-parse", "--show-toplevel"])
  if (result.exitCode !== 0) {
    throw new UpstreamIntegrityError(`"${directory}" is not inside a Git worktree: ${stderrText(result)}`)
  }

  const reportedRoot = decodeUtf8(result.stdout).trim()
  if (reportedRoot.length === 0) {
    throw new UpstreamIntegrityError(`Git reported an empty worktree root for "${directory}"`)
  }

  const [expected, actual] = await Promise.all([realpath(directory), realpath(reportedRoot)])
  if (!samePath(expected, actual)) {
    throw new UpstreamIntegrityError(
      `"${directory}" is not the root of its own Git worktree (worktree root is "${reportedRoot}")`,
    )
  }
  return actual
}

async function requireCleanWorktree(root: string): Promise<void> {
  const status = await requireGitText(
    root,
    ["status", "--porcelain", "--untracked-files=all"],
    "inspect the working tree status",
  )
  if (status.length === 0) return
  throw new UpstreamIntegrityError(
    `Working tree at "${root}" has staged, unstaged, or untracked changes that are not ignored:\n${status}`,
  )
}

async function verifyWorkingTree(root: string, entries: readonly TreeEntry[]): Promise<void> {
  const fileEntries: TreeEntry[] = []
  const linkEntries: TreeEntry[] = []

  for (const entry of entries) {
    if (entry.type === "commit") continue
    if (entry.type !== "blob") {
      throw new UpstreamIntegrityError(`Unsupported Git tree object type "${entry.type}" for "${entry.path}"`)
    }

    if (entry.mode === "120000") {
      const stats = await lstatIfPresent(absolutePath(root, entry.path))
      if (stats === undefined) {
        throw new UpstreamIntegrityError(`Tracked symlink "${entry.path}" is missing from the working tree`)
      }
      if (stats.isSymbolicLink()) {
        linkEntries.push(entry)
        continue
      }
      // Windows checkouts with core.symlinks=false store the link text in a
      // regular file, which is hashed like any other file below.
    }

    fileEntries.push(entry)
  }

  const fileHashes = await hashWorkingFiles(root, fileEntries)
  for (const [index, entry] of fileEntries.entries()) {
    assertBlobHash(entry, fileHashes[index])
  }
  for (const entry of linkEntries) {
    assertBlobHash(entry, await hashSymlink(root, entry))
  }

  await verifyGitlinks(root, entries)
}

// git hash-object applies the repository's clean conversion (for example
// core.autocrlf end-of-line normalization) when it hashes a path, so the
// results are the canonical blob contents recorded in the tree. Raw on-disk
// byte fingerprints can legitimately differ from those canonical contents when
// EOL conversion is configured. Index flags such as assume-unchanged and
// skip-worktree do not hide files from hash-object, so every blob is verified
// independently of `git status`.
async function hashWorkingFiles(root: string, entries: readonly TreeEntry[]): Promise<string[]> {
  if (entries.length === 0) return []

  const stdin = joinPathLines(entries.map((entry) => entry.pathBytes))
  const output = await requireGitBytes(root, ["hash-object", "--stdin-paths"], "hash working tree files", stdin)
  const hashes = decodeUtf8(output)
    .split("\n")
    .filter((line) => line.length > 0)

  if (hashes.length !== entries.length) {
    throw new UpstreamIntegrityError(
      `Expected ${entries.length} working tree hashes from git hash-object, received ${hashes.length}`,
    )
  }
  return hashes
}

// A real symlink must hash its link text, not the contents of whatever it
// points at, so the target is read with readlink and piped to git hash-object
// instead of being opened through the link.
async function hashSymlink(root: string, entry: TreeEntry): Promise<string> {
  const linkText = await readlink(absolutePath(root, entry.path))
  const output = await requireGitBytes(
    root,
    ["hash-object", "--stdin"],
    "hash the symlink link text",
    textEncoder.encode(linkText),
  )
  return decodeUtf8(output).trim()
}

function assertBlobHash(entry: TreeEntry, computed: string | undefined): void {
  if (computed === entry.hash) return
  throw new UpstreamIntegrityError(
    `Working tree content for "${entry.path}" does not match the pinned tree: expected Git object ${entry.hash}, computed ${computed ?? "nothing"}`,
  )
}

async function verifyGitlinks(root: string, entries: readonly TreeEntry[]): Promise<void> {
  const gitlinks = entries.filter((entry) => entry.type === "commit")
  if (gitlinks.length === 0) return

  const staged = await readStagedGitlinks(root)
  for (const entry of gitlinks) {
    const stagedHash = staged.get(entry.path)
    if (stagedHash !== entry.hash) {
      throw new UpstreamIntegrityError(
        `Gitlink "${entry.path}" is staged as ${stagedHash ?? "nothing"}, expected pinned commit ${entry.hash}`,
      )
    }
    await verifySubmodule(root, entry)
  }
}

async function readStagedGitlinks(root: string): Promise<Map<string, string>> {
  const output = await requireGitBytes(root, ["ls-files", "--stage", "-z"], "list staged gitlinks")
  const staged = new Map<string, string>()

  for (const record of splitNul(output)) {
    const tabIndex = record.indexOf(TAB)
    if (tabIndex < 0) continue
    const header = decodeUtf8(record.subarray(0, tabIndex)).split(" ")
    const mode = header[0]
    const hash = header[1]
    const stage = header[2]
    if (mode !== "160000" || stage !== "0" || hash === undefined) continue
    staged.set(decodeUtf8(record.subarray(tabIndex + 1)), hash)
  }
  return staged
}

async function verifySubmodule(root: string, entry: TreeEntry): Promise<void> {
  const submodulePath = absolutePath(root, entry.path)
  const stats = await lstatIfPresent(submodulePath)
  if (stats === undefined) return // Not checked out; the superproject tree is still intact.
  if (!stats.isDirectory()) {
    throw new UpstreamIntegrityError(`Gitlink "${entry.path}" is not a directory in the working tree`)
  }

  // An empty, uninitialized submodule directory is a normal checkout state.
  const children = await readdir(submodulePath)
  if (children.length === 0) return

  const marker = await lstatIfPresent(join(submodulePath, ".git"))
  if (marker === undefined) {
    await requireIgnoredChildren(root, entry.path, children)
    return
  }

  const head = await requireGitText(submodulePath, ["rev-parse", "HEAD"], "resolve the submodule HEAD")
  if (head !== entry.hash) {
    throw new UpstreamIntegrityError(
      `Submodule "${entry.path}" is checked out at ${head}, expected pinned commit ${entry.hash}`,
    )
  }

  // --ignore-submodules=all bounds the check below the submodule itself instead
  // of recursing through nested submodules without limit.
  const status = await requireGitText(
    submodulePath,
    ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"],
    "inspect the submodule tracked state",
  )
  if (status.length > 0) {
    throw new UpstreamIntegrityError(`Submodule "${entry.path}" has tracked modifications:\n${status}`)
  }
}

async function requireIgnoredChildren(root: string, modulePath: string, children: readonly string[]): Promise<void> {
  const paths = children.map((child) => `${modulePath}/${child}`)
  const result = await runGit(
    root,
    ["check-ignore", "-z", "--stdin"],
    joinNul(paths.map((path) => textEncoder.encode(path))),
  )
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new UpstreamIntegrityError(
      `Failed to check ignored entries below gitlink "${modulePath}" in "${root}": ${stderrText(result)}`,
    )
  }

  const ignored = new Set(
    splitNul(result.stdout)
      .flatMap((record) => decodeUtf8(record).split("\n"))
      .filter((path) => path.length > 0),
  )
  const unexpected = paths.filter((path) => !ignored.has(path))
  if (unexpected.length === 0) return
  throw new UpstreamIntegrityError(
    `Gitlink "${modulePath}" is not initialized but contains non-ignored entries: ${unexpected.join(", ")}`,
  )
}

async function requireGitText(
  root: string,
  args: readonly string[],
  action: string,
  stdin?: Uint8Array,
): Promise<string> {
  return decodeUtf8(await requireGitBytes(root, args, action, stdin)).trim()
}

async function requireGitBytes(
  root: string,
  args: readonly string[],
  action: string,
  stdin?: Uint8Array,
): Promise<Uint8Array> {
  const result = await runGit(root, args, stdin)
  if (result.exitCode !== 0) {
    throw new UpstreamIntegrityError(
      `Failed to ${action} in "${root}": git ${args.join(" ")} exited with code ${result.exitCode}: ${stderrText(result)}`,
    )
  }
  return result.stdout
}

async function runGit(root: string, args: readonly string[], stdin?: Uint8Array): Promise<GitResult> {
  try {
    const child = Bun.spawn(["git", "-C", root, ...args], {
      env: gitEnvironment,
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ])
    return { exitCode, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) }
  } catch (error) {
    throw new UpstreamIntegrityError(`Failed to run git ${args.join(" ")} in "${root}": ${errorMessage(error)}`)
  }
}

function parseTreeEntries(output: Uint8Array): TreeEntry[] {
  return splitNul(output).map(parseTreeEntry)
}

// `git ls-tree -r -z` emits: mode SP type SP object-hash TAB path NUL. Paths are
// raw bytes with -z, so spaces (and other filename bytes) survive intact.
function parseTreeEntry(record: Uint8Array): TreeEntry {
  const tabIndex = record.indexOf(TAB)
  if (tabIndex < 0) {
    throw new UpstreamIntegrityError(`Malformed Git tree entry: ${decodeUtf8(record)}`)
  }

  const header = decodeUtf8(record.subarray(0, tabIndex)).split(" ")
  const pathBytes = record.subarray(tabIndex + 1)
  const mode = header[0]
  const type = header[1]
  const hash = header[2]
  if (
    header.length !== 3 ||
    mode === undefined ||
    type === undefined ||
    hash === undefined ||
    !/^[0-7]{6}$/.test(mode) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash) ||
    pathBytes.length === 0
  ) {
    throw new UpstreamIntegrityError(`Malformed Git tree entry: ${decodeUtf8(record)}`)
  }

  const path = decodeUtf8(pathBytes)
  assertSafeTreePath(path)
  return { mode, type, hash, path, pathBytes }
}

function assertSafeTreePath(path: string): void {
  const unsafe = path
    .split("/")
    .some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
    )
  if (unsafe) throw new UpstreamIntegrityError(`Git tree entry has an unsafe path: "${path}"`)
}

// Deterministic SHA-256 manifest over the pinned tree: records of
// `mode SP object-hash SP path` sorted by raw path bytes.
function digestTree(entries: readonly TreeEntry[]): string {
  const hash = createHash("sha256")
  const sorted = [...entries].sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes))
  for (const entry of sorted) {
    hash.update(`${entry.mode} ${entry.hash} `)
    hash.update(entry.pathBytes)
    hash.update("\n")
  }
  return hash.digest("hex")
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = []
  let start = 0
  for (;;) {
    const end = bytes.indexOf(NUL, start)
    if (end === -1) break
    if (end > start) records.push(bytes.subarray(start, end))
    start = end + 1
  }
  if (start < bytes.length) records.push(bytes.subarray(start))
  return records
}

// `git hash-object --stdin-paths` reads newline-delimited paths and C-unquotes
// any line that starts with a double quote, so paths that start with a quote or
// contain raw newlines must be quoted (and backslashes escaped inside quotes).
function joinPathLines(paths: readonly Uint8Array[]): Uint8Array {
  return concatBytes(
    paths.flatMap((pathBytes) => [needsQuoting(pathBytes) ? quotePath(pathBytes) : pathBytes, LINE_FEED_BYTES]),
  )
}

// `git check-ignore -z --stdin` accepts NUL-delimited raw paths, which cannot
// contain NUL themselves, so no quoting is required here.
function joinNul(paths: readonly Uint8Array[]): Uint8Array {
  return concatBytes(paths.flatMap((pathBytes) => [pathBytes, NUL_BYTES]))
}

function needsQuoting(pathBytes: Uint8Array): boolean {
  if (pathBytes[0] === DOUBLE_QUOTE) return true
  return pathBytes.some((byte) => byte === LINE_FEED || byte === CARRIAGE_RETURN)
}

function quotePath(pathBytes: Uint8Array): Uint8Array {
  const output: number[] = [DOUBLE_QUOTE]
  for (const byte of pathBytes) {
    if (byte === DOUBLE_QUOTE || byte === BACKSLASH) output.push(BACKSLASH, byte)
    else if (byte === LINE_FEED) output.push(BACKSLASH, 0x6e)
    else if (byte === CARRIAGE_RETURN) output.push(BACKSLASH, 0x72)
    else if (byte === TAB) output.push(BACKSLASH, 0x74)
    else if (byte < 0x20) {
      output.push(BACKSLASH, 0x30 + ((byte >> 6) & 0x07), 0x30 + ((byte >> 3) & 0x07), 0x30 + (byte & 0x07))
    } else output.push(byte)
  }
  output.push(DOUBLE_QUOTE)
  return Uint8Array.from(output)
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function absolutePath(root: string, path: string): string {
  return join(root, ...path.split("/"))
}

async function lstatIfPresent(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  if (process.platform !== "win32") return normalizedLeft === normalizedRight
  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
}

function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}

function stderrText(result: GitResult): string {
  const text = decodeUtf8(result.stderr).trim()
  return text.length === 0 ? "(no stderr output)" : text
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return (error as { readonly code?: unknown }).code
}
