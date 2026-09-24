import path from "node:path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Cause, Effect, Schema } from "effect"
import { EventBoundary } from "./event-boundary"
import { PrivatePromptContext } from "./session-facade"
import { PendingSessionExecution } from "./session-execution"
import { recordV2SessionCreated, requireV2Session } from "./session-classification"

export class ChildRunError extends Schema.TaggedErrorClass<ChildRunError>()("CyberMastery.ChildRun", {
  message: Schema.String,
  sessionID: Schema.optional(SessionSchema.ID),
  outcome: Schema.optional(Schema.Literals(["error", "interrupted"])),
}) {}

export type ChildRunInput = {
  readonly parentSessionID: SessionSchema.ID
  readonly childSessionID?: SessionSchema.ID
  readonly promptMessageID?: SessionMessage.ID
  readonly agent: AgentV2.ID
  readonly model: ModelV2.Ref
  readonly title: string
  readonly prompt: string
  readonly actor: { readonly userID: string; readonly workspaceID: string }
}

export type ChildRunner = {
  readonly run: (
    input: ChildRunInput,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly text: string }, ChildRunError>
}

export type ChildRunnerOptions = {
  readonly location: Location.Ref
  readonly authorize: (request: {
    readonly actor: ChildRunInput["actor"]
    readonly parent: SessionSchema.Info
  }) => Effect.Effect<void, ChildRunError>
}

/**
 * Owned child composition: one EventBoundary transaction creates and classifies
 * the native child and admits its prompt, then shared pending execution drains
 * the work. Authorization is rechecked under the boundary so a denied or
 * conflicting call cannot leak a published empty child.
 */
export function makeChildRunner(options: ChildRunnerOptions): Effect.Effect<
  ChildRunner,
  never,
  | Database.Service
  | EventV2.Service
  | ProjectV2.Service
  | SessionStore.Service
  | SessionV2.Service
  | PendingSessionExecution
  | EventBoundary
