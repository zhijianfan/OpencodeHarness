import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import type { OperatingChatBindingError, OperatingChatDescriptor } from "@cybermastery/contracts/operating-chat"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LLMClient, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import { databaseCleanup } from "../../../test-utils/cleanup"
import { makeOperatingChatBinding, type OperatingChatAuthorizeInput } from "../src/operating-chat-binding"
import { createSessionRuntime } from "../src/session-runtime"

const cleanup = databaseCleanup()

function runtimeFor(filename: string) {
  return createSessionRuntime({
    filename,
    policy: {
      managed: () => Effect.succeed(true),
      authorize: () => Effect.void,
      freeze: () => Effect.succeed({ apiContent: "", rendererVersion: 1 }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: () => Stream.empty })],
      [
        SessionRunnerModel.node,
        SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "test", provider: "proof", route }))),
      ],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
}

async function withRuntime(
  run: (fixture: { runtime: ReturnType<typeof runtimeFor>; directory: string }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-ocb-"))
  cleanup(directory)
  const runtime = runtimeFor(join(directory, "runtime.db"))
  try {
    await run({ runtime, directory })
  } finally {
    await runtime.dispose()
  }
}

const allowAuthorize = (_input: OperatingChatAuthorizeInput): Effect.Effect<void, OperatingChatBindingError> => Effect.void

function descriptorFor(directory: string, workspaceID: WorkspaceV2.ID, blockID: string): OperatingChatDescriptor {
  return {
    workspaceID,
    workspaceName: "Operating Chat",
    blockID,
    functionalityID: "builtin:operating-chat-session",
    functionalityInstanceID: `instance-${blockID}`,
    directory,
    operatingAgent: "build",
  }
}

function sessionLocation(directory: string, workspaceID: WorkspaceV2.ID) {
  return { directory: AbsolutePath.make(directory), workspaceID }
}

function expectFailureCode(exit: Exit.Exit<unknown, OperatingChatBindingError>, code: OperatingChatBindingError["code"]) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  const failure = Cause.findErrorOption(exit.cause)
  expect(Option.isSome(failure)).toBe(true)
  if (Option.isSome(failure)) expect(failure.value.code).toBe(code)
}

// The native directory column may canonicalize paths, so tests derive the
// descriptor from the exact recorded value the adapter will read back.
const recordedDirectory = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const row = yield* database.db
      .get<{ directory: string }>(sql`SELECT directory FROM session WHERE id = ${sessionID}`)
      .pipe(Effect.orDie)
    return row?.directory ?? ""
  })

const nativeLedger = Effect.gen(function* () {
  const database = yield* Database.Service
  const tables = yield* database.db
    .all<{ name: string }>(sql`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'cm_%' AND name LIKE '%migration%'`)
    .pipe(Effect.orDie)
  return yield* Effect.forEach(tables, (table) =>
    database.db
      .get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${table.name}"`))
      .pipe(Effect.orDie, Effect.map((row) => `${table.name}:${row?.n ?? 0}`)),
  )
})

const bindingCount = Effect.gen(function* () {
  const database = yield* Database.Service
  const row = yield* database.db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM cm_operating_chat_binding`)
    .pipe(Effect.orDie)
  return row?.n ?? 0
})

const sessionEvents = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db
      .all<{ id: string }>(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`)
      .pipe(Effect.orDie)
  })

test("bind, resolve, revalidate and reset follow the trusted profile lifecycle", async () => {
  await withRuntime(async (fixture) => {
    const workspaceID = WorkspaceV2.ID.make("wrk_ocb_lifecycle")
    const actor = { userID: "user-lifecycle", workspaceID }
    const sessionID = SessionSchema.ID.make("ses_ocb_lifecycle")
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.create({ id: sessionID, location: sessionLocation(fixture.directory, workspaceID) })
        const descriptor = descriptorFor(yield* recordedDirectory(sessionID), workspaceID, "block-lifecycle")
        expect(normalize((yield* session.get(sessionID)).location.directory)).toBe(normalize(descriptor.directory))
        expect((yield* session.get(sessionID)).location.workspaceID).toBe(workspaceID)
        const binding = yield* makeOperatingChatBinding({ authorize: allowAuthorize })
        const profile = yield* binding.bind({ actor, descriptor, sessionID })
        expect(profile).toEqual({
          kind: "operating-chat",
          workspaceID,
          workspaceName: "Operating Chat",
          blockID: "block-lifecycle",
          functionalityID: "builtin:operating-chat-session",
          functionalityInstanceID: "instance-block-lifecycle",
          generation: 1,
          revision: 1,
          directory: descriptor.directory,
          operatingAgent: "build",
        })
        expect(yield* binding.resolve(sessionID)).toEqual(profile)
        yield* binding.revalidate(sessionID, profile)
        expectFailureCode(yield* Effect.exit(binding.reset({
          actor: { userID: "foreign-user", workspaceID: "wrk_foreign" }, sessionID, expectedRevision: 1,
        })), "unauthorized")
        expect(yield* binding.resolve(sessionID)).toEqual(profile)
        yield* binding.reset({ actor, sessionID, expectedRevision: 1 })
        expect(yield* binding.resolve(sessionID)).toBeUndefined()
        expectFailureCode(yield* Effect.exit(binding.revalidate(sessionID, profile)), "stale")
      }),
    )
  })
}, 30_000)

