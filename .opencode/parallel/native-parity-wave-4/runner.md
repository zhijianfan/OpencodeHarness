# Worker 1 of 2 — owned runner failure parity

Implement this task in `D:\OpencodeHarness`. You run on `openai/gpt-6-astra`, high. All needed context is in this brief and the two attached owned-file snapshots from checkpoint d8fdf95. Do not read/search anything, run commands/tests, delegate, or change Git state. Use apply_patch only. The other worker edits runtime composition and runtime tests; do not inspect or touch them.

## Exclusive owned files

- `modular/packages/adapters-opencode/src/runner.ts`
- `modular/packages/adapters-opencode/test/runner.test.ts`

The master will typecheck and test after both workers finish. Preserve all current tests and exported interfaces. No dependency/config/native changes. No aliases/star imports, any, non-null assertions or new unchecked casts. Keep tests deterministic and scoped; use native services/registry/publisher rather than reimplementing behavior. Existing provider fixture substitution is intentional for deterministic provider results.

## Goal and acceptance

Expand native-runner conformance around permission and provider failure, and fix two bounded orchestration weaknesses:

1. Check the Session's recorded Location **before** repairing interrupted tools, not only inside the first provider attempt. Otherwise a stale/misrouted runner mutates another Location's outstanding tool history before interrupting. Keep the per-attempt guard as well. A small reusable `requireLocalSession` effect is appropriate because both paths need the same lookup/check. Preserve idle advisory no-op behavior and missing-Session failure behavior.
2. Match native interruption precedence. Current owned code turns a non-interruption tool settlement failure into model-facing tool failure *before* the provider-interruption branch. Native code performs interruption cleanup first, then the ordinary tool-failure branch; settled tool tracking prevents overwriting the interruption. Move that ordinary branch after the interruption block. If a reliable simultaneous-failure regression needs additional scaffolding, implement it; report remaining timing uncertainty rather than using sleeps.
3. Add focused tests that run both pinned stock and private runners for behavior that should match: user permission decline, correction/blocked tool output versus interruption, provider-error events, typed raw stream failure, outstanding hosted tools, local tool settlement before raw provider failure, partial text/reasoning flushing and overflow after visible output. Choose a compact, meaningful matrix rather than repetitive checks. Permission/question tests may use the real native services described below; decline type propagation through a real Tool also matches upstream's own test strategy.
4. Add a private-runner regression for a relocated Session with an unfinished tool: no provider call, no tool execution/repair event, no admitted-input promotion, unchanged latest event sequence, interrupted exit. This intentionally tightens the pinned native pre-cleanup ordering; do not assert stock satisfies this new guard.
5. Keep private-context behavior, one stream per provider attempt, queue/steer and step limits intact. Do not claim complete G1B parity.

## Input attachments and current fixture

The attached runner.ts and runner.test.ts are the exact owned baseline contents, supplied in full. The test file already has an async file-backed fixture selecting `native ? node : privateRunnerNode`, actual Database/Event/SessionProjector/SessionStore/Agent/ToolRegistry, a deterministic LLM client, and eight tests. It calls per-file `databaseCleanup()` and disposes each ManagedRuntime immediately. Keep that cleanup ownership.

You may extend this fixture with typed response errors, a caller-provided tool or execute callback, a reusable scoped run Effect for cause/interrupt assertions, and a history reader. Avoid creating a second duplicate fixture. The current run registers `echo` with `{ text: string }` input/output, records tools, then calls the selected SessionRunner with `force:false`.

## Verified dependency contracts (Effect 4.0.0-beta.83, Bun 1.3.14)

Imports, names and relevant APIs:

```ts
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { LLMError, ProviderInternalReason, LLMEvent, ToolFailure } from "@opencode-ai/llm"
import { Cause, Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"

new PermissionV2.DeclinedError()
new PermissionV2.CorrectedError({ feedback: "Use another tool" })
new PermissionV2.BlockedError({ rules: [{ action: "echo", resource: "*", effect: "deny" }] })
new QuestionV2.RejectedError()
new Tool.Failure({ message: "Use another tool" })
new LLMError({ module: "proof", method: "stream", reason: new ProviderInternalReason({ message: "Provider unavailable", status: 503 }) })

// Public runner error channel includes LLMError; preserve object identity.
type Run = (input: { sessionID: Session.ID; force: boolean }) => Effect.Effect<void, SessionRunner.RunError>

// A real tool is created with:
Tool.make({
  description: "...",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: (input, context) => Effect.succeed(input),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})
// context = {sessionID, agent, assistantMessageID, toolCallID}.
// execute returns Effect<{text:string}, Tool.Failure> with no service requirements;
// capture services from an outer generator before creating a tool.
// Tool.Failure becomes a model-facing error result; defects and interruption propagate.
// Registry.register(tools) requires Scope and can fail Tool.RegistrationError.
// Registry.materialize(agentPermissions) filters wholly denied tools.

Effect.scoped(effect)
Effect.exit(effect) // Success.value / Failure.cause
Effect.forkScoped(effect, { startImmediately: true })
Fiber.join(fiber)
Fiber.await(fiber)
Fiber.interrupt(fiber)
Cause.hasInterruptsOnly(cause)
Cause.findErrorOption(cause) // Option<E>
Cause.hasDies(cause)
Deferred.makeUnsafe<void>()
Deferred.await(deferred)
Deferred.succeed(deferred, undefined)
Deferred.poll(deferred) // Effect<Option<Effect<A,E>>>
Effect.ensuring(effect, finalizer)
Effect.onExit(effect, (exit) => ...)
Effect.yieldNow
Stream.concat(first, second)
Stream.fail(llmError)
Stream.never
Stream.fromEffect(effect)
Stream.unwrap(effectOfStream)
```

