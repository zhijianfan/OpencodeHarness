# Native host composition: bounded source evidence

Source-only audit, 2026-09-23. Paths below are relative to `D:/OpencodeHarness`. **Proven** means directly visible source; **inference** means a composition recommendation, not verified execution. No commands, tests, dependency changes, or native edits. Read calls were denied; evidence came from permitted source searches. File-path search queries initially returned sibling matches; those out-of-scope results were not pursued or used. Package identity/pin immutability was not independently verified.

## 1. Assemble HTTP without the closed graph

**Proven:** `vendor/opencode/packages/server/src/routes.ts:26-37` declares a **non-exported** `applicationServices`. Its **non-exported** `makeRoutes` always calls `AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])`, then provides that graph internally (`:51-62`). `createRoutes(password?: string)`, `createEmbeddedRoutes()`, `routes`, and `webHandler` are exported (`:39-68`), but accept no graph/replacement argument. Providing an external graph around those helpers does not remove this internal construction.

**Yes, lower-level assembly is available.** Exported pieces:

| Import subpath under `@opencode-ai/server/` | Export and source evidence |
| --- | --- |
| `api` | `Api`, `vendor/opencode/packages/server/src/api.ts:5-8` |
| `handlers` | `handlers = Layer.mergeAll(...)`, all 19 groups, `vendor/opencode/packages/server/src/handlers.ts:21-40` |
| `middleware/session-location` | `SessionLocationMiddleware`, `sessionLocationLayer`, `vendor/opencode/packages/server/src/middleware/session-location.ts:15-25` |
| `location` | `LocationMiddleware`, `layer`, `vendor/opencode/packages/server/src/location.ts:11-13,49-60` |
| `middleware/authorization` | `Authorization`, `authorizationLayer`, `vendor/opencode/packages/server/src/middleware/authorization.ts:4,38-58` |
| `middleware/schema-error` | `SchemaErrorMiddleware`, `schemaErrorLayer`, `vendor/opencode/packages/server/src/middleware/schema-error.ts:5,14` |
| `auth` | `ServerAuth`, `Config.configLayer(input: Info)`, `vendor/opencode/packages/server/src/auth.ts:1,15-23` |

`vendor/opencode/packages/server/package.json:8-9` exports `"./*": "./src/*.ts"`; Core and Protocol similarly expose source subpaths (`vendor/opencode/packages/core/package.json:18-23`; `vendor/opencode/packages/protocol/package.json:7-8`). These are exports, not private-file workarounds.

**Recommended owned composition:** reproduce only the small assembly at `routes.ts:54-61`: `HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })`, provide the handler/middleware layers, auth configuration, and **one externally selected service layer**. Transport uses `HttpRouter.toWebHandler` plus `HttpServer.layerServices`, as demonstrated at `routes.ts:67-68`. Do not call the closed helpers alongside it.

The smallest **evidenced production baseline**, not a mathematically minimized graph, is the native root list: `Database.node`, `EventV2.node`, `httpClient`, `ToolOutputStore.cleanupNode`, `SessionV2.node`, `PermissionSaved.node`, `PtyTicket.node`, `Credential.node`, `PtyEnvironment.node`, `LocationServiceMap.node` (`routes.ts:26-37`). Union the owned boundary/bootstrap/store/execution roots and preserve the mandatory replacements from `modular/packages/adapters-opencode/src/session-runtime.ts:28-43`. Use the selected `sessionExecutionNode`, not an additional native-local execution instance. Expose `ApplicationTools.node` in this same root if embedded registration is required.

`createSessionRuntime` currently returns a `ManagedRuntime`, not an exported configurable HTTP layer (`session-runtime.ts:21-44`). An owned composition entrypoint is therefore needed. Keep one build/lifetime/memoization boundary; singleton runtime identity has **not** been tested. `LayerNode.compile` uses a per-compilation node cache (`vendor/opencode/packages/core/src/effect/layer-node.ts:250-270`), so independently constructing more runtimes is not evidence of sharing.

## 2. Location defaults are already included

**Default-runtime conclusion (inference):** it should include the full shipped Location graph, not merely leaves selected by its small roots. Its root includes the original `SessionExecution.node`; the selected execution and facade declare `LocationServiceMap.node` dependencies (`modular/packages/adapters-opencode/src/session-runtime.ts:33-41`; `modular/packages/adapters-opencode/src/session-execution.ts:31-42`; `modular/packages/adapters-opencode/src/session-facade.ts:119-122`).

