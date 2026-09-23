import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { sql } from "drizzle-orm"
import { EventBoundary } from "../src/event-boundary"
import { admit } from "../src/admission"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { admittedEvent, createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()

test("mediated native replayAll rolls back a failed prefix and suppresses notifications", async () => {
  await using env = await mediatedFixture()
  const hints: string[] = []
  const result = await env.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    yield* events.listen((event) => Effect.sync(() => { hints.push(event.id) }))
    const first = admittedEvent(env.sessionID, 0)
    const result = yield* events.replayAll([first, { ...first, seq: 1, id: EventV2.ID.create(), type: "unsupported" }], { publish: true }).pipe(Effect.exit)
    return { result: result._tag, rows: yield* database.db.all(sql`SELECT id FROM session_input`) }
  }))
  expect(result).toEqual({ result: "Failure", rows: [] })
  expect(hints).toEqual([])
})

test("private sidecar failure rolls back replay and deferred wake together", async () => {
  await using env = await mediatedFixture()
  const observed: string[] = []
  const result = await env.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    yield* events.listen(() => Effect.sync(() => { observed.push("notification") }))
    const result = yield* boundary.transaction(Effect.gen(function* () {
      yield* events.replayAll([admittedEvent(env.sessionID, 0)], { publish: true })
      yield* boundary.afterCommit(Effect.sync(() => { observed.push("wake") }))
      return yield* Effect.fail("injected sidecar failure")
    })).pipe(Effect.exit)
    return { result: result._tag, rows: yield* database.db.all(sql`SELECT id FROM session_input`) }
  }))
  expect(result).toEqual({ result: "Failure", rows: [] })
  expect(observed).toEqual([])
})