test("rejects foreign, unknown and unclassified Sessions without writing", async () => {
  await withRuntime(async (fixture) => {
    const workspaceID = WorkspaceV2.ID.make("wrk_ocb_reject")
    const otherWorkspaceID = WorkspaceV2.ID.make("wrk_ocb_foreign")
    const actor = { userID: "user-reject", workspaceID }
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const database = yield* Database.Service
        const binding = yield* makeOperatingChatBinding({ authorize: allowAuthorize })
        expect(yield* bindingCount).toBe(0)

        expectFailureCode(
          yield* Effect.exit(
            binding.bind({
              actor,
              descriptor: descriptorFor(fixture.directory, workspaceID, "block-reject"),
              sessionID: SessionSchema.ID.make("ses_ocb_unknown"),
            }),
          ),
          "missing-session",
        )

        const mismatchID = SessionSchema.ID.make("ses_ocb_mismatch")
        yield* session.create({ id: mismatchID, location: sessionLocation(fixture.directory, workspaceID) })
        expectFailureCode(
          yield* Effect.exit(
            binding.bind({
              actor,
              descriptor: descriptorFor(yield* recordedDirectory(mismatchID), otherWorkspaceID, "block-reject"),
              sessionID: mismatchID,
            }),
          ),
          "unauthorized",
        )

        const foreignSession = SessionSchema.ID.make("ses_ocb_foreign")
        yield* session.create({ id: foreignSession, location: sessionLocation(fixture.directory, otherWorkspaceID) })
        expectFailureCode(
          yield* Effect.exit(
            binding.bind({
              actor,
              descriptor: descriptorFor(yield* recordedDirectory(foreignSession), workspaceID, "block-reject"),
              sessionID: foreignSession,
            }),
          ),
          "unauthorized",
        )

        const directorySession = SessionSchema.ID.make("ses_ocb_directory")
        yield* session.create({ id: directorySession, location: sessionLocation(fixture.directory, workspaceID) })
        expectFailureCode(
          yield* Effect.exit(
            binding.bind({
              actor,
              descriptor: descriptorFor(
                join(yield* recordedDirectory(directorySession), "elsewhere"),
                workspaceID,
                "block-reject",
              ),
              sessionID: directorySession,
            }),
          ),
          "invalid",
        )

        const unclassified = SessionSchema.ID.make("ses_ocb_unclassified")
        yield* session.create({ id: unclassified, location: sessionLocation(fixture.directory, workspaceID) })
        for (const runtime of ["legacy", "mixed"]) {
          yield* database.db
            .run(sql`UPDATE cm_session_runtime SET runtime = ${runtime} WHERE session_id = ${unclassified}`)
            .pipe(Effect.orDie)
          expectFailureCode(
            yield* Effect.exit(
              binding.bind({
                actor,
                descriptor: descriptorFor(yield* recordedDirectory(unclassified), workspaceID, "block-reject"),
                sessionID: unclassified,
              }),
            ),
            "invalid",
          )
        }
        yield* database.db
          .run(sql`UPDATE cm_session_runtime SET runtime = 'v2' WHERE session_id = ${unclassified}`)
          .pipe(Effect.orDie)

        expect(yield* bindingCount).toBe(0)
      }),
    )
  })
}, 30_000)

test("authorization revoked between pre-read and commit rejects without writing", async () => {
  await withRuntime(async (fixture) => {
    const workspaceID = WorkspaceV2.ID.make("wrk_ocb_revoke")
    const actor = { userID: "user-revoke", workspaceID }
    const sessionID = SessionSchema.ID.make("ses_ocb_revoke")
    let calls = 0
    const authorize = (_input: OperatingChatAuthorizeInput): Effect.Effect<void, OperatingChatBindingError> =>
      Effect.suspend(() => {
        calls += 1
        return calls === 1
          ? Effect.void
          : Effect.fail<OperatingChatBindingError>({ _tag: "OperatingChatBinding.Error", code: "unauthorized" })
      })
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.create({ id: sessionID, location: sessionLocation(fixture.directory, workspaceID) })
        const descriptor = descriptorFor(yield* recordedDirectory(sessionID), workspaceID, "block-revoke")
        const binding = yield* makeOperatingChatBinding({ authorize })
        expectFailureCode(yield* Effect.exit(binding.bind({ actor, descriptor, sessionID })), "unauthorized")
        expect(calls).toBe(2)
        expect(yield* bindingCount).toBe(0)
      }),
    )
  })
}, 30_000)

