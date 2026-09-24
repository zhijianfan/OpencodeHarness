import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { createHash } from "node:crypto"
import {
  executePrivate,
  makeOrchestrator,
  makeReadinessCoordinator,
  PrivateRedirectError,
  TopologyError,
  validateTarget,
} from "../src/transfer-topology"
import type { Peer } from "../src/transfer-topology"
import type { LeaseInput } from "../src/transfer-readiness"

function makePeer(
  workspaceID: string,
  events: string[],
  options?: { readonly failProbe?: boolean; readonly failGrant?: () => boolean; readonly failRevoke?: boolean },
) {
  const grants: LeaseInput[] = []
  const revocations: LeaseInput[] = []
  const peer: Peer = {
    workspaceID,
    endpoint: `https://${workspaceID}.example.test`,
    version: 1,
    probe: Effect.gen(function* () {
      events.push(`probe:${workspaceID}`)
      if (options?.failProbe) return yield* Effect.fail("private probe payload")
      return { transferRequired: false }
    }),
    grant: (lease) =>
      Effect.gen(function* () {
        events.push(`grant:${workspaceID}`)
        grants.push(lease)
        if (options?.failGrant?.()) return yield* Effect.fail(`private grant payload ${lease.requestToken}`)
        return { acceptedRevision: lease.topologyRevision, expiresAt: lease.expiresAt }
      }),
    revoke: (lease) =>
      Effect.gen(function* () {
        events.push(`revoke:${workspaceID}`)
        revocations.push(lease)
        if (options?.failRevoke) return yield* Effect.fail(`private revoke payload ${lease.requestToken}`)
        return { acceptedRevision: lease.topologyRevision, expiresAt: lease.expiresAt, transferRequired: true }
      }),
  }
  return { peer, grants, revocations }
}

describe("transfer topology", () => {
  test("coordinators are isolated and snapshot activation entries", async () => {
    const first = makeReadinessCoordinator()
    const second = makeReadinessCoordinator()
    const local = { topologyRevision: "local", requestToken: "a".repeat(64) }
    const workspace = { workspaceID: "workspace", topologyRevision: "workspace", requestToken: "b".repeat(64) }
    const activate = first.activate([local, workspace])
    workspace.requestToken = "c".repeat(64)
    await Effect.runPromise(activate)
    expect(first.proof("workspace")?.requestToken).toBe("b".repeat(64))
    expect(first.proof("other")?.topologyRevision).toBe("local")
    expect(second.proof("workspace")).toBeUndefined()
    await Effect.runPromise(second.clear)
    expect(first.proof()).toBeDefined()
    await Effect.runPromise(first.clear)
    expect(first.proof("workspace")).toBeUndefined()
  })

  test("probes precede grants; sorted revisions and matching topologies reuse the token", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events: string[] = []
        const a = makePeer("a", events)
        const b = makePeer("b", events)
        const coordinator = makeReadinessCoordinator()
        const clock = { time: 0, tokens: 0 }
        const orchestrator = makeOrchestrator({
          coordinator,
          now: Effect.sync(() => clock.time),
          token: () => {
            clock.tokens++
            return "a".repeat(64)
          },
        })
        const activated = yield* orchestrator.activate([b.peer, a.peer])
        expect(events.slice(0, 2).sort()).toEqual(["probe:a", "probe:b"])
        expect(events.slice(2)).toEqual(["grant:b", "grant:a"])
        expect(activated).toEqual({
          topologyRevision: createHash("sha256")
            .update("a\0https://a.example.test\0" + "1\nb\0https://b.example.test\0" + "1")
            .digest("hex"),
          expiresAt: 30_000,
        })
        expect(coordinator.proof("a")?.topologyRevision).toBe(activated.topologyRevision)
        clock.time = 5_000
        const renewed = yield* orchestrator.renew
        expect(renewed?.expiresAt).toBe(35_000)
        yield* orchestrator.activate([a.peer, b.peer])
        expect(clock.tokens).toBe(1)
        expect(a.grants.every((lease) => lease.requestToken === "a".repeat(64))).toBe(true)
        expect(orchestrator.revision()).toBe(activated.topologyRevision)
      }),
    )
  })

  test("probe failure clears proofs and never grants", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events: string[] = []
        const peer = makePeer("a", events, { failProbe: true })
        const coordinator = makeReadinessCoordinator()
        yield* coordinator.activate([{ topologyRevision: "old", requestToken: "a".repeat(64) }])
        const orchestrator = makeOrchestrator({ coordinator, now: Effect.succeed(0) })
        const error = yield* orchestrator.activate([peer.peer]).pipe(Effect.catch(Effect.succeed))
        expect(error).toBeInstanceOf(TopologyError)
        expect(events).toEqual(["probe:a"])
        expect(coordinator.proof()).toBeUndefined()
      }),
    )
  })

  test("grant failure rolls back acknowledged peers even when a revoke fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events: string[] = []
        const a = makePeer("a", events, { failRevoke: true })
        const b = makePeer("b", events)
        const c = makePeer("c", events, { failGrant: () => true })
        const coordinator = makeReadinessCoordinator()
        const token = "d".repeat(64)
        const orchestrator = makeOrchestrator({ coordinator, now: Effect.succeed(0), token: () => token })
        const error = yield* orchestrator.activate([a.peer, b.peer, c.peer]).pipe(Effect.catch(Effect.succeed))
        expect(error).toBeInstanceOf(TopologyError)
        if (error instanceof TopologyError) {
          expect(error.phase).toBe("grant")
          expect(JSON.stringify(error)).not.toContain(token)
          expect(JSON.stringify(error)).not.toContain("private grant payload")
        }
        expect(events.slice(3, 6)).toEqual(["grant:a", "grant:b", "grant:c"])
        expect(events.slice(6).sort()).toEqual(["revoke:a", "revoke:b"])
        expect(a.revocations[0]).toEqual(a.grants[0])
        expect(b.revocations[0]).toEqual(b.grants[0])
        expect(c.revocations).toHaveLength(0)
        expect(coordinator.proof("a")).toBeUndefined()
        expect(orchestrator.revision()).toBeUndefined()
      }),
    )
  })

  test("renewal failure withdraws proofs and all previous peer leases", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events: string[] = []
        const state = { fail: false }
        const a = makePeer("a", events)
        const b = makePeer("b", events, { failGrant: () => state.fail })
        const coordinator = makeReadinessCoordinator()
        const orchestrator = makeOrchestrator({ coordinator, now: Effect.succeed(0), token: () => "a".repeat(64) })
        yield* orchestrator.activate([a.peer, b.peer])
        state.fail = true
        const error = yield* orchestrator.renew.pipe(Effect.catch(Effect.succeed))
        expect(error).toBeInstanceOf(TopologyError)
        if (error instanceof TopologyError) expect(error.phase).toBe("renew")
        expect(coordinator.proof("a")).toBeUndefined()
        expect(coordinator.proof("b")).toBeUndefined()
        expect(a.revocations).toHaveLength(1)
        expect(b.revocations).toHaveLength(1)
        expect(orchestrator.revision()).toBeUndefined()
      }),
    )
  })

  test("beforeMutation clears proofs before revocation and reports transferRequired", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events: string[] = []
        const coordinator = makeReadinessCoordinator()
        const a = makePeer("a", events)
        const peer: Peer = {
          ...a.peer,
          revoke: (lease) =>
            Effect.gen(function* () {
              expect(coordinator.proof("a")).toBeUndefined()
              return yield* a.peer.revoke(lease)
            }),
        }
        const orchestrator = makeOrchestrator({ coordinator, now: Effect.succeed(0), token: () => "a".repeat(64) })
        expect(yield* orchestrator.beforeMutation).toBe(false)
        yield* orchestrator.activate([peer])
        expect(yield* orchestrator.beforeMutation).toBe(true)
        expect(a.revocations).toHaveLength(1)
        expect(orchestrator.revision()).toBeUndefined()
        expect(yield* orchestrator.beforeMutation).toBe(false)
      }),
    )
  })

  test("mutation revocation attempts every peer on failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events: string[] = []
        const a = makePeer("a", events, { failRevoke: true })
        const b = makePeer("b", events)
        const coordinator = makeReadinessCoordinator()
        const orchestrator = makeOrchestrator({ coordinator, now: Effect.succeed(0), token: () => "a".repeat(64) })
        yield* orchestrator.activate([a.peer, b.peer])
        expect(Exit.isFailure(yield* Effect.exit(orchestrator.beforeMutation))).toBe(true)
        expect(a.revocations).toHaveLength(1)
        expect(b.revocations).toHaveLength(1)
        expect(coordinator.proof("a")).toBeUndefined()
      }),
    )
  })
})

