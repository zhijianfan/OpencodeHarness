import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { LLMClient, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Session } from "@opencode-ai/schema/session"
import { sql } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { createNativeHttp } from "../src/native-http"
import { databaseCleanup } from "../../../test-utils/cleanup"

const cleanup = databaseCleanup()
const policy = {
  managed: () => Effect.succeed(true),
  authorize: () => Effect.void,
  freeze: () => Effect.succeed({ apiContent: "isolated HTTP test", rendererVersion: 1 }),
}

function request(path: string, credentials?: string) {
  return new Request(`http://native.test${path}`, {
    headers: credentials === undefined ? {} : {
      Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
    },
  })
}

async function withApp(
  run: (fixture: {
    app: Awaited<ReturnType<typeof createNativeHttp>>
    directory: string
    paths: Global.Interface
  }) => Promise<void>,
  username?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "cybermastery-native-http-"))
  cleanup(directory)
  const paths = {
    home: join(directory, "home"),
    data: join(directory, "data"),
    cache: join(directory, "cache"),
    config: join(directory, "config"),
    state: join(directory, "state"),
    tmp: join(directory, "tmp"),
    bin: join(directory, "bin"),
    log: join(directory, "log"),
    repos: join(directory, "repos"),
  }
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })))
  const model = Model.make({ id: "http-proof-model", provider: "proof", route })
  const app = await createNativeHttp({
    filename: join(directory, "runtime.db"),
    password: "password",
    username,
    policy,
    replacements: [
      // cleanupNode must never scan the user's native tool-output directory.
      [Global.node, Global.layerWith(paths)],
      [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, {
        stream: () => Stream.die("Native HTTP tests must not invoke a provider"),
      })],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Snapshot.node, Snapshot.noopLayer],
      [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
      [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
    ],
  })
  try {
    await run({ app, directory, paths })
  } finally {
    await app.dispose()
  }
}

test("native health requires valid Basic credentials", async () => {
  await withApp(async ({ app }) => {
    expect((await app.fetch(request("/api/health"))).status).toBe(401)
    expect((await app.fetch(request("/api/health", "opencode:wrong"))).status).toBe(401)
    expect((await app.fetch(request("/api/health", "wrong:password"))).status).toBe(401)
    const response = await app.fetch(request("/api/health", "opencode:password"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ healthy: true })
  })
}, 30_000)

test("native auth honors an explicit username", async () => {
  await withApp(async ({ app }) => {
    expect((await app.fetch(request("/api/health", "opencode:password"))).status).toBe(401)
    const response = await app.fetch(request("/api/health", "host:password"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ healthy: true })
  }, "host")
}, 30_000)

test("native HTTP reads the runtime's created and adopted Session and subsequent database state", async () => {
  await withApp(async ({ app, directory }) => {
    const location = { directory: AbsolutePath.make(join(directory, "project")) }
    await mkdir(location.directory)
    const info = await app.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id: Session.ID.make("ses_native_http"), location })
      const adopted = yield* session.create({ id: created.id, location })
      expect(adopted).toEqual(created)
      expect(yield* session.get(created.id)).toEqual(created)
      return created
    }))
    const response = await app.fetch(request(`/api/session/${info.id}`, "opencode:password"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { id: info.id, location } })

    const switched = await app.fetch(new Request(`http://native.test/api/session/${info.id}/agent`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("opencode:password").toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "plan" }),
    }))
    expect(switched.status).toBe(204)
    expect(await app.runtime.runPromise(Effect.gen(function* () {
      const session = yield* SessionV2.Service
      return String((yield* session.get(info.id)).agent)
    }))).toBe("plan")

    await app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(sql`UPDATE session SET title = 'native HTTP shared database proof' WHERE id = ${info.id}`)
      const session = yield* SessionV2.Service
      expect(JSON.stringify(yield* session.get(info.id))).toContain("native HTTP shared database proof")
    }))
    const updated = await app.fetch(request(`/api/session/${info.id}`, "opencode:password"))
    expect(updated.status).toBe(200)
    expect(JSON.stringify(await updated.json())).toContain("native HTTP shared database proof")
  })
}, 30_000)

test("HTTP initialization retains selected runtime services and isolated Global paths", async () => {
  await withApp(async ({ app, paths }) => {
    const identities = Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const store = yield* SessionStore.Service
      const execution = yield* SessionExecution.Service
      const locations = yield* LocationServiceMap.Service
      const global = yield* Global.Service
      return { database, events, session, store, execution, locations, global }
    })
    const before = await app.runtime.runPromise(identities)
    expect(before.global).toEqual(paths)
    expect((await app.fetch(request("/api/health", "opencode:password"))).status).toBe(200)
    const after = await app.runtime.runPromise(identities)
    expect(after.database).toBe(before.database)
    expect(after.events).toBe(before.events)
    expect(after.session).toBe(before.session)
    expect(after.store).toBe(before.store)
    expect(after.execution).toBe(before.execution)
    expect(after.locations).toBe(before.locations)
    expect(after.global).toBe(before.global)
  })
}, 30_000)

test("native OpenAPI retains health and Session routes", async () => {
  await withApp(async ({ app }) => {
    const response = await app.fetch(request("/openapi.json", "opencode:password"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      paths: {
        "/api/health": { get: expect.anything() },
        "/api/session/{sessionID}": { get: expect.anything() },
      },
    })
  })
}, 30_000)

test("empty passwords are rejected before graph inputs are read", async () => {
  await expect(createNativeHttp({
    password: "",
    get filename(): string {
      throw new Error("Graph inputs must not be read for an empty password")
    },
    policy,
  })).rejects.toThrow("A non-empty native HTTP password is required")
})

test("disposal is shared, repeatable, and closes HTTP and the owned runtime", async () => {
  await withApp(async ({ app }) => {
    expect((await app.fetch(request("/api/health", "opencode:password"))).status).toBe(200)
    const first = app.dispose()
    expect(app.dispose()).toBe(first)
    await first
    expect(app.dispose()).toBe(first)
    await app.dispose()
    await expect(app.fetch(request("/api/health", "opencode:password"))).rejects.toThrow("Native HTTP has been disposed")
    await expect(app.runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      return database
    }))).rejects.toThrow()
  })
}, 30_000)
