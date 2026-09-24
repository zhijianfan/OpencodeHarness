# Worker 2 of 2 — child runs under the existing native coordinator

Own ONLY these files under D:/OpencodeHarness/modular/packages/adapters-opencode:
- src/child-runner.ts (new)
- src/session-execution.ts
- src/session-runtime.ts
- test/child-runner.test.ts (new)
- test/session-execution.test.ts

Astra High. No exploration, commands/tests, Git, delegation or other edits. All relevant native and fork-added source snapshots are supplied. Preserve existing cause-transport tests/behavior, mandatory replacement keys, root/Location identity and shared exported signatures.

## Goal

Replace the fork child helper's direct Location runner invocation with execution through the same process-global native SessionRunCoordinator used by external resume and interrupt. No copied coordinator, independent child mutex as the sole owner, second model loop or hidden forced retry.

Export an owned child API with the fork's Input fields parentSessionID, optional childSessionID/promptMessageID, agent/model/title/prompt, plus explicit authenticated `actor:{userID,workspaceID}`. Return `{sessionID,text}` or a stable ChildRunError with message/sessionID/outcome error|interrupted. Preserve deterministic supplied IDs, exact configuration retry checks, latest assistant text/error handling and parent Location checks. Use the already-installed native Session facade for admission with PrivatePromptContext; worker prompts have no implicit automatic recall/reference inputs. Never use a fabricated global actor.

## Pending-only execution requirement

Native SessionExecution.resume is forced while idle, whereas the old child helper ran `SessionRunner.run({force:false})`. Exact completed child retries must NOT reissue a provider turn. Add an explicitly owned pending-only execution entrypoint alongside the native SessionExecution service, sharing the ONE existing native coordinator. Keep native resume/wake/interrupt/active semantics.

One viable design is a small shared execution-composition service with native and pending-only views. Serialize only admission to native coordinator calls (not execution) with a semaphore, select a pending-only force override only when starting an idle owner, and start/join the native waiter before releasing the admission gate. Native drain callbacks should yield before observable work so mode selection/registration completes. All resume/wake entrypoints must use the same setup gate; never hold it while waiting for a drain or interrupt cleanup. Do not key the native coordinator by (Session,mode), which would create duplicate owners. The native coordinator source and existing cause-boxing adapter are attached; choose a correct implementation against those exact APIs, not a guessed native pending method.

Expose the pending-only view with an owned Context.Service/node and include it in makeSessionGraph so root and Location consumers share it. Canonicalize/hoist the native SessionStore as currently done. Preserve the cause boxing workaround for interrupted Deferred fan-out and waiter cancellation semantics. Do not change the native coordinator source.

## Child creation

Native SessionV2.create does not accept parentID/title. The attached fork-added SessionCreate helper shows native Project resolution and SessionV1.Event.Created construction. You may implement a small owned child creation composition over actual ProjectV2, Database, EventV2 and SessionStore, publishing the native Created schema with parentID/title/agent/model. Do not import fork-only SessionRuntime or SessionProcessRole modules. Do not create a second Session table/transcript. Respect managed EventBoundary.transaction when reconciling creation races and mutation. Runtime classification lives in existing cm_session_runtime; explicit legacy/mixed rows must not be mutated as V2. A missing classification for a newly created selected-graph Session may be marked v2 for the child, but do not silently reclassify historical rows; report any shared facade classification gap for master integration.

Reusing a child ID must match parent, recorded location, agent, model/variant and title. Conflicting reuse fails without prompting/running. Use the actual native V1 SessionInfo codec for event payloads, with no fork-only runtime field inserted into native data; any classification is extension metadata in the same transaction. Resolve native project before publishing and preserve native IDs/slug/version utilities from the attached creation source.

## Cancellation / race acceptance

Tests must prove a child run racing external SessionExecution.resume joins one provider attempt; explicit interrupt(childID) cancels the shared owner and settles both callers; different children run concurrently; exact completed child retry adds no provider turn; new pending prompts are promoted normally. Caller interruption must not leave a child that this call started running accidentally. Clearly distinguish joining a preexisting owner from owning child work if cancellation responsibility differs; do not claim parent/descendant ownership beyond executable evidence.

Use real createSessionRuntime, native Session/Event/Store/Location map and fake deterministic LLM stream. Per-file databaseCleanup, temporary file-backed DB, scoped fibers and Deferred barriers. Use native brands via WorkspaceV2.ID.make, SessionSchema.ID.make, SessionMessage.ID.make; no assertion casts. `LLMClient.Service.stream` is exactly `(request:LLMRequest)=>Stream<LLMEvent,LLMError>`, so contextual typing is sufficient.

Root bootstrap already initializes cm_private_input/requirements, cm_legacy_input/event, cm_session_runtime and deletion tables. Native SessionInput.find(db,id) returns Admitted with prompt, delivery, admittedSeq/promotedSeq. Use native immutable admission reconciliation; do not recall/freeze again on exact retry. Master will register the task_batch tool against this API later.

No any, star/aliased imports, non-null assertions, polling sleeps or globalThis. Return files changed, exact guarantees and unresolved shared-boundary requirements. Master validates after both return.
