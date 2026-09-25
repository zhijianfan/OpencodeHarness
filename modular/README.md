# CyberMastery isolated modular proof workspace

This is an executable frontend/backend/persistence slice around official OpenCode. It is **not a full replacement** for the integrated application. Full-parity startup deliberately fails until the native-context, migration and host gates pass. See `../compat/gates.json`.

## Implemented

- `apps/web`: standalone Solid shell with a descriptor-driven static card, local edit revision protection, one event connection per client context, and logical CSS for LTR/RTL.
- `apps/host`: authenticated one-origin proof host and static assets; selects one native database/Event/projector graph through the adapter.
- `packages/contracts`: browser-safe layout DTO validation and extension HTTP route manifest.
- `packages/client`: typed client facade with extension-generated route bindings and abortable SSE.
- `packages/domain`: layout authorization/catalog policy behind a repository port.
- `packages/adapters-opencode`: official-source package integration, extension layout storage/CAS, independent migration ledger, private admission facade, managed Event transactions, private history/compaction adapters and full-snapshot proof transport.
- `packages/canvas`: descriptor registry and scoped event router.
- `packages/compat`: official pin/content attestation including edits hidden by index flags.

Native source is `../vendor/opencode` at `b02acc1e30ef55f7f181fec8d2f241d26f022683`. This workspace never imports the old root `packages/core` or `packages/server`. Native dependencies are installed in their unchanged native workspace. `script/link-native.ts` creates explicit local package links to those actual source packages and their exact dependency instances; it does not map native imports to custom implementations. No global `bun link` registry is required.

The existing integrated application remains at the repository root. That placement is temporary pending the gates, not a claimed production topology conversion.

## Setup

From the repository root initialize `vendor/opencode` and `vendor/superpowers` with `git submodule update --init`.

From `vendor/opencode`:

```text
bun install --frozen-lockfile
```

From `modular`:

```text
bun install --frozen-lockfile
bun run link:native
bun run attest:native
```

From `modular/packages/client`, run `bun run generate`. Generated files belong only to this extension workspace; do not generate changes inside native clients.

## Run the proof

Build from `modular/apps/web` with `bun run build`.

In PowerShell, choose a disposable database path and token, then run from `modular/apps/host`:

```powershell
$env:CYBERMASTERY_PROOF_DB = "$env:TEMP\cybermastery-static-card-proof.db"
$env:CYBERMASTERY_PROOF_TOKEN = "choose-a-local-proof-token"
bun run start --proof
```

Open `http://127.0.0.1:3174` and enter the token. Use `?dir=rtl` for an English/RTL check. The proof has a fixed grid, not the complete production canvas or session blocks. Explicit Reload acquires layout authority; event-triggered refresh does not.

Running full mode instead of `--proof` raises `FullParityUnavailable`; it does not silently downgrade private context or route to the old fork.

## Verification

Run `bun typecheck` from each affected package directory. Run `bun test src` in contracts, canvas, client and compat; `bun test test` in adapters-opencode and apps/host. Tests never run from the repository root.

From `apps/web`, `bun run test:smoke` drives the built shell in two real browser contexts. Playwright runs in a Node subprocess, with the proof host still on Bun. Windows uses installed Edge; other systems require Playwright Chromium. English LTR and forced RTL are covered; real RTL locale/native desktop parity is not claimed.

The compatibility suite has a POSIX-only symlink test skipped on Windows. The actual official Windows checkout is separately attested, including its link-text files. Before/after attestation does not establish protection from unobserved temporary rewrites; read-only build packaging remains a release requirement.

## Native-context finding

The native-boundary tests prove local atomic admission/sidecar commit, exact retry without repeated recall, rollback on sidecar failure and resume intent through the explicit external facade. The managed Event boundary also defers an enclosing transaction's execution wake until commit. These do not intercept every stock `SessionV2.prompt` entrypoint.

They also characterize two failing full-parity strategies:

1. Stock `EventV2.replayAll` commits a public prefix before a later failure.
2. A naive outer transaction rolls rows back, but a native replay notification has already escaped.

`event-boundary.ts` now resolves those two timing failures through an explicit replacement: upstream still owns storage/projectors, while the facade buffers public hints and fences native durable readers until the managed outer transaction completes. Nested savepoint rollback discards only its own hints/actions. Unmanaged outer SQL transactions and writes escaping the owning fiber/kernel fail closed.

`projection.ts` atomically restores input sidecars, checkpoints and the native epoch in the new explicit proof format. It checks an independently supplied expected digest, authorization, placement, relations and immutable duplicates. Native revert deletion cleans up extension records. This is not the original fork's paged BundleV1 protocol: lossy native codec decoding is rejected and migration compatibility remains pending.

`legacy-projection.ts` separately restores/exports the fork BundleV1 losslessly using the legacy context/event codecs, including proofs reconstructed after actual local native reverts. Supported private admissions retain full snapshots and compatibility metadata; readiness-gated clean admissions retain a clean identity without creating private state. The bounded encrypted spool, source/receiver, authenticated sync HTTP, reusable transfer client/peer and restart-durable completion receipts are integrated and verified. The application passes one readiness manager through both admission and transfer HTTP, holding enrichment permits through enclosing commit/rollback.

