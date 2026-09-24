import { expect, test } from "bun:test"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { Cause, Deferred, Effect, Fiber, Option } from "effect"
import { makeExecutionComposition, makeInterruptSafeCoordinator } from "../src/session-execution"

test("pinned native coordinator characterizes interrupted Deferred fan-out losing a joined waiter", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const native = yield* SessionRunCoordinator.make<string, never>({
      drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    })
    const first = yield* native.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const joined = yield* native.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow
    yield* native.interrupt("session")
    expect(first.pollUnsafe()?._tag).toBe("Failure")
    expect(joined.pollUnsafe()).toBeUndefined()
    expect((yield* native.active).size).toBe(0)
    // The scope cancels the stranded waiter; never await the known-broken fan-out.
  })).pipe(Effect.timeout("5 seconds"))),
)

test("the execution adapter releases every joined waiter on external interruption", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()
    const calls: boolean[] = []
    const coordinator = yield* makeInterruptSafeCoordinator<string, never>({
      drain: (_key, force) => Effect.sync(() => { calls.push(force) }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(finalized, undefined)),
      ),
    })
    const first = yield* coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const joined = yield* Effect.forEach([1, 2], () => coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true })))
    yield* Effect.yieldNow
    yield* coordinator.interrupt("session")
    for (const fiber of [first, ...joined]) {
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
    expect(Option.isSome(yield* Deferred.poll(finalized))).toBe(true)
    expect(calls).toEqual([true])
    expect((yield* coordinator.active).size).toBe(0)
    yield* coordinator.interrupt("session")
    yield* coordinator.interrupt("missing")
    expect(calls).toEqual([true])
  })).pipe(Effect.timeout("5 seconds"))),
)

test("cancelling a resume waiter leaves the native execution owner and other waiters running", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()
    const coordinator = yield* makeInterruptSafeCoordinator<string, never>({
      drain: () => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.ensuring(Deferred.succeed(finalized, undefined)),
      ),
    })
    const disconnected = yield* coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const remaining = yield* coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Fiber.interrupt(disconnected)
    expect((yield* Fiber.await(disconnected))._tag).toBe("Failure")
    expect((yield* coordinator.active).has("session")).toBe(true)
    expect(Option.isNone(yield* Deferred.poll(finalized))).toBe(true)
    expect(remaining.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.await(remaining))._tag).toBe("Success")
    expect(Option.isSome(yield* Deferred.poll(finalized))).toBe(true)
    expect((yield* coordinator.active).size).toBe(0)
  })).pipe(Effect.timeout("5 seconds"))),
)

for (const kind of ["typed", "defect", "interruption"] as const) {
  test(`the execution adapter preserves ${kind} causes for all resume waiters`, () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const error = new Error("original drain failure")
      const terminal = kind === "typed" ? Effect.fail(error) : kind === "defect" ? Effect.die(error) : Effect.interrupt
      const coordinator = yield* makeInterruptSafeCoordinator<string, Error>({
        drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(terminal)),
      })
      const first = yield* coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)
      const joined = yield* coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      for (const fiber of [first, joined]) {
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") continue
        if (kind === "typed") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(error)
        if (kind === "defect") expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(error)
        if (kind === "interruption") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      expect((yield* coordinator.active).size).toBe(0)
    })).pipe(Effect.timeout("5 seconds"))),
  )
}

for (const fail of [false, true]) {
  test(`native coalesced advisory wakes survive a ${fail ? "failed" : "successful"} owned drain`, () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const successor = yield* Deferred.make<void>()
      const calls: boolean[] = []
      const error = new Error("first drain failure")
      const coordinator = yield* makeInterruptSafeCoordinator<string, Error>({
        drain: (_key, force) => Effect.gen(function* () {
          calls.push(force)
          if (calls.length > 1) {
            yield* Deferred.succeed(successor, undefined)
            return
          }
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          if (fail) return yield* Effect.fail(error)
        }),
      })
      const owner = yield* coordinator.run("session").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* coordinator.wake("session")
      yield* coordinator.wake("session")
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(owner)
      expect(exit._tag).toBe(fail ? "Failure" : "Success")
      if (exit._tag === "Failure") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(error)
      yield* Deferred.await(successor)
      yield* Effect.yieldNow
      expect(calls).toEqual([true, false])
      expect((yield* coordinator.active).size).toBe(0)
    })).pipe(Effect.timeout("5 seconds"))),
  )
}

for (const firstMode of ["pending", "resume"] as const) {
  test(`${firstMode} and the other execution view join one native owner and both settle on interrupt`, () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const calls: boolean[] = []
      const execution = yield* makeExecutionComposition<string, never>({
        drain: (_key, force) => Effect.sync(() => { calls.push(force) }).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        ),
      })
      const first = yield* execution[firstMode]("child").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)
      const joined = yield* execution[firstMode === "pending" ? "resume" : "pending"]("child").pipe(
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* execution.interrupt("child")
      for (const fiber of [first, joined]) {
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      expect(calls).toEqual([firstMode === "resume"])
      expect((yield* execution.active).size).toBe(0)
    })).pipe(Effect.timeout("5 seconds"))),
  )
}

