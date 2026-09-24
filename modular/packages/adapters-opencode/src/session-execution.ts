import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Semaphore } from "effect"

/** Retain native ownership/coalescing; transport causes without reentrant interruption of its Deferred waiters. */
export function makeInterruptSafeCoordinator<Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}) {
  return Effect.gen(function* () {
    const native = yield* SessionRunCoordinator.make<Key, Cause.Cause<E>>({
      // Effect beta.83 removes an interrupted waiter while iterating Deferred's
      // live listener array. Box causes inside the mask, then restore each
      // waiter's original cause after it has left the native Deferred callback.
      drain: (key, force) => Effect.uninterruptibleMask((restore) =>
        restore(Effect.suspend(() => options.drain(key, force))).pipe(Effect.sandbox)),
    })
    return {
      active: native.active,
      run: (key: Key) => native.run(key).pipe(Effect.catch((cause) => Effect.failCause(cause))),
      wake: native.wake,
      interrupt: native.interrupt,
    } satisfies SessionRunCoordinator.Coordinator<Key, E>
  })
}

/** Two admission modes, but exactly one native owner map and native wake queue. */
export function makeExecutionComposition<Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}) {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1)
    const pendingOwners = new Map<Key, { readonly ready: Deferred.Deferred<void> }>()
    const coordinator = yield* makeInterruptSafeCoordinator<Key, E>({
      drain: (key, force) => Effect.suspend(() => {
        const owner = pendingOwners.get(key)
        // Native run must register its waiter before a drain can finish. This
        // also leaves admission time to select the idle owner's execution mode.
        return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
          if (owner !== undefined) yield* Deferred.succeed(owner.ready, undefined)
          yield* restore(Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => options.drain(key, force && owner === undefined)))))
        }).pipe(Effect.onExit((exit) =>
          Effect.sync(() => {
            // A failed drain can spawn a *new* native entry for a coalesced wake.
            // Cancellation by the old child caller must not stop that successor.
            if (exit._tag === "Failure" && pendingOwners.get(key) === owner) pendingOwners.delete(key)
          }),
        )))
      }),
    })

    const run = (key: Key, pending: boolean) => Effect.scoped(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const registration = yield* gate.withPermit(Effect.gen(function* () {
        const idle = !(yield* coordinator.active).has(key)
        const owner = pending && idle ? { ready: yield* Deferred.make<void>() } : undefined
        if (idle) {
          pendingOwners.delete(key)
          if (owner !== undefined) pendingOwners.set(key, owner)
        }
        // Fork only the native waiter, not another execution owner. Starting it
        // immediately performs native start/join before the setup gate opens.
        // Keep interruption boxed across this additional waiter boundary too.
        const waiter = yield* restore(coordinator.run(key)).pipe(
          Effect.sandbox,
          Effect.forkScoped({ startImmediately: true }),
        )
        // Install the drain's exit guard before another control call can stop
        // this owner. This waits for registration, never for provider work.
        if (owner !== undefined) yield* Deferred.await(owner.ready)
        return { owner, waiter }
      }))

      yield* restore(Fiber.join(registration.waiter).pipe(Effect.catch((cause) => Effect.failCause(cause)))).pipe(
        Effect.onExit((exit) => Effect.gen(function* () {
          if (exit._tag !== "Failure" || !Cause.hasInterrupts(exit.cause) || registration.owner === undefined) return
          const cleanup = yield* gate.withPermit(Effect.gen(function* () {
            if (pendingOwners.get(key) !== registration.owner || registration.waiter.pollUnsafe() !== undefined) return
            // Register interruption under the same gate; never keep the gate
            // while awaiting provider/tool finalizers.
            return yield* coordinator.interrupt(key).pipe(Effect.forkScoped({ startImmediately: true }))
          }))
          if (cleanup !== undefined) yield* Fiber.join(cleanup)
        })),
        Effect.ensuring(Effect.sync(() => {
          if (registration.owner !== undefined && pendingOwners.get(key) === registration.owner) pendingOwners.delete(key)
        })),
      )
    })))

    return {
      active: coordinator.active,
      resume: (key: Key) => run(key, false),
      // Only a pending caller that started an idle owner assumes cancellation
      // responsibility. Joining an existing resume/child never transfers it.
      pending: (key: Key) => run(key, true),
      wake: (key: Key) => gate.withPermit(Effect.gen(function* () {
        if (!(yield* coordinator.active).has(key)) pendingOwners.delete(key)
        yield* coordinator.wake(key)
      })),
      interrupt: (key: Key) => Effect.scoped(Effect.uninterruptible(Effect.gen(function* () {
        const cleanup = yield* gate.withPermit(coordinator.interrupt(key).pipe(Effect.forkScoped({ startImmediately: true })))
        yield* Fiber.join(cleanup)
      }))),
    }
  })
}

export class PendingSessionExecution extends Context.Service<PendingSessionExecution, {
  readonly run: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
}>()("@cybermastery/PendingSessionExecution") {}

class ExecutionComposition extends Context.Service<ExecutionComposition, {
  readonly native: Effect.Success<typeof SessionExecution.Service>
  readonly pending: Effect.Success<typeof PendingSessionExecution>
}>()("@cybermastery/ExecutionComposition") {}

export const executionCompositionNode = makeGlobalNode({
  service: ExecutionComposition,
  deps: [SessionStore.node, LocationServiceMap.node],
  layer: Layer.effect(ExecutionComposition, Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* makeExecutionComposition<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fn("CyberMastery.SessionExecution.drain")(function* (sessionID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID }))),
        )
      }),
    })
    return ExecutionComposition.of({
      native: SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.resume,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      }),
      pending: PendingSessionExecution.of({ run: coordinator.pending }),
    })
  })),
})

export const sessionExecutionNode = makeGlobalNode({
  service: SessionExecution.Service,
  deps: [executionCompositionNode],
  layer: Layer.effect(SessionExecution.Service, Effect.gen(function* () {
    const composition = yield* ExecutionComposition
    return composition.native
  })),
})

export const pendingSessionExecutionNode = makeGlobalNode({
  service: PendingSessionExecution,
  deps: [executionCompositionNode],
  layer: Layer.effect(PendingSessionExecution, Effect.gen(function* () {
    const composition = yield* ExecutionComposition
    return composition.pending
  })),
})