> {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const session = yield* SessionV2.Service
    const pending = yield* PendingSessionExecution
    const boundary = yield* EventBoundary

    const fail = (message: string, sessionID?: SessionSchema.ID, outcome?: "error" | "interrupted") =>
      Effect.fail(
        new ChildRunError({
          message,
          ...(sessionID === undefined ? {} : { sessionID }),
          ...(outcome === undefined ? {} : { outcome }),
        }),
      )

    const requireClassified = (sessionID: SessionSchema.ID) =>
      requireV2Session(sessionID).pipe(Effect.provideService(Database.Service, database))

    const createChild = (parent: SessionSchema.Info, childID: SessionSchema.ID, input: ChildRunInput) =>
      Effect.gen(function* () {
        const project = yield* projects.resolve(options.location.directory)
        yield* database.db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: childID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: options.location.directory,
          path: path.relative(project.directory, options.location.directory).replaceAll("\\", "/"),
          workspaceID: options.location.workspaceID ? WorkspaceV2.ID.make(options.location.workspaceID) : undefined,
          parentID: parent.id,
          title: input.title,
          agent: input.agent,
          model: {
            id: ModelV2.ID.make(input.model.id),
            providerID: input.model.providerID,
            variant: input.model.variant,
          },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        yield* events.publish(SessionV1.Event.Created, { sessionID: childID, info }, { location: options.location })
        const created = yield* store.get(childID)
        if (!created) return yield* Effect.die(`Created child Session projection was not found: ${childID}`)
        yield* recordV2SessionCreated(childID).pipe(Effect.provideService(Database.Service, database))
        return created
      })

    const run: ChildRunner["run"] = (input) =>
      Effect.gen(function* () {
        if (!input.actor.userID.trim() || !input.actor.workspaceID.trim()) return yield* fail("Child run requires a nonempty actor")
        const childID = input.childSessionID ?? SessionSchema.ID.create()
        const promptMessageID = input.promptMessageID ?? SessionMessage.ID.create()

        const initialParent = yield* store.get(input.parentSessionID)
        if (!initialParent) return yield* fail(`Parent session not found: ${input.parentSessionID}`, input.parentSessionID)
        if (!requirePlacement(initialParent, options.location)) {
          return yield* fail(
            `Parent session is not available in this location: ${input.parentSessionID}`,
            input.parentSessionID,
          )
        }
        yield* requireClassified(initialParent.id)
        yield* options.authorize({ actor: input.actor, parent: initialParent })

        const initialChild = yield* store.get(childID)
        if (initialChild) {
          yield* requireClassified(initialChild.id)
          if (!matchesConfiguration(initialChild, initialParent, input)) {
            return yield* fail("Worker child configuration conflicts with retry", childID)
          }
        }

        yield* boundary.transaction(
          Effect.gen(function* () {
            const parent = yield* store.get(input.parentSessionID)
            if (!parent) return yield* fail(`Parent session not found: ${input.parentSessionID}`, input.parentSessionID)
            if (!requirePlacement(parent, options.location)) {
              return yield* fail(
                `Parent session is not available in this location: ${input.parentSessionID}`,
                input.parentSessionID,
              )
            }
            yield* requireClassified(parent.id)
            yield* options.authorize({ actor: input.actor, parent })
            const existing = yield* store.get(childID)
            const child = existing ?? (yield* createChild(parent, childID, input))
            yield* requireClassified(child.id)
            if (!matchesConfiguration(child, parent, input)) {
              return yield* fail("Worker child configuration conflicts with retry", childID)
            }
            yield* session.prompt({
              id: promptMessageID,
              sessionID: childID,
              prompt: { text: input.prompt },
              resume: false,
            }).pipe(Effect.provideService(PrivatePromptContext, { actor: input.actor, references: [] }))
          }),
        )

        // Shared pending execution owns the drain and its cleanup. Only a pending
        // caller that started an idle owner assumes cancellation responsibility;
        // joining an existing run never transfers it, so no second map is added.
        yield* Effect.uninterruptibleMask((restore) => restore(pending.run(childID)).pipe(
          Effect.mapError(
            (error) => new ChildRunError({ message: errorMessage(error), sessionID: childID, outcome: "error" }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? fail(`Worker interrupted: ${childID}`, childID, "interrupted")
              : Effect.failCause(cause),
          ),
        ))

        const messages = yield* store.context(childID)
        const assistant = messages.findLast((message) => message.type === "assistant")
        if (!assistant) return yield* fail(`Worker did not return an assistant message: ${childID}`, childID, "error")
        if (assistant.error) {
          return yield* fail(`Worker failed: ${assistant.error.message ?? "unknown error"}`, childID, "error")
        }
        const text = assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        if (!text) return yield* fail(`Worker did not return text: ${childID}`, childID, "error")
        return { sessionID: childID, text }
      }).pipe(
        Effect.catchDefect(() => fail("Worker admission or execution failed", input.childSessionID, "error")),
        Effect.mapError((error) =>
          error instanceof ChildRunError ? error : new ChildRunError({ message: errorMessage(error), sessionID: input.childSessionID, outcome: "error" }),
        ),
      )

    return { run }
  })
}

function requirePlacement(parent: SessionSchema.Info, location: Location.Ref) {
  return parent.location.directory === location.directory && parent.location.workspaceID === location.workspaceID
}

function matchesConfiguration(child: SessionSchema.Info, parent: SessionSchema.Info, input: ChildRunInput) {
  return (
    child.parentID === parent.id &&
    child.location.directory === parent.location.directory &&
    child.location.workspaceID === parent.location.workspaceID &&
    child.agent === input.agent &&
    child.model?.providerID === input.model.providerID &&
    child.model.id === input.model.id &&
    child.model.variant === (input.model.variant ?? ModelV2.VariantID.make("default")) &&
    child.title === input.title
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
