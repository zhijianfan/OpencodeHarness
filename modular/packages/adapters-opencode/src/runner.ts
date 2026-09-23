import { LLM, LLMClient, LLMError, LLMEvent, Message, SystemPart, isContextOverflowFailure, type ProviderErrorEvent } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Session } from "@opencode-ai/schema/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import type { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { preparePrivateTurn } from "./provider-context"
import { makePrivateCompaction } from "./compaction"

type Dependencies = {
  readonly database: Effect.Success<typeof Database.Service>
  readonly events: EventV2.Interface
  readonly client: Effect.Success<typeof LLMClient.Service>
  readonly agents: Effect.Success<typeof AgentV2.Service>
  readonly config: Effect.Success<typeof Config.Service>
  readonly models: Effect.Success<typeof SessionRunnerModel.Service>
  readonly store: Effect.Success<typeof SessionStore.Service>
  readonly tools: Effect.Success<typeof ToolRegistry.Service>
  readonly snapshots: Effect.Success<typeof Snapshot.Service>
  readonly location: Effect.Success<typeof Location.Service>
  readonly system: Effect.Success<typeof SystemContextRegistry.Service>
  readonly skills: Effect.Success<typeof SkillGuidance.Service>
  readonly references: Effect.Success<typeof ReferenceGuidance.Service>
}

export type RunnerIdentity = Pick<Dependencies, "database" | "events" | "store" | "location">

/**
 * Explicit maintained orchestration at the native SessionRunner boundary.
 * Native inbox, history, epochs, publisher, tools, model selection and execution
 * ownership remain authoritative. No upstream module is copied or shadowed.
 */
