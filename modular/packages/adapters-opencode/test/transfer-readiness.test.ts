import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { LEASE_DURATION_MS, makeRequestProof, makeTransferReadiness } from "../src/transfer-readiness"
import type { LeaseInput, Mode } from "../src/transfer-readiness"

const lease: LeaseInput = {
  version: 1,
  workspaceID: "workspace-a",
  topologyRevision: "revision-a",
  requestToken: "a".repeat(64),
  expiresAt: LEASE_DURATION_MS,
}

const request = { sessionID: "session-a", workspaceID: lease.workspaceID, proof: makeRequestProof(lease) }

describe("transfer readiness", () => {
  test("fixed modes delegate without a lease", async () => {
    const modes: ReadonlyArray<Mode> = ["v1-local-explicit", "v1-clean-only", "v2-enriched"]
    await Effect.runPromise(
      Effect.forEach(modes, (mode) =>
        Effect.gen(function* () {
          const readiness = yield* makeTransferReadiness({ mode })
          expect(yield* readiness.withPermit({ sessionID: "session" }, Effect.succeed)).toBe(mode)
        }),
      ),
    )
  })

  test("proof, workspace, revision and token are isolated; expiry is exclusive", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const clock = { time: 0 }
        const readiness = yield* makeTransferReadiness({ now: Effect.sync(() => clock.time) })
        yield* readiness.grant(lease)
        expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v2-enriched")
        const invalid = [
          { ...request, proof: undefined },
          { ...request, workspaceID: "workspace-b" },
          { ...request, proof: makeRequestProof({ ...lease, topologyRevision: "revision-b" }) },
          { ...request, proof: makeRequestProof({ ...lease, requestToken: "b".repeat(64) }) },
        ]
        for (const input of invalid)
          expect(yield* readiness.withPermit(input, Effect.succeed)).toBe("v1-clean-only")
        clock.time = LEASE_DURATION_MS - 1
        expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v2-enriched")
        clock.time++
        expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v1-clean-only")
      }),
    )
  })

  test("caps and renews leases, rejects invalid and conflicting grants", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const clock = { time: 0 }
        const readiness = yield* makeTransferReadiness({ now: Effect.sync(() => clock.time) })
        expect((yield* readiness.grant({ ...lease, expiresAt: 90_000 })).expiresAt).toBe(30_000)
        clock.time = 10_000
        expect((yield* readiness.grant({ ...lease, expiresAt: 90_000 })).expiresAt).toBe(40_000)
        for (const expiresAt of [0, 10_000, Number.NaN, Number.POSITIVE_INFINITY])
          expect(Exit.isFailure(yield* Effect.exit(readiness.grant({ ...lease, expiresAt })))).toBe(true)
        for (const input of [
          { ...lease, requestToken: "secret-invalid-token" },
          { ...lease, requestToken: "b".repeat(64) },
          { ...lease, workspaceID: "workspace-b" },
          { ...lease, topologyRevision: "revision-b" },
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(readiness.grant(input)))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(readiness.revoke(input)))).toBe(true)
        }
      }),
    )
  })

  test("snapshots admitted inputs and keeps factories independent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* makeTransferReadiness({ now: Effect.succeed(0) })
        const second = yield* makeTransferReadiness({ now: Effect.succeed(0) })
        const mutable = { ...lease }
        const grant = first.grant(mutable)
        mutable.requestToken = "b".repeat(64)
        yield* grant
        const mutableRequest = { ...request }
        const permit = first.withPermit(mutableRequest, Effect.succeed)
        mutableRequest.proof = makeRequestProof(mutable)
        mutableRequest.workspaceID = "workspace-b"
        expect(yield* permit).toBe("v2-enriched")
        expect(yield* second.withPermit(request, Effect.succeed)).toBe("v1-clean-only")
        yield* second.grant(mutable)
        yield* second.revoke(mutable)
        expect(yield* first.withPermit(request, Effect.succeed)).toBe("v2-enriched")
      }),
    )
  })

  test("revoke fences new permits, waits for the holder, and releases every waiter", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const readiness = yield* makeTransferReadiness({ now: Effect.succeed(0) })
          yield* readiness.grant(lease)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const state = { revoked: 0 }
          const holder = yield* Effect.forkScoped(
            readiness.withPermit(request, (mode) =>
              Effect.gen(function* () {
                expect(mode).toBe("v2-enriched")
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }),
            ),
          )
          yield* Deferred.await(entered)
          const revoke = Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* readiness.revoke(lease)
            state.revoked++
          })
          const first = yield* Effect.forkScoped(revoke, { startImmediately: true })
          yield* Deferred.await(started)
          const second = yield* Effect.forkScoped(revoke)
          expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v1-clean-only")
          expect(state.revoked).toBe(0)
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(holder))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
          expect(state.revoked).toBe(2)
        }),
      ),
    )
  })

  test("same-identity renewal cannot reopen a revoking lease before holders drain", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const readiness = yield* makeTransferReadiness({ now: Effect.succeed(0) })
          yield* readiness.grant(lease)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const revoking = yield* Deferred.make<void>()
          const renewing = yield* Deferred.make<void>()
          const holder = yield* Effect.forkScoped(
            readiness.withPermit(request, () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }),
            ),
          )
          yield* Deferred.await(entered)
          const revoke = yield* Effect.forkScoped(
            Effect.gen(function* () {
              yield* Deferred.succeed(revoking, undefined)
              return yield* readiness.revoke(lease)
            }),
            { startImmediately: true },
          )
          yield* Deferred.await(revoking)
          expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v1-clean-only")
          const renewal = yield* Effect.forkScoped(
            Effect.gen(function* () {
              yield* Deferred.succeed(renewing, undefined)
              return yield* readiness.grant(lease)
            }),
            { startImmediately: true },
          )
          yield* Deferred.await(renewing)
          expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v1-clean-only")
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(holder))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(revoke))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(renewal))).toBe(true)
          expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v2-enriched")
        }),
      ),
    )
  })

  test("interruption, failure and defect release held permits", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const readiness = yield* makeTransferReadiness({ now: Effect.succeed(0) })
          yield* readiness.grant(lease)
          yield* Effect.exit(readiness.withPermit(request, () => Effect.fail("failure")))
          yield* Effect.exit(readiness.withPermit(request, () => Effect.die("defect")))
          const entered = yield* Deferred.make<void>()
          const blocked = yield* Deferred.make<void>()
          const holder = yield* Effect.forkScoped(
            readiness.withPermit(request, () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(blocked)
              }),
            ),
          )
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(holder)
          yield* readiness.revoke(lease)
          expect(yield* readiness.withPermit(request, Effect.succeed)).toBe("v1-clean-only")
        }),
      ),
    )
  })

  test("expired active lease replacement waits outside the lock and then succeeds", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = { time: 0, granted: false }
          const checked = yield* Deferred.make<void>()
          const readiness = yield* makeTransferReadiness({
            now: Effect.gen(function* () {
              if (clock.time === 30_000) yield* Deferred.succeed(checked, undefined)
              return clock.time
            }),
          })
          yield* readiness.grant(lease)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const holder = yield* Effect.forkScoped(
            readiness.withPermit(request, () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }),
            ),
          )
          yield* Deferred.await(entered)
          clock.time = 30_000
          const next = { ...lease, requestToken: "b".repeat(64), expiresAt: 60_000 }
          const replacement = yield* Effect.forkScoped(
            readiness.grant(next).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  clock.granted = true
                }),
              ),
            ),
          )
          yield* Deferred.await(checked)
          expect(yield* readiness.withPermit({ ...request, proof: makeRequestProof(next) }, Effect.succeed)).toBe(
            "v1-clean-only",
          )
          expect(clock.granted).toBe(false)
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(holder))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(replacement))).toBe(true)
          expect(yield* readiness.withPermit({ ...request, proof: makeRequestProof(next) }, Effect.succeed)).toBe(
            "v2-enriched",
          )
        }),
      ),
    )
  })
})
