import { Clock, Deferred, Effect, Schema, Semaphore } from "effect"

const proofBrand = Symbol()

export interface RequestProof {
  readonly [proofBrand]: true
  readonly topologyRevision: string
  readonly requestToken: string
}

export interface LeaseInput {
  readonly version: 1
  readonly workspaceID?: string
  readonly topologyRevision: string
  readonly expiresAt: number
  readonly requestToken: string
}

export interface LeaseAck {
  readonly acceptedRevision: string
  readonly expiresAt: number
}

export class LeaseConflict extends Schema.TaggedErrorClass<LeaseConflict>()(
  "SessionContextTransferReadiness.LeaseConflict",
  { reason: Schema.String },
) {}

export type Mode = "v1-local-explicit" | "v1-clean-only" | "v2-enriched"

export const LEASE_DURATION_MS = 30_000

export function makeRequestProof(input: {
  readonly topologyRevision: string
  readonly requestToken: string
}): RequestProof {
  return Object.freeze({
    [proofBrand]: true as const,
    topologyRevision: input.topologyRevision,
    requestToken: input.requestToken,
  })
}

type LeaseState = {
  readonly input: LeaseInput
  expiresAt: number
  accepting: boolean
  active: number
  drained?: Deferred.Deferred<void>
}

export function makeTransferReadiness(options?: {
  readonly mode?: Mode | "managed"
  readonly now?: Effect.Effect<number>
}) {
  return Effect.sync(() => {
    const mode = options?.mode ?? "managed"
    const now = options?.now ?? Clock.currentTimeMillis
    const lock = Semaphore.makeUnsafe(1)
    const state: { lease?: LeaseState } = {}

    const grantSnapshot = (input: LeaseInput): Effect.Effect<LeaseAck, LeaseConflict> =>
      Effect.gen(function* () {
        const result = yield* lock.withPermit(
          Effect.gen(function* () {
            const time = yield* now
            if (
              input.version !== 1 ||
              !/^[0-9a-f]{64}$/i.test(input.requestToken) ||
              !Number.isFinite(input.expiresAt) ||
              input.expiresAt <= time
            )
              return yield* new LeaseConflict({ reason: "invalid readiness lease" })

            const current = state.lease
            if (current && (current.expiresAt <= time || !current.accepting)) {
              current.accepting = false
              if (current.active > 0) {
                // A draining lease must never be reopened, even by the same identity.
                if (current.expiresAt > time && !matches(current.input, input))
                  return yield* new LeaseConflict({ reason: "conflicting readiness lease" })
                current.drained ??= yield* Deferred.make<void>()
                return { _tag: "Wait" as const, drained: current.drained }
              }
              state.lease = undefined
            }
            const lease = state.lease
            if (lease && !matches(lease.input, input))
              return yield* new LeaseConflict({ reason: "conflicting readiness lease" })

            const expiresAt = Math.min(input.expiresAt, time + LEASE_DURATION_MS)
            if (lease) lease.expiresAt = expiresAt
            state.lease = lease ?? { input, expiresAt, accepting: true, active: 0 }
            return { _tag: "Granted" as const, ack: { acceptedRevision: input.topologyRevision, expiresAt } }
          }),
        )
        if (result._tag === "Granted") return result.ack
        // Never wait while holding the manager's semaphore: release needs it too.
        yield* Deferred.await(result.drained)
        return yield* grantSnapshot(input)
      })

    return {
      withPermit: <A, E, R>(
        input: { readonly sessionID: string; readonly workspaceID?: string; readonly proof?: RequestProof },
        run: (mode: Mode) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => {
        const request = {
          workspaceID: input.workspaceID,
          proof: input.proof ? makeRequestProof(input.proof) : undefined,
        }
        if (mode !== "managed") return Effect.suspend(() => run(mode))
        return Effect.acquireUseRelease(
          lock.withPermit(
            Effect.gen(function* () {
              const time = yield* now
              const lease = state.lease
              if (lease && lease.expiresAt <= time) {
                lease.accepting = false
                if (lease.active === 0) state.lease = undefined
              }
              if (
                !lease?.accepting ||
                !request.proof ||
                (lease.input.workspaceID !== undefined && request.workspaceID !== lease.input.workspaceID) ||
                request.proof.topologyRevision !== lease.input.topologyRevision ||
                request.proof.requestToken !== lease.input.requestToken
              )
                return undefined
              lease.active++
              return lease
            }),
          ),
          (lease) => Effect.suspend(() => run(lease ? "v2-enriched" : "v1-clean-only")),
          (lease) =>
            !lease
              ? Effect.void
              : lock.withPermit(
                  Effect.gen(function* () {
                    lease.active--
                    if (lease.active !== 0 || lease.accepting) return
                    if (state.lease === lease) state.lease = undefined
                    if (lease.drained) yield* Deferred.succeed(lease.drained, undefined)
                  }),
                ),
        )
      },
      grant: (input: LeaseInput) => grantSnapshot({ ...input }),
      revoke: (input: LeaseInput): Effect.Effect<LeaseAck, LeaseConflict> => {
        const snapshot = { ...input }
        return Effect.gen(function* () {
          const result = yield* lock.withPermit(
            Effect.gen(function* () {
              const lease = state.lease
              if (!lease)
                return {
                  ack: { acceptedRevision: snapshot.topologyRevision, expiresAt: snapshot.expiresAt },
                  drained: undefined,
                }
              if (!matches(lease.input, snapshot))
                return yield* new LeaseConflict({ reason: "conflicting readiness lease" })
              lease.accepting = false
              const ack = { acceptedRevision: lease.input.topologyRevision, expiresAt: lease.expiresAt }
              if (lease.active === 0) {
                state.lease = undefined
                return { ack, drained: undefined }
              }
              lease.drained ??= yield* Deferred.make<void>()
              return { ack, drained: lease.drained }
            }),
          )
          if (result.drained) yield* Deferred.await(result.drained)
          return result.ack
        })
      },
    }
  })
}

function matches(left: LeaseInput, right: LeaseInput) {
  return (
    left.workspaceID === right.workspaceID &&
    left.topologyRevision === right.topologyRevision &&
    left.requestToken === right.requestToken
  )
}