test("pending-only mode is per idle owner and never changes native forced resume or advisory wakes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const woke = yield* Deferred.make<void>()
    const calls: boolean[] = []
    const execution = yield* makeExecutionComposition<string, never>({
      drain: (_key, force) => Effect.sync(() => { calls.push(force) }).pipe(
        Effect.andThen(Effect.suspend(() => calls.length === 4 ? Deferred.succeed(woke, undefined).pipe(Effect.asVoid) : Effect.void)),
      ),
    })
    yield* execution.pending("child")
    yield* execution.pending("child")
    yield* execution.resume("child")
    yield* execution.wake("child")
    yield* Deferred.await(woke)
    expect(calls).toEqual([false, false, true, false])
  })).pipe(Effect.timeout("5 seconds"))),
)

test("cancelling the pending caller that started an idle owner cancels its native owner and settles a resume joiner", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()
    const execution = yield* makeExecutionComposition<string, never>({
      drain: () => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(finalized, undefined)),
      ),
    })
    const child = yield* execution.pending("child").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const joined = yield* execution.resume("child").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Fiber.interrupt(child)
    const exit = yield* Fiber.await(joined)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(Option.isSome(yield* Deferred.poll(finalized))).toBe(true)
    expect((yield* execution.active).size).toBe(0)
  })).pipe(Effect.timeout("5 seconds"))),
)

for (const joiningMode of ["pending", "resume"] as const) {
  test(`cancelling a joining ${joiningMode} caller does not cancel preexisting child work`, () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const execution = yield* makeExecutionComposition<string, never>({
        drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      const owner = yield* execution.pending("child").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)
      const joined = yield* execution[joiningMode]("child").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Fiber.interrupt(joined)
      expect((yield* execution.active).has("child")).toBe(true)
      expect(owner.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(owner)
      expect((yield* execution.active).size).toBe(0)
    })).pipe(Effect.timeout("5 seconds"))),
  )
}

test("different pending children run concurrently and interrupt cleanup never holds the admission gate", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const startedA = yield* Deferred.make<void>()
    const startedB = yield* Deferred.make<void>()
    const finalizingA = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()
    const calls: string[] = []
    const execution = yield* makeExecutionComposition<string, never>({
      drain: (key) => Effect.sync(() => { calls.push(key) }).pipe(Effect.andThen(
        key === "a" ? Deferred.succeed(startedA, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(finalizingA, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup)))),
        ) : key === "b" ? Deferred.succeed(startedB, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void,
      )),
    })
    yield* Effect.gen(function* () {
      const a = yield* execution.pending("a").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(startedA)
      const b = yield* execution.pending("b").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(startedB)
      expect((yield* execution.active).size).toBe(2)
      const interrupt = yield* execution.interrupt("a").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(finalizingA)
      yield* execution.pending("c")
      expect(calls).toEqual(["a", "b", "c"])
      expect(b.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Fiber.join(interrupt)
      expect((yield* Fiber.await(a))._tag).toBe("Failure")
      yield* execution.interrupt("b")
      expect((yield* Fiber.await(b))._tag).toBe("Failure")
    }).pipe(Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)))
  })).pipe(Effect.timeout("5 seconds"))),
)

test("cancelling the initiating native resume waiter does not transfer owner cancellation to a pending joiner", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const execution = yield* makeExecutionComposition<string, never>({
      drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    })
    const resume = yield* execution.resume("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const pending = yield* execution.pending("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Fiber.interrupt(resume)
    yield* Fiber.interrupt(pending)
    expect((yield* execution.active).has("session")).toBe(true)
    const remaining = yield* execution.resume("session").pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(remaining)
    expect((yield* execution.active).size).toBe(0)
  })).pipe(Effect.timeout("5 seconds"))),
)

for (const kind of ["typed", "defect", "interruption"] as const) {
  test(`shared execution transports ${kind} causes to both views without cancelling a coalesced successor`, () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const successor = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const error = new Error("shared execution failure")
      const terminal = kind === "typed" ? Effect.fail(error) : kind === "defect" ? Effect.die(error) : Effect.interrupt
      const calls: boolean[] = []
      const execution = yield* makeExecutionComposition<string, Error>({
        drain: (_key, force) => Effect.gen(function* () {
          calls.push(force)
          if (calls.length > 1) {
            yield* Deferred.succeed(successor, undefined)
            yield* Deferred.await(finish)
            return
          }
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return yield* terminal
        }),
      })
      const pending = yield* execution.pending("session").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)
      const resume = yield* execution.resume("session").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* execution.wake("session")
      yield* execution.wake("session")
      yield* Deferred.succeed(release, undefined)
      for (const fiber of [pending, resume]) {
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") continue
        if (kind === "typed") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(error)
        if (kind === "defect") expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(error)
        if (kind === "interruption") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      yield* Deferred.await(successor)
      expect((yield* execution.active).has("session")).toBe(true)
      expect(calls).toEqual([false, false])
      const joined = yield* execution.resume("session").pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(joined)
      expect(calls).toEqual([false, false])
      expect((yield* execution.active).size).toBe(0)
    })).pipe(Effect.timeout("5 seconds"))),
  )
}
