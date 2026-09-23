# CyberMastery modularization: current-source alignment review

- Date: 2026-09-23
- Audience: Lead Engineer, Product Manager, Lead Architect
- Status: Source review and focused verification; extraction is not implemented.
- Companion: `CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md`

## Executive decision

**The supplied zero-patch architecture, 14-task plan, and summary are strongly aligned with the main source boundaries. Adopt the external host plus explicit OpenCode mediation layer, but amend the preservation inventory before implementation.**

The most important corrections are:

1. MasterAgent already includes `task_batch`, manifest hashes, stable child identities, persisted worker/batch CtxPacks, partial-retry reconciliation, and archival. Treating all durable manifest behavior as deferred would omit implemented behavior.
2. The CtxPack Browser test is not currently blocked: its correct Solid test configuration passes 29 tests on Bun 1.3.14. The earlier report used the wrong conditions.
3. The baseline has advanced: seven stabilization files are committed; the current fork comparison is 1,128 paths and 147 fork-only commits.
4. The new OpencodeHarness repository has identical committed file contents but 43 executable-mode differences. It is a fork snapshot, not independently verified official upstream.
5. Private replay is a concrete missing upstream API, not just an abstract risk: the fork calls `EventV2.replayBatch`; the official comparison pin does not provide it.

An ordinary static-card slice and a private-context slice remain the right paired feasibility gates. A directory move or a clean vendor tree alone cannot establish parity.

## 1. Review scope and reproducible baseline

### Source examined

| Item | Observed state |
| --- | --- |
| CyberMastery checkout | `D:\CyberMastery`, branch `feature/Modularize` |
| CyberMastery HEAD | `d555e5aa7031ca210b7ba4ab098e746c3ee79404` |
| Prior report baseline | `b7c82166e3ed1c7c7cb64a1ac631f2a9e15404e0` |
| Upstream comparison object | `b02acc1e30ef55f7f181fec8d2f241d26f022683` |
| Harness checkout | `D:\OpencodeHarness`, branch `main` |
| Harness HEAD | `4a59cbde7e67f2fdd7c7523cf6a5274d9594a076` |
| Current rename-aware fork delta | 658 added, 461 modified, 5 deleted, 4 renamed: 1,128 paths |
| Current fork-only history | 147 commits relative to the comparison object |

The seven stabilization files and the previous reports were committed in `d555e5aa7`. Before this review, CyberMastery had only `.opencode-tmp/` untracked; Harness was clean. The supplied plan's instruction to preserve seven uncommitted files must become a reference to that commit, plus capture of any subsequently discovered worktree delta.

Comparing both committed trees found the same 7,279 paths, matching content object IDs, 60 symlink entries and the same Superpowers gitlink. However, 43 entries changed from `100755` to `100644` in Harness. Examples include `.husky/pre-push`, `install`, `packages/opencode/bin/opencode`, and `packages/sdk/js/script/build.ts`. This can affect Linux execution and hooks. Record and repair the modes before cross-platform acceptance; no such repair was made in this review.

The two supplied zero-patch documents were reviewed from the user-provided text; files with those names were not present at either repository root. The referenced `baseline.json`, `test-evidence.json`, `probe-evidence.json`, and `cybermaster-encapsulation-status.md` were not found in the CyberMastery search. Their reported 62-pass/5-skip and 1-success/31-conflict results are historical supplied evidence, not fresh results here.

### Independent upstream inspection

The official raw source was retrieved for these files at the exact comparison SHA:

- `packages/core/src/event.ts`
- `packages/core/src/effect/app-node-builder.ts`
- `packages/server/src/routes.ts`

Base URL: `https://raw.githubusercontent.com/anomalyco/opencode/b02acc1e30ef55f7f181fec8d2f241d26f022683/`.

Other upstream comparisons used the local Git object. This establishes the specific inspected upstream mechanisms, not provenance of an independently installed complete checkout or a successful pristine build.

## 2. Findings, ordered by impact

### F1. High: MasterAgent preservation scope is incomplete

The report emphasizes the legacy `ChildTaskRunner` path and labels durable manifests as deferred. The current V2 path also contains:

