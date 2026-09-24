# Remaining implementation: dependency-aware parallel plan

Date: 2026-09-23. Starting checkpoint: `d8fdf95`. Complements the T01-T14 mediation plan and the live gate inventory.

## Execution policy

- Current user-selected model: `opencode-go/deepseek-v4.1-flash`. Use **high** for new bounded workers: wave-10 max attempts exhausted 65536 reasoning tokens without edits, while high completed. Explicit CLI overrides select the variant. The master owns decomposition, source evidence, shared contracts, integration and acceptance decisions.
- Start with two concurrent coding workers. Increase concurrency only when a third lane has complete input contracts and disjoint files; do not split a shared runtime edit merely to create more workers.
- Each worker receives exact acceptance criteria, dependency APIs, baseline source snapshots and an exclusive file list. Freeze shared signatures before dispatch. No worker exploration, test/build commands, shared configuration edits or native-source edits.
- After all workers return, audit ownership and model/variant records, integrate, run package-scoped checks, and update evidence. Tests and migration rehearsals that share infrastructure remain serialized.
- Fix small integration failures in the master rather than paying a second dispatch/setup cycle. Re-delegate only independent, substantial follow-up work with a revised complete brief.
- Bounded read-only evidence lanes using the selected model may locate integration APIs while package verification runs. They write only their assigned inventory report; implementation workers still receive complete frozen contracts and do not explore. The master verifies decisive source excerpts before accepting a new boundary.
- Preserve actual model provenance: waves 1–3 were DeepSeek max, waves 4–9 Astra high, wave 10 DeepSeek max (no edits) followed by high. Fresh CLI sessions apply explicit model/variant selection without restarting the user's active application.

## Historical wave 4 (T03/T05/T06)

| Lane | Work | Exclusive implementation area | Barrier evidence |
| --- | --- | --- | --- |
| A | Runner failure/permission conformance; interruption settlement ordering; pre-mutation Location checks | adapters-opencode runner and runner tests | Pinned-native comparisons, deterministic cancellation, no misplaced history mutation |
| B | Native Session create/adopt and concurrent runtime isolation | adapters-opencode runtime composition and runtime tests | Actual native coordinator/Location-map operation, shared global identity, no private cross-talk, targeted interruption |

These lanes share only already-frozen exported signatures. Detailed ownership is in `.opencode/parallel/native-parity-wave-4/MANIFEST.md`.

**Wave 4 outcome:** both Astra High workers completed within disjoint ownership. Master integration fixed branded-ID fixture details and the pinned interruption/registration defects exposed by their tests. The final modular proof passed 192 tests with one platform skip, all eight typechecks and build/browser checks. `RUNNER_CONFORMANCE.md` records the additional execution-composition replacement and remaining scope. This completes this wave, not G1B.

## Contract lanes (T01/T05/T06/T12)

Waves 5–15 have completed the bounded G1B proof: authorized one-graph Session/native HTTP, private/clean readiness admission, reversible fork codecs, atomic full transfer with local-revert proofs, real source/receiver/client/peer HTTP, durable receipts, copied-fork Session upgrade and actual parent-tool child ownership. Latest full proof: **486 pass / 1 platform skip / 0 fail**. Independent read-only follow-up passes the milestone and the measured replacement decision is recorded. `G1B_ACCEPTANCE.md` defines its boundary; `COMPLETION_WORKLOG.md` is the detailed ledger.

The master first completes the relevant source inventory and pins the boundary DTOs. Then fan out:

1. **Admission/transport lane:** authorized Session command/query facade and thin HTTP/embedded adapters. Own new entrypoint modules and tests. Preserve existing ID/conflict/queue/steer/resume semantics and map each baseline principal explicitly.
2. **Fork codec/migration lane:** lossless fork event, private input/checkpoint, epoch and deletion decoding plus schema fixtures. Own codec/migration modules and tests, not live transport or Session orchestration.
3. **Baseline ledger lane when justified:** bounded, evidence-backed route/schema/host dispositions, each assigned a separate feature ledger. The master reconciles the shared inventory; path-derived labels alone do not complete G0.

The admission lane does not wait for paged transfer. The codec lane does not edit Session/HTTP composition. Restoration wiring follows the codec contract; authenticated paged spool/readiness follows the frozen restore interface. Do not parallelize two writers on projection.ts, Event mediation or one migration database.

**G1B barrier passed (T05/T06 feasibility):** selected admission surfaces, native provider/compaction behavior, parent-tool/child/external-resume ownership, lossless fork transfer, rollback and notification/read isolation. Full product features, migration and production-host conversion retain their separate acceptance gates below.

## Feature extraction waves after G1A/G1B review (T07-T11)

| Parallel lane | Can start after | Output / subsequent dependency |
| --- | --- | --- |
| Shell/Canvas/drafts and injected Session UI | Stable client, descriptor, event-feed and draft contracts | Native screens, four render modes and browser-local draft lifecycle; feeds OperatingChat UI |
| CtxPack catalog/materialization | Proven private admission and fixed catalog ports/schema mapping | CRUD/search/pinning/usage/limits, worker/batch packs; prerequisite for MasterAgent batch capture |
| Skills/Superpowers and ChatRelay backend/page worker | Frozen actor, skill policy, page ownership and file contracts | Role-specific skill bodies and real page lifecycle; relay UI can follow independently |
| OperatingChat service integration | Stable Session commands/queries and binding ports | Supported transport/embedded behavior, private context and interruption |
| MasterAgent/task_batch/control plane | CtxPack capture + Session child ownership + skill/model contracts | Manifest hashes, stable child IDs, persisted models/results, partial retry, archival and transfer |

Frontend and backend implementations may proceed concurrently only after their contract is pinned. The master alone changes shared contract barrels, client generation, host composition and migration registration; assign dependent feature folders rather than overlapping large packages.

## Acceptance and production conversion (T12-T14)

- Run Windows/Linux/CLI/desktop/embedded/TUI checks in parallel only with independent environments and databases.
- Serialize schema upgrade/rollback rehearsals against copied data. Validate IDs, content hashes, sidecars, Context Epoch, packs, drafts/blobs and compatibility state.
- Integrate one selected application graph before broad host acceptance. Keep one event connection per browser/server context.
- Perform the official-pin upgrade drill and source-integrity checks after integration; enforce source immutability throughout builds as well as before/after attestation.
- Remove the integrated tree and convert production topology only after all required gates pass. The scheduling changes do not relax any preservation or zero-patch requirements.