test("notifications see committed private data, duplicate batches do not notify again", async () => {
  await using env = await mediatedFixture()
  const values: string[] = []
  await env.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    const event = admittedEvent(env.sessionID, 0)
    yield* events.listen(() => Effect.gen(function* () {
      const row = yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input`).pipe(Effect.orDie)
      values.push(row?.api_content ?? "missing")
    }))
    yield* boundary.transaction(Effect.gen(function* () {
      yield* events.replayAll([event], { publish: true, ownerID: "owner", strictOwner: true })
      yield* database.db.run(sql`INSERT INTO cm_private_input
        (message_id,session_id,request_hash,api_content,api_content_hash,renderer_version)
        VALUES (${event.data.messageID as string},${env.sessionID},'request','private','hash',1)`)
      expect(values).toEqual([])
    }))
    yield* events.replayAll([event], { publish: true, ownerID: "owner", strictOwner: true })
  }))
  expect(values).toEqual(["private"])
})

test("durable subscriptions cannot see an intermediate replay before private commit", async () => {
  const ready = Deferred.makeUnsafe<void>()
  const startObserver = Deferred.makeUnsafe<void>()
  await using env = await mediatedFixture({
    onDurableReadAttempt: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
  })
  const seen: string[] = []
  await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    const observer = yield* Deferred.await(startObserver).pipe(Effect.andThen(events.durable({ aggregateID: env.sessionID }).pipe(
      Stream.take(1), Stream.runForEach(() => Effect.gen(function* () {
        const row = yield* database.db.get<{ api_content: string }>(sql`SELECT api_content FROM cm_private_input`)
        seen.push(row?.api_content ?? "missing")
      })),
    )), Effect.forkScoped)
    const event = admittedEvent(env.sessionID, 0)
    yield* boundary.transaction(Effect.gen(function* () {
      yield* events.replayAll([event], { publish: true })
      yield* Deferred.succeed(startObserver, undefined)
      yield* Deferred.await(ready)
      expect(seen).toEqual([])
      yield* database.db.run(sql`INSERT INTO cm_private_input
        (message_id,session_id,request_hash,api_content,api_content_hash,renderer_version)
        VALUES (${event.data.messageID as string},${env.sessionID},'request','complete private context','hash',1)`)
    }))
    yield* Fiber.join(observer)
  })))
  expect(seen).toEqual(["complete private context"])
})

test("nested savepoint rollback discards only its notifications and post-commit actions", async () => {
  await using env = await mediatedFixture()
  const observed: string[] = []
  await env.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    yield* events.listen((event) => Effect.sync(() => {
      observed.push(Schema.decodeUnknownSync(Schema.Struct({ messageID: Schema.String }))(event.data).messageID)
    }))
    const rolledBack = admittedEvent(env.sessionID, 0)
    const kept = admittedEvent(env.sessionID, 0)
    yield* boundary.transaction(Effect.gen(function* () {
      yield* boundary.transaction(Effect.gen(function* () {
        yield* events.replayAll([rolledBack], { publish: true })
        yield* boundary.afterCommit(Effect.sync(() => { observed.push("bad wake") }))
        return yield* Effect.fail("rollback nested")
      })).pipe(Effect.catch(() => Effect.void))
      yield* events.replayAll([kept], { publish: true })
      yield* boundary.afterCommit(Effect.sync(() => { observed.push("good wake") }))
      expect(observed).toEqual([])
    }))
    expect(observed).toEqual([String(kept.data.messageID), "good wake"])
  }))
})

test("reentrant live listeners can publish without holding the write gate", async () => {
  await using env = await mediatedFixture()
  const ping = EventV2.define({ type: "proof.ping", schema: { value: Schema.String } })
  const values: string[] = []
  await env.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.listen((event) => Effect.gen(function* () {
      const data = Schema.decodeUnknownSync(ping.data)(event.data)
      values.push(data.value)
      if (data.value === "outer") yield* events.publish(ping, { value: "inner" })
    }))
    yield* events.publish(ping, { value: "outer" })
  }))
  expect(values).toEqual(["outer", "inner"])
})

test("unmanaged outer SQL transactions are rejected before notification escapes", async () => {
  await using env = await mediatedFixture()
  const notified: string[] = []
  await env.runtime.runPromise(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    yield* events.listen((event) => Effect.sync(() => { notified.push(event.id) }))
    const result = yield* database.db.transaction(() => events.replayAll([admittedEvent(env.sessionID, 0)], { publish: true })).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* database.db.all(sql`SELECT id FROM session_input`)).toEqual([])
  }))
  expect(notified).toEqual([])
})

test("all and typed subscriptions receive only post-commit payloads", async () => {
  const ready = Deferred.makeUnsafe<void>()
  const subscriptions = { count: 0 }
  await using env = await mediatedFixture({
    onPublicSubscribe: Effect.suspend(() => ++subscriptions.count === 2 ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void),
  })
  await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const all = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    const typed = yield* events.subscribe(SessionEvent.PromptAdmitted).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Deferred.await(ready)
    const event = admittedEvent(env.sessionID, 0)
    yield* boundary.transaction(events.replayAll([event], { publish: true }))
    expect((yield* Fiber.join(all))[0].id).toBe(event.id)
    expect((yield* Fiber.join(typed))[0].id).toBe(event.id)
  })))
})

test("a durable reader awakened by a rolled-back batch emits only the later committed history", async () => {
  const ready = Deferred.makeUnsafe<void>()
  const start = Deferred.makeUnsafe<void>()
  await using env = await mediatedFixture({ onDurableReadAttempt: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid) })
  await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const reader = yield* Deferred.await(start).pipe(
      Effect.andThen(events.durable({ aggregateID: env.sessionID }).pipe(Stream.take(1), Stream.runCollect)), Effect.forkScoped,
    )
    const discarded = admittedEvent(env.sessionID, 0)
    yield* boundary.transaction(Effect.gen(function* () {
      yield* events.replayAll([discarded], { publish: true })
      yield* Deferred.succeed(start, undefined)
      yield* Deferred.await(ready)
      return yield* Effect.fail("rollback")
    })).pipe(Effect.catch(() => Effect.void))
    const kept = admittedEvent(env.sessionID, 0)
    yield* events.replayAll([kept], { publish: true })
    const observed = yield* Fiber.join(reader)
    expect(observed.map((event) => event.id)).toEqual([kept.id])
  })))
})

test("native admission facade defers execution wake until an enclosing managed transaction commits", async () => {
  await using env = await mediatedFixture()
  const wakes: string[] = []
  await env.runtime.runPromise(Effect.gen(function* () {
    const boundary = yield* EventBoundary
    yield* boundary.transaction(Effect.gen(function* () {
      yield* admit({ sessionID: env.sessionID, messageID: SessionMessage.ID.create(), actor: { userID: "user", workspaceID: "workspace-proof" },
        text: "clean", delivery: "steer", references: [],
      }, { authorize: () => Effect.void, freeze: () => Effect.succeed({ apiContent: "private", rendererVersion: 1 }) },
      (id) => Effect.sync(() => { wakes.push(id) }))
      expect(wakes).toEqual([])
    }))
  }))
  expect(wakes).toEqual([env.sessionID])
})

test("write effects cannot escape a managed transaction into another fiber", async () => {
  await using env = await mediatedFixture()
  await env.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const events = yield* EventV2.Service
    const boundary = yield* EventBoundary
    const database = yield* Database.Service
    yield* boundary.transaction(Effect.gen(function* () {
      const child = yield* events.replayAll([admittedEvent(env.sessionID, 0)], { publish: true }).pipe(Effect.forkScoped)
      expect((yield* Fiber.await(child))._tag).toBe("Failure")
    }))
    expect(yield* database.db.all(sql`SELECT id FROM session_input`)).toEqual([])
  })))
})

test("a different kernel cannot join another boundary's transaction scope", async () => {
  await using first = await mediatedFixture()
  await using second = await mediatedFixture()
  const foreign = await second.runtime.runPromise(EventBoundary)
  await first.runtime.runPromise(Effect.gen(function* () {
    const boundary = yield* EventBoundary
    const result = yield* boundary.transaction(foreign.events.replayAll([admittedEvent(second.sessionID, 0)])).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }))
  expect(await second.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.all(sql`SELECT id FROM event`)
  }))).toEqual([])
})