**Proven:** `AppNodeBuilder.build` detects an unbound Location map and installs `buildLocationServiceMap(replacements)` unless explicitly replaced (`vendor/opencode/packages/core/src/effect/app-node-builder.ts:6-16`). The map uses the **entire** exported `locationServices`. It binds `Location.node` per reference, applies replacements while hoisting globals, compiles fresh Location layers, provides hoisted globals, and sets a 60-minute idle TTL (`vendor/opencode/packages/core/src/location-services.ts:84-110`). **Verification caveat:** detection inspects the original root before replacement; original Session node declarations were outside scope. The production root above explicitly includes `LocationServiceMap.node`, removing that uncertainty.

The default group includes config/policy/agents/commands/catalog/AISDK/integrations; plugins and internal boot; filesystem/search/watcher/project-copy/PTY; skills/references/guidance; system-context registry/builtins; permissions/questions; tool registry/registration/output/image/read-filesystem/builtins; todo/snapshot/model/LLM runner (`location-services.ts:42-79`). Custom `LocationServiceMap` replacements can bypass this default; `createSessionRuntime` does not reserve that node against caller replacement (`session-runtime.ts:28-29`). Thus inclusion describes the default composition, not arbitrary overrides or successful initialization.

Builtin registration is an explicit side-effect root: `BuiltInTools.node` includes apply-patch, bash, edit, glob, grep, question, read, skill, todowrite, webfetch, websearch, write (`vendor/opencode/packages/core/src/tool/builtins.ts:31-48`). The question leaf acquires `Tools.Service`, `QuestionV2.Service`, and `PermissionV2.Service`, registers its tool, and declares the corresponding dependencies (`vendor/opencode/packages/core/src/tool/question.ts:47-54,90-93`). Do not add a second builtin registry. “Complete” means this pin's shipped set: its own TODO explicitly excludes task/LSP/repo/plan/Rune follow-ups (`builtins.ts:18-29`).

`PluginInternal.node` declares its default dependencies (`vendor/opencode/packages/core/src/plugin/internal.ts:132-152`). Boot batches `plugin.add` calls for reference/config, agent, command, skill, models-dev, provider plugins, external/config providers, and variants, then forks scoped with `startImmediately: true` (`:105-123`). Construction is not proof that every plugin has finished loading.

Application-wide tool registration is exported through `ApplicationTools.Service`/`node` (`vendor/opencode/packages/core/src/tool/application-tools.ts:21-28,57`). Location registry materialization combines application entries with scoped local registrations and permission filtering (`vendor/opencode/packages/core/src/tool/registry.ts:85-115`).

## 3. Authentication, placement, private prompt context

**Proven:** native authorization validates a shared Basic credential, accepting `auth_token` query credentials first; no configured password makes it a pass-through. Ticketed PTY connect bypasses this credential check for handler-level ticket validation (`vendor/opencode/packages/server/src/middleware/authorization.ts:29-55`). It supplies **no authenticated user/tenant service**. Protocol's `Authorization` declares only its error (`vendor/opencode/packages/protocol/src/middleware/authorization.ts:4-6`). Do not interpret its username as application ownership.

General Location middleware reads `location[workspace]`/`x-opencode-workspace`, and `location[directory]`/decoded `x-opencode-directory`, falling back to cwd (`vendor/opencode/packages/server/src/location.ts:29-38,49-58`). Session middleware instead decodes route `sessionID`, queries the session's stored directory/workspace, then provides `locations.get(Location.Ref.make(...))` (`vendor/opencode/packages/server/src/middleware/session-location.ts:30-63`). Neither shown middleware performs user ownership authorization. Session creation accepts payload placement or cwd (`vendor/opencode/packages/server/src/handlers/session.ts:67-75`).

**Supported extension boundary:** supply an owned implementation of the exported `Authorization` middleware key that authenticates the application actor and wraps the downstream effect with `Effect.provideService(PrivatePromptContext, { actor, references })`. Alternatively use request-layer provision: native SDK demonstrates `HttpRouter.provideRequest(Layer.succeed(...))` (`vendor/opencode/packages/sdk-next/src/opencode.ts:22-27`). Dynamic extraction/order/body reuse needs verification; do not claim a tested recipe. Keep context request-scoped, never a global actor layer, and retain native placement middleware.

This matches the existing facade: `PrivatePromptContext` holds `Pick<AdmissionRequest, "actor" | "references">`; managed prompts fetch it at invocation, reject missing context/user/workspace, and invoke policy authorization (`modular/packages/adapters-opencode/src/session-facade.ts:21-22,89-99`). Capture and validate fork attachments **before native payload decoding**, translating them into `references` through an owned ingress adapter.