export const makePrivateRunner = Effect.fn("CyberMastery.makePrivateRunner")(function* (deps: Dependencies) {
  const db = deps.database.db
  const compaction = makePrivateCompaction({ events: deps.events, llm: deps.client, config: yield* deps.config.entries() })
  const loadSystem = (agent: AgentV2.Selection) => Effect.all([
    deps.system.load(), deps.skills.load(agent), deps.references.load(),
  ], { concurrency: "unbounded" }).pipe(Effect.map(SystemContext.combine))

  const repairInterruptedTools = Effect.fn("CyberMastery.repairInterruptedTools")(function* (sessionID: Session.ID) {
    for (const message of yield* deps.store.context(sessionID)) {
      if (message.type !== "assistant") continue
      for (const part of message.content) {
        if (part.type !== "tool" || (part.state.status !== "running" && part.state.status !== "pending")) continue
        yield* deps.events.publish(SessionEvent.Tool.Failed, {
          sessionID, timestamp: yield* DateTime.now, assistantMessageID: message.id, callID: part.id,
          error: { type: "unknown", message: "Tool execution interrupted" },
          provider: { executed: part.provider?.executed === true, ...(part.provider?.metadata ? { metadata: part.provider.metadata } : {}) },
        })
      }
    }
  })

  const attempt = Effect.fn("CyberMastery.providerAttempt")(function* (sessionID: Session.ID, step: number, recoverOverflow: boolean, promotion?: "steer" | "queue") {
    const session = yield* deps.store.get(sessionID)
    if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
    if (session.location.directory !== deps.location.directory || session.location.workspaceID !== deps.location.workspaceID) return yield* Effect.interrupt
    const agent = yield* deps.agents.select(session.agent)
    const initialized = yield* SessionContextEpoch.initialize(db, loadSystem(agent), sessionID)
    const cutoff = promotion ? yield* EventV2.latestSequence(db, sessionID) : -1
    const queued = promotion === "queue" ? Number(yield* SessionInput.promoteNextQueued(db, deps.events, sessionID)) : 0
    const steers = promotion ? yield* SessionInput.promoteSteers(db, deps.events, sessionID, cutoff) : 0
    const currentStep = queued + steers > 0 ? 1 : step
    const system = initialized ?? (yield* SessionContextEpoch.prepare(db, deps.events, loadSystem(agent), sessionID))
    const model = yield* deps.models.resolve(session)
    const entries = yield* SessionHistory.entriesForRunner(db, sessionID, system.baselineSeq)
    const last = agent.info?.steps !== undefined && currentStep >= agent.info.steps
    const tools = last ? undefined : yield* deps.tools.materialize(agent.info?.permissions)
    const request = LLM.request({
      model,
      http: { headers: { "x-session-affinity": sessionID, "X-Session-Id": sessionID, ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}) } },
      providerOptions: { openai: { promptCacheKey: /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID } },
      system: [agent.info?.system, system.baseline].filter((value): value is string => !!value).map(SystemPart.make),
      messages: [...toLLMMessages(entries.map((entry) => entry.message), model), ...(last ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
      tools: tools?.definitions ?? [], toolChoice: last ? "none" : undefined,
    })
    const input = { sessionID, entries, model, request }
    if (yield* compaction.compactIfNeeded(input).pipe(Effect.provideService(Database.Service, deps.database), Effect.orDie)) {
      return { kind: "compacted" as const, step: currentStep }
    }
    const prepared = yield* preparePrivateTurn(input).pipe(Effect.provideService(Database.Service, deps.database), Effect.orDie)
    const start = yield* deps.snapshots.capture()
    const publisher = createLLMEventPublisher(deps.events, {
      sessionID, agent: agent.id, snapshot: start,
      model: { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider), ...(session.model?.variant ? { variant: session.model.variant } : {}) },
    })
    const publication = Semaphore.makeUnsafe(1).withPermit
    const jobs = yield* FiberSet.make<void, ToolOutputStore.Error>()
    const state: { continuation: boolean; overflow?: ProviderErrorEvent } = { continuation: false }
    const publish = (event: LLMEvent, paths: readonly string[] = []) => publication(publisher.publish(event, paths))

    // Exactly one delegation for this provider attempt. Compaction uses the
    // native compactor's separate summary request, never a hidden tool loop.
    const provider = deps.client.stream(prepared.request).pipe(Stream.runForEach((event) => Effect.gen(function* () {
      if (state.overflow || publisher.hasProviderError()) return
      if (LLMEvent.is.providerError(event) && isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
        state.overflow = event
        return
      }
      yield* publish(event)
      if (event.type !== "tool-call" || event.providerExecuted) return
      if (!tools) return yield* publication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
      state.continuation = true
      const assistantMessageID = yield* publisher.assistantMessageID(event.id)
      yield* Effect.uninterruptibleMask((restore) => restore(tools.settle({ sessionID, agent: agent.id, assistantMessageID, call: event })).pipe(
        Effect.flatMap((settlement) => publish(LLMEvent.toolResult({ id: event.id, name: event.name, result: settlement.result, output: settlement.output }), settlement.outputPaths ?? [])),
      )).pipe(FiberSet.run(jobs))
    })), Effect.ensuring(publication(publisher.flush())))

    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const streamed = yield* restore(provider).pipe(Effect.exit)
    const failure = streamed._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(streamed.cause)) : undefined
    if (recoverOverflow && !publisher.hasAssistantStarted() && isContextOverflowFailure(state.overflow ?? failure)) {
      if (yield* restore(compaction.compactAfterOverflow(input).pipe(Effect.provideService(Database.Service, deps.database), Effect.orDie))) {
        return { kind: "overflow-compacted" as const, step: currentStep }
      }
    }
    if (state.overflow) yield* publish(state.overflow)
    if (failure instanceof LLMError && !publisher.hasProviderError()) {
      yield* publication(publisher.failUnsettledTools("Provider did not return a tool result", true))
      yield* publication(publisher.failAssistant(failure.reason.message))
    }
    if (streamed._tag === "Failure" && Cause.hasInterrupts(streamed.cause)) yield* FiberSet.clear(jobs)
    const settled = yield* restore(Effect.raceFirst(FiberSet.join(jobs), FiberSet.awaitEmpty(jobs))).pipe(Effect.exit)
    if (settled._tag === "Failure") {
      const declined = settled.cause.reasons.some((reason) => Cause.isDieReason(reason) &&
        (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError))
      if (declined) {
        yield* FiberSet.clear(jobs)
        yield* publication(publisher.failUnsettledTools("Tool execution interrupted"))
        return yield* Effect.interrupt
      }
      if (!Cause.hasInterrupts(settled.cause)) {
        const cause = Cause.squash(settled.cause)
        yield* publication(publisher.failUnsettledTools(`Tool execution failed: ${cause instanceof Error ? cause.message : String(cause)}`))
      }
    }
    const interrupted = (streamed._tag === "Failure" && Cause.hasInterrupts(streamed.cause)) || (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
    if (interrupted) {
      yield* FiberSet.clear(jobs)
      yield* publication(publisher.failUnsettledTools("Tool execution interrupted"))
      if (publisher.hasActiveAssistant()) yield* publication(publisher.failAssistant("Provider turn interrupted"))
    }
    const stepResult = publisher.stepSettlement()
    if (stepResult && !publisher.hasProviderError()) {
      const end = yield* deps.snapshots.capture()
      const files = start && end ? yield* deps.snapshots.files({ from: start, to: end }).pipe(Effect.catch(() => Effect.succeed(undefined))) : undefined
      yield* publication(deps.events.publish(SessionEvent.Step.Ended, {
        sessionID, timestamp: yield* DateTime.now, assistantMessageID: yield* publisher.startAssistant(),
        finish: stepResult.finish, cost: 0, tokens: stepResult.tokens, snapshot: end, files,
      }))
    }
    if (publisher.hasProviderError()) yield* publication(publisher.failUnsettledTools("Tool execution interrupted"))
    if (streamed._tag === "Success" && !publisher.hasProviderError()) yield* publication(publisher.failUnsettledTools("Provider did not return a tool result", true))
    if (streamed._tag === "Failure") return yield* Effect.failCause(streamed.cause)
    if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) return yield* Effect.failCause(settled.cause)
    return { kind: "settled" as const, step: currentStep, continuation: !publisher.hasProviderError() && state.continuation }
    }))
  }, Effect.scoped)

  const run: SessionRunner.Interface["run"] = Effect.fn("CyberMastery.SessionRunner.run")(function* (input) {
    const pending = () => Effect.gen(function* () {
      if (yield* SessionInput.hasPending(db, input.sessionID, "steer")) return "steer" as const
      if (yield* SessionInput.hasPending(db, input.sessionID, "queue")) return "queue" as const
      return undefined
    })
    const initial = yield* pending()
    if (!input.force && !initial) return
    yield* repairInterruptedTools(input.sessionID)
    const state: { promotion?: "steer" | "queue"; step: number; recover: boolean } = { promotion: initial, step: 1, recover: true }
    for (;;) {
      const promotion = state.promotion
      state.promotion = undefined
      const turn = yield* attempt(input.sessionID, state.step, state.recover, promotion)
      state.step = turn.step
      if (turn.kind !== "settled") {
        if (turn.kind === "overflow-compacted") state.recover = false
        yield* Effect.yieldNow
        continue
      }
      state.step++
      state.recover = true
      state.promotion = turn.continuation ? "steer" : yield* pending()
      if (!turn.continuation && !state.promotion) return
    }
  })
  return SessionRunner.Service.of({ run })
})

export function makePrivateRunnerNode(onConstruct?: (identity: RunnerIdentity) => void) {
return makeLocationNode({
  service: SessionRunner.Service,
  layer: Layer.effect(SessionRunner.Service, Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const client = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const tools = yield* ToolRegistry.Service
    const snapshots = yield* Snapshot.Service
    const location = yield* Location.Service
    const system = yield* SystemContextRegistry.Service
    const skills = yield* SkillGuidance.Service
    const references = yield* ReferenceGuidance.Service
    onConstruct?.({ database, events, store, location })
    return yield* makePrivateRunner({ database, events, client, agents, config, models, store, tools, snapshots, location, system, skills, references })
  })),
  deps: [Database.node, EventV2.node, llmClient, AgentV2.node, Config.node, SessionRunnerModel.node, SessionStore.node,
    ToolRegistry.node, Snapshot.node, Location.node, SystemContextRegistry.node, SkillGuidance.node, ReferenceGuidance.node],
})
}

export const privateRunnerNode = makePrivateRunnerNode()