- `packages/core/src/tool/task-batch.ts:25-99`: a bounded 1-32 task manifest, owned-file declarations, outcome and capture schemas.
- `task-batch.ts:195-325`: binding and permission checks, persisted-model selection, concurrent worker execution, settlement, capture and archival.
- `task-batch.ts:347-491`: batch/manifest/task hashes, deterministic child Session and prompt IDs, discovery of previously captured results.
- `packages/core/src/tool/builtins.ts:14,44`: live builtin registration.
- `packages/core/src/plugin/agent.ts:98-100` and `plugin/superpowers.ts:19-25`: `task_batch` dependency-wave policy and legacy-task restrictions.
- `packages/core/test/tool-task-batch.test.ts:758-825`: partial capture retry and concurrent identical settlement coverage.

This is not proof of a general pre-dispatch durable scheduler, crash-recovery journal, or enforced filesystem sandbox. The owned-file list is part of the brief and manifest, not an enforcement boundary. Preserve the implemented capture/retry protocol while keeping additional scheduling, sandboxing, per-task cancellation, and progress UI separate.

**Amend T01, T08, T11 and T12:** include worker/batch CtxPack metadata, idempotency keys, model pinning, output bounding, result identity, child archival and retry conflicts in the parity/data ledgers. “Do not add deferred manifests” must not authorize deleting existing manifest-backed capture.

### F2. High: private replay requires more than the upstream publish callback

The supplied warning is confirmed:

- Fork `packages/core/src/event.ts:147-159,527-712` adds `replayBatch`, validation/commit hooks, batch transaction handling and post-transaction notifications.
- `packages/core/src/session/projection-transfer.ts:246-299` depends directly on that method to restore events, sidecars and epoch state.
- Official pinned `event.ts` provides a local `publish(..., { commit })` callback, but its `replayAll` iterates individual `replay` calls. It has no `replayBatch`.
- Official durable commit code wakes durable subscribers after its transaction, independently of whether public replay notification is requested. `publish:false` alone is not evidence of notification isolation under a proposed outer transaction.

An outer wrapper must prove nested transaction behavior, rollback, durable subscriber visibility and wake ordering. Do not assume it works because both writes use the same database. This is a release-blocking capability until demonstrated or addressed through an explicitly reviewed native service replacement.

### F3. High: current custom injection ports do not prove pristine-upstream seams

The fork's `SessionInput.SessionContextAssemblyPort`, context profile and transfer-readiness nodes are visible in `packages/core/src/session.ts:195-197,318-342,445-447`. They are not present in the comparison pin's admission helper.

The official Session service directly calls the imported `SessionInput.admit` function. A free function import is not independently replaceable merely because the application builder supports service replacement. Each proof must identify the actual replaceable node and all callers it covers.

The current fork correctly checks existing input identity before context assembly and persists the new private snapshot inside the event commit callback (`session/input.ts:200-329`). Provider reconstruction and compaction additionally modify `runner/to-llm-message.ts:117-187`, `runner/llm.ts`, and `compaction.ts:200-288`.

**Amend T03/T05/T06:** distinguish existing native seams from fork-created seams. A custom HTTP endpoint alone does not cover native Session prompts, embedded calls, child admission or compatibility routes.

### F4. High: canonical MasterAgent binding invalidation is broken

Source and a fresh executable probe agree with the supplied finding:

- Producer validation: `packages/core/src/workspace/master-agent-events.ts:40-53`.
- Canonical fields: `packages/schema/src/master-agent.ts:83-92` contain workspaceID, blockID, sessionID, generation and revision, but no functionalityID.
- Registration: `packages/app/src/pages/canvas/master-agent/runtime-registration.ts:61-67` requires functionalityID.
- Router: `pages/canvas/runtime/event-router.ts:95-109,135-172` compares that field strictly.

Fresh result using the real decoder, registration and router: registration deliveries **0**, canonical workspace/block listener **1**, unrelated block **0**.

`runtime-registration.test.ts:94-100` currently asserts the incompatible key, explaining why a registration-only unit test does not detect this contract failure. Correct the consumer scope and test producer-to-refresh behavior. A real two-client network/browser test remains necessary.

Runtime v3 is enabled (`pages/canvas/flag.ts:2`). Its manager fallback is disabled when `runtimeHostBindings` is true (`manager.ts:940-967`). This does not establish two active binding owners.

