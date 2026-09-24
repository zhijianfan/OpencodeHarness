import { Clock, Effect, Exit, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { createHash, randomBytes } from "node:crypto"
import { LEASE_DURATION_MS, makeRequestProof } from "./transfer-readiness"
import type { LeaseAck, LeaseInput, RequestProof } from "./transfer-readiness"

export const TOPOLOGY_HEADER = "x-opencode-session-context-topology"
export const LEASE_HEADER = "x-opencode-session-context-lease"

export interface CoordinatorInterface {
  readonly proof: (workspaceID?: string) => RequestProof | undefined
  readonly activate: (
    entries: ReadonlyArray<{
      readonly workspaceID?: string
      readonly topologyRevision: string
      readonly requestToken: string
    }>,
  ) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>
}

export function makeReadinessCoordinator(): CoordinatorInterface {
  const proofs = new Map<string | undefined, RequestProof>()
  return {
    proof: (workspaceID) => proofs.get(workspaceID) ?? proofs.get(undefined),
    activate: (entries) => {
      const snapshot = entries.map((entry) => ({ workspaceID: entry.workspaceID, proof: makeRequestProof(entry) }))
      return Effect.sync(() => {
        proofs.clear()
        for (const entry of snapshot) proofs.set(entry.workspaceID, entry.proof)
      })
    },
    clear: Effect.sync(() => proofs.clear()),
  }
}

export interface Peer {
  readonly workspaceID?: string
  readonly endpoint: string
  readonly version: 1
  readonly probe: Effect.Effect<{ readonly transferRequired: boolean }, unknown>
  readonly grant: (lease: LeaseInput) => Effect.Effect<LeaseAck, unknown>
  readonly revoke: (lease: LeaseInput) => Effect.Effect<LeaseAck & { readonly transferRequired: boolean }, unknown>
}

export class TopologyError extends Schema.TaggedErrorClass<TopologyError>()(
  "SessionContextReadiness.TopologyError",
  { phase: Schema.Literals(["probe", "grant", "renew", "revoke"]), cause: Schema.Defect() },
) {}

type ActiveTopology = {
  readonly peers: ReadonlyArray<Peer>
  readonly topologyRevision: string
  readonly requestToken: string
  readonly expiresAt: number
}

export function makeOrchestrator(input: {
  readonly coordinator: CoordinatorInterface
  readonly now?: Effect.Effect<number>
  readonly token?: () => string
}) {
  const coordinator = input.coordinator
  const lock = Semaphore.makeUnsafe(1)
  const now = input.now ?? Clock.currentTimeMillis
  const token = input.token ?? (() => randomBytes(32).toString("hex"))
  let active: ActiveTopology | undefined

  const revoke = (state: ActiveTopology) =>
    Effect.gen(function* () {
      yield* coordinator.clear
      // Visit every peer even if another peer fails; do not leave usable local proofs.
      const results = yield* Effect.forEach(
        state.peers,
        (peer) => Effect.exit(Effect.suspend(() => peer.revoke(leaseFor(state, peer)))),
        { concurrency: "unbounded" },
      )
      if (results.some(Exit.isFailure))
        return yield* new TopologyError({ phase: "revoke", cause: "readiness peer revocation failed" })
      active = undefined
      return results.some((result) => Exit.isSuccess(result) && result.value.transferRequired)
    })

  const grant = (peers: ReadonlyArray<Peer>, phase: "grant" | "renew", previous?: ActiveTopology) =>
    Effect.gen(function* () {
      const topologyRevision = revision(peers)
      const state: ActiveTopology = {
        peers,
        topologyRevision,
        requestToken: previous?.topologyRevision === topologyRevision ? previous.requestToken : token(),
        expiresAt: (yield* now) + LEASE_DURATION_MS,
      }
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => ({ acknowledged: new Set<Peer>(), completed: false })),
        (transaction) =>
          Effect.gen(function* () {
            const result = yield* Effect.exit(
              Effect.forEach(
                peers,
                (peer) =>
                  Effect.suspend(() => peer.grant(leaseFor(state, peer))).pipe(
                    Effect.tap(() => Effect.sync(() => transaction.acknowledged.add(peer))),
                  ),
                { discard: true },
              ),
            )
            // Peer failures may contain private payloads or tokens: never retain their cause.
            if (Exit.isFailure(result))
              return yield* new TopologyError({ phase, cause: "readiness peer grant failed" })
            yield* coordinator.activate(
              peers.map((peer) => ({ workspaceID: peer.workspaceID, topologyRevision, requestToken: state.requestToken })),
            )
            active = state
            transaction.completed = true
            return { topologyRevision, expiresAt: state.expiresAt }
          }),
        (transaction) =>
          Effect.gen(function* () {
            if (transaction.completed) return
            yield* coordinator.clear
            active = undefined
            yield* Effect.forEach(
              [...transaction.acknowledged],
              (peer) => Effect.exit(Effect.suspend(() => peer.revoke(leaseFor(state, peer)))),
              { concurrency: "unbounded", discard: true },
            )
            // Renewal failure must also withdraw old leases from peers not yet renewed.
            if (previous)
              yield* Effect.forEach(
                previous.peers.filter((peer) => !transaction.acknowledged.has(peer)),
                (peer) => Effect.exit(Effect.suspend(() => peer.revoke(leaseFor(previous, peer)))),
                { concurrency: "unbounded", discard: true },
              )
          }),
      )
    })

  return {
    activate: (peers: ReadonlyArray<Peer>) => {
      const snapshot = peers.map((peer) => ({ ...peer }))
      return lock.withPermit(
        Effect.gen(function* () {
          yield* coordinator.clear
          const probes = yield* Effect.exit(
            Effect.forEach(snapshot, (peer) => peer.probe, { concurrency: "unbounded", discard: true }),
          )
          if (Exit.isFailure(probes)) {
            if (active) yield* Effect.exit(revoke(active))
            return yield* new TopologyError({ phase: "probe", cause: "readiness peer probe failed" })
          }
          return yield* grant(snapshot, "grant", active)
        }),
      )
    },
    renew: lock.withPermit(
      Effect.gen(function* () {
        if (!active) return
        return yield* grant(active.peers, "renew", active)
      }),
    ),
    beforeMutation: lock.withPermit(
      Effect.gen(function* () {
        yield* coordinator.clear
        if (!active) return false
        return yield* revoke(active)
      }),
    ),
    revision: () => active?.topologyRevision,
  }
}

