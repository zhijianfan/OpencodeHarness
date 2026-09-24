# Worker 2 of 2 — native Session runtime isolation

Implement this task in `D:\OpencodeHarness` on Astra High. All source context is this brief plus the two attached owned-file snapshots from checkpoint d8fdf95. Do not explore/read/search, run commands/tests, delegate, or change Git state. Use apply_patch only. Another worker owns runner implementation and its tests; do not inspect or modify them.

## Exclusive owned files

- `modular/packages/adapters-opencode/src/session-runtime.ts`
- `modular/packages/adapters-opencode/test/session-runtime.test.ts`

Preserve exported signatures and mandatory replacement keys, especially `[SessionStore.node, SessionStore.node]`. Prefer focused runtime tests over gratuitous production changes; make minimal production fixes only if the supplied facts prove they are necessary. Do not add placeholders or change production gates. No aliases/star imports, any, non-null assertions or new unchecked casts.

## Acceptance

1. Exercise **actual native SessionV2.create** and adoption, rather than relying solely on SQL-seeded Session records. Create/adopt the same ID and prove existing placement/identity are retained; prompt/resume still use the private snapshot and clean public transcript.
2. Exercise two real Locations within one createSessionRuntime: distinct directories/workspace IDs, separate Location runner identities, **identical root Database/Event/SessionStore** objects. Private input for one Session must not appear in another's provider request or public transcript. Policies/context are fixture-scoped and explicit.
3. Prove two different Sessions can have simultaneous blocked provider attempts through the actual native SessionExecution coordinator and Location map. Two concurrent resumes of the same Session join one attempt. Interrupting A releases A's joined resumes and leaves B active; releasing B completes it normally. Provider-call counts and finalizers must show no duplicate or leaked work.
4. Prove queued/admit-only input accepted while a Session is active remains durable after interruption and can execute on a later explicit resume without re-freezing private snapshots. Do not invent automatic provider retry after a crash.
5. Keep all work on disposable file-backed databases and directories; dispose runtimes on failures, and keep per-file databaseCleanup. Avoid sleeps/polling timeouts as proof of concurrency; synchronize using Deferreds and scoped fibers. A safety Effect timeout is fine to fail a deadlock.

This wave is core runtime coverage. Do not describe these tests as task_batch/SubagentRunner child ownership or completed HTTP/legacy integration. SessionV2.create has NO parentID input at this pin; do not invent one.

## Attached baseline source

session-runtime.ts and session-runtime.test.ts are supplied in full. The current test uses the actual native Location map and coordinator with deterministic LLM client, Config, Model, Snapshot, SkillGuidance and ReferenceGuidance layers. That is the approved fixture. It seeds one Session using SQL and verifies private request/public history and shared identities. Retain this proof, preferably factor a reusable scoped fixture within the same test file for the expanded matrix.

The fixture LLM service accepts canonical LLMRequest instances via the existing exact-pin bridge cast. You may retain that cast; don't add speculative casts. A factory can accept an explicit response function returning `Stream.Stream<LLMEvent, LLMError>` and capture request/constructor arrays. Dependencies have already been installed; no package edits are needed.

## Frozen public contracts

```ts
import { SessionV2 } from "@opencode-ai/core/session"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { PrivatePromptContext } from "../src/session-facade"
import { createSessionRuntime } from "../src/session-runtime"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"

createSessionRuntime({
  filename: string,
  policy: {
    managed: (session: SessionSchema.Info) => Effect.Effect<boolean>,
    authorize: (request: AdmissionRequest) => Effect.Effect<void, AdmissionError>,
    freeze: (request: AdmissionRequest) => Effect.Effect<{ apiContent: string; rendererVersion: number }, AdmissionError>,
  },
  replacements?: LayerNode.Replacements,
  onRunnerConstruct?: (identity: RunnerIdentity) => void,
}) // returns ManagedRuntime with native SessionV2, Database, EventV2, SessionStore, SessionExecution etc.

type AdmissionRequest = {
  sessionID: Session.ID; messageID: SessionMessage.ID;
  actor: { userID: string; workspaceID: string }; text: string;
  delivery: "queue" | "steer"; resume?: boolean;
  references: readonly { id: string; contentHash: string }[];
}
// Existing private facade checks managed(), requires PrivatePromptContext,
// authorizes, reconciles immutable identity before freeze, and defers wake until commit.
// It delegates all non-prompt methods to native SessionV2 implementation.

// Get these from native services in a named-variable generator:
session.create({ id?: Session.ID, agent?: AgentV2.ID, model?: ModelV2.Ref,
  location: { directory: AbsolutePath; workspaceID?: string } })
// Effect<SessionSchema.Info>, recorded ID adopts existing Session before resolving new placement.
session.get(id) // Info; Info.id, Info.location.directory, Info.location.workspaceID
session.prompt({ id?: SessionMessage.ID, sessionID, prompt: {text: string, files?: ...},
  delivery?: "queue" | "steer", resume?: boolean })
// Effect<SessionInput.Admitted, SessionV2.NotFoundError | SessionV2.PromptConflictError>
session.resume(id) // Effect<void, SessionV2.NotFoundError | SessionRunner.RunError>
session.interrupt(id) // Effect<void>
session.active // Effect<ReadonlySet<Session.ID>>
session.messages({sessionID, order?: "asc" | "desc"})
session.context(id)
session.history({sessionID, after?: number, limit:number}) // {events,hasMore}

type RunnerIdentity = {
  database: Effect.Success<typeof Database.Service>;
  events: EventV2.Interface;
  store: Effect.Success<typeof SessionStore.Service>;
  location: Effect.Success<typeof Location.Service>;
}
// location has directory and workspaceID. Two Location services must differ;
// root and both runners' database/events/store must be object-identical.
```

