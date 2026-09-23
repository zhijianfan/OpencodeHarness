import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Config } from "@opencode-ai/core/config"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Session } from "@opencode-ai/schema/session"
import { LLMClient, LLMRequest, LLMEvent, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Stream } from "effect"
import { sql } from "drizzle-orm"
import { createSessionRuntime } from "../src/session-runtime"
import { PrivatePromptContext } from "../src/session-facade"
import type { RunnerIdentity } from "../src/runner"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()

test("native Session prompt and resume route through the private runner using the native Location map and coordinator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-runtime-"))
  cleanup(directory)
  const requests: LLMRequest[] = []
  const constructed: RunnerIdentity[] = []
  const model = Model.make({ id: "proof-model", provider: "proof", route })
  const runtime = createSessionRuntime({
    filename: join(directory, "runtime.db"),
    onRunnerConstruct: (identity) => { constructed.push(identity) },
    policy: {
      managed: () => Effect.succeed(true), authorize: () => Effect.void,
      freeze: () => Effect.succeed({ apiContent: "private through native Session API", rendererVersion: 1 }),
    },
    replacements: [
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: ((request: LLMRequest) => {
        if (!(request instanceof LLMRequest)) return Stream.die("Expected canonical LLMRequest")
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text" }), LLMEvent.textDelta({ id: "text", text: "answer" }),
          LLMEvent.textEnd({ id: "text" }), LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" }),
        ])
      }) as unknown as Effect.Success<typeof LLMClient.Service>["stream"] })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* SessionV2.Service
      const id = Session.ID.make("ses_integrated")
      yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_integrated', ${directory}, '[]', 0, 0)`)
      yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
        VALUES (${id}, 'proj_integrated', 'proof', ${directory}, 'Proof', '1', 0, 0, 'wrk_integrated')`)
      yield* session.prompt({ sessionID: id, prompt: { text: "public question" }, resume: false }).pipe(
        Effect.provideService(PrivatePromptContext, { actor: { userID: "user", workspaceID: "wrk_integrated" }, references: [] }),
      )
      expect(requests).toHaveLength(0)
      yield* session.resume(id)
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      expect(constructed).toHaveLength(1)
      expect(constructed[0].database).toBe(database)
      expect(constructed[0].events).toBe(events)
      expect(constructed[0].store).toBe(store)
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0].messages)).toContain("private through native Session API")
      const history = yield* session.messages({ sessionID: id })
      expect(history.some((message) => message.type === "user" && message.text === "public question")).toBe(true)
      expect(JSON.stringify(history)).not.toContain("private through native Session API")
    }))
  } finally {
    await runtime.dispose()
  }
}, 30_000)
