import { Buffer } from "node:buffer"
import { mkdir, mkdtemp } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import type { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { CtxPackAccess, CtxPackActor, CtxPackError } from "@cybermastery/contracts/ctxpack"
import type { OperatingChatBindingError } from "@cybermastery/contracts/operating-chat"
import { DefaultInteractiveContextBudget } from "@cybermastery/contracts/ctxpack-capsule"
import { AdmissionError } from "./admission"
import { interactiveContextBudget, renderContextSnapshot } from "./context-renderer"
import { createCtxPackHttp } from "./ctxpack-http"
import type { CtxPackCatalog } from "./ctxpack-catalog"
import type { CtxPackMaterializer } from "./ctxpack-materializer"
import type { CtxPackUsagePort } from "./ctxpack-usage"
import type { CtxPackRecall } from "./ctxpack-recall"
import type { OperatingChatAuthorize, OperatingChatBindingInterface } from "./operating-chat-binding"
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

const CtxPackChanged = EventV2.define({ type: "workspace.ctxpack.changed", schema: {
  workspaceID: Schema.String, ctxPackID: Schema.String, revision: Schema.Int,
  change: Schema.Literals(["created", "metadata-updated", "deleted", "restored", "used", "pinned", "unpinned"]),
} })
const ReferenceIdentity = Schema.fromJsonString(Schema.Struct({
  contextCapsuleID: Schema.String, sourceCtxPackID: Schema.String, label: Schema.String,
}))

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
  /** A trusted host must check its observed block and functionality-instance ownership. */
  readonly operatingChat?: { readonly authorize: OperatingChatAuthorize }
}) {
  if (!input.token.trim()) throw new Error("An explicit authentication token is required")
  if (!input.userID.trim() || !input.workspaceID.trim()) throw new Error("An explicit user and workspace are required")
  if (!input.filename.trim()) throw new Error("An explicit database filename is required")
  if (input.operatingChat && input.policy) throw new Error("Trusted OperatingChat recall requires the selected admission policy")

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
  const ctxpack: { catalog?: CtxPackCatalog; materializer?: CtxPackMaterializer; usage?: CtxPackUsagePort } = {}
  const operatingChat: { binding?: OperatingChatBindingInterface; recall?: CtxPackRecall } = {}
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
    freeze: (request) => Effect.gen(function* () {
      const profile = request.mode === "v2-enriched" && operatingChat.binding
        ? yield* operatingChat.binding.resolve(request.sessionID).pipe(
          Effect.mapError(() => new AdmissionError({ code: "unauthorized" }))) : undefined
      if (profile && profile.workspaceID !== request.actor.workspaceID)
        return yield* new AdmissionError({ code: "unauthorized" })
      if (!profile && request.references.length === 0) return { apiContent: request.text, rendererVersion: 1 }
      const materializer = ctxpack.materializer
      if (!materializer) return yield* new AdmissionError({ code: "missing-private-context" })
      const identities = request.references.length === 0 ? [] : yield* Effect.try({
        try: () => request.references.map((reference) => ({
          ...Schema.decodeUnknownSync(ReferenceIdentity, { onExcessProperty: "error" })(reference.id),
          contentHash: reference.contentHash,
        })),
        catch: () => new AdmissionError({ code: "invalid-snapshot" }),
      })
      const snapshot = identities.length === 0 ? undefined : yield* materializer.snapshotForSessionInput({
        actor: request.actor,
        targetInstanceID: `chat-instance:${request.sessionID}`,
        targetFunctionalityID: "builtin:chat",
        attachments: identities.map((item) => ({
          contextCapsuleID: item.contextCapsuleID, label: item.label, contentHash: item.contentHash,
          source: { kind: "ctxpack", ctxPackID: item.sourceCtxPackID },
        })),
        budget: DefaultInteractiveContextBudget,
      }).pipe(Effect.mapError(() => new AdmissionError({ code: "missing-private-context" })))
      const explicit = snapshot?.attachments.map((item) => ({
        selection: "explicit" as const, contextCapsuleID: item.contextCapsuleID, sourceCtxPackID: item.sourceCtxPackID,
        label: item.label, ...(item.tags?.length ? { tags: item.tags } : {}), contentHash: item.contentHash,
        fragments: item.fragments.map((fragment) => ({ contentHash: fragment.contentHash, text: fragment.text })),
      })) ?? []
      const recalled = profile && operatingChat.recall ? yield* operatingChat.recall.select({
        actor: request.actor,
        target: { workspaceID: profile.workspaceID, instanceID: profile.functionalityInstanceID,
          functionalityID: profile.functionalityID },
        promptText: request.text, explicit, budget: interactiveContextBudget,
      }) : undefined
      const rendered = yield* Effect.try({
        try: () => renderContextSnapshot({
          promptText: request.text, createdAt: snapshot?.createdAt ?? Date.now(),
          recall: profile ? { policy: "operating-chat-v1", status: recalled?.status ?? "unavailable" }
            : { policy: "disabled", status: "disabled" }, budget: interactiveContextBudget,
          attachments: [...explicit, ...(recalled?.attachments ?? [])],
        }),
        catch: () => new AdmissionError({ code: "invalid-snapshot" }),
      })
      return { apiContent: rendered.apiContent, rendererVersion: rendered.rendererVersion,
        context: rendered.snapshot, operatingChat: profile }
    }),
    onAdmitted: ({ request, admitted, snapshot }) => Effect.gen(function* () {
      if (snapshot.operatingChat) {
        // The projector/commit transaction must not accept an obsolete binding
        // or revoked host ownership after preparation/recall.
        const profile = snapshot.operatingChat
        if (!operatingChat.binding || !input.operatingChat) return yield* new AdmissionError({ code: "unauthorized" })
        yield* operatingChat.binding.revalidate(request.sessionID, profile).pipe(
          Effect.mapError(() => new AdmissionError({ code: "unauthorized" })))
        yield* input.operatingChat.authorize({ actor: request.actor, action: "read", sessionID: request.sessionID,
          descriptor: { workspaceID: profile.workspaceID, workspaceName: profile.workspaceName,
            blockID: profile.blockID, functionalityID: profile.functionalityID,
            functionalityInstanceID: profile.functionalityInstanceID, directory: profile.directory,
            operatingAgent: profile.operatingAgent },
        }).pipe(Effect.mapError(() => new AdmissionError({ code: "unauthorized" })))
      }
      if (!snapshot.context) return
      const usage = ctxpack.usage
      if (!usage) return yield* new AdmissionError({ code: "missing-private-context" })
      const packIDs = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Schema.Struct({ attachments: Schema.Array(Schema.Struct({
          sourceCtxPackID: Schema.String,
        })) }))(snapshot.context).attachments.map((attachment) => attachment.sourceCtxPackID),
        catch: () => new AdmissionError({ code: "invalid-snapshot" }),
      })
      if (packIDs.length === 0) return
      yield* usage.recordAdmittedUse({
        userID: request.actor.userID, workspaceID: request.actor.workspaceID,
        ctxPackIDs: packIDs, sessionInputID: admitted.id, admittedAt: DateTime.toEpochMillis(admitted.timeCreated),
      }).pipe(Effect.mapError(() => new AdmissionError({ code: "missing-private-context" })))
    }),
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
    const events = await native.runtime.runPromise(EventV2.Service)
    const { makeCtxPackCatalog } = await import("./ctxpack-catalog")
    const { makeCtxPackCapsuleStore } = await import("./ctxpack-capsule")
    const { makeCtxPackMaterializer } = await import("./ctxpack-materializer")
    const { makeCtxPackUsage } = await import("./ctxpack-usage")
    const authorizeCtxPack = (request: { readonly actor: CtxPackActor; readonly operation: string;
      readonly target?: { readonly workspaceID: string; readonly instanceID: string; readonly functionalityID: string } }): Effect.Effect<void, CtxPackError> => Effect.gen(function* () {
      const denied = () => ({ _tag: "CtxPackPermissionDenied", operation: request.operation } satisfies CtxPackError)
      if (!matchesActor(request.actor) || (request.target && request.target.workspaceID !== actor.workspaceID))
        return yield* Effect.fail(denied())
      if (request.target?.functionalityID === "builtin:operating-chat-session") {
        if (!operatingChat.binding || !input.operatingChat) return yield* Effect.fail(denied())
        const row = yield* database.db.get<{ session_id: string }>(sql`
          SELECT session_id FROM cm_operating_chat_binding WHERE workspace_id = ${request.actor.workspaceID}
            AND instance_id = ${request.target.instanceID} AND deleted_at IS NULL`).pipe(
          Effect.mapError(() => denied()))
        if (!row) return yield* Effect.fail(denied())
        const profile = yield* operatingChat.binding.resolve(SessionSchema.ID.make(row.session_id)).pipe(
          Effect.mapError(() => denied()))
        if (!profile || profile.functionalityInstanceID !== request.target.instanceID ||
          profile.workspaceID !== request.actor.workspaceID) return yield* Effect.fail(denied())
        yield* input.operatingChat.authorize({ actor: request.actor, action: "read",
          sessionID: SessionSchema.ID.make(row.session_id),
          descriptor: { workspaceID: profile.workspaceID, workspaceName: profile.workspaceName,
            blockID: profile.blockID, functionalityID: profile.functionalityID,
            functionalityInstanceID: profile.functionalityInstanceID, directory: profile.directory,
            operatingAgent: profile.operatingAgent },
        }).pipe(Effect.mapError(() => denied()))
      } else if (request.target && (request.target.functionalityID !== "builtin:chat" ||
        !request.target.instanceID.startsWith("chat-instance:"))) return yield* Effect.fail(denied())
      const workspace = yield* database.db.get<{ owner_id: string }>(sql`
        SELECT owner_id FROM cm_workspace WHERE id = ${actor.workspaceID}`).pipe(Effect.orDie)
      if (workspace?.owner_id !== request.actor.userID)
        return yield* Effect.fail({ _tag: "CtxPackPermissionDenied", operation: request.operation } satisfies CtxPackError)
    })
    const catalog = await native.runtime.runPromise(makeCtxPackCatalog({
      authorize: (request: CtxPackAccess) => authorizeCtxPack(request),
      publish: (hint) => events.publish(CtxPackChanged, hint.properties).pipe(Effect.asVoid),
    }))
    ctxpack.catalog = catalog
    const capsules = await native.runtime.runPromise(makeCtxPackCapsuleStore())
    const materializer = makeCtxPackMaterializer({ catalog, capsules, authorize: authorizeCtxPack })
    ctxpack.materializer = materializer
    const usage = await native.runtime.runPromise(makeCtxPackUsage({
      catalog, authorize: authorizeCtxPack,
      publish: (hint) => events.publish(CtxPackChanged, hint.properties).pipe(Effect.asVoid),
    }))
    ctxpack.usage = usage
    if (input.operatingChat) {
      const hostAuthorize = input.operatingChat.authorize
      const { makeOperatingChatBinding } = await import("./operating-chat-binding")
      const { makeCtxPackRecall } = await import("./ctxpack-recall")
      operatingChat.binding = await native.runtime.runPromise(makeOperatingChatBinding({
        authorize: (request) => Effect.gen(function* () {
          if (!matchesActor(request.actor)) return yield* Effect.fail({
            _tag: "OperatingChatBinding.Error", code: "unauthorized",
          } satisfies OperatingChatBindingError)
          const workspace = yield* database.db.get<{ owner_id: string }>(sql`
            SELECT owner_id FROM cm_workspace WHERE id = ${actor.workspaceID}`).pipe(Effect.orDie)
          if (workspace?.owner_id !== request.actor.userID) return yield* Effect.fail({
            _tag: "OperatingChatBinding.Error", code: "unauthorized",
          } satisfies OperatingChatBindingError)
          yield* hostAuthorize(request)
        }),
      }))
      operatingChat.recall = await native.runtime.runPromise(makeCtxPackRecall({ catalog,
        authorize: (request) => authorizeCtxPack(request),
      }))
    }
    const catalogHttp = createCtxPackHttp({
      catalog, materializer,
      authenticate: async (request) => request.headers.has("Authorization") ? authenticate(request) : undefined,
      run: (effect) => native.runtime.runPromise(effect),
    })
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
      ctxpack: { catalog, materializer, usage },
      operatingChat: operatingChat.binding,
      async fetch(request: Request): Promise<Response> {
        if (owned.disposal) throw new Error("Application adapter has been disposed")
        const privateResponse = await transfer.fetch(request)
        if (privateResponse !== undefined) return privateResponse
        const catalogResponse = await catalogHttp.fetch(request)
        if (catalogResponse !== undefined) return catalogResponse
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