`provider-context.ts` reconstructs immutable private request messages, and `compaction.ts` exercises the real native compactor with enriched history while atomically storing a clean public checkpoint plus private summary/recent text. `runner.ts` now supplies explicit owned orchestration at the Location-scoped SessionRunner boundary. `session-facade.ts` delegates the native Session constructor and normalization while adding private admission/guard behavior. `createSessionRuntime` wires both into the native Location map and execution coordinator, with object-identity checks for shared services.

The core integration kernel is exported as `@cybermastery/adapters-opencode/session-runtime`; managed callers provide `PrivatePromptContext` from `./session-context`. The static-card HTTP host is still a proof host, not an assertion that every native/legacy endpoint has been migrated. See `../compat/OWNED_RUNNER_DECISION.md` for the replacement responsibility and outstanding conformance matrix.

Native creation/adoption and simultaneous Sessions in two Locations now have executable isolation tests. `session-execution.ts` composes one native coordinator with an explicit cause-transport workaround for interrupted Deferred fan-out in pinned Effect beta.83. Local tools yield before their first observable execution so cancellation cannot miss native FiberSet registration. Tests retain the native counterexamples and verify fixes, typed error identity, cleanup, queued-input survival and private snapshot reuse. See `../compat/RUNNER_CONFORMANCE.md`.

`application.ts` assembles native HTTP, actor-aware Session/sync HTTP and borrowed layout persistence over one runtime. Fresh Session creation atomically records v2 runtime classification/lifecycle metadata and an explicitly configured replay owner, separate from execution ownership. `child-runner.ts` creates and admits authorized children transactionally and uses shared pending-only execution. Real parent-tool tests prove external joining/interruption, parent cleanup, preservation of an independently owned child and no extra provider call on completed exact retries. Full task_batch product manifests/CtxPack capture/archival remain T11 extraction work.

**G1B T05/T06 feasibility passed**, including independent source-based re-review and a measured maintained-replacement decision. Latest full proof: **486 pass / 1 platform skip / 0 fail**, eight typechecks, frontend build, real-browser smoke and unchanged native-source attestation (**2026-09-24T09:41:58.276Z**). See `../compat/G1B_ACCEPTANCE.md`, `G1B_REVIEW.md`, `../compat/verification.json` and `../compat/COMPLETION_WORKLOG.md`.

Server-side composition exports now include `@cybermastery/adapters-opencode/child-runner`, `./transfer-client` and `./fork-session-copy`. The copy importer is a digest-bound, read-only representative Session upgrade experiment; full product-data migration/rollback remains a later gate.

### CtxPack extraction in progress

Latest full proof rerun: **659 pass / 1 POSIX-only skip / 0 fail**, **2026-09-24T15:22:33.050Z**; the earlier wave22 proof timestamp below is retained for provenance.

`@cybermastery/contracts/ctxpack` owns the browser-safe DTOs; `@cybermastery/domain/ctxpack-content` owns server-side normalization, frozen content/provenance hashes, UTF-8 splitting and search/recall terms. `@cybermastery/adapters-opencode/ctxpack-catalog` exports an explicitly authorized catalog over the selected native Database/EventBoundary, with revision CAS, private-pack filtering, FTS and per-user pins.

Capsule storage, authorized materialization, once-only native admitted-input usage, authenticated catalog HTTP and `@cybermastery/client/ctxpack` borrow the same selected graph. An actual browser-safe client→HTTP materialize→readiness-gated Session prompt verifies private/public separation and usage once on exact retry. The host may explicitly supply an observed-layout/functionality-instance authorization port for a trusted OperatingChat binding; only these bound Sessions may automatically recall packs, with native placement/runtime checks and transaction-time revalidation. The proof app exposes no client binding route. Latest full proof: **659 pass / 1 platform skip / 0 fail**, at **2026-09-24T15:02:26.121Z**, with adapter512. G1B's historical 486-test acceptance is recorded separately. Full OperatingChat lifecycle/UI, event multiplexing, worker/batch packs and copied-data migration remain pending. See `../compat/inventory/ctxpack.md`.

Current-fork data migration and all supported CLI/desktop/embedded/TUI workflows remain pending. **Do not remove the integrated source based on this proof.**

## Worker provenance

Seven independent implementation workers across three waves used `opencode-go/deepseek-v4.1-flash`, variant `max`, via fresh OpenCode CLI sessions. The catalogue did not advertise the requested ExtraHigh/xhigh variant; max was the highest supported effort. The master supplied self-contained, file-owned briefs, reviewed outputs and ran all validation after worker barriers. Manifests are in `.opencode/parallel/zero-patch-wave-*` at the repository root.

Waves 4–9 used **Astra High**. Waves 10–15 used the latest user selection, **OpenCode Go DeepSeek V4.1 Flash/high** (wave10 first tried max without producing edits). Later response caps increased to 131072 after a reasoning-only limit was reached. Coding workers received owned-file briefs; the separate reviewer had bounded read-only access. Export audits verify model/variant and successful edit scope, including rejected read/scratch/out-of-scope attempts. See `../compat/PARALLEL_IMPLEMENTATION_PLAN.md`, `../compat/workers.json` and `.opencode/parallel/completion-wave-*`.

Fresh CLI workers use `harness-worker` with explicit `--model opencode-go/deepseek-v4.1-flash --variant high`; no running application restart is required.
