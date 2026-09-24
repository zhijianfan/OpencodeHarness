import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { node } from "@opencode-ai/core/session/runner/llm"
import { Layer, ManagedRuntime } from "effect"
import { makeEventBoundaryNode, makeMediatedEventNode } from "./event-boundary"
import { initializeExtension } from "./kernel"
import { makePrivateRunnerNode, type RunnerIdentity } from "./runner"
import { makeSessionFacadeNode, type SessionPolicy } from "./session-facade"
import { executionCompositionNode, pendingSessionExecutionNode, sessionExecutionNode } from "./session-execution"

/**
 * Native Session/coordinator with explicit admission, Event, runner and
 * interruption-safe execution composition. This is not full host/data parity.
 */
export type SessionRuntimeOptions = {
  readonly filename: string
  readonly policy: SessionPolicy
  readonly replacements?: LayerNode.Replacements
  readonly onRunnerConstruct?: (identity: RunnerIdentity) => void
}

export function createSessionRuntime(input: SessionRuntimeOptions) {
  const graph = makeSessionGraph(input)
  return ManagedRuntime.make(AppNodeBuilder.build(graph.root, graph.replacements))
}

/** Let host composition add roots before the single native graph is compiled. */
export function makeSessionGraph(input: SessionRuntimeOptions) {
  if (!input.filename) throw new Error("An explicit database filename is required")
  const reserved = new Set([Database.node.name, EventV2.node.name, SessionV2.node.name, SessionExecution.node.name, SessionStore.node.name, executionCompositionNode.name, pendingSessionExecutionNode.name, node.name])
  if (input.replacements?.some(([source]) => reserved.has(source.name))) throw new Error("Required integration nodes cannot be overridden")
  const database = makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(input.filename), deps: [] })
  const boundary = makeEventBoundaryNode()
  const bootstrap = makeGlobalNode({ name: "cybermastery-private-bootstrap", layer: Layer.effectDiscard(initializeExtension), deps: [Database.node] })
  const replacements: LayerNode.Replacements = [
    [Database.node, database],
    [EventV2.node, makeMediatedEventNode(boundary)],
    [SessionV2.node, makeSessionFacadeNode(boundary, input.policy)],
    [SessionExecution.node, sessionExecutionNode],
    // Canonicalize this shared global node after dependency replacement; the
    // pinned hoister otherwise encounters rewritten and original identities.
    [SessionStore.node, SessionStore.node],
    [executionCompositionNode, executionCompositionNode],
    [pendingSessionExecutionNode, pendingSessionExecutionNode],
    [node, makePrivateRunnerNode(input.onRunnerConstruct)],
    ...(input.replacements ?? []),
  ]
  return {
    root: LayerNode.group([SessionV2.node, SessionExecution.node, pendingSessionExecutionNode, SessionStore.node, EventV2.node, ProjectV2.node, Database.node, boundary, bootstrap]),
    replacements,
  }
}
