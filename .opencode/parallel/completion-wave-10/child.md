# Worker 2 of 2 — actual authorized child runner

Use ONLY attached snapshots and this brief. Your model is opencode-go/deepseek-v4.1-flash/high. Edit only these exact files under D:/OpencodeHarness/modular/packages/adapters-opencode:
- src/child-runner.ts (new; does not exist yet)
- test/child-runner.test.ts (existing pending bridge tests; preserve those and add actual API tests)

No read/glob/grep/commands/tests/Git/delegation or other edits. Master validates after both workers return. No vendor patches, copied native orchestration, new coordinator, second transcript or direct runner invocation. No any, alias/star imports or unchecked casts. Effect 4.0.0-beta.83 follows supplied source examples. Ask via final report if a required signature is missing.

## Frozen cross-worker contract

src/session-classification.ts will export:
- RuntimeClassificationError: Schema.TaggedErrorClass with tag CyberMastery.RuntimeClassification and fields sessionID: SessionSchema.ID, code: Schema.String.
- recordV2SessionCreated(sessionID: SessionSchema.ID): Effect.Effect<void, RuntimeClassificationError, Database.Service>
- requireV2Session(sessionID: SessionSchema.ID): Effect.Effect<void, RuntimeClassificationError, Database.Service>

recordV2SessionCreated is ONLY called after a freshly published native SessionV1.Event.Created has returned and INSIDE its owning EventBoundary.transaction, never on historical adoption. It writes cm_session_runtime='v2' and compatibility lifecycle metadata for export, preserving the native event. requireV2Session checks exactly v2 and rejects missing/legacy/mixed without writing. New Sessions made by the decorated SessionV2.create will already be classified. Consume this contract without inspecting worker 1 files.

## Public API

Export ChildRunError as Schema.TaggedErrorClass tagged CyberMastery.ChildRun with message: Schema.String, sessionID: Schema.optional(SessionSchema.ID), outcome: Schema.optional(Schema.Literals(['error','interrupted'])).
Export ChildRunInput with parentSessionID, optional childSessionID/promptMessageID, agent: AgentV2.ID, model: ModelV2.Ref, title: string, prompt: string and REQUIRED actor:{readonly userID:string; readonly workspaceID:string}.
Export makeChildRunner(options:{readonly location:Location.Ref; readonly authorize:(request:{readonly actor:ChildRunInput['actor']; readonly parent:SessionSchema.Info})=>Effect.Effect<void,ChildRunError>}). This is an Effect constructor capturing Database.Service, EventV2.Service, ProjectV2.Service, SessionStore.Service, SessionV2.Service, PendingSessionExecution and EventBoundary; return {run:(input:ChildRunInput)=>Effect.Effect<{readonly sessionID:SessionSchema.ID;readonly text:string},ChildRunError>}. No Scope requirement beyond existing captured services. No graph changes needed in this task; the caller constructs it in the selected runtime.

## Behavior

Follow the supplied fork SubagentRunner and SessionCreate semantics, but use the shared PendingSessionExecution.run and decorated SessionV2.prompt with PrivatePromptContext {actor:input.actor,references:[]} and resume:false. Never direct-call SessionRunner, force SessionExecution.resume for child retries or fabricate an actor. options.authorize is REQUIRED; validate nonempty actor and parent placement against options.location, call it before mutation and recheck inside the transaction. requireV2Session(parent.id) and requireV2Session(existing child.id) reject historical/legacy/mixed ownership. Source fork modules are references ONLY, not imports into modular runtime.

Choose/generate child and prompt IDs once per call. Existing child must exactly match parent ID, native location directory/workspace, agent, model provider/id/default variant, and title. A mismatch fails before prompting/executing. New child creation uses a small owned native composition: resolve Project, ensure ProjectTable row, construct actual SessionV1.SessionInfo without runtime field (with parentID/title/agent/model), publish native Created with recorded location, read projected child, then call recordV2SessionCreated in same EventBoundary transaction. Use native Slug, InstallationVersion, IDs, SessionV1 schema exactly as attached creation references show. Do not copy native engines. Recheck existing child and parent under the boundary to reconcile races rather than swallowing native errors. Create + classification + prompt admission should be ONE owning boundary transaction, so authorization/admission failures cannot leak an empty published child. No wake until after commit; pending.run happens outside that transaction.

After pending.run, inspect actual SessionStore.context(child.id), latest assistant, assistant.error, concatenate text parts. Return stable ChildRunError on application failures. Preserve interruption semantics: map genuine interruption to outcome interrupted only after shared pending execution has completed cleanup; never catch it early and leave work alive. Existing bridge owns cancellation ONLY for a pending caller that started an idle owner; joining an existing run does not transfer ownership. Do not add a second ownership map.

## Tests

Extend existing real runtime/LLM Deferred fixtures (branded IDs, temporary file DB, cleanup/finalizers). Verify actual API: parent/title/model creation + public native data separation and runtime metadata; identical supplied IDs reuse and freeze once without another provider call after completion; conflicting parent/placement/agent/model/variant/title rejected; denied actor produces no new Session/admission/event; explicit legacy/mixed/unclassified parent/child rejected without reclassification; concurrent child call + external resume share one provider turn; explicit interrupt settles both; cancellation of initiating caller cleans owned execution; independent children run concurrently. Use Deferred barriers and startImmediately where needed, no timing sleeps. Existing bridge tests must remain.

Native helper context: ModelV2.Ref variant defaults to ModelV2.VariantID.make('default') in Session Info. ProjectTable insert and SessionV1.SessionInfo.make shapes are in attached native/fork creation sources. EventBoundary transaction is fiber-owned: no forked work inside it. PrivatePromptContext exists in attached facade; its creator update is concurrent but prompt contract unchanged. PendingSessionExecution is in attached execution module and already installed in createSessionRuntime. Test fixture SessionV2.create will be classified by worker 1's facade update.

Return files changed, guarantees and uncertainties; do not claim tests run.
