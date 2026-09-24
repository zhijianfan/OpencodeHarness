# Worker 1 of 3 — authorized native Session access

Implement from this brief and the attached source snapshots only. Workspace: D:\OpencodeHarness. Model: Astra High. Do not explore, run commands/tests, delegate, or change Git state. Apply patches only to these new owned files:

- modular/packages/adapters-opencode/src/session-access.ts
- modular/packages/adapters-opencode/test/session-access.test.ts

No other files. Other workers implement independent legacy codecs; do not import them yet. Preserve the existing runtime graph, native API and private facade. The master owns HTTP mounting, package exports and generated client changes.

## Goal

Provide one actor-aware adapter surface usable by HTTP and embedded entrypoints, delegating native Session operations through the already-created selected graph. No new runtime, database, Session projection, execution coordinator or model loop. Every public method requires its explicit authenticated actor and checks policy before data is returned or mutations occur.

## Public contract

```ts
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Location } from "@opencode-ai/core/location"
import { Effect, Schema } from "effect"

export type SessionActor = { readonly userID: string; readonly workspaceID: string }
export type ContextAttachment = {
  readonly contextCapsuleID: string; readonly label: string; readonly contentHash: string;
  readonly source: { readonly kind: "ctxpack"; readonly ctxPackID: string };
}
export type SessionAction = "create" | "read" | "prompt" | "resume" | "interrupt" | "configure" | "revert"
export class SessionAccessError extends Schema.TaggedErrorClass<SessionAccessError>()("CyberMastery.SessionAccess", {
  code: Schema.Literals(["unauthorized", "forbidden", "invalid-attachments"]),
}) {}
export type SessionAccessPolicy = {
  readonly authorize: (input: {
    readonly actor: SessionActor; readonly action: SessionAction;
    readonly location: Location.Ref; readonly session?: SessionSchema.Info;
  }) => Effect.Effect<void, SessionAccessError>;
}
// Effect factory requiring existing SessionV2.Service; capture it once.
export const makeSessionAccess = /* Effect.fn or equivalent */ (policy: SessionAccessPolicy) => ...
```

Return named methods:
- `create(actor, input: Parameters<SessionV2.Interface["create"]>[0])`
- `get(actor, sessionID)`, `context(actor, sessionID)`, `messages(actor, nativeInput)`, `message(actor, nativeInput)`, `history(actor, nativeInput)`
- `list(actor, nativeInput = {})`, `active(actor)`
- `prompt(actor, input: Parameters<SessionV2.Interface["prompt"]>[0] & {readonly contextAttachments?: readonly ContextAttachment[]})`
- `resume(actor, sessionID)`, `interrupt(actor, sessionID)`
- `switchAgent(actor, nativeInput)`, `switchModel(actor, nativeInput)`
- `revertStage(actor, nativeInput)`, `revertClear(actor, sessionID)`, `revertCommit(actor, sessionID)`
- `events(actor, nativeInput)` returns the native public event Stream after authorization, rechecking placement policy for each emitted event.

Return native typed values/errors, not JSON strings; the transport will encode with native schemas. Keep native typed NotFound/PromptConflict/model errors and interruption intact. Access errors contain codes only, never prompt/private content.

## Authorization semantics

Reject empty/whitespace userID or workspaceID before delegating. Do not treat user-supplied actor values as authentication; the caller supplies an authenticated actor. Policy is mandatory and no allow-all fallback may be installed.

For existing Sessions: resolve native info, then authorize with its **recorded** location/session. For create: authorize requested location first; if ID exists, authorize its recorded placement BEFORE calling create/adopt. Native create with reused ID adopts existing placement; never authorize only the caller's requested placement and leak a Session from another workspace. After create/adopt recheck actual info before returning.

For list/active: filter every returned native Session by `read` policy; only `SessionAccessError` with `code:"forbidden"` may hide a candidate. Other errors fail the call. Empty actor must fail even when no results exist. Do not infer access from Session ID or automatically grant cross-workspace access. The explicit policy receives workspace/directory and decides membership. Do not hard-code a new product tenancy model.

