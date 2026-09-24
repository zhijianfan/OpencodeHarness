# Remaining runner integration boundary

Date: 2026-09-23. Official pin: `b02acc1e30ef55f7f181fec8d2f241d26f022683`.

## Implementation update after checkpoint 48b592f

Wave 4 after `d8fdf95` adds stock/private failure comparisons, native creation/adoption and two-Location execution tests. Those tests exposed pinned cancellation defects, so the selected graph now installs the explicit `session-execution.ts` composition around one native coordinator and makes local tool registration cancellation-safe. See `RUNNER_CONFORMANCE.md` for counterexamples, exact workaround responsibilities and current validation; the earlier boundary analysis remains historical context.

The owned replacement described below is now implemented in `runner.ts` and assembled by `session-runtime.ts`. Native `SessionV2.prompt`/`resume` flow through the private Session facade, native Location map and native execution coordinator. An executable integration test checks that root and Location runner use the identical Database, Event and SessionStore instances. Clean-mode comparison, private context, tools/step limits, queue/steer boundaries, compaction, overflow recovery and interruption have focused tests.

This resolves the earlier absence of actual runner wiring for the core integration kernel. The broader legacy/HTTP/child/permission/provider matrix and fork transfer/data compatibility remain incomplete. See `OWNED_RUNNER_DECISION.md` and the replacement inventory; the historical boundary analysis below explains why the replacement was necessary.

## What is now executable

- `event-boundary.ts` supplies an explicit Event-service replacement that delegates native persistence/projectors and controls transaction visibility.
- `projection.ts` restores the extension proof format atomically, including input sidecars, checkpoints and the native epoch. Native revert events delete extension records through same-database foreign keys/triggers.
- `provider-context.ts` rebuilds provider messages from verified immutable context without altering public messages or request controls.
- `compaction.ts` delegates to the actual native compactor with enriched inputs and intercepts only the committed public checkpoint projection, storing private summary/recent text atomically.

These components pass scoped tests. They are not yet a replacement for every native runner/admission entrypoint.

## Why merely replacing the LLM client is insufficient

In official `packages/core/src/session/runner/llm.ts`:

- Line 109 constructs `SessionCompaction.make` internally.
- Lines 199-222 load history through the directly imported `SessionHistory.entriesForRunner`, construct a request through the directly imported `toLLMMessages`, and test compaction before calling the LLM client.
- Line 239 calls the LLM stream.
- Lines 284-295 separately handle overflow-triggered compaction.

An LLM transport decorator runs too late to make the preceding automatic-compaction decision private-context-aware. The native `SessionStore` service is not the owner of that particular history read; replacing it would not affect the direct helper call.

The current pin therefore has no demonstrated narrow service input for supplying the new history/compaction adapters to this loop. Import rewriting, module shadowing, database-query string interception and copying the native runner elsewhere are not acceptable solutions.

## Next implementation decision

An original, explicitly maintained `SessionRunner.Service` implementation at the existing Location-scoped node boundary is a possible next step. It must compose native services/helpers rather than duplicate transcript/inbox/storage authority. Its maintenance responsibility is materially larger than the Event decorator and must be recorded as a native-runtime replacement.

Before enabling it, the replacement review/test matrix must cover:

1. Agent/model selection and Location mismatch interruption.
2. Native System Context initialization/reconciliation and epoch replacement after compaction.
3. Queue/steer cutoffs, one queued input at idle, exact retry and provider-turn allowance reset.
4. One explicit provider-stream delegation per turn, distinct summary/overflow attempts, and limits.
5. Tool advertisement, local/provider-executed distinction, concurrent settlement barrier, declined permissions and interruption.
6. Native publisher event order, usage/token accounting, snapshots/files and interrupted/unsettled tool cleanup.
7. Process-global native SessionExecution ownership, including child execution and external resume/interrupt races.
8. Every supported native/legacy/HTTP/embedded admission surface using the intended private policy.

Use a common owned scenario harness to compare the stock native runner (private context disabled) with the replacement, then exercise private-context cases. Do not alter native tests or imports to make the comparison pass.

## Additional compatibility work

The new proof transport intentionally uses `cybermastery-private-projection/v1`, not the existing fork's `BundleV1`. It rejects lossy native event/epoch decoding, including fork-only `PromptAdmitted.modelContextVersion` at this pin. A lossless migration/decoder adapter, original deletion-manifest format, paged spool/readiness protocol and peer authentication remain required for full parity.

G1B is partial, not complete. The integrated application stays in place, and full-parity startup remains gated.
