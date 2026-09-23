# Zero-patch modularization implementation status

Date: 2026-09-23

## Overall state

**Partially implemented. Official upstream and the independent modular proof slice work. Managed replay isolation and private reconstruction/compaction adapters now pass; full runner/entrypoint wiring and fork-transfer compatibility still block removal of the integrated runtime.**

Work is local in `D:\OpencodeHarness`. No implementation commit or push has been made. `D:\CyberMastery` remains unchanged.

## Completed work

1. Added the complete official `https://github.com/anomalyco/opencode.git` monorepo at `vendor/opencode`, pinned to `b02acc1e30ef55f7f181fec8d2f241d26f022683`.
2. Installed upstream dependencies with its unchanged frozen lockfile and initialized the independent Superpowers gitlink.
3. Added source attestation that verifies the official pin/remote and tracked blob contents independently of `assume-unchanged` index flags. Before/after digest is identical for 6,626 tracked upstream entries.
4. Captured the CyberMastery baseline, rename-aware binary diff, trees, patch state and 1,128 candidate path dispositions in `compat/baseline`. Per-path semantic review is still pending; the generated classification is not a completeness claim.
5. Restored the 43 executable Git modes lost when the Harness snapshot was initialized on Windows. These are staged mode corrections, not content rewrites.
6. Created an isolated `modular/` workspace with actual frontend, backend, domain, persistence, client, Canvas and compatibility packages.
7. Implemented an authenticated static-card flow: Solid shell -> extension client -> host -> authorized layout service -> native database service. Layout saves use a conditional revision/authority transition; events are published after commit. Read-only refresh does not transfer authority.
8. Implemented an external private-admission facade using the existing native admission helper and atomic event-commit callback. Tests cover sidecar rollback, clean public input, exact retry, immutable snapshot reuse after reopening the database and resume intent.
9. Corrected the integrated MasterAgent registration's incompatible `functionalityID` filter, with an actual schema/registration/router regression test. This is custom application code, outside the new upstream submodule.
10. Added explicit Event-service mediation using upstream `layerWith(beforeAggregateRead)`: buffered public notifications, durable-reader fencing, nested rollback, post-commit wakes and owning-fiber/kernel checks. Native storage, sequencing and projectors remain delegated to upstream. The external proof host now uses this graph.
11. Added an atomic private-projection proof transport covering immutable input records, checkpoint records, requirements, native epoch state, authorization/digest/placement checks and native revert cascade cleanup. Duplicate/conflicting/lossy imports fail closed.
12. Preserved the private checkpoint v1 format and added verified private-history/request projection. The compaction adapter invokes the real native compactor on enriched history, commits private summary/recent data atomically, and keeps the public checkpoint at the existing sentinel plus clean recent text.

The proof shell deliberately has only a static card grid. It does not claim that OperatingChat, MasterAgent, CtxPack, ChatRelay, skills, Scratchpad, all native screens or existing data have been fully extracted.

## Verification

The modular proof uses one native database service for native tables and extension tables. Native migration entries remain unchanged in the tested native-to-extension upgrade path.

Machine-readable output: `compat/verification.json`.

| Check | Result |
| --- | --- |
| Typechecks for eight modular packages/apps | Pass |
| Modular contract, Canvas, client, compatibility, native-boundary, storage and HTTP tests | 144 pass, 1 skip, 0 fail |
| Real-browser static-card smoke | 1 pass; independent LTR and RTL contexts, save/sync/remove |
| Independent Solid production build | Pass |
| Integrated app typecheck and corrected MasterAgent registration suite | Previously verified pass; 4 tests, unchanged in this continuation |
| Official upstream before/after attestation | Same pin, tree and source digest |

The latest proof verification records **145 passing tests**, with **one POSIX-only symlink case skipped on Windows**. The separately recorded integrated-app regression adds four earlier passes, not part of the latest proof command. The browser smoke drives installed Edge through a Node subprocess while the proof application remains on Bun. No toolchain upgrade was made. SQLite runtimes are disposed immediately; per-file suite cleanup unlinks temporary databases after test frames release Windows native statements, and cleanup failures remain test failures.

This is not the full repository suite, a Linux run, live ChatGPT-site verification, complete migration coverage, all native host surfaces or an upstream-pin upgrade drill.

## Why the integrated runtime remains

The original native-boundary suite preserves two counterexamples relevant to G1B:

- Stock native `EventV2.replayAll` commits an earlier public event/input before a later event fails.
- A naive outer transaction rolls the rows back, but a native replay notification has already escaped.

The new mediated graph fixes these timing failures for managed operations. It does not claim the stock implementation acquired a new `replayBatch` method or that arbitrary unmanaged outer transactions became safe.

The remaining blocker is integration coverage: the admission facade does not intercept all stock/legacy prompt entrypoints, and the stock runner constructs history and compaction through direct helper imports. The new adapters are verified when invoked explicitly but are not automatically wired into those internal calls. The new full-snapshot proof transport is also not the fork's existing paged BundleV1 protocol; fork-only fields rejected by native codecs remain a migration/decoder integration issue.

Consequently, full-parity startup throws `FullParityUnavailable`. `compat/gates.json` records `legacyRemovalAllowed: false`. Deleting the integrated runtime now would remove behavior before a replacement is proven, contrary to the approved parity and migration constraints.

## Next required implementation work

1. Finish the baseline's per-path feature/disposition review, route/event/default inventory and schema migration inventory.
2. Complete the explicit Session/provider/compaction integration decision against the existing Location-scoped `SessionRunner.Service` boundary. The Event replacement is now implemented and recorded. Measure any additional replacement responsibility; do not copy or shadow native modules.
3. Pass G1B across every supported admission entrypoint, native provider turns, compaction and transactional public/private restore with post-commit notification isolation.
4. Extract the remaining features with the corrected preservation inventory, including existing task_batch manifest/result capture, model pinning, retry and archival.
5. Complete current-fork data migration/rollback and the combined-host/CLI/desktop/embedded/TUI parity matrix, then perform an official-pin upgrade drill.
6. Remove the old integrated source only after those gates pass; move the validated isolated workspace into the final production topology at that point.

The stock/naive replay limitations are now addressed by the explicit Event facade in the proof graph. See `compat/G1B_INTEGRATION_DECISION.md` for its responsibility and `compat/SESSION_RUNNER_INTEGRATION_REVIEW.md` for the remaining runner boundary and required parity matrix.

## Worker model

Seven workers across three waves used `opencode-go/deepseek-v4.1-flash` with variant `max`. The installed catalogue advertises low/high/max, not ExtraHigh/xhigh. Fresh CLI worker sessions allowed the requested model to be pinned independently of this session's preconfigured Task agents. The master supplied file-owned briefs, reviewed and corrected output, integrated it and ran validation only after each worker barrier.

See `compat/workers.json` and `.opencode/parallel/zero-patch-wave-*`. Wave 3 supplied the checkpoint and history helpers; the master implemented transaction mediation, projection restore and provider/compaction integration. The worker definition is loaded by new OpenCode sessions; existing sessions retain their previously loaded configuration.

## Entry points

- `modular/README.md`: setup, proof launch and package test commands.
- `modular/package.json`: `capture:baseline`, `link:native`, `attest:native`, `verify:proof`.
- `compat/upstream-pin.json`: exact official source dependency.
- `compat/native-replacements.json`: explicit integration and blocked replacement inventory.
- `compat/upstream-capabilities.json`: verified capability scope and limitations.
- `compat/imports.json`: native import ownership.