The fixture response signature can widen to `(request: LLMRequest, index: number) => Stream.Stream<LLMEvent, LLMError>`. Keep the existing canonical-client bridge cast, but add no new unchecked casts. `runtime.runPromise(Effect.exit(runEffect))` gives the typed Exit for assertions without losing the actual failure to a JS FiberFailure wrapper. Make the reusable run Effect available alongside the existing async `run()` if needed. Tests can operate within `env.runtime.runPromise(Effect.scoped(Effect.gen(...)))` and fork/join/interrupt there.

Native PermissionV2.node is Location-scoped; deps include Event, Location, Agent, SessionStore and a Database-backed permission store. Native QuestionV2.node is Location-scoped and depends on Event. Add their nodes to the fixture group only if using the real services. APIs:

```ts
permissions.assert({ sessionID, agent, action: "echo", resources: ["file"], source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID } })
// Effect<void, BlockedError | CorrectedError | SessionV2.NotFoundError>;
// explicit user reject without feedback dies with DeclinedError.
permissions.list() // Effect<readonly Request[]>
permissions.reply({ requestID, reply: "reject" | "once" | "always", message?: string })
questions.ask({ sessionID, questions: [], tool?: { messageID: string; callID: string } })
// Effect<readonly Answer[], QuestionV2.RejectedError>
questions.list() // Effect<readonly Request[]>
questions.reject(requestID)
// Capture these services before constructing Tool.execute. Map expected corrections
// to Tool.Failure; `questions.ask(...).pipe(Effect.as(input), Effect.orDie)` preserves rejection as defect.
```

The upstream tests also use a real `Tool.make` whose execute is simply `Effect.die(new PermissionV2.DeclinedError())`; this is valid for runner error mapping but is not evidence of complete HTTP permission flow. Keep assertions honest.

## Exact native behavior to preserve

- Decline/rejected-question defects in tool fibers clear all jobs, fail outstanding tools with `Tool execution interrupted`, and return `Effect.interrupt`. They do not start the next model turn.
- A Tool.Failure (e.g. correction) is converted by native registry into an error tool result, and the runner continues with that result.
- A `provider-error` event creates an assistant with `finish:"error"` and `error:{type:"unknown",message:...}`; `run` succeeds, but local tool continuation is suppressed. New pending steer/queue remains its normal separate continuation condition.
- Typed raw stream LLMError is returned as the same typed failure, with durable assistant failure. Already-started local tools settle before it is returned.
- Unresolved provider-executed calls become failed tools: `Tool execution interrupted` after a provider-error event, `Provider did not return a tool result` after raw error or normal EOF. No local execution of hosted calls.
- Partial text/reasoning/tool-input buffers flush on failure/interruption.
- Once assistant output has started, context overflow is not recovered by summarization. Before output, only one overflow recovery is allowed.
- Provider interruption takes precedence over ordinary tool-failure cleanup. Native order after streamed/settled Exits: user decline; interruption cleanup (clear jobs, fail unsettled tools, fail active assistant with `Provider turn interrupted`); ordinary non-interruption settlement-failure cleanup; step/snapshot settlement; terminal checks.

Native publisher API for seeding an outstanding tool through actual events:

```ts
const publisher = createLLMEventPublisher(events, {
  sessionID, agent: "build", model: { id: ModelV2.ID.make("proof-model"), providerID: ProviderV2.ID.make("proof") },
})
yield* publisher.publish(LLMEvent.toolCall({ id: "unfinished", name: "echo", input: { text: "old" } }))
// This emits Step.Started and Tool input/call events; projected tool state is "running".
const before = yield* EventV2.latestSequence(database.db, sessionID)
yield* database.db.run(sql`UPDATE session SET workspace_id = 'wrk_moved' WHERE id = ${sessionID}`)
// runEffect must now interrupt without changing before or pending inbox state.
yield* SessionInput.hasPending(database.db, sessionID, "steer")
```

`ModelV2` and `ProviderV2` namespaces are available from `@opencode-ai/core/model` and `/provider`. Native `.make` identifiers require proper prefixes for workspace IDs (`wrk_...`), while model/provider IDs are strings.

No provider timing sleeps. To coordinate a blocked tool, use per-test Deferreds captured by execute and provider functions; use `Effect.ensuring` or `Effect.onExit` for cleanup notifications and `Fiber.interrupt` for cancellation. Any second explicit resume used in a join test must start immediately before interrupting, as shown in the existing test.

## Validation / output

Do not execute these; master runs after both workers return:

- From `modular/packages/adapters-opencode`: `bun typecheck` and `bun test test/runner.test.ts --timeout 30000`.
- Then full modular proof verification.

Return files changed, implemented cases/fixes, and remaining uncertainty. Distinguish tests authored from tests executed. Do not claim production/host/child parity.
