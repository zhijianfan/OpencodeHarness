# Worker 2 of 3 — actor-aware Session HTTP ingress

Create only `modular/packages/adapters-opencode/src/session-http.ts` and `modular/packages/adapters-opencode/test/session-http.test.ts` in D:\OpencodeHarness. Astra High; no commands/tests/exploration/Git/delegation or other edits. Use the attached source snapshots and this contract.

## API and ownership

```ts
import type { createSessionRuntime } from "./session-runtime"
import type { SessionActor, SessionAccessPolicy } from "./session-access"
import type { Location } from "@opencode-ai/core/location"
export async function createSessionHttp(input: {
  readonly runtime: Pick<ReturnType<typeof createSessionRuntime>, "runPromise" | "runFork">
  readonly policy: SessionAccessPolicy
  readonly defaultLocation: Location.Ref
  readonly authenticate: (request: Request) => Promise<SessionActor | undefined>
}) // => { fetch(request:Request):Promise<Response|undefined>, dispose():Promise<void> }
```

Borrow the selected runtime; create no runtime/database/coordinator. Capture `makeSessionAccess(input.policy)` through runtime once. Return undefined for paths outside `/api/session` and `/api/cybermastery/session`. Handle matching paths yourself (unknown matching paths 404, unsupported method 405); this prevents a later raw native Session handler from bypassing actor policy. Authentication is required before all matching routes, including SSE. User/body/query actor fields never supply identity. Dispose only streams owned by this ingress, not the borrowed runtime.

## Required route behavior

Preserve native v2 wire shapes and codecs. Attached original Protocol/session and native Server/session/message handlers give exact paths, defaults/cursor algorithms/error bodies. Implement:
- GET/POST `/api/session`: list and create; list defaults to limit 50 and preserves previous/next cursor format. Create uses payload location or input.defaultLocation.
- GET `/api/session/active`: `{data: record of id -> {type:"running"}}` after access filtering.
- GET `/api/session/:sessionID`: `{data: encoded native Session.Info}`.
- POST `/api/session/:sessionID/prompt`: payload id/prompt/delivery/resume/contextAttachments; `{data: encoded native SessionInput.Admitted}`. Default steer and resume behavior stays native.
- POST `/api/session/:sessionID/agent` and `/model`, `/interrupt`, revert `/stage`, `/clear`, `/commit`: native status/body shapes and access delegation.
- GET `/api/session/:sessionID/context`, `/history`, `/message`, `/message/:messageID`: native wrappers, finite history limit<=100, message pagination limit<=200/default50, native cursor rules.
- GET `/api/session/:sessionID/event`: clean native durable SSE with exclusive after cursor, abort/disposal cleanup and no private sidecars. Use access.events so placement is rechecked per event. Native SessionEvent.Durable codec encodes payloads before JSON. Do not stringify DateTime/service instances directly.
- POST `/api/cybermastery/session/:sessionID/resume`: owned explicit-resume entrypoint, 204 on completion. This is an extension route, not claimed to exist in upstream Protocol.
- Native `/compact` and `/wait` are currently unavailable at this pin. Authorize the Session then return matching 503 ServiceUnavailableError; do not invent compaction or wait semantics.

`SessionAccess` is attached in full. It forwards native typed values/errors. It also exports `isContextAttachments(value:unknown): value is readonly ContextAttachment[]`; use this for the raw optional attachment value before calling access.prompt. Reject invalid attachments with stable 400 SessionContextAttachmentError and do not accept client fragment bodies. Do not recall/materialize here or change exact retry semantics. The existing private facade uses provided actor/reference context and freezes only new admissions.

For native input schema validation use native Schema exports, not unchecked casts/manual unsafe brands:
`SessionSchema.ID/Info`, `SessionMessage.ID/Message`, `PromptInput.Prompt`, `SessionInput.Delivery/Admitted`, `AgentV2.ID`, `ModelV2.Ref`, `Location.Ref`, `Revert.State`. All are available through official Core/Schema source exports. `Schema.decodeUnknownOption` returns Option; `Schema.encodeSync` produces native JSON with millisecond timestamps. Native schemas may strip their own optional excess fields as normal; attachment identity validation is strict.

Protocol `SessionsCursor.make`/`.parse` and `SessionHistoryQuery`/`SessionsQuery` are exported from @opencode-ai/protocol/groups/session. Message query schema is `SessionMessagesQuery` from @opencode-ai/protocol/groups/message; its cursor shape/encoding is in the attached native MessageHandler. Native Protocol error classes are in @opencode-ai/protocol/errors, attached in full.

Map access unauthorized/forbidden to 401/403, invalid attachments to 400, native NotFound to 404, prompt conflict to 409, malformed JSON/IDs/query/cursors to 400, unavailable operations to 503. Error bodies use `_tag` plus the native fields; private AdmissionError defects must be sanitized to stable attachment errors. Unexpected failures return generic UnknownError, never input/private text or raw provider credentials. Preserve cancellation: request abort must interrupt the request's effect, not start a new drain; active execution is interrupted only by the explicit interrupt operation. A resume waiter disconnect does not own/cancel the Session drain.

SSE must not buffer unboundedly. A bounded queue/ReadableStream highWaterMark or source demand handling is required, with stream finalization on abort/client cancel/dispose. Handshake or first data should follow actual subscription establishment. Do not add a browser connection; this supplies a compatibility endpoint for non-browser consumers and the host's later multiplexer.

## Tests

Use actual createSessionRuntime and SessionAccess with disposable paths, native Database/Event/Session graph, and deterministic model replacements from the attached full-runtime fixture. Native Workspace IDs MUST use WorkspaceV2.ID.make("wrk_..."); paths use AbsolutePath.make.

Exercise Request/Response roundtrips (real ephemeral Bun HTTP server optional): unauthorized/body-spoofed actors, authorized create/get/list and cross-workspace denial, prompt MIME/delivery/resume:false/exact retry/attachment conflict and no private output, malformed payload/cursor IDs and sanitized errors, native messages/history millisecond serialization, explicit resume/interrupt with fake provider, and SSE abort/disposal. Tests should check implementation behavior, not duplicate routing logic. Per-file databaseCleanup and runtime disposal are mandatory. No live credentials/model/site use.

All supplied source files are context only. Master mounts this ingress before native fallback and integrates the one-graph host after all workers return. Report gaps rather than inventing APIs. No any/aliased/star imports, globalThis or new unchecked casts.
