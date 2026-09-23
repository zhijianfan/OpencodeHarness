import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Cause, Context, Effect, Layer, Option, PubSub, Semaphore, Stream } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"

type Batch = {
  readonly boundary: object
  readonly owner: number
  readonly notifications: EventV2.Payload[]
  readonly afterCommit: Effect.Effect<void>[]
  active: boolean
}
class CurrentBatch extends Context.Service<CurrentBatch, Batch>()("@cybermastery/EventBatch") {}

export class EventBoundaryViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EventBoundaryViolation"
  }
}

export interface EventBoundaryInterface {
  readonly events: EventV2.Interface
  readonly transaction: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>
  readonly afterCommit: (body: Effect.Effect<void>) => Effect.Effect<void>
}

export class EventBoundary extends Context.Service<EventBoundary, EventBoundaryInterface>()("@cybermastery/EventBoundary") {}

/** Delegates native event persistence/projectors; replaces notification timing and read fencing only. */
export function makeEventBoundaryNode(options: {
  readonly onDurableReadAttempt?: (aggregateID: string) => Effect.Effect<void>
  readonly onPublicSubscribe?: Effect.Effect<void>
} = {}) {
  return makeGlobalNode({
    service: EventBoundary,
    deps: [Database.node],
    layer: Layer.effect(EventBoundary, Effect.gen(function* () {
      const database = yield* Database.Service
      const identity = {}
      const gate = yield* Semaphore.make(1)
      const bus = yield* PubSub.unbounded<EventV2.Payload>()
      const listeners = new Set<{ readonly run: EventV2.Subscriber }>()
      yield* Effect.addFinalizer(() => Effect.sync(() => { listeners.clear() }).pipe(Effect.andThen(PubSub.shutdown(bus))))

      const batch = Effect.withFiber((fiber) => Effect.gen(function* () {
        const current = yield* Effect.serviceOption(CurrentBatch)
        if (Option.isNone(current)) return undefined
        if (current.value.boundary !== identity || !current.value.active || current.value.owner !== fiber.id) {
          return yield* Effect.die(new EventBoundaryViolation("Transaction mutation escaped its owning fiber"))
        }
        return current.value
      }))

      const nativeContext = yield* Layer.build(EventV2.layerWith({
        beforeAggregateRead: (aggregateID) => Effect.gen(function* () {
          if (Option.isSome(yield* Effect.serviceOption(CurrentBatch))) {
            return yield* Effect.die(new EventBoundaryViolation("Durable subscription inside a write transaction"))
          }
          if (options.onDurableReadAttempt) yield* options.onDurableReadAttempt(aggregateID)
          yield* gate.withPermit(Effect.void)
        }),
      }))
      const native = Context.get(nativeContext, EventV2.Service)

      const notify = (event: EventV2.Payload) => Effect.gen(function* () {
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue
          const observed = Effect.suspend(() => listener.run(event))
          yield* event.durable
            ? observed.pipe(Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                () => Effect.logError("Committed event listener failed", { eventID: event.id, eventType: event.type }),
              ))
            : observed
        }
        yield* PubSub.publish(bus, event)
      })

      const unsubscribe = yield* native.listen((event) => Effect.gen(function* () {
        const current = yield* batch
        if (current) {
          current.notifications.push(event)
          return
        }
        yield* notify(event)
      }))
      yield* Effect.addFinalizer(() => unsubscribe)

      const transaction: EventBoundaryInterface["transaction"] = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
          const current = yield* batch
          if (current) {
            const start = current.notifications.length
            const actions = current.afterCommit.length
            return yield* database.db.transaction(() => restore(body)).pipe(Effect.onExit((exit) =>
              Effect.sync(() => {
                if (exit._tag !== "Failure") return
                current.notifications.splice(start)
                current.afterCommit.splice(actions)
              }),
            ))
          }
          if (Option.isSome(yield* Effect.serviceOption(database.db.$client.transactionService))) {
            return yield* Effect.die(new EventBoundaryViolation("Use EventBoundary.transaction as the outer transaction"))
          }
          const owner = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
          const scope: Batch = { boundary: identity, owner, notifications: [], afterCommit: [], active: true }
          const result = yield* gate.withPermit(
            database.db.transaction(() => restore(body).pipe(Effect.provideService(CurrentBatch, scope)), { behavior: "immediate" }),
          ).pipe(Effect.onExit(() => Effect.sync(() => { scope.active = false })))
          // The SQL connection and read gate are released before external
          // listeners run, so reentrant publication does not deadlock.
          for (const event of scope.notifications) yield* notify(event)
          for (const action of scope.afterCommit) yield* action
          return result
        }))

      const mutate = <A>(operation: Effect.Effect<A>): Effect.Effect<A> => Effect.gen(function* () {
        if (yield* batch) return yield* operation
        return yield* transaction(operation).pipe(Effect.orDie)
      })

      const all = () => Stream.unwrap(Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(bus)
        if (options.onPublicSubscribe) yield* options.onPublicSubscribe
        return Stream.fromSubscription(subscription)
      }))
      const events: EventV2.Interface = {
        publish: (definition, data, options) => mutate(native.publish(definition, data, options)),
        replay: (event, options) => mutate(native.replay(event, options)),
        replayAll: (events, options) => mutate(native.replayAll(events, options)),
        remove: (aggregateID) => mutate(native.remove(aggregateID)),
        claim: (aggregateID, ownerID) => mutate(native.claim(aggregateID, ownerID)),
        project: native.project,
        durable: native.durable,
        all,
        subscribe: (definition) => all().pipe(
          Stream.filter((event): event is EventV2.Payload<typeof definition> => event.type === definition.type),
        ),
        listen: (run) => Effect.sync(() => {
          const listener = { run }
          listeners.add(listener)
          return Effect.sync(() => { listeners.delete(listener) })
        }),
      }
      return EventBoundary.of({
        events,
        transaction,
        afterCommit: (body) => Effect.gen(function* () {
          const current = yield* batch
          if (!current) return yield* body
          current.afterCommit.push(body)
        }),
      })
    })),
  })
}

export function makeMediatedEventNode(boundary: ReturnType<typeof makeEventBoundaryNode>) {
  return makeGlobalNode({
    service: EventV2.Service,
    deps: [boundary],
    layer: Layer.effect(EventV2.Service, Effect.gen(function* () {
      const mediator = yield* EventBoundary
      return mediator.events
    })),
  })
}
