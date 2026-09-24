# Worker 1 of 3 — native HTTP on one selected graph

Create only `modular/packages/adapters-opencode/src/native-http.ts` and `modular/packages/adapters-opencode/test/native-http.test.ts` in D:\OpencodeHarness. Model Astra High. Use this brief and attached source snapshots only. No exploration, commands/tests, Git, delegation or other edits.

## Frozen API

```ts
import type { SessionRuntimeOptions } from "./session-runtime"
export async function createNativeHttp(input: SessionRuntimeOptions & {
  readonly password: string
  readonly username?: string
}) // => { runtime, fetch: (request: Request) => Promise<Response>, dispose: () => Promise<void> }
```

Reject an empty password before constructing resources. `runtime` is the only native service ManagedRuntime, exposed only for owned host composition. `fetch` uses native Basic authentication. The master will layer the actor-aware Session ingress in front; do NOT invent authenticated user identity from the Basic username. Do not call native routes/createRoutes/createEmbeddedRoutes/webHandler or create another service graph.

## Composition

The attached current `session-runtime.ts` exports `makeSessionGraph(input) -> {root,replacements}`. It prepares Database/Event/Session/Execution/runner replacements but does not compile them. Add the native server's required roots, then make exactly ONE `ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([...]), graph.replacements))`.

Native roots to union with graph.root:
- `httpClient` from @opencode-ai/core/effect/app-node-platform
- `ToolOutputStore.cleanupNode` from @opencode-ai/core/tool-output-store
- `PermissionSaved.node` from @opencode-ai/core/permission/saved
- `PtyTicket.node` from @opencode-ai/core/pty/ticket
- `Credential.node` from @opencode-ai/core/credential
- `PtyEnvironment.node` from @opencode-ai/server/pty-environment
- `LocationServiceMap.node` from @opencode-ai/core/location-service-map
- `ApplicationTools.node` from @opencode-ai/core/tool/application-tools for embedded tool registration

The attached native routes.ts shows the exact lower-level handler assembly. Import its component exports, NEVER that closed routes module. Available exports:
```ts
import { Api } from "@opencode-ai/server/api"
import { handlers } from "@opencode-ai/server/handlers"
import { sessionLocationLayer } from "@opencode-ai/server/middleware/session-location"
import { layer } from "@opencode-ai/server/location" // no aliased imports
import { authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { schemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { ServerAuth } from "@opencode-ai/server/auth"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Layer, ManagedRuntime, Option } from "effect"
```

`await runtime.context()` returns Context of its actual already-built services; use `Layer.succeedContext` to provide those instances to the HTTP layers. `runtime.memoMap` may be passed to HttpRouter.toWebHandler. Do not recompile graph.root for HTTP.

Construct `HttpApiBuilder.layer(Api, {openapiPath:"/openapi.json"})`, provide the handlers, session/location middleware, authorization/schema-error layers, `ServerAuth.Config.configLayer({username: input.username ?? "opencode",password:Option.some(input.password)})`, captured service context, and `HttpServer.layerServices`. `HttpRouter.toWebHandler(...,{disableLogger:true,memoMap:runtime.memoMap})` returns `{handler(request,context?),dispose():Promise<void>}`. No unsafe casts to hide missing service requirements.

Dispose HTTP resources before service runtime, both on construction failure and normal idempotent dispose. Never dispose an unrelated external runtime. The selected graph supplies all normal native Location services/builtins via the native Location map; do not recreate that graph or another coordinator.

## Tests

Use a disposable file-backed database and per-file databaseCleanup, preserving existing fixture patterns in attached session-runtime.test.ts. Native Global paths must be isolated: cleanupNode scans tool output, so override `[Global.node, Global.layerWith({...})]` with ALL paths (home,data,cache,config,state,tmp,bin,log,repos) under the temporary test directory. The attached Global source defines those fields. Do not change process.env or globalThis. Avoid live credentials, providers and real user data. Other deterministic native replacements in the existing fixture remain useful.

Tests should prove:
- `/api/health` rejects missing/wrong Basic auth and returns 200 `{healthy:true}` with valid Basic credentials (`Buffer.from("opencode:password").toString("base64")`).
- Seed/create a Session through `app.runtime` and retrieve it through `/api/session/:sessionID`; mutate through native HTTP (e.g. switch agent) and observe the same database/native Session state through runtime. Native creation/adoption and read routes need no live model call.
- If exercising prompt, the raw native route lacks PrivatePromptContext and must not bypass managed admission. The actor-aware Session overlay is another lane; do not relax the guard just to make raw prompts pass.
- Active runtime/global service identities and disposal remain coherent; no extra Database/Event/SessionStore/Execution instances. You may assert equality with captured onRunnerConstruct identities only if a deterministic fake provider is used as in the attached fixture.
- Invalid password construction and repeated disposal are safe.

The native `/openapi.json` route inventory can be inspected through the produced handler in tests, not through commands. Metadata should retain the native groups. Package links for Core/Schema/LLM/Protocol/Server/Effect are already installed. No package or lockfile edits.

No any, import aliases/star imports, non-null assertions or new unchecked casts. Bind Effect services to named variables. Return authored coverage and uncertainty; master runs typecheck/tests after all workers return.
