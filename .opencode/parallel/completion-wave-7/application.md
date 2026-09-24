# Worker 1 of 2 — integrated application composition

Implement only these files in D:\OpencodeHarness:
- modular/packages/adapters-opencode/src/application.ts (new)
- modular/packages/adapters-opencode/test/application.test.ts (new)
- modular/apps/host/src/app.ts (existing, supplied)

Astra High; supplied snapshots are your entire source context. No exploration, commands/tests, Git, delegation or other edits. Master owns package exports, startup CLI and shared code. Do not weaken full-parity startup gating.

## Goal

Connect the existing static-card host to the authorized Session ingress and lower-level native HTTP assembly using exactly one selected graph. No second createLayoutRepository runtime alongside createNativeHttp. Borrow its runtime via bindLayoutRepository. Keep existing layout/static/SSE behavior and auth while exposing native health and Session operations through the same host.

## New factory contract

Export `createApplicationAdapter(input)` from application.ts. Input:
```ts
{
 readonly filename:string; readonly workspaceID:string; readonly userID:string; readonly token:string;
 readonly directory?:string;
 readonly isolated?:boolean;
 readonly policy?: SessionPolicy;
 readonly replacements?: LayerNode.Replacements;
 readonly onRunnerConstruct?: (identity:RunnerIdentity)=>void;
}
```
It returns `{repository, listen, authenticate, fetch, runtime, dispose}`:
- repository/listen are the borrowed layout storage surface, identical to current bindLayoutRepository.
- authenticate(Request) returns `SessionActor | undefined` (sync is fine); actor comes only from configured credentials/user/workspace, never caller JSON/query identity.
- fetch(Request) handles authorized Session routes first, then native fallback. It must authenticate native fallback even for OpenAPI paths; do not expose the raw native handler around the Session overlay.
- runtime is the one native HTTP runtime, for owned composition/tests only.
- dispose is idempotent, closes owned Session ingress streams before native HTTP/runtime disposal, including startup failure cleanup.

Use createNativeHttp({filename,password:token,policy,replacements,onRunnerConstruct}); createSessionHttp borrowing native.runtime; bindLayoutRepository borrowing that same runtime. All three current sources are attached. Do not call native closed route helpers.

## Default placement and policy

- Resolve directory from input.directory or process.cwd(), use AbsolutePath.make.
- If configured workspaceID starts with `wrk`, use WorkspaceV2.ID.make(workspaceID) in native Location.Ref. Historical proof fixtures use arbitrary workspace names; map those to implicit-local placement (no native workspaceID) while retaining the explicit logical workspace in the actor. This is proof compatibility, not a new multi-tenant identity mapping.
- Access policy requires actor.userID/userID and actor.workspaceID/workspaceID to match configured values and Session/requested Location to match the configured native directory/workspace placement. Reused Session IDs cannot adopt another placement.
- If no explicit admission policy is supplied, use the new SessionPolicy factory: `(dependencies:{database,session}) => SessionAdmissionPolicy`. `database` is the actual native Database instance, `session` the native constructor result. Each managed admission rechecks native recorded placement and `cm_workspace.owner_id` against the configured actor, including the in-transaction revalidation. `managed` can be true for this selected application.
- Default freeze may accept an empty reference list and freeze request.text with rendererVersion 1. Nonempty context references MUST fail closed with AdmissionError({code:"missing-private-context"}) until a real context-catalog policy is injected. Do not drop references or fabricate fragment content. Explicit supplied policy is the feature-integration seam and is not exposed to HTTP callers.
- `AdmissionError` comes from ./admission, with codes unauthorized/conflict/missing-private-context/invalid-snapshot and Effect TaggedError behavior. Use captured dependencies so policy Effects require no extra services.

## Authentication

Require nonblank token/user/workspace. Accept configured `Bearer <token>` and native Basic `opencode:<token>` credentials. For native auth_token query compatibility, decode its Base64 credential string and compare against the same configured credential; do not derive the application user from Basic username. Unknown credentials fail.

When passing an already-authenticated request to native fallback, set the native Basic Authorization header on a cloned Request; preserve body/signal and all other headers. Strip auth_token only if necessary to avoid it taking precedence over the authenticated native header. Session routes always go through createSessionHttp, including unknown matching paths; no bypass via a second handler.

## Proof isolation

Native root includes ToolOutputStore.cleanupNode. For `isolated:true`, override native Global.node with Global.layerWith using all nine fields home/data/cache/config/state/tmp/bin/log/repos under a private directory beside the explicit database filename. Create those directories before building. This prevents proof/tests from cleaning the user's real tool-output directory. The native HTTP test fixture shows this exact pattern. Do not alter process.env/globalThis.

Host app.ts should pass isolated:true in proof mode. Retain requireFullParity at the start of full-mode createApplication before database construction. Preserve existing static path containment, capabilities route, workspace query scoping, layout CAS responses and scoped layout SSE. The existing SSE remains layout-compatible; the master will add typed native/extension multiplexing separately.

## Host changes

- Replace createLayoutRepository with createApplicationAdapter; temporarily use a relative adapter source import if the package export is not yet present (master updates export after the barrier).
- Add optional directory to createApplication options.
- Keep layout routes and custom events handled as before, using adapter.authenticate rather than a second inconsistent token check.
- Route native `/api/...` requests not belonging to existing custom layout/events/capabilities, and `/openapi.json`, to adapter.fetch before static serving. No public unauthenticated native fallback.
- Dispose layout subscriptions before adapter.dispose. Do not separately dispose its runtime.

## Tests

Add adapter-level integration tests with real disposable DB and deterministic provider replacements: layout save and Session create/prompt/resume share state/root identities; valid/invalid Bearer and Basic; Session overlay preserves private context and does not fall through to raw native prompt; native health works; supplied policy freezes once on exact retry; default policy rejects unsupported references; repeated disposal. Use isolated:true and databaseCleanup. Supplied native-http/session-runtime tests provide fixtures and exact APIs. Preserve existing host tests (master runs them).

No any, aliases/star imports, non-null assertions or unchecked casts. Report implementation and any remaining gaps, without test-pass claims.

## Retry context addendum

The prior attempt correctly requested missing source context and made no edits. The resumed request now attaches session-access.ts and the cast-free session-http.test.ts fixture in full. Exact additional contract:

```ts
type SessionAccessPolicy = {
  readonly authorize: (input: {
    readonly actor: {readonly userID:string;readonly workspaceID:string};
    readonly action: "create"|"read"|"prompt"|"resume"|"interrupt"|"configure"|"revert";
    readonly location: Location.Ref;
    readonly session?: SessionSchema.Info;
  }) => Effect.Effect<void, SessionAccessError>
}
// SessionAccessError({code:"unauthorized"|"forbidden"|"invalid-attachments"})
// Native LLMClient.Interface:
// readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
```

A cast-free deterministic replacement is `Layer.mock(LLMClient.Service, {stream: (request) => { requests.push(request); return Stream.fromIterable(events) }})`; contextual typing supplies LLMRequest. The supplied session-http fixture also uses a parameterless stream function when only call counts are needed. You need no assertion cast. Implement the task now using these completed contracts; the master still validates only after all workers have returned.
