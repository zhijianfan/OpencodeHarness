import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { LLM, LLMEvent, ContentBlockID, Model, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Stream } from "effect"
import { sql } from "drizzle-orm"
import { admit } from "../src/admission"
import { SENTINEL } from "../src/checkpoint"
import { makePrivateCompaction } from "../src/compaction"
import { preparePrivateTurn } from "../src/provider-context"
import { createMediatedFixtures } from "./fixture"

const mediatedFixture = createMediatedFixtures()

const model = Model.make({ id: "proof-model", provider: "proof", route: route.with({ limits: { context: 20_000, output: 500 } }) })
const config = [new Config.Document({ type: "document", info: new Config.Info({
  compaction: new ConfigCompaction.Info({ buffer: 19_000, keep: new ConfigCompaction.Keep({ tokens: 100 }) }),
}) })]

async function historyFixture(env: Awaited<ReturnType<typeof mediatedFixture>>) {
  await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    for (const [index, content] of ["private head ".repeat(1600), "private recent tail"].entries()) {
      yield* admit({
        sessionID: env.sessionID, messageID: SessionMessage.ID.make(`msg_history_${index}`),
        actor: { userID: "user-proof", workspaceID: "workspace-proof" }, text: `public-${index}`,
        delivery: "steer", resume: false, references: [],
      }, { authorize: () => Effect.void, freeze: () => Effect.succeed({ apiContent: content, rendererVersion: 1 }) }, () => Effect.void)
    }
    yield* SessionInput.promoteSteers(database.db, events, env.sessionID, yield* EventV2.latestSequence(database.db, env.sessionID))
  }))
}

test("reconstructs frozen provider messages and preserves request metadata without changing public history", async () => {
  await using env = await mediatedFixture()
  await historyFixture(env)
  await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const entries = yield* SessionHistory.entriesForRunner(database.db, env.sessionID, -1)
    const request = LLM.request({ model, messages: toLLMMessages(entries.map((entry) => entry.message), model),
      http: { headers: { "X-Session-Id": env.sessionID } }, providerOptions: { proof: { immutable: true } }, generation: { maxTokens: 17 } })
    const prepared = yield* preparePrivateTurn({ sessionID: env.sessionID, entries, request })
    expect(JSON.stringify(prepared.request.messages)).toContain("private recent tail")
    expect(JSON.stringify(request.messages)).not.toContain("private recent tail")
    expect(prepared.request.http).toEqual(request.http)
    expect(prepared.request.providerOptions).toEqual(request.providerOptions)
    expect(prepared.request.generation).toEqual(request.generation)
    const wrongSession = yield* preparePrivateTurn({ sessionID: env.sessionID, entries,
      request: LLM.updateRequest(request, { http: { headers: { "X-Session-Id": "ses_other" } } }),
    }).pipe(Effect.exit)
    expect(wrongSession._tag).toBe("Failure")
    expect(JSON.stringify(yield* SessionHistory.entriesForRunner(database.db, env.sessionID, -1))).not.toContain("private recent tail")
    yield* database.db.run(sql`DELETE FROM cm_private_input WHERE message_id = 'msg_history_1'`)
    const missing = yield* preparePrivateTurn({ sessionID: env.sessionID, entries, request }).pipe(Effect.exit)
    expect(missing._tag).toBe("Failure")
  }))
})

test("native compaction runs once on enriched context and stores only a public sentinel/clean recent", async () => {
  await using env = await mediatedFixture()
  await historyFixture(env)
  const calls: LLMRequest[] = []
  await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const entries = yield* SessionHistory.entriesForRunner(database.db, env.sessionID, -1)
    const request = LLM.request({ model, messages: toLLMMessages(entries.map((entry) => entry.message), model) })
    const compaction = makePrivateCompaction({ events, config, llm: { stream: (request) => {
      calls.push(request)
      return Stream.make(LLMEvent.textDelta({ id: ContentBlockID.make("summary"), text: "summary containing private knowledge" }))
    } } })
    expect(yield* compaction.compactIfNeeded({ sessionID: env.sessionID, entries, model, request })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0].messages)).toContain("private head")
    const clean = yield* SessionHistory.entriesForRunner(database.db, env.sessionID, -1)
    expect(clean).toHaveLength(1)
    expect(clean[0].message.type).toBe("compaction")
    expect(JSON.stringify(clean)).toContain(SENTINEL)
    expect(JSON.stringify(clean)).toContain("public-1")
    expect(JSON.stringify(clean)).not.toContain("private recent tail")
    expect(JSON.stringify(clean)).not.toContain("summary containing private knowledge")
    const next = yield* preparePrivateTurn({ sessionID: env.sessionID, entries: clean,
      request: LLM.request({ model, messages: toLLMMessages(clean.map((entry) => entry.message), model) }) })
    expect(JSON.stringify(next.request.messages)).toContain("summary containing private knowledge")
    expect(JSON.stringify(next.request.messages)).toContain("private recent tail")
    expect(JSON.stringify(next.request.messages)).not.toContain(SENTINEL)
    yield* database.db.run(sql`UPDATE cm_private_checkpoint SET context_json = '{}'`)
    const corrupt = yield* preparePrivateTurn({ sessionID: env.sessionID, entries: clean,
      request: LLM.request({ model, messages: toLLMMessages(clean.map((entry) => entry.message), model) }) }).pipe(Effect.exit)
    expect(corrupt._tag).toBe("Failure")
  }))
})

test("checkpoint commit failure never publishes private summary into public history", async () => {
  await using env = await mediatedFixture()
  await historyFixture(env)
  await env.runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* database.db.run(sql`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON cm_private_checkpoint
      BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`)
    const entries = yield* SessionHistory.entriesForRunner(database.db, env.sessionID, -1)
    const request = LLM.request({ model, messages: toLLMMessages(entries.map((entry) => entry.message), model) })
    const compaction = makePrivateCompaction({ events, config, llm: { stream: () =>
      Stream.make(LLMEvent.textDelta({ id: ContentBlockID.make("summary"), text: "PRIVATE-MUST-NOT-LEAK" })),
    } })
    const result = yield* compaction.compactAfterOverflow({ sessionID: env.sessionID, entries, model, request }).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    const history = yield* database.db.all<{ data: string }>(sql`SELECT data FROM event`)
    expect(JSON.stringify(history)).not.toContain("PRIVATE-MUST-NOT-LEAK")
    expect(yield* database.db.all(sql`SELECT message_id FROM cm_private_checkpoint`)).toEqual([])
    expect(yield* database.db.all(sql`SELECT id FROM session_message WHERE type = 'compaction'`)).toEqual([])
  }))
})