function leaseFor(state: ActiveTopology, peer: Peer): LeaseInput {
  return {
    version: 1,
    workspaceID: peer.workspaceID,
    topologyRevision: state.topologyRevision,
    requestToken: state.requestToken,
    expiresAt: state.expiresAt,
  }
}

function revision(peers: ReadonlyArray<Peer>) {
  return createHash("sha256")
    .update(
      peers
        .map((peer) => `${peer.workspaceID ?? ""}\0${peer.endpoint}\0${peer.version}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")
}

export class PrivateTransportError extends Schema.TaggedErrorClass<PrivateTransportError>()(
  "SessionContextReadiness.PrivateTransportError",
  { protocol: Schema.String, hostname: Schema.String },
) {}

export class PrivateRedirectError extends Schema.TaggedErrorClass<PrivateRedirectError>()(
  "SessionContextReadiness.PrivateRedirectError",
  { status: Schema.Number },
) {}

export function validateTarget(input: {
  readonly url: string | URL
  readonly confidential?: boolean
}): Effect.Effect<URL, PrivateTransportError> {
  return Effect.try({
    try: () => new URL(input.url),
    catch: () => new PrivateTransportError({ protocol: "invalid", hostname: "invalid" }),
  }).pipe(
    Effect.flatMap((url) => {
      if (input.confidential || url.protocol === "https:") return Effect.succeed(url)
      if (url.protocol === "http:" && isLoopback(url.hostname)) return Effect.succeed(url)
      return Effect.fail(new PrivateTransportError({ protocol: url.protocol, hostname: url.hostname }))
    }),
  )
}

export function executePrivate(
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  options?: { readonly confidential?: boolean },
) {
  return Effect.gen(function* () {
    yield* validateTarget({ url: request.url, confidential: options?.confidential })
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    )
    if (response.status >= 300 && response.status < 400)
      return yield* new PrivateRedirectError({ status: response.status })
    return response
  })
}

function isLoopback(hostname: string) {
  if (hostname === "::1" || hostname === "[::1]") return true
  const octets = hostname.split(".")
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  )
}
