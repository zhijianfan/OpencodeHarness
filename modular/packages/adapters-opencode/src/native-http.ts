import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Api } from "@opencode-ai/server/api"
import { ServerAuth } from "@opencode-ai/server/auth"
import { handlers } from "@opencode-ai/server/handlers"
import { layer } from "@opencode-ai/server/location"
import { authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { schemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { sessionLocationLayer } from "@opencode-ai/server/middleware/session-location"
import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { Layer, ManagedRuntime, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { makeSessionGraph, type SessionRuntimeOptions } from "./session-runtime"

/** Basic auth protects native HTTP; actor-aware prompt admission belongs to the host. */
export async function createNativeHttp(input: SessionRuntimeOptions & {
  readonly password: string
  readonly username?: string
}) {
  if (!input.password) throw new Error("A non-empty native HTTP password is required")

  const graph = makeSessionGraph(input)
  const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([
    graph.root,
    httpClient,
    ToolOutputStore.cleanupNode,
    PermissionSaved.node,
    PtyTicket.node,
    Credential.node,
    PtyEnvironment.node,
    LocationServiceMap.node,
    ApplicationTools.node,
    Global.node,
  ]), graph.replacements))
  const resources: {
    http?: { dispose: () => Promise<void> }
    disposal?: Promise<void>
  } = {}
  const dispose = () => {
    resources.disposal ??= Promise.resolve().then(async () => {
      try {
        await resources.http?.dispose()
      } finally {
        await runtime.dispose()
      }
    })
    return resources.disposal
  }

  try {
    // Supply the already-built instances, not a second compilation of the graph.
    const context = await runtime.context()
    const http = HttpRouter.toWebHandler(HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(handlers),
      Layer.provide(sessionLocationLayer),
      Layer.provide(layer),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(ServerAuth.Config.configLayer({
        username: input.username ?? "opencode",
        password: Option.some(input.password),
      })),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(HttpServer.layerServices),
    ), { disableLogger: true, memoMap: runtime.memoMap })
    resources.http = http

    return {
      runtime,
      fetch: async (request: Request): Promise<Response> => {
        if (resources.disposal) throw new Error("Native HTTP has been disposed")
        return http.handler(request, context)
      },
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
