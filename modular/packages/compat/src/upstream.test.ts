import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { attestUpstream, UpstreamIntegrityError, type UpstreamPin } from "./upstream"

const FIXTURE_REPOSITORY = "https://fixture.invalid/upstream-attestation.git"

// Fixture repositories must not be shaped by the machine's global Git config.
const CONFIG_ARGS = [
  "-c",
  `core.excludesFile=${devNull}`,
  "-c",
  `core.attributesFile=${devNull}`,
  "-c",
  "core.autocrlf=false",
  "-c",
  "commit.gpgsign=false",
] as const

const IDENTITY_ARGS = [
  "-c",
  "user.name=Upstream Fixture",
  "-c",
  "user.email=upstream-fixture@example.com",
] as const

type Fixture = {
  readonly directory: string
  readonly commit: string
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "upstream-attestation-"))
  await runFixtureGit(directory, ["init", "--quiet"])

  await writeFile(join(directory, ".gitignore"), "node_modules/\nbuild/\n")
  await writeFile(join(directory, "README.md"), "# upstream fixture\n")
  await mkdir(join(directory, "node_modules", "fixture"), { recursive: true })
  await writeFile(join(directory, "node_modules", "fixture", "index.js"), "module.exports = 1\n")
  await mkdir(join(directory, "build"), { recursive: true })
  await writeFile(join(directory, "build", "output.txt"), "generated output\n")

  await runFixtureGit(directory, [...CONFIG_ARGS, "add", "--", "."])
  await runFixtureGit(directory, [
    ...CONFIG_ARGS,
    ...IDENTITY_ARGS,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  await runFixtureGit(directory, ["remote", "add", "origin", FIXTURE_REPOSITORY])

  const commit = (await runFixtureGit(directory, ["rev-parse", "HEAD"])).trim()
  return { directory, commit }
}

async function runFixtureGit(directory: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with code ${exitCode}: ${stderr.trim()}`)
  }
  return stdout
}

async function removeFixture(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

function pinFor(fixture: Fixture): UpstreamPin {
  return { commit: fixture.commit, repository: FIXTURE_REPOSITORY }
}

async function expectIntegrityFailure(directory: string, pin: UpstreamPin): Promise<UpstreamIntegrityError> {
  const failure = await attestUpstream(directory, pin).then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(failure instanceof UpstreamIntegrityError)) {
    throw new Error(`Expected UpstreamIntegrityError, received ${String(failure)}`)
  }
  return failure
}

describe("attestUpstream", () => {
  it("attests a clean checkout and tolerates ignored build outputs", async () => {
    const fixture = await createFixture()
    try {
      const attestation = await attestUpstream(fixture.directory, pinFor(fixture))
      expect(attestation.commit).toBe(fixture.commit)
      expect(attestation.repository).toBe(FIXTURE_REPOSITORY)
      expect(attestation.tree).toMatch(/^[0-9a-f]{40}$/)
      expect(attestation.trackedFiles).toBe(2)
      expect(attestation.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it("rejects a directory that is not a Git worktree root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "upstream-attestation-"))
    try {
      await expect(
        attestUpstream(directory, { commit: "0".repeat(40), repository: FIXTURE_REPOSITORY }),
      ).rejects.toThrow(UpstreamIntegrityError)
    } finally {
      await removeFixture(directory)
    }
  })

  it("rejects a pin whose commit differs from HEAD", async () => {
    const fixture = await createFixture()
    try {
      const failure = await expectIntegrityFailure(fixture.directory, {
        commit: "0".repeat(40),
        repository: FIXTURE_REPOSITORY,
      })
      expect(failure.name).toBe("UpstreamIntegrityError")
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it("rejects a pin whose repository differs from origin", async () => {
    const fixture = await createFixture()
    try {
      await expectIntegrityFailure(fixture.directory, {
        commit: fixture.commit,
        repository: "https://fixture.invalid/other-repository.git",
      })
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it("rejects modified tracked content", async () => {
    const fixture = await createFixture()
    try {
      await writeFile(join(fixture.directory, "README.md"), "# tampered\n")
      await expectIntegrityFailure(fixture.directory, pinFor(fixture))
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it("rejects a missing tracked file", async () => {
    const fixture = await createFixture()
    try {
      await rm(join(fixture.directory, "README.md"))
      await expectIntegrityFailure(fixture.directory, pinFor(fixture))
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it("detects an assume-unchanged edit that git status hides", async () => {
    const fixture = await createFixture()
    try {
      await runFixtureGit(fixture.directory, ["update-index", "--assume-unchanged", "README.md"])
      await writeFile(join(fixture.directory, "README.md"), "# hidden tampering\n")

      const status = await runFixtureGit(fixture.directory, ["status", "--porcelain", "--untracked-files=all"])
      expect(status.trim()).toBe("")

      await expectIntegrityFailure(fixture.directory, pinFor(fixture))
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it("rejects an untracked non-ignored file", async () => {
    const fixture = await createFixture()
    try {
      await writeFile(join(fixture.directory, "extra.txt"), "not ignored\n")
      await expectIntegrityFailure(fixture.directory, pinFor(fixture))
    } finally {
      await removeFixture(fixture.directory)
    }
  })

  it.skipIf(process.platform === "win32")("hashes symlink link text rather than the target contents", async () => {
    const fixture = await createFixture()
    try {
      await writeFile(join(fixture.directory, "target.txt"), "target contents\n")
      await symlink("target.txt", join(fixture.directory, "link.txt"))
      await runFixtureGit(fixture.directory, [...CONFIG_ARGS, "add", "--", "target.txt", "link.txt"])
      await runFixtureGit(fixture.directory, [
        ...CONFIG_ARGS,
        ...IDENTITY_ARGS,
        "commit",
        "--quiet",
        "-m",
        "add symlink",
      ])

      const commit = (await runFixtureGit(fixture.directory, ["rev-parse", "HEAD"])).trim()
      const attestation = await attestUpstream(fixture.directory, { commit, repository: FIXTURE_REPOSITORY })
      expect(attestation.commit).toBe(commit)
      expect(attestation.trackedFiles).toBe(4)
    } finally {
      await removeFixture(fixture.directory)
    }
  })
})