`AdmissionError` comes from `../src/admission` and is constructed with `{code:"unauthorized"}` if you need a rejected fixture policy. Do not introduce new production authorization semantics in this test wave. Use freeze counters and return content including session ID/workspace, not a global constant, to prove isolation. Provide PrivatePromptContext per call with `.pipe(Effect.provideService(PrivatePromptContext, { actor, references: [] }))`; do not use globals.

Native create resolves ProjectV2 for an existing directory, inserts its project row if absent and publishes the native Session Created event. It does not require a preexisting workspace row; workspace identifiers must start with `wrk`. Use real temporary directories (mkdtemp under tmpdir), `AbsolutePath.make(directory)` and explicit `wrk_...` IDs. One temp root may own nested dirs made with node:fs/promises mkdir; register root with databaseCleanup. No real project or user database.

## Native execution semantics

- One process-global coordinator indexes by Session ID. It discovers placement from SessionStore when a drain begins, then provides the Location service map's layer to the owned runner.
- `resume` starts a forced drain or joins an active one. `wake` coalesces advisory work; `resume:false` admission does not wake. Different IDs run concurrently.
- `interrupt(id)` cancels that active owner, waits for cleanup, clears its pendingWake; idle/missing interruption is a no-op.
- `active` is a snapshot of currently owned IDs.
- Waiting `resume` is not the execution owner; interrupt through `session.interrupt`, and ensure cleanup if a test assertion fails before releasing provider barriers.
- Root runtime bootstrap installs extension schema before ManagedRuntime exposure. Canonical SessionStore self-replacement is necessary for native hoisting, and must stay.

## Verified Effect v4 / test APIs

```ts
const entered = Deferred.makeUnsafe<void>()
const release = Deferred.makeUnsafe<void>()
const response = Stream.unwrap(
  Deferred.succeed(entered, undefined).pipe(
    Effect.andThen(Deferred.await(release)),
    Effect.as(Stream.fromIterable(events)),
  ),
)
// Use Stream.ensuring(stream, finalizer) or Effect.ensuring for cleanup signals.

await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
  const session = yield* SessionV2.Service
  const first = yield* session.resume(id).pipe(Effect.forkScoped)
  yield* Deferred.await(entered)
  // startImmediately matters: otherwise a not-yet-started second call can resume
  // AFTER interruption instead of joining the intended active drain.
  const joined = yield* session.resume(id).pipe(Effect.forkScoped({startImmediately:true}))
  yield* session.interrupt(id)
  const exit = yield* Fiber.await(first)
  if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  yield* Fiber.await(joined)
})))

Effect.exit(effect)
Effect.timeout(effect, "10 seconds")
Effect.ensuring(effect, finalizer)
Effect.onExit(effect, (exit) => ...)
Deferred.await(deferred)
Deferred.succeed(deferred, undefined)
Deferred.poll(deferred) // Effect<Option<Effect<A,E>>>
Fiber.join(fiber)
Fiber.await(fiber)
Effect.all(effects, {concurrency:"unbounded"})
new Headers(request.http?.headers).get("X-Session-Id")
```

The current fixture source shows the exact native mock layer setup and completed LLMEvent sequence. No need to change native providers or add libraries. Keep schema brands via `.make`, avoid non-null assertion shortcuts when mapping request headers to a known gate.

## Validation / report

No worker test execution. After both workers return, master runs from adapters-opencode: `bun typecheck` and `bun test test/session-runtime.test.ts --timeout 30000`, then full proof verification.

Report changed files, coverage authored, production changes if any, and uncertainty. Never say tests passed unless the master later reports it. Leave all unrelated files alone.

## Post-run contract correction

Integration found that the abbreviated `Location.Ref` contract above should declare `workspaceID?: WorkspaceV2.ID`, not `string`. The master corrected the fixture to use `WorkspaceV2.ID.make(...)` and validated the complete graph. Preserve the original brief as provenance; future briefs must retain this brand explicitly.