test("a live Session cannot be bound to two blocks", async () => {
  await withRuntime(async (fixture) => {
    const workspaceID = WorkspaceV2.ID.make("wrk_ocb_duplicate")
    const actor = { userID: "user-duplicate", workspaceID }
    const sessionID = SessionSchema.ID.make("ses_ocb_duplicate")
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.create({ id: sessionID, location: sessionLocation(fixture.directory, workspaceID) })
        const descriptor = descriptorFor(yield* recordedDirectory(sessionID), workspaceID, "block-first")
        const binding = yield* makeOperatingChatBinding({ authorize: allowAuthorize })
        yield* binding.bind({ actor, descriptor, sessionID })
        expectFailureCode(
          yield* Effect.exit(
            binding.bind({
              actor,
              descriptor: { ...descriptor, blockID: "block-second", functionalityInstanceID: "instance-block-second" },
              sessionID,
            }),
          ),
          "conflict",
        )
      }),
    )
  })
}, 30_000)

test("same block rebinding serializes CAS across two connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-ocb-cas-"))
  cleanup(directory)
  const filename = join(directory, "runtime.db")
  const runtimeA = runtimeFor(filename)
  const runtimeB = runtimeFor(filename)
  const workspaceID = WorkspaceV2.ID.make("wrk_ocb_cas")
  const actor = { userID: "user-cas", workspaceID }
  const sessionID = SessionSchema.ID.make("ses_ocb_cas")
  const bind = (descriptor: OperatingChatDescriptor, expectedRevision?: number) =>
    Effect.gen(function* () {
      const binding = yield* makeOperatingChatBinding({ authorize: allowAuthorize })
      return yield* binding.bind({ actor, descriptor, sessionID, expectedRevision })
    })
  try {
    const descriptor = await runtimeA.runPromise(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.create({ id: sessionID, location: sessionLocation(directory, workspaceID) })
        return descriptorFor(yield* recordedDirectory(sessionID), workspaceID, "block-cas")
      }),
    )
    const first = await runtimeA.runPromise(bind(descriptor))
    expect(first.generation).toBe(1)
    expect(first.revision).toBe(1)
    const second = await runtimeB.runPromise(bind(descriptor, 1))
    expect(second.generation).toBe(2)
    expect(second.revision).toBe(2)
    expectFailureCode(await runtimeA.runPromise(Effect.exit(bind(descriptor, 1))), "stale")
    const race = await Promise.all([
      runtimeA.runPromise(Effect.exit(bind(descriptor, 2))),
      runtimeB.runPromise(Effect.exit(bind(descriptor, 2))),
    ])
    expect(race.filter(Exit.isSuccess)).toHaveLength(1)
    const losers = race.filter(Exit.isFailure)
    expect(losers).toHaveLength(1)
    if (losers[0]) expectFailureCode(losers[0], "stale")
  } finally {
    await runtimeA.dispose()
    await runtimeB.dispose()
  }
}, 30_000)

test("rebinding and reset invalidate stale revisions while preserving the Session transcript and native ledger", async () => {
  await withRuntime(async (fixture) => {
    const workspaceID = WorkspaceV2.ID.make("wrk_ocb_stale")
    const actor = { userID: "user-stale", workspaceID }
    const sessionID = SessionSchema.ID.make("ses_ocb_stale")
    const nextSessionID = SessionSchema.ID.make("ses_ocb_stale_next")
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.create({ id: sessionID, location: sessionLocation(fixture.directory, workspaceID) })
        yield* session.create({ id: nextSessionID, location: sessionLocation(fixture.directory, workspaceID) })
        const descriptor = descriptorFor(yield* recordedDirectory(sessionID), workspaceID, "block-stale")
        const eventsBefore = yield* sessionEvents(sessionID)
        const ledgerBefore = yield* nativeLedger
        const binding = yield* makeOperatingChatBinding({ authorize: allowAuthorize })

        const first = yield* binding.bind({ actor, descriptor, sessionID })
        expect(first.revision).toBe(1)
        const second = yield* binding.bind({ actor, descriptor, sessionID, expectedRevision: 1 })
        expect(second.generation).toBe(2)
        expect(second.revision).toBe(2)
        expectFailureCode(
          yield* Effect.exit(binding.bind({ actor, descriptor, sessionID, expectedRevision: 1 })),
          "stale",
        )

        const rebound = yield* binding.bind({ actor, descriptor, sessionID: nextSessionID, expectedRevision: 2 })
        expect(rebound.generation).toBe(3)
        expect(rebound.revision).toBe(3)
        expect((yield* session.get(sessionID)).id).toBe(sessionID)
        expect(yield* sessionEvents(sessionID)).toEqual(eventsBefore)

        yield* binding.reset({ actor, sessionID: nextSessionID, expectedRevision: 3 })
        expect(yield* binding.resolve(nextSessionID)).toBeUndefined()
        expectFailureCode(
          yield* Effect.exit(binding.bind({ actor, descriptor, sessionID, expectedRevision: 3 })),
          "stale",
        )
        const fresh = yield* binding.bind({ actor, descriptor, sessionID })
        expect(fresh.generation).toBe(4)
        expect(fresh.revision).toBe(5)
        expectFailureCode(yield* Effect.exit(binding.revalidate(sessionID, first)), "stale")

        expect(yield* sessionEvents(sessionID)).toEqual(eventsBefore)
        expect(yield* nativeLedger).toEqual(ledgerBefore)
      }),
    )
  })
}, 30_000)