describe("private transport", () => {
  test("accepts HTTPS, numeric loopback HTTP, and explicitly confidential targets only", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const url of [
          "https://remote.example.test/path?secret=value",
          "http://127.0.0.1:1234",
          "http://127.255.255.255",
          "http://[::1]:1234",
        ])
          expect(Exit.isSuccess(yield* Effect.exit(validateTarget({ url })))).toBe(true)
        for (const url of [
          "http://remote.example.test",
          "http://localhost",
          "http://10.0.0.1",
          "http://128.0.0.1",
          "http://[::ffff:127.0.0.1]",
          "ftp://127.0.0.1",
          "not a URL",
        ])
          expect(Exit.isFailure(yield* Effect.exit(validateTarget({ url })))).toBe(true)
        expect(
          (yield* validateTarget({ url: "http://remote.example.test", confidential: true })).protocol,
        ).toBe("http:")
      }),
    )
  })

  test("manual policy rejects every 3xx and never follows a redirect", async () => {
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        requests.push(path)
        if (path === "/ok" || path === "/followed") return new Response("ok")
        return new Response(null, { status: Number(path.slice(1)), headers: { location: "/followed" } })
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        for (const status of Array.from({ length: 100 }, (_, index) => 300 + index)) {
          const error = yield* executePrivate(client, HttpClientRequest.get(new URL(`/${status}`, server.url).href)).pipe(
            Effect.catch(Effect.succeed),
          )
          expect(error).toBeInstanceOf(PrivateRedirectError)
          if (error instanceof PrivateRedirectError) expect(error.status).toBe(status)
        }
        const response = yield* executePrivate(client, HttpClientRequest.get(new URL("/ok", server.url).href))
        expect(response.status).toBe(200)
        expect(requests).not.toContain("/followed")
        expect(requests).toHaveLength(101)
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            server.stop(true)
          }),
        ),
      ),
    )
  })
})