**Exact loss boundary:** native prompt payload declares only `id`, `prompt`, `delivery`, `resume` (`vendor/opencode/packages/protocol/src/groups/session.ts:205-216`). The handler explicitly forwards just those plus route session ID (`vendor/opencode/packages/server/src/handlers/session.ts:139-150`). Therefore top-level `contextAttachments` has no native forwarding path. **Inference:** default Schema.Struct excess-property decoding strips it. Exact decoder behavior and nested `PromptInput.Prompt` fields are **unknown within this bounded audit**: their Effect/Schema implementations were outside scope. Handler omission alone proves it cannot reach the facade as a top-level input field.

## 4. Entrypoints, SSE, necessary owned adapters

CLI exports its default `Runtime.handler`, but `listen` and `bind` are local functions. `bind` invokes closed `createRoutes(password)` and provides another Credential/PermissionSaved graph (`vendor/opencode/packages/cli/src/commands/handlers/serve.ts:15-46`). SDK's source-exported zero-argument `create` builds tools/permissions with a memo map, invokes closed embedded routes using that map, installs request permissions, and returns client plus `tools.register` (`vendor/opencode/packages/sdk-next/src/opencode.ts:10-49`). Neither accepts the selected graph. SDK package exposes only its index, not an `./opencode` subpath (`vendor/opencode/packages/sdk-next/package.json:7-8`); index re-export names are outside this ticket.

No combined static-web/native-API composition export appeared in the bounded Server surface. Current modular host is explicitly proof-oriented: full mode calls `requireFullParity`, static serving is separate, Bearer auth guards `/api/`, and SSE listens to layout storage (`modular/apps/host/src/app.ts:8-23,28-73`). It does not compose native handlers.

Native `EventHandler` captures `EventV2.Service`, obtains `EventV2.allBounded(events, 256)` before readiness, emits `server.connected`, encodes with fixed `OpenCodeEvent`, and merges a 15-second heartbeat (`vendor/opencode/packages/server/src/handlers/event.ts:9-48`). `eventData` is private; no generic multiplex factory is exported. Protocol exports `makeEventGroup(definitions)`, `EventGroup`, `OpenCodeEvent` (`vendor/opencode/packages/protocol/src/groups/event.ts:49-56`) and customizable `makeApi` (`vendor/opencode/packages/protocol/src/api.ts:66-86`), but custom definitions do **not** change the fixed native handler encoder.

**Inventory of necessary ownership:** (1) external graph/HTTP assembly and CLI/embedded/combined-host launch adapters; (2) trusted actor plus attachment ingress middleware; (3) an extension-aware SSE handler/encoder if layout and native events must share one stream. For (3), compose the individually exported handler groups instead of the fixed aggregate containing `EventHandler`; preserve bounded subscription, readiness, heartbeat, cancellation, and authorization semantics. Never start another Event/Database/SessionStore/SessionExecution graph to multiplex. Reuse native exports; no broad native copying or patches are indicated.

## Compact actual signatures

Return types below remain inferred where the source omits annotations.

```ts
// vendor/opencode/packages/core/src/effect/app-node-builder.ts:6
export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = [])

// vendor/opencode/packages/core/src/location-services.ts:84-86
export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service>

// vendor/opencode/packages/core/src/location-service-map.ts:7-14
export class Service extends Context.Service<
  Service, LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
>()("@opencode/example/LocationServiceMap") {
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref)))
  }
}

// vendor/opencode/packages/core/src/tool/application-tools.ts:21-25
export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
  readonly entries: () => ReadonlyMap<string, Entry>
}

// modular/packages/adapters-opencode/src/session-runtime.ts:21-26
export function createSessionRuntime(input: {
  readonly filename: string
  readonly policy: SessionAdmissionPolicy
  readonly replacements?: LayerNode.Replacements
  readonly onRunnerConstruct?: (identity: RunnerIdentity) => void
})

// modular/packages/adapters-opencode/src/session-facade.ts:21-22
export type PrivatePromptRequest = Pick<AdmissionRequest, "actor" | "references">
export class PrivatePromptContext extends Context.Service<PrivatePromptContext, PrivatePromptRequest>()("@cybermastery/PrivatePromptContext") {}

// vendor/opencode/packages/protocol/src/groups/event.ts:49-50
export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  make(definitions).group
```
