import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { DateTime, Effect } from "effect"
import { sql } from "drizzle-orm"
import { admit } from "../src/admission"
import { makeCheckpoint, SENTINEL } from "../src/checkpoint"
import { persistCheckpoint } from "../src/context-store"
import { makePrivateProjection, projectionDigest, ProjectionError } from "../src/projection"
import { createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()
const projection = makePrivateProjection({ authorize: () => Effect.void })

async function sourceBundle(source: Awaited<ReturnType<typeof mediatedFixture>>, checkpoint = false) {
  const scope = { sessionID: source.sessionID, workspaceID: "workspace-proof", ownerID: "owner-proof" }
  await source.runtime.runPromise(Effect.gen(function* () {
    yield* admit({
      sessionID: source.sessionID, messageID: SessionMessage.ID.make("msg_source_input"),
      actor: { userID: "user-proof", workspaceID: scope.workspaceID }, text: "public input", delivery: "steer", resume: false, references: [],
    }, { authorize: () => Effect.void, freeze: () => Effect.succeed({ apiContent: "private input snapshot", rendererVersion: 1 }) }, () => Effect.die("must not wake"))
    if (!checkpoint) return
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const messageID = SessionMessage.ID.make("msg_source_checkpoint")
    const timestamp = yield* DateTime.now
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID: source.sessionID, messageID, timestamp, reason: "auto" })
    yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID: source.sessionID, messageID, timestamp, reason: "auto", text: SENTINEL, recent: "public recent",
    }, { commit: (seq) => persistCheckpoint({
      sessionID: source.sessionID, messageID, seq,
      checkpoint: makeCheckpoint({ summary: "private summary", recent: "private recent", createdAt: DateTime.toEpochMillis(timestamp) }),
    }).pipe(Effect.provideService(Database.Service, database), Effect.orDie) })
    yield* database.db.run(sql`INSERT INTO session_context_epoch (session_id, baseline_seq, baseline, snapshot)
      VALUES (${source.sessionID}, 2, 'private system baseline', '{}')`)
  }))
  return { scope, bundle: await source.runtime.runPromise(projection.export(scope)) }
}

