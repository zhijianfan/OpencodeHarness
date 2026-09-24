import { Buffer } from "node:buffer"
import { mkdir, mkdtemp } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import type { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { AdmissionError } from "./admission"
import { bindLayoutRepository } from "./layout"
import { createNativeHttp } from "./native-http"
import type { RunnerIdentity } from "./runner"
import { SessionAccessError, type SessionActor } from "./session-access"
import type { SessionPolicy } from "./session-facade"
import { createSessionHttp } from "./session-http"
import { createTransferHttp } from "./transfer-http"
import { TransferError } from "./transfer-protocol"
import { makeTransferReadiness } from "./transfer-readiness"
import { makeTransferReceiver } from "./transfer-receiver"
import { makeTransferSource, type TransferSource } from "./transfer-source"
import { SessionContextTransferSpool } from "./transfer-spool"

/** One owned native graph; both the Session ingress and layout storage borrow it. */
export async function createApplicationAdapter(input: {
  readonly filename: string
  readonly workspaceID: string
  readonly userID: string
  readonly token: string
  readonly directory?: string
  readonly isolated?: boolean
  readonly policy?: SessionPolicy
  readonly replacements?: LayerNode.Replacements
  readonly onRunnerConstruct?: (identity: RunnerIdentity) => void
}) {
  if (!input.token.trim()) throw new Error("An explicit authentication token is required")
  if (!input.userID.trim() || !input.workspaceID.trim()) throw new Error("An explicit user and workspace are required")
  if (!input.filename.trim()) throw new Error("An explicit database filename is required")

  const token = input.token
  const actor: SessionActor = Object.freeze({ userID: input.userID, workspaceID: input.workspaceID })
  const location: Location.Ref = {
    directory: AbsolutePath.make(resolve(input.directory ?? process.cwd())),
    // Historical proof workspaces remain logical identities, not native placements.
    ...(actor.workspaceID.startsWith("wrk") ? { workspaceID: WorkspaceV2.ID.make(actor.workspaceID) } : {}),
  }
  const matchesActor = (candidate: SessionActor) => candidate.userID === actor.userID && candidate.workspaceID === actor.workspaceID
  const matchesLocation = (candidate: Location.Ref) => candidate.directory === location.directory && candidate.workspaceID === location.workspaceID
  const credentials = `opencode:${token}`
  const basic = `Basic ${Buffer.from(credentials).toString("base64")}`
  const authenticate = (request: Request): SessionActor | undefined => {
    const header = request.headers.get("Authorization")
    if (header !== null) {
      if (header === `Bearer ${token}`) return actor
      return header.startsWith("Basic ") && matchesCredentials(header.slice(6), credentials) ? actor : undefined
    }
    const query = new URL(request.url).searchParams.get("auth_token")
    return query !== null && matchesCredentials(query, credentials) ? actor : undefined
  }
  const policy: SessionPolicy = input.policy ?? ((dependencies) => ({
    managed: () => Effect.succeed(true),
    authorize: (request) => Effect.gen(function* () {
      if (!matchesActor(request.actor)) return yield* new AdmissionError({ code: "unauthorized" })
      // These captured native services also participate in the projector's
      // transaction: do not rely on the earlier HTTP placement check alone.
      const recorded = yield* dependencies.session.get(request.sessionID).pipe(
        Effect.mapError(() => new AdmissionError({ code: "unauthorized" })),
      )
      if (!matchesLocation(recorded.location)) return yield* new AdmissionError({ code: "unauthorized" })
      const workspace = yield* dependencies.database.db.get<{ owner_id: string }>(sql`
        SELECT owner_id FROM cm_workspace WHERE id = ${actor.workspaceID}`).pipe(
        Effect.mapError(() => new AdmissionError({ code: "unauthorized" })),
      )
      if (workspace?.owner_id !== request.actor.userID) return yield* new AdmissionError({ code: "unauthorized" })
    }),
    freeze: (request) => request.references.length === 0
      ? Effect.succeed({ apiContent: request.text, rendererVersion: 1 })
      : Effect.fail(new AdmissionError({ code: "missing-private-context" })),
  }))
  const replacements = input.isolated
    ? await isolatedReplacements(input.filename, input.replacements ?? [])
    : input.replacements
  const readiness = Effect.runSync(makeTransferReadiness())
  const native = await createNativeHttp({
    filename: input.filename,
    password: token,
    policy,
    readiness,
    replayOwner: actor.workspaceID,
    replacements,
    onRunnerConstruct: input.onRunnerConstruct,
  })
  const owned: {
    ingress?: Awaited<ReturnType<typeof createSessionHttp>>
    source?: TransferSource
    receiver?: Effect.Success<ReturnType<typeof makeTransferReceiver>>
    spool?: SessionContextTransferSpool
    disposal?: Promise<void>
  } = {}
  const dispose = () => {
    owned.disposal ??= Promise.resolve().then(async () => {
      try {
        await owned.ingress?.dispose()
      } finally {
        try {
          if (owned.source) await native.runtime.runPromise(owned.source.dispose)
          if (owned.receiver) await native.runtime.runPromise(owned.receiver.dispose)
        } finally {
          try {
            await owned.spool?.dispose()
          } finally {
            await native.dispose()
          }
        }
      }
    })
    return owned.disposal
  }

  try {
    const storage = await bindLayoutRepository({ runtime: native.runtime, workspaceID: actor.workspaceID, ownerID: actor.userID })
    const database = await native.runtime.runPromise(Database.Service)
    const project = await native.runtime.runPromise(Effect.gen(function* () {
      const projects = yield* ProjectV2.Service
      const project = yield* projects.resolve(location.directory)
      yield* database.db.insert(ProjectTable).values({
        id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [],
      }).onConflictDoNothing().run()
      return project
    }))
    const authorizeTransfer = () => database.db.get<{ owner_id: string }>(sql`
      SELECT owner_id FROM cm_workspace WHERE id = ${actor.workspaceID}`).pipe(
      Effect.mapError(() => new TransferError({ code: "forbidden", message: "workspace unavailable" })),
      Effect.flatMap((workspace) => workspace?.owner_id === actor.userID
        ? Effect.void : Effect.fail(new TransferError({ code: "forbidden", message: "workspace authority changed" }))),
    )
    const transferPolicy = {
      scope: { principalID: actor.userID, ownerID: actor.workspaceID, projectID: project.id,
        workspaceID: location.workspaceID, directory: location.directory },
      authorize: authorizeTransfer,
    }
    const source = await native.runtime.runPromise(makeTransferSource(transferPolicy))
    owned.source = source
    const spool = await SessionContextTransferSpool.make({ root: resolve(input.filename) + ".transfer-spool" })
    owned.spool = spool
    const receiver = await native.runtime.runPromise(makeTransferReceiver({ ...transferPolicy, spool }))
    owned.receiver = receiver
    const transfer = createTransferHttp({
      source, receiver, readiness, workspaceID: location.workspaceID,
      authenticate: async (request) => authenticate(request) !== undefined,
      authorizeStart: authorizeTransfer,
      run: (effect) => native.runtime.runPromise(effect),
    })
    const ingress = await createSessionHttp({
      runtime: native.runtime,
      defaultLocation: location,
      authenticate: async (request) => authenticate(request),
      policy: {
        authorize: (request) => matchesActor(request.actor) && matchesLocation(request.location)
          && (request.session === undefined || matchesLocation(request.session.location))
          ? Effect.void : Effect.fail(new SessionAccessError({ code: "forbidden" })),
      },
    })
    owned.ingress = ingress
    return {
      ...storage,
      authenticate,
      runtime: native.runtime,
      async fetch(request: Request): Promise<Response> {
        if (owned.disposal) throw new Error("Application adapter has been disposed")
        const privateResponse = await transfer.fetch(request)
        if (privateResponse !== undefined) return privateResponse
        const response = await ingress.fetch(request)
        if (response !== undefined) return response
        // Even native OpenAPI must pass application authentication. Never expose
        // the raw native handler as a way around the Session overlay.
        if (!authenticate(request)) return Response.json({ code: "unauthorized" }, { status: 401 })
        const headers = new Headers(request.headers)
        headers.set("Authorization", basic)
        const forwarded = new Request(request.clone(), { headers })
        const url = new URL(request.url)
        if (!url.searchParams.has("auth_token")) return native.fetch(forwarded)
        // The native query credential can take precedence over Authorization.
        url.searchParams.delete("auth_token")
        return native.fetch(new Request(url, forwarded))
      },
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

function matchesCredentials(encoded: string, expected: string): boolean {
  // Buffer's decoder otherwise silently ignores malformed Base64 characters.
  return /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 !== 1
    && Buffer.from(encoded, "base64").toString("utf8") === expected
}

async function isolatedReplacements(filename: string, replacements: LayerNode.Replacements): Promise<LayerNode.Replacements> {
  const parent = dirname(resolve(filename))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, ".cybermastery-global-"))
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
  // Isolation is mandatory in proof mode, even when other nodes are replaced.
  return [...replacements.filter(([source]) => source.name !== Global.node.name), [Global.node, Global.layerWith(paths)]]
}
