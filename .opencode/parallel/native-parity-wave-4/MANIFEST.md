# Wave 4: native Session conformance and isolation

Baseline: `d8fdf95f39f2a10f4c4e6a74884bb606c048b4b3`. Official dependency: `b02acc1e30ef55f7f181fec8d2f241d26f022683`.

User selected **Astra High** for parallel work. Catalogue and OpenAI OAuth availability verified with OpenCode CLI 1.18.31: `openai/gpt-6-astra`, variant `high` maps to `reasoningEffort: high`. This supersedes the older DeepSeek worker choice for new runs.

| Worker | Brief | Exclusive files | Acceptance |
| --- | --- | --- | --- |
| runner | runner.md | modular/packages/adapters-opencode/src/runner.ts; modular/packages/adapters-opencode/test/runner.test.ts | Provider/tool/permission failure parity; interruption settlement ordering; misplaced drains reject before cleanup mutates history |
| runtime | runtime.md | modular/packages/adapters-opencode/src/session-runtime.ts; modular/packages/adapters-opencode/test/session-runtime.test.ts | Actual native create/prompt/resume; shared global identities across distinct Locations; same-Session joining; Session-specific interruption/private-context isolation |

Both workers are independent. Neither changes exported cross-task contracts. The master owns all other files, integration, evidence and final verification.

Dispatch: two simultaneous foreground CLI worker sessions with `--pure --agent harness-astra --model openai/gpt-6-astra --variant high --format json`; message precedes `--file`. Fresh processes load the new agent configuration. This uses parallel CLI execution rather than the running master's already-loaded subagent registry or background-task support. Each task receives the brief plus the explicitly attached baseline snapshots of its owned files; those attachments are part of its self-contained input, not permission to explore. No worker commands or tests; the master waits for both to finish before editing task code or running checks.

Shared contracts frozen for this wave:

- `makePrivateRunnerNode(onConstruct?: (identity: RunnerIdentity) => void)` and `RunnerIdentity = { database, events, store, location }` retain their signatures.
- `createSessionRuntime({ filename, policy, replacements?, onRunnerConstruct? })` retains its signature and canonical SessionStore replacement.
- Native Database/Event/SessionStore and native SessionExecution coordinator remain the only authorities. Provider stream calls are explicitly owned per attempt; actor/reference snapshots remain fiber-local.
- Worker output cannot change gates, dependencies, upstream imports outside existing ownership, or production host topology.

After the barrier: review ownership/transcripts, run adapter typecheck and focused tests, fix actual failures, run the full modular proof command once, then update evidence. A failing worker is rebriefed or repaired after both have returned. There is no commit/push in this implementation wave.

## Result

- Both workers returned with edits confined to their ownership. Session exports verify `openai/gpt-6-astra` and `high`; only apply_patch/todowrite were used. Provenance and overlapping timestamps are in `compat/workers.json`.
- The master corrected the runtime brief's Workspace ID branding and completed omitted deterministic ordering/fragment tests.
- New tests exposed pinned interrupted-Deferred fan-out and reentrant FiberSet registration defects. After the barrier, the master added `src/session-execution.ts` / `test/session-execution.test.ts`, installed the explicit execution composition in `session-runtime.ts`, and made local tool startup registration-safe. The native coordinator remains the sole execution owner.
- Final proof verification: **192 pass, 1 skip, 0 fail**, eight package/app typechecks, build/browser smoke and native-source attestation passed. Gates remain partial; see `compat/RUNNER_CONFORMANCE.md` for precise scope.