test("restores public events, input sidecar, checkpoint and native epoch before notifying", async () => {
  await using source = await mediatedFixture()
  await using target = await mediatedFixture()
  const value = await sourceBundle(source, true)
  const observations: number[] = []
  await target.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    yield* events.listen(() => Effect.gen(function* () {
      const row = yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM cm_private_checkpoint`).pipe(Effect.orDie)
      observations.push(row?.count ?? 0)
    }))
    yield* projection.restore({ ...value, expectedDigest: value.bundle.digest, publish: true })
  }))
  expect(observations).toEqual([1, 1, 1])
  expect(await target.runtime.runPromise(projection.export(value.scope))).toEqual(value.bundle)
  await target.runtime.runPromise(projection.restore({ ...value, expectedDigest: value.bundle.digest, publish: true }))
  expect(observations).toHaveLength(3)
})

test("failure writing a private row leaves no public prefix or notifications", async () => {
  await using source = await mediatedFixture()
  await using target = await mediatedFixture()
  const value = await sourceBundle(source)
  const hints: string[] = []
  const result = await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* database.db.run(sql`CREATE TRIGGER reject_transfer BEFORE INSERT ON cm_private_input
      BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END`)
    yield* events.listen((event) => Effect.sync(() => { hints.push(event.id) }))
    const exit = yield* projection.restore({ ...value, expectedDigest: value.bundle.digest, publish: true }).pipe(Effect.exit)
    return {
      exit: exit._tag,
      inputs: yield* database.db.all(sql`SELECT id FROM session_input`),
      events: yield* database.db.all(sql`SELECT id FROM event`),
      requirements: yield* database.db.all(sql`SELECT message_id FROM cm_private_requirement`),
    }
  }))
  expect(result).toEqual({ exit: "Failure", inputs: [], events: [], requirements: [] })
  expect(hints).toEqual([])
})

test("wrong digest, scope, missing private context and corrupted hashes fail closed", async () => {
  await using source = await mediatedFixture()
  await using target = await mediatedFixture()
  const value = await sourceBundle(source)
  const missing = { ...value.bundle.body, inputs: [] }
  const corrupt = { ...value.bundle.body, inputs: value.bundle.body.inputs.map((row) => ({ ...row, apiContent: "modified private snapshot" })) }
  const lossy = { ...value.bundle.body, events: value.bundle.body.events.map((event) => ({ ...event, data: { ...event.data, modelContextVersion: 2 } })) }
  for (const input of [
    { ...value, expectedDigest: "wrong" },
    { ...value, scope: { ...value.scope, workspaceID: "wrong" }, expectedDigest: value.bundle.digest },
    { scope: value.scope, bundle: { body: missing, digest: projectionDigest(missing) }, expectedDigest: projectionDigest(missing) },
    { scope: value.scope, bundle: { body: corrupt, digest: projectionDigest(corrupt) }, expectedDigest: projectionDigest(corrupt) },
    { scope: value.scope, bundle: { body: lossy, digest: projectionDigest(lossy) }, expectedDigest: projectionDigest(lossy) },
  ]) {
    const exit = await target.runtime.runPromise(projection.restore(input).pipe(Effect.exit))
    expect(exit._tag).toBe("Failure")
  }
  expect(await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.all(sql`SELECT id FROM event`)
  }))).toEqual([])
})

test("authorization is mandatory and an expired transfer permit rejects before effects", async () => {
  await using source = await mediatedFixture()
  await using target = await mediatedFixture()
  const value = await sourceBundle(source)
  const denied = makePrivateProjection({ authorize: () => Effect.fail(new ProjectionError({ code: "expired-permit" })) })
  const error = await target.runtime.runPromise(denied.restore({ ...value, expectedDigest: value.bundle.digest }).pipe(Effect.flip))
  expect(error).toMatchObject({ code: "expired-permit" })
  expect(await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.all(sql`SELECT id FROM event`)
  }))).toEqual([])
})

test("duplicate restore cannot overwrite a conflicting private snapshot", async () => {
  await using source = await mediatedFixture()
  await using target = await mediatedFixture()
  const value = await sourceBundle(source)
  await target.runtime.runPromise(projection.restore({ ...value, expectedDigest: value.bundle.digest }))
  await target.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`UPDATE cm_private_input SET request_hash = 'conflicting'`)
  }))
  const error = await target.runtime.runPromise(projection.restore({ ...value, expectedDigest: value.bundle.digest }).pipe(Effect.flip))
  expect(error).toMatchObject({ code: "input-conflict" })
})

test("native revert deletion removes private records and remains consistent on a receiver with the earlier snapshot", async () => {
  await using source = await mediatedFixture()
  await using target = await mediatedFixture()
  const scope = { sessionID: source.sessionID, workspaceID: "workspace-proof", ownerID: "owner-proof" }
  const first = SessionMessage.ID.make("msg_retained")
  const second = SessionMessage.ID.make("msg_reverted")
  await source.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    for (const id of [first, second]) {
      yield* admit({ sessionID: source.sessionID, messageID: id, actor: { userID: "user", workspaceID: scope.workspaceID },
        text: id, delivery: "steer", resume: false, references: [],
      }, { authorize: () => Effect.void, freeze: () => Effect.succeed({ apiContent: `private ${id}`, rendererVersion: 1 }) }, () => Effect.void)
      yield* SessionInput.promoteSteers(database.db, events, source.sessionID, yield* EventV2.latestSequence(database.db, source.sessionID))
    }
  }))
  const before = await source.runtime.runPromise(projection.export(scope))
  await target.runtime.runPromise(projection.restore({ bundle: before, scope, expectedDigest: before.digest }))
  await source.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.RevertEvent.Committed, { sessionID: source.sessionID, messageID: first, timestamp: yield* DateTime.now })
  }))
  const after = await source.runtime.runPromise(projection.export(scope))
  expect(after.body.inputs.map((row) => row.messageID)).toEqual([first])
  expect(after.body.requirements.map((row) => row.messageID)).toEqual([first])
  await target.runtime.runPromise(projection.restore({ bundle: after, scope, expectedDigest: after.digest }))
  expect(await target.runtime.runPromise(projection.export(scope))).toEqual(after)
})
