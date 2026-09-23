import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionStore } from "@opencode-ai/core/session/store"
import { node } from "@opencode-ai/core/session/runner/llm"
import { Layer, ManagedRuntime } from "effect"
import { makeEventBoundaryNode, makeMediatedEventNode } from "./event-boundary"
import { initializeExtension } from "./kernel"
import { makePrivateRunnerNode, type RunnerIdentity } from "./runner"
import { makeSessionFacadeNode, type SessionAdmissionPolicy } from "./session-facade"

/**
 * Native Session/Execution services with explicit admission, Event and runner
 * replacements. This remains an integration kernel, not full host/data parity.
 */
export function createSessionRuntime(input: {
  readonly filename: string
  readonly policy: SessionAdmissionPolicy
  readonly replacements?: LayerNode.Replacements
  readonly onRunnerConstruct?: (identity: RunnerIdentity) => void
}) {
  if (!input.filename) throw new Error("An explicit database filename is required")
  const reserved = new Set([Database.node.name, EventV2.node.name, SessionV2.node.name, SessionExecution.node.name, SessionStore.node.name, node.name])
  if (input.replacements?.some(([source]) => reserved.has(source.name))) throw new Error("Required integration nodes cannot be overridden")
  const database = makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(input.filename), deps: [] })
  const boundary = makeEventBoundaryNode()
  const bootstrap = makeGlobalNode({ name: "cybermastery-private-bootstrap", layer: Layer.effectDiscard(initializeExtension), deps: [Database.node] })
  return ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([SessionV2.node, SessionExecution.node, SessionStore.node, EventV2.node, Database.node, boundary, bootstrap]), [
    [Database.node, database],
    [EventV2.node, makeMediatedEventNode(boundary)],
    [SessionV2.node, makeSessionFacadeNode(boundary, input.policy)],
    [SessionExecution.node, SessionExecutionLocal.node],
    // Canonicalize this shared global node after dependency replacement; the
    // pinned hoister otherwise encounters rewritten and original identities.
    [SessionStore.node, SessionStore.node],
    [node, makePrivateRunnerNode(input.onRunnerConstruct)],
    ...(input.replacements ?? []),
  ]))
}