### F5. Medium: layout CAS risk is real in source; expiry is not current semantics

`packages/core/src/workspace/service.ts:729-775` reads authority and revision, then updates by layout ID only. The write predicate does not include expected revision or holder, and the method does not wrap that sequence in one transaction. This supports the proposed multi-connection test and atomic-transition correction; this review did not reproduce a lost update.

`requireAuthority` at lines 468-490 rejects a different holder but does not check expiry. `held_at` is recorded, not used as a TTL. T02's “expired authority” scenario must characterize existing timestamp behavior or be separately approved as a new lease policy. It must not silently change parity semantics.

### F6. Medium: child execution ownership needs an additional proof

`packages/core/src/session/subagent-runner.ts:83-113` directly admits a child input and invokes the Location-scoped `SessionRunner.run`. The process-global coordinator is assembled separately in `session/execution/local.ts:20-73`.

The batch tool has a module-local keyed mutex, and its tests cover identical batch settlement. That is not proof that a direct child drain and an external `SessionExecution.resume(childID)` cannot overlap, nor that external interruption reaches both paths.

No duplicate child execution was reproduced here. Add a controlled same-child direct-run/resume/interruption test to T10/T11 before claiming one-owner coverage for every entrypoint. If the ownership contract needs correction, record it explicitly rather than disguising it as extraction.

### F7. Medium: the previously reported CtxPack test blocker is corrected

The file is `ctxpack-browser.test.tsx`, not a `*.browser.test.*` file. `packages/app/package.json:24-25` sends that category through `--conditions=solid`.

Running the correct command on Bun 1.3.14 produced **29 pass, 0 fail**. The previous browser-conditions invocation does not justify a Bun upgrade or a claim of a confirmed upstream product defect. The CtxPack file is fork-added and absent from the official comparison tree; “pristine upstream test file” in the earlier report referred to the remote fork version, not vanilla OpenCode.

**Amend T13:** preserve the correct suite split, then add the required real-browser and Linux coverage. Do not upgrade tools just to address this historical invocation error.

### F8. Medium: package installation, generated contracts and boot ownership need explicit gates

- Core/Server are private workspace packages with source exports, workspace dependencies, catalogs and runtime conditions (`packages/core/package.json:7,18-40,63-127`; `packages/server/package.json:5-20`).
- The app resolves `@opencode-ai/client` from a vendored `1.17.13-v2.tgz`, while Core/schema/SDK/session-ui resolve from workspaces (`packages/app/package.json:54-66`). Directory names and versions alone do not establish runtime identity.
- Current `packages/server/src/routes.ts:81-117` exports `applicationLayer` but still supplies it inside the route helper. The official pinned helper builds the graph internally.
- Combined host, custom CLI and embedded SDK have separate assembly paths (`packages/opencode/src/server/routes/instance/httpapi/server.ts:336-399`; `packages/cli/src/commands/handlers/serve.ts:26-42`; `packages/sdk-next/src/opencode.ts:10-46`).
- Native durable decoding uses a compiled manifest (`packages/schema/src/durable-event-manifest.ts:3-15`). Moving schemas to another directory does not make native replay accept the fork's additional fields or variants.

Preserve wire paths, errors, event versions and optional-field behavior through extension contracts. Prove one physical Core/Effect/database graph and one memoization/scope policy across entrypoints. Do not infer duplicate services merely from multiple layer declarations.

### F9. Medium: migration and context ownership need finer attribution

The fork changes native Session columns, fresh schema generation, the migration list and event payloads. Example deltas include `session_input.context_snapshot_json`, `session_message.model_context_json`, Session runtime classification and `PromptAdmitted.modelContextVersion`.

`packages/core/src/database/migration.ts:18-105` separates fresh-schema creation, upgrades and legacy journal seeding. `ctxpack/sql.ts:141` adds lazy FTS initialization. All must be inventoried before moving migration ownership.

System Context and Context Epoch are already native. The inspected `context-epoch.ts` delta is only the added `readTransfer` export. Keep the native epoch's authority; mediate the custom transfer integration rather than creating a second extension epoch owner.