`message` must authorize its parent Session before native lookup. `events` must authorize before subscription and recheck current recorded placement for emitted public events. Do not expose native objects/services on the returned facade.

## Prompt and attachment semantics

Validate contextAttachments synchronously: array, at most 8, unique nonempty contextCapsuleID, nonempty label/contentHash/source.ctxPackID, source.kind exactly ctxpack. Reject unknown fields rather than silently removing identity input. No private fragment bodies are accepted from callers.

Translate each attachment to the current PrivatePromptContext reference with this exact identity:

```ts
{ id: JSON.stringify({ contextCapsuleID: a.contextCapsuleID, sourceCtxPackID: a.source.ctxPackID, label: a.label }), contentHash: a.contentHash }
```

Pass `{actor,references}` via `Effect.provideService(PrivatePromptContext, ...)` around native `session.prompt`, forwarding the native prompt, ID, delivery and resume unchanged. Native MIME normalization and exact retry remain delegated. Do not recall/materialize anything here: the installed policy.freeze handles fresh admission, and the current private facade reuses stored context before freeze on exact retry. Changed label/source/hash/order must conflict through the private identity rather than be ignored. Strip only the extra contextAttachments field before delegating the native input.

## Source and test context

Attachments provide the complete native Session API/implementation, the private Session facade, and an existing file-backed native admission test fixture. These are input context, not permission to edit/read other files. You may adapt that fixture inside your new test file. It uses real Database, Event, SessionProjector and native Session constructor, with only execution and unused collaborators replaced; do not replace Session itself with a mock. For create/adopt, use the real `createSessionRuntime` fixture if needed; its exact implementation and existing integration test are also attached.

Core imports use their exported namespaces. Native Workspace IDs are branded: `WorkspaceV2.ID.make("wrk_...")`; Location directories use `AbsolutePath.make(directory)`. Session and message IDs use `.ID.make("ses_...")` and `.ID.make("msg_...")`. Do not use string-only Location workspace fields.

The selected runtime is already initialized with private extension tables. `createSessionRuntime({filename,policy,replacements?})` returns ManagedRuntime; tests use `runtime.runPromise(Effect.gen(...))` and always dispose in finally or async disposal. `databaseCleanup()` (import `../../../test-utils/cleanup`) must be called once at test-file registration time; register each temporary directory and let afterAll unlink Windows SQLite files.

Current PrivatePromptContext and policy:
```ts
import { PrivatePromptContext } from "./session-facade"
// Context.Service<{actor:{userID:string,workspaceID:string}, references:readonly {id:string,contentHash:string}[]}>
// createSessionRuntime.policy:
// managed(session) => Effect<boolean>
// authorize(admissionRequest) => Effect<void, AdmissionError>
// freeze(admissionRequest) => Effect<{apiContent:string,rendererVersion:number}, AdmissionError>
```

Effect v4: `Effect.gen(function*(){ const service = yield* Foo.Service; ... })`, `Effect.catchTag`, `Effect.catchIf`, `Effect.fail`, `Effect.serviceOption`, `Stream.unwrap`, `Stream.mapEffect`, `Effect.scoped`, `Effect.forkScoped`, `Fiber.interrupt`. Use supplied source patterns; no any, new unchecked casts, star/aliased imports or globalThis mocks.

## Tests to author

Actual native fixture cases: unauthorized empty actor; cross-workspace read/prompt/resume/configure/revert denial with no side effects; denied adoption of an existing ID at another placement; list/active filtering; prompt MIME normalization, queue and resume:false; exact attachment retry freeze count stays one; changing source/label/hash conflicts; invalid/duplicate/>8 attachments fail before freeze; private text absent from native public messages/history. At least one read method and one mutation should prove the recorded placement is used.

No test execution by worker. Master will run `bun typecheck` and `bun test test/session-access.test.ts --timeout 30000` from the adapter package after all workers return. Report files, coverage implemented, and precise uncertainties.