Move schema/decoder compatibility experiments into the early proof gates. T12 can complete the full migration rehearsal later, but discovering a lossless-decoding blocker only after broad extraction is too late.

### F10. Documentation digests must not be treated as executable contracts

Several compacted-source comments in the existing context/report need correction:

- Text-only ChatRelay prompts are supported (`packages/server/src/handlers/chat-proxy.ts:85-97`); files, skills or context attachments are not required.
- A skill-load error clears the validation request, but submission with selected skills still requires a verified matching catalog (`chat-relay/composer.tsx:128-184`). It is not an unconditional allow-on-error policy.
- Hashes/manifests check integrity; authenticated transport and owner/workspace/readiness checks establish authorization. A digest alone does not authenticate a peer.
- Layout authority timestamps and transfer leases are different mechanisms.
- `RepositoryCache` source and its test have no delta from the supplied comparison pin. Preserve it as native unless a separate pending patch is actually supplied.

Treat the C++-style digest as documentation, not an API or source substitute. Update stale reports alongside the first approved baseline work package.

## 3. Alignment matrix

| Proposed direction | Current-source assessment |
| --- | --- |
| Complete official OpenCode monorepo pinned unchanged | Appropriate target; Harness is currently a fresh-history fork snapshot, not that target |
| CyberMastery-owned web shell | Appropriate; current registration lacks view/metadata ownership and `workspace.tsx` has concrete branches |
| CyberMastery-owned composition root | Appropriate; current route helpers internally supply their service graph |
| One native Session/inbox/transcript authority | Correct invariant; child direct-run path requires explicit coverage |
| One application database, separate extension migration ledger | Appropriate proposal; not yet implemented or migration-tested |
| Independent extension clients | Required; current custom groups and generated clients remain inside modified native packages |
| CtxPack/ChatRelay/drafts are extraction candidates | Supported by source boundaries; still coupled to policy, storage, identity and session surfaces |
| Explicit native replacement inventory | Essential; current custom context ports are not proof of vanilla extension APIs |
| Private-context feasibility as an early gate | Strongly supported; missing replayBatch and internal provider/compaction code make this decisive |
| MasterAgent deferred-feature classification | Partially incorrect: preserve implemented task_batch capture/retry semantics |
| Reported CtxPack browser blocker | Stale/incorrect invocation; correct suite passes |
| Full parity already verified | Not established; focused fork tests are not extraction, live-site or migration evidence |

## 4. Fresh verification evidence

All test commands ran from package directories in `D:\CyberMastery`, on Bun 1.3.14. No dependency installation, service restart, real-site relay submission, production database migration or upstream source edit was performed in this review.

| Working directory | Command / probe | Result |
| --- | --- | --- |
| `packages/core` | `bun test --only-failures test/session-ctxpack-admission.test.ts test/session-projection-transfer.test.ts test/session-compaction.test.ts` | 41 pass, 0 fail; 194 assertions |
| `packages/core` | `bun test --only-failures test/tool-task-batch.test.ts test/session-subagent-runner.test.ts` | 25 pass, 0 fail; 190 assertions |
| `packages/app` | `bun test --conditions=solid --isolate --only-failures --preload ./happydom.ts ./src/pages/canvas/blocks/ctxpack-browser/ctxpack-browser.test.tsx` | 29 pass, 0 fail; 149 assertions |
| `packages/app` | Decode `MasterAgent.BindingUpdated.data`, route through actual registration and actual event router, compare canonical-scope/unrelated listeners | 0 / 1 / 0 deliveries; mismatch reproduced |

Total: **95 passing tests across six existing files**, plus one direct contract probe demonstrating the binding defect. No full suite, full typecheck matrix, clean external-host build, live browser, multi-process layout race or upstream-pin upgrade drill was run here. Task-batch tests include injected worker behavior; they do not establish live model or cross-entrypoint execution exclusivity.

## 5. Disposition

Proceed with the supplied architectural direction and amended work packages in the companion plan. Prioritize baseline correction, complete host/entrypoint inventory, executable binding correction, independent installation/identity, and the paired host/private-context proofs.

Full-parity feasibility remains **unproven**. The two largest maintenance risks are a broad Session/provider-context replacement and a broad Event/replay replacement. Measure those before committing to wholesale extraction.
